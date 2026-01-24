const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Telegraf } = require('telegraf');

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// 数据库配置 - 从环境变量读取
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('只支持图片文件'));
    }
  }
});

// JWT密钥 - 从环境变量读取
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key-for-dev';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'default-admin-secret-for-dev';

// Telegram机器人 - 从环境变量读取
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'your-telegram-bot-token') {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  
  // 机器人指令
  bot.command('ck', async (ctx) => {
    try {
      const orders = await pool.query('SELECT COUNT(*) FROM orders WHERE created_at >= NOW() - INTERVAL \'3 days\'');
      const products = await pool.query('SELECT COUNT(*) FROM products WHERE is_active = true');
      const users = await pool.query('SELECT COUNT(*) FROM users');
      const config = await pool.query('SELECT exchange_rate, service_fee_percent FROM system_config LIMIT 1');
      
      const message = `
📊 数据库统计：
• 近3天订单: ${orders.rows[0].count}
• 上架商品: ${products.rows[0].count}
• 注册用户: ${users.rows[0].count}
• 当前汇率: ${config.rows[0]?.exchange_rate || 7.2}
• 手续费: ${config.rows[0]?.service_fee_percent || 3.0}%
      `;
      
      await ctx.reply(message);
    } catch (error) {
      console.error('查询数据库失败:', error);
      await ctx.reply('❌ 查询数据库失败');
    }
  });
  
  bot.command('qc', async (ctx) => {
    await ctx.reply('⚠️ 确认清空数据库？请回复"确认清空"以继续。');
    
    // 等待确认
    const confirmation = await waitForConfirmation(ctx);
    
    if (confirmation === '确认清空') {
      try {
        await pool.query('TRUNCATE TABLE orders, chat_messages RESTART IDENTITY');
        await ctx.reply('✅ 数据库已清空（订单和聊天记录）');
      } catch (error) {
        console.error('清空数据库失败:', error);
        await ctx.reply('❌ 清空数据库失败');
      }
    } else {
      await ctx.reply('❌ 操作已取消');
    }
  });
  
  bot.hears(/设置汇率 (\d+(\.\d+)?)/, async (ctx) => {
    const rate = parseFloat(ctx.match[1]);
    
    if (rate <= 0) {
      await ctx.reply('❌ 汇率必须大于0');
      return;
    }
    
    try {
      await pool.query('UPDATE system_config SET exchange_rate = $1, updated_at = NOW() WHERE id = 1', [rate]);
      await ctx.reply(`✅ 汇率已设置为: 1 USDT = ¥${rate}`);
    } catch (error) {
      console.error('设置汇率失败:', error);
      await ctx.reply('❌ 设置汇率失败');
    }
  });
  
  bot.hears(/设置手续费 (\d+(\.\d+)?)/, async (ctx) => {
    const fee = parseFloat(ctx.match[1]);
    
    if (fee < 0 || fee > 100) {
      await ctx.reply('❌ 手续费必须在0-100之间');
      return;
    }
    
    try {
      await pool.query('UPDATE system_config SET service_fee_percent = $1, updated_at = NOW() WHERE id = 1', [fee]);
      await ctx.reply(`✅ 手续费已设置为: ${fee}%`);
    } catch (error) {
      console.error('设置手续费失败:', error);
      await ctx.reply('❌ 设置手续费失败');
    }
  });
  
  bot.command('bz', async (ctx) => {
    const helpText = `
🤖 电商管理机器人指令：

/ck - 查看数据库统计
/qc - 清空数据库（订单和聊天记录）
设置汇率 [数值] - 设置汇率（如：设置汇率 7.2）
设置手续费 [数值] - 设置手续费（如：设置手续费 3.0）
/bz - 显示此帮助

⚠️ 注意：所有操作只能在群组中进行
    `;
    
    await ctx.reply(helpText);
  });
  
  // 启动机器人
  bot.launch().then(() => {
    console.log('🤖 Telegram机器人已启动');
  }).catch(error => {
    console.log('⚠️ Telegram机器人启动失败，跳过机器人功能');
  });
}

// 等待确认函数
async function waitForConfirmation(ctx) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve('超时');
    }, 30000);
    
    const listener = (ctx2) => {
      if (ctx2.from.id === ctx.from.id && ctx2.chat.id === ctx.chat.id) {
        clearTimeout(timeout);
        bot.off('text', listener);
        resolve(ctx2.message.text);
      }
    };
    
    bot.on('text', listener);
  });
}

// 初始化数据库表
async function initDatabase() {
  try {
    // 用户表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        contact VARCHAR(100) NOT NULL,
        balance DECIMAL(10, 2) DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 商品表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        price_usdt DECIMAL(10, 2) NOT NULL,
        stock INTEGER NOT NULL,
        category VARCHAR(100),
        product_type VARCHAR(20) CHECK (product_type IN ('physical', 'virtual')),
        images TEXT[],
        is_pinned BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 订单表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_code VARCHAR(20) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER NOT NULL,
        payment_method VARCHAR(20) CHECK (payment_method IN ('usdt', 'wechat', 'alipay')),
        exchange_rate DECIMAL(10, 4) NOT NULL,
        service_fee_percent DECIMAL(5, 2) DEFAULT 0,
        total_cny DECIMAL(10, 2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        contact_info TEXT,
        qr_code_url TEXT,
        payment_proof_url TEXT,
        tracking_number VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP,
        shipped_at TIMESTAMP
      )
    `);
    
    // 招聘信息表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recruitments (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        subtitle VARCHAR(500),
        tags VARCHAR(500),
        salary VARCHAR(100),
        location VARCHAR(100),
        type VARCHAR(50),
        is_pinned BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 公告表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        is_pinned BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 客服消息表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        message TEXT NOT NULL,
        is_from_admin BOOLEAN DEFAULT false,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 系统配置表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        id SERIAL PRIMARY KEY,
        exchange_rate DECIMAL(10, 4) DEFAULT 7.2,
        service_fee_percent DECIMAL(5, 2) DEFAULT 3.0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 插入默认配置
    const configCount = await pool.query('SELECT COUNT(*) FROM system_config');
    if (parseInt(configCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO system_config (exchange_rate, service_fee_percent) 
        VALUES (7.2, 3.0)
      `);
    }
    
    // 创建管理员用户（如果不存在）
    const adminPassword = await bcrypt.hash('admin123', 10);
    await pool.query(`
      INSERT INTO users (username, password_hash, contact, balance, is_active)
      VALUES ('admin', $1, 'admin@techshop.com', 0, true)
      ON CONFLICT (username) DO NOTHING
    `, [adminPassword]);
    
    console.log('✅ 数据库初始化完成');
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
  }
}

// 验证用户Token中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: '需要身份验证' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: '无效的令牌' });
    }
    req.user = user;
    next();
  });
}

// 验证管理员Token中间件
function authenticateAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: '需要管理员身份验证' });
  }
  
  jwt.verify(token, ADMIN_JWT_SECRET, (err, admin) => {
    if (err) {
      return res.status(403).json({ message: '无效的管理员令牌' });
    }
    req.admin = admin;
    next();
  });
}

// ==================== 用户API路由 ====================
const userRouter = express.Router();

// 用户注册
userRouter.post('/register', async (req, res) => {
  try {
    const { username, password, contact } = req.body;
    
    // 验证输入
    if (!username || !password || !contact) {
      return res.status(400).json({ message: '请填写所有必填字段' });
    }
    
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ message: '用户名长度应为3-20位' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ message: '密码长度至少6位' });
    }
    
    // 检查用户名是否已存在
    const existingUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: '用户名已存在' });
    }
    
    // 加密密码
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // 创建用户
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, contact) VALUES ($1, $2, $3) RETURNING id, username, contact, balance, created_at',
      [username, passwordHash, contact]
    );
    
    const user = result.rows[0];
    
    // 生成Token
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.status(201).json({
      message: '注册成功',
      token,
      user: {
        id: user.id,
        username: user.username,
        contact: user.contact,
        balance: user.balance
      }
    });
  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({ message: '注册失败，请稍后重试' });
  }
});

// 用户登录
userRouter.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: '请输入用户名和密码' });
    }
    
    // 查找用户
    const result = await pool.query(
      'SELECT id, username, password_hash, contact, balance FROM users WHERE username = $1 AND is_active = true',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }
    
    const user = result.rows[0];
    
    // 验证密码
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }
    
    // 生成Token
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      message: '登录成功',
      token,
      user: {
        id: user.id,
        username: user.username,
        contact: user.contact,
        balance: user.balance
      }
    });
  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({ message: '登录失败，请稍后重试' });
  }
});

// 获取当前用户信息
userRouter.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, contact, balance, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: '用户不存在' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(500).json({ message: '获取用户信息失败' });
  }
});

// 更新用户信息
userRouter.put('/update', authenticateToken, async (req, res) => {
  try {
    const { contact } = req.body;
    
    if (!contact) {
      return res.status(400).json({ message: '请提供联系方式' });
    }
    
    const result = await pool.query(
      'UPDATE users SET contact = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, contact, balance',
      [contact, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: '用户不存在' });
    }
    
    res.json({
      message: '更新成功',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('更新用户信息失败:', error);
    res.status(500).json({ message: '更新用户信息失败' });
  }
});

// ==================== 商品API路由 ====================
const productRouter = express.Router();

// 获取所有商品
productRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, price_usdt, stock, category, product_type, images, is_pinned, created_at FROM products WHERE is_active = true ORDER BY is_pinned DESC, created_at DESC'
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('获取商品失败:', error);
    res.status(500).json({ message: '获取商品失败' });
  }
});

// 获取单个商品
productRouter.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, price_usdt, stock, category, product_type, images, created_at FROM products WHERE id = $1 AND is_active = true',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: '商品不存在' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('获取商品失败:', error);
    res.status(500).json({ message: '获取商品失败' });
  }
});

// ==================== 订单API路由 ====================
const orderRouter = express.Router();

// 获取用户订单
orderRouter.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        o.id, o.order_code, o.quantity, o.payment_method, 
        o.exchange_rate, o.service_fee_percent, o.total_cny,
        o.status, o.qr_code_url, o.payment_proof_url,
        o.tracking_number, o.created_at, o.paid_at, o.shipped_at,
        p.name as product_name, p.price_usdt
      FROM orders o
      JOIN products p ON o.product_id = p.id
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('获取订单失败:', error);
    res.status(500).json({ message: '获取订单失败' });
  }
});

// 创建订单
orderRouter.post('/', authenticateToken, async (req, res) => {
  try {
    const { product_id, quantity, payment_method } = req.body;
    
    if (!product_id || !quantity || !payment_method) {
      return res.status(400).json({ message: '请填写所有必填字段' });
    }
    
    // 获取商品信息
    const productResult = await pool.query(
      'SELECT price_usdt, stock FROM products WHERE id = $1 AND is_active = true',
      [product_id]
    );
    
    if (productResult.rows.length === 0) {
      return res.status(404).json({ message: '商品不存在' });
    }
    
    const product = productResult.rows[0];
    
    // 检查库存
    if (product.stock < quantity) {
      return res.status(400).json({ message: '库存不足' });
    }
    
    // 获取系统配置
    const configResult = await pool.query('SELECT exchange_rate, service_fee_percent FROM system_config LIMIT 1');
    const config = configResult.rows[0] || { exchange_rate: 7.2, service_fee_percent: 3.0 };
    
    // 计算价格
    let totalUSDT = product.price_usdt * quantity;
    let serviceFee = 0;
    
    if (payment_method !== 'usdt') {
      serviceFee = totalUSDT * (config.service_fee_percent / 100);
      totalUSDT += serviceFee;
    }
    
    const totalCNY = totalUSDT * config.exchange_rate;
    
    // 生成订单号
    const orderCode = 'TS' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase();
    
    // 创建订单
    const orderResult = await pool.query(`
      INSERT INTO orders (
        order_code, user_id, product_id, quantity, payment_method,
        exchange_rate, service_fee_percent, total_cny, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id, order_code, total_cny, created_at
    `, [
      orderCode, req.user.id, product_id, quantity, payment_method,
      config.exchange_rate, config.service_fee_percent, totalCNY
    ]);
    
    // 减少库存
    await pool.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2',
      [quantity, product_id]
    );
    
    res.status(201).json({
      message: '订单创建成功',
      order: orderResult.rows[0]
    });
  } catch (error) {
    console.error('创建订单失败:', error);
    res.status(500).json({ message: '创建订单失败' });
  }
});

// 上传支付凭证
orderRouter.post('/upload-proof', authenticateToken, upload.single('proof'), async (req, res) => {
  try {
    const { orderCode } = req.body;
    
    if (!orderCode || !req.file) {
      return res.status(400).json({ message: '请提供订单号和支付凭证' });
    }
    
    // 检查订单是否存在且属于当前用户
    const orderResult = await pool.query(
      'SELECT id FROM orders WHERE order_code = $1 AND user_id = $2',
      [orderCode, req.user.id]
    );
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: '订单不存在' });
    }
    
    const fileUrl = `/uploads/${req.file.filename}`;
    
    // 更新订单
    await pool.query(
      'UPDATE orders SET payment_proof_url = $1, status = $2 WHERE order_code = $3',
      [fileUrl, 'paid', orderCode]
    );
    
    res.json({ message: '支付凭证上传成功', url: fileUrl });
  } catch (error) {
    console.error('上传支付凭证失败:', error);
    res.status(500).json({ message: '上传支付凭证失败' });
  }
});

// ==================== 公告API路由 ====================
const announcementRouter = express.Router();

// 获取所有公告
announcementRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, content, is_pinned, is_active, created_at FROM announcements WHERE is_active = true ORDER BY is_pinned DESC, created_at DESC'
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('获取公告失败:', error);
    res.status(500).json({ message: '获取公告失败' });
  }
});

// ==================== 招聘API路由 ====================
const recruitmentRouter = express.Router();

// 获取所有招聘信息
recruitmentRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, content, subtitle, tags, salary, location, type, is_pinned, created_at FROM recruitments WHERE is_active = true ORDER BY is_pinned DESC, created_at DESC'
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('获取招聘信息失败:', error);
    res.status(500).json({ message: '获取招聘信息失败' });
  }
});

// ==================== 聊天API路由 ====================
const chatRouter = express.Router();

// 发送消息
chatRouter.post('/send', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ message: '消息内容不能为空' });
    }
    
    // 保存消息
    const result = await pool.query(
      'INSERT INTO chat_messages (user_id, message, is_from_admin, is_read) VALUES ($1, $2, false, false) RETURNING id, created_at',
      [req.user.id, message.trim()]
    );
    
    res.json({
      message: '消息发送成功',
      chat: result.rows[0]
    });
  } catch (error) {
    console.error('发送消息失败:', error);
    res.status(500).json({ message: '发送消息失败' });
  }
});

// ==================== 配置API路由 ====================
const configRouter = express.Router();

// 获取系统配置
configRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT exchange_rate, service_fee_percent FROM system_config LIMIT 1');
    
    if (result.rows.length === 0) {
      return res.json({ exchangeRate: 7.2, serviceFee: 3.0 });
    }
    
    res.json({
      exchangeRate: result.rows[0].exchange_rate,
      serviceFee: result.rows[0].service_fee_percent
    });
  } catch (error) {
    console.error('获取配置失败:', error);
    res.json({ exchangeRate: 7.2, serviceFee: 3.0 });
  }
});

// ==================== 管理员API路由 ====================
const adminRouter = express.Router();

// 管理员登录
adminRouter.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: '请输入管理员账号和密码' });
    }
    
    // 查找管理员用户
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: '管理员账号或密码错误' });
    }
    
    const admin = result.rows[0];
    
    // 验证密码
    const isValidPassword = await bcrypt.compare(password, admin.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ message: '管理员账号或密码错误' });
    }
    
    // 生成管理员Token
    const token = jwt.sign(
      { id: admin.id, username: admin.username, isAdmin: true },
      ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      message: '管理员登录成功',
      token
    });
  } catch (error) {
    console.error('管理员登录失败:', error);
    res.status(500).json({ message: '管理员登录失败' });
  }
});

// 检查管理员认证
adminRouter.get('/auth/check', authenticateAdminToken, async (req, res) => {
  res.json({ message: '管理员认证有效' });
});

// 获取仪表盘数据
adminRouter.get('/dashboard', authenticateAdminToken, async (req, res) => {
  try {
    // 今日订单
    const todayOrdersResult = await pool.query(`
      SELECT COUNT(*) FROM orders 
      WHERE DATE(created_at) = CURRENT_DATE
    `);
    
    // 昨日订单
    const yesterdayOrdersResult = await pool.query(`
      SELECT COUNT(*) FROM orders 
      WHERE DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'
    `);
    
    // 待上传二维码订单
    const pendingQrOrdersResult = await pool.query(`
      SELECT COUNT(*) FROM orders 
      WHERE status = 'pending' AND payment_method != 'usdt'
    `);
    
    // 总用户数
    const totalUsersResult = await pool.query(`
      SELECT COUNT(*) FROM users WHERE is_active = true
    `);
    
    // 系统配置
    const configResult = await pool.query('SELECT exchange_rate, service_fee_percent FROM system_config LIMIT 1');
    
    res.json({
      todayOrders: parseInt(todayOrdersResult.rows[0].count),
      yesterdayOrders: parseInt(yesterdayOrdersResult.rows[0].count),
      pendingQrOrders: parseInt(pendingQrOrdersResult.rows[0].count),
      totalUsers: parseInt(totalUsersResult.rows[0].count),
      exchangeRate: configResult.rows[0]?.exchange_rate || 7.2,
      serviceFee: configResult.rows[0]?.service_fee_percent || 3.0
    });
  } catch (error) {
    console.error('获取仪表盘数据失败:', error);
    res.status(500).json({ message: '获取仪表盘数据失败' });
  }
});

// 获取所有公告（管理员）
adminRouter.get('/announcements', authenticateAdminToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, content, is_pinned, is_active, created_at FROM announcements ORDER BY is_pinned DESC, created_at DESC'
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('获取公告失败:', error);
    res.status(500).json({ message: '获取公告失败' });
  }
});

// 创建公告
adminRouter.post('/announcements', authenticateAdminToken, async (req, res) => {
  try {
    const { title, content, is_pinned = false, is_active = true } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ message: '请填写标题和内容' });
    }
    
    const result = await pool.query(`
      INSERT INTO announcements (title, content, is_pinned, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING id, title, content, is_pinned, is_active, created_at
    `, [title, content, is_pinned, is_active]);
    
    res.status(201).json({
      message: '公告创建成功',
      announcement: result.rows[0]
    });
  } catch (error) {
    console.error('创建公告失败:', error);
    res.status(500).json({ message: '创建公告失败' });
  }
});

// 获取所有商品（管理员）
adminRouter.get('/products', authenticateAdminToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, price_usdt, stock, category, product_type, images, is_pinned, is_active, created_at FROM products ORDER BY is_pinned DESC, created_at DESC'
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('获取商品失败:', error);
    res.status(500).json({ message: '获取商品失败' });
  }
});

// 创建商品
adminRouter.post('/products', authenticateAdminToken, upload.array('images', 10), async (req, res) => {
  try {
    const { name, description, price_usdt, stock, category, product_type } = req.body;
    
    if (!name || !description || !price_usdt || !stock || !product_type) {
      return res.status(400).json({ message: '请填写所有必填字段' });
    }
    
    const price = parseFloat(price_usdt);
    const stockNum = parseInt(stock);
    
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ message: '价格必须大于0' });
    }
    
    if (isNaN(stockNum) || stockNum < 0) {
      return res.status(400).json({ message: '库存不能为负数' });
    }
    
    // 处理图片
    let images = [];
    if (req.files && req.files.length > 0) {
      images = req.files.map(file => `/uploads/${file.filename}`);
    }
    
    const result = await pool.query(`
      INSERT INTO products (name, description, price_usdt, stock, category, product_type, images)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, name, description, price_usdt, stock, category, product_type, images, created_at
    `, [name, description, price, stockNum, category, product_type, images]);
    
    res.status(201).json({
      message: '商品创建成功',
      product: result.rows[0]
    });
  } catch (error) {
    console.error('创建商品失败:', error);
    res.status(500).json({ message: '创建商品失败' });
  }
});

// 注册路由
app.use('/api/auth', userRouter);
app.use('/api/products', productRouter);
app.use('/api/orders', orderRouter);
app.use('/api/announcements', announcementRouter);
app.use('/api/recruitments', recruitmentRouter);
app.use('/api/chat', chatRouter);
app.use('/api/config', configRouter);
app.use('/api/admin', adminRouter);

// 默认路由
app.get('/', (req, res) => {
  res.json({
    message: 'TechShop电商平台API',
    version: '1.0.0',
    status: '运行正常',
    endpoints: {
      auth: '/api/auth',
      products: '/api/products',
      orders: '/api/orders',
      announcements: '/api/announcements',
      recruitments: '/api/recruitments',
      chat: '/api/chat',
      config: '/api/config',
      admin: '/api/admin'
    }
  });
});

// 健康检查端点（Render需要）
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ message: 'API接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: '文件上传错误: ' + err.message });
  }
  
  res.status(500).json({ 
    message: '服务器内部错误'
  });
});

// 启动服务器
async function startServer() {
  try {
    // 初始化数据库
    await initDatabase();
    
    // 启动Express服务器
    app.listen(port, () => {
      console.log(`🚀 服务器运行在端口: ${port}`);
      console.log(`📚 API地址: http://localhost:${port}/`);
      console.log(`🔗 健康检查: http://localhost:${port}/health`);
    });
  } catch (error) {
    console.error('❌ 启动服务器失败:', error);
    process.exit(1);
  }
}

startServer();

// 优雅关闭
process.on('SIGINT', () => {
  console.log('🛑 正在关闭服务器...');
  if (bot) {
    bot.stop();
  }
  pool.end();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 正在关闭服务器...');
  if (bot) {
    bot.stop();
  }
  pool.end();
  process.exit(0);
});
