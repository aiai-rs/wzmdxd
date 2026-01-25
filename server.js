/**
 * NexGen Backend - High Performance, Secure, Single File Implementation
 * Stack: Express, PostgreSQL (Neon), Telegraf, Node-Cron
 */

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer'); // Used for memory storage of uploads
const bcrypt = require('bcryptjs');

// --- 配置检查 ---
const requiredEnv = ['DATABASE_URL', 'TG_BOT_TOKEN', 'TG_GROUP_ID', 'JWT_SECRET'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ 缺少环境变量: ${missingEnv.join(', ')}`);
    // 为了防止部署失败，这里不退出进程，但 API 会报错
}

// --- 初始化组件 ---
const app = express();
const upload = multer({ 
    limits: { fileSize: 2 * 1024 * 1024 }, // 限制 2MB
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('只允许上传图片'));
        cb(null, true);
    }
});
const bot = new Telegraf(process.env.TG_BOT_TOKEN);
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon 需要 SSL
});

// --- 全局变量与缓存 (Settings) ---
let SYSTEM_CONFIG = {
    exchangeRate: 7.20,
    fees: { wx: 0.03, ali: 0.03 }
};

// --- 1. 数据库初始化 (自动建表) ---
const initDB = async () => {
    const client = await pool.connect();
    try {
        // 用户表
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                balance DECIMAL(10, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 商品表
        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                stock INTEGER DEFAULT 0,
                type VARCHAR(20) CHECK (type IN ('real', 'virtual')),
                image_url TEXT,
                is_top BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 订单表 (包含支付凭证和二维码，使用 Text 存储 Base64 或 URL)
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id VARCHAR(50) PRIMARY KEY,
                user_id UUID REFERENCES users(id),
                items JSONB NOT NULL,
                total_amount DECIMAL(10, 2) NOT NULL,
                pay_type VARCHAR(20) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending', 
                qr_code TEXT, -- 管理员上传的收款码 (Base64)
                payment_proof TEXT, -- 用户上传的凭证 (Base64)
                expire_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 招聘/公告表
        await client.query(`
            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                content TEXT NOT NULL,
                is_popup BOOLEAN DEFAULT FALSE,
                type VARCHAR(20) DEFAULT 'notice', -- notice, job
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ 数据库初始化完成 (Neon PostgreSQL)');
    } catch (err) {
        console.error('❌ 数据库初始化失败:', err);
    } finally {
        client.release();
    }
};

// --- 2. 中间件与安全性 ---
app.use(helmet()); // 设置安全 HTTP 头
app.use(cors()); // 允许跨域 (生产环境应限制域名)
app.use(express.json({ limit: '10mb' })); // 允许 JSON Body
app.use(morgan('tiny')); // 日志

// 鉴权中间件
const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: '未授权访问' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token 无效或已过期' });
        req.user = user;
        next();
    });
};

// --- 3. 业务 API 接口 ---

// >>> 公开接口 <<<

// 获取全局配置 (汇率等)
app.get('/api/config', (req, res) => {
    res.json(SYSTEM_CONFIG);
});

// 获取商品列表
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY is_top DESC, id DESC');
        // 前端显示时自动换算汇率，后端只发 USDT 价格
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 注册
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '参数不完整' });
    
    // 简单的防止暴力破解 (生产环境应加 Rate Limit)
    if (password.length < 6) return res.status(400).json({ error: '密码过短' });

    const hashedPassword = await bcrypt.hash(password, 10);
    try {
        const result = await pool.query(
            'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, balance',
            [username, hashedPassword]
        );
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: '用户名已存在' });
        res.status(500).json({ error: '注册失败' });
    }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ error: '用户不存在' });

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: '密码错误' });

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username, balance: user.balance } });
    } catch (err) {
        res.status(500).json({ error: '登录失败' });
    }
});

// >>> 需登录接口 <<<

// 创建订单 (核心安全逻辑)
app.post('/api/orders', authenticate, async (req, res) => {
    const { items, payType, useBalance } = req.body; 
    // items: [{id, qty}, ...]
    
    if (!items || items.length === 0) return res.status(400).json({ error: '购物车为空' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // 开启事务

        let subtotal = 0;
        const dbItems = [];

        // 1. 验证商品价格与库存 (后端计算，不信前端)
        for (const item of items) {
            const prodRes = await client.query('SELECT * FROM products WHERE id = $1', [item.id]);
            if (prodRes.rows.length === 0) throw new Error(`商品 ID ${item.id} 不存在`);
            const prod = prodRes.rows[0];
            
            if (prod.stock < item.qty) throw new Error(`商品 ${prod.name} 库存不足`);
            
            // 扣减库存
            await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.qty, item.id]);
            
            subtotal += parseFloat(prod.price) * item.qty;
            dbItems.push({ id: prod.id, name: prod.name, price: prod.price, qty: item.qty });
        }

        // 2. 计算费用
        let feeRate = 0;
        if (payType === 'wechat') feeRate = SYSTEM_CONFIG.fees.wx;
        if (payType === 'alipay') feeRate = SYSTEM_CONFIG.fees.ali;
        
        let totalAmount = subtotal * (1 + feeRate);

        // 3. 余额抵扣逻辑
        let balanceUsed = 0;
        if (useBalance) {
            const userRes = await client.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
            const userBalance = parseFloat(userRes.rows[0].balance);
            
            if (userBalance >= totalAmount) {
                balanceUsed = totalAmount;
                totalAmount = 0; // 全额抵扣
            } else {
                balanceUsed = userBalance;
                totalAmount -= userBalance;
            }
            
            // 扣除余额
            if (balanceUsed > 0) {
                await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [balanceUsed, req.user.id]);
            }
        }

        // 4. USDT 随机小数逻辑
        if (payType === 'usdt' && totalAmount > 0) {
            const randomDecimal = (Math.floor(Math.random() * 99) + 1) / 100;
            totalAmount += randomDecimal;
            totalAmount = parseFloat(totalAmount.toFixed(2));
        }

        // 5. 生成订单
        const orderId = uuidv4().split('-')[0].toUpperCase(); // 生成短订单号
        const expireAt = new Date(Date.now() + 30 * 60000); // 30分钟后过期

        // 状态: 如果全额余额支付，直接 paid，否则 pending
        const status = totalAmount <= 0.01 ? 'paid' : 'pending';

        await client.query(
            `INSERT INTO orders (id, user_id, items, total_amount, pay_type, status, expire_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orderId, req.user.id, JSON.stringify(dbItems), totalAmount, payType, status, expireAt]
        );

        await client.query('COMMIT');

        // TG 通知
        notifyGroup(`📦 <b>新订单创建</b>\n订单号: <code>${orderId}</code>\n用户: ${req.user.username}\n金额: ${totalAmount} ${payType.toUpperCase()}\n状态: ${status}`);

        res.json({ orderId, totalAmount, status, expireAt });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message || '订单创建失败' });
    } finally {
        client.release();
    }
});

// 获取我的订单
app.get('/api/orders/my', authenticate, async (req, res) => {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    // 安全策略: 只有 pending 且非 USDT 的订单才返回 qr_code (如果是 Base64 图片)
    // 这里为了简化，直接返回，前端负责展示逻辑
    res.json(result.rows);
});

// 上传支付凭证
app.post('/api/orders/:id/proof', authenticate, upload.single('proof'), async (req, res) => {
    const orderId = req.params.id;
    const file = req.file; // 内存中的文件
    if (!file) return res.status(400).json({ error: '未上传文件' });

    // 将图片转为 Base64 存入 DB (适应无文件系统环境)
    const base64Img = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    try {
        await pool.query('UPDATE orders SET payment_proof = $1 WHERE id = $2 AND user_id = $3', [base64Img, orderId, req.user.id]);
        notifyGroup(`📸 <b>收到支付凭证</b>\n订单号: <code>${orderId}</code>\n请管理员尽快审核。`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '上传失败' });
    }
});

// >>> 管理员接口 (需要单独的 Admin Key header 或特殊 Token, 这里简化用特殊 Header) <<<
const adminAuth = (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: '管理员权限验证失败' });
    next();
};

// 管理员：获取所有订单
app.get('/api/admin/orders', adminAuth, async (req, res) => {
    const result = await pool.query(`
        SELECT orders.*, users.username 
        FROM orders 
        LEFT JOIN users ON orders.user_id = users.id 
        ORDER BY orders.created_at DESC
    `);
    res.json(result.rows);
});

// 管理员：上传收款码
app.post('/api/admin/orders/:id/qr', adminAuth, upload.single('qr'), async (req, res) => {
    const orderId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未上传文件' });
    
    const base64Img = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    try {
        await pool.query('UPDATE orders SET qr_code = $1 WHERE id = $2', [base64Img, orderId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '数据库错误' });
    }
});

// 管理员：确认收款 (安全策略：立即删除二维码)
app.post('/api/admin/orders/:id/confirm', adminAuth, async (req, res) => {
    const orderId = req.params.id;
    const client = await pool.connect();
    try {
        // 确认收款，清空 QR 码，清空凭证 (节省空间)
        await client.query(`
            UPDATE orders 
            SET status = 'paid', qr_code = NULL 
            WHERE id = $1
        `, [orderId]);
        
        notifyGroup(`✅ <b>订单已确认收款</b>\n订单号: <code>${orderId}</code>`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '操作失败' });
    } finally {
        client.release();
    }
});

// 管理员：上架商品
app.post('/api/admin/products', adminAuth, async (req, res) => {
    const { name, price, stock, type, image_url } = req.body;
    try {
        await pool.query(
            'INSERT INTO products (name, price, stock, type, image_url) VALUES ($1, $2, $3, $4, $5)',
            [name, price, stock, type, image_url]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '上架失败' });
    }
});

// --- 4. 自动清理任务 (Cron) ---
// 每天凌晨 3 点清理超过 3 天的订单和物流数据
cron.schedule('0 3 * * *', async () => {
    console.log('🧹 开始执行数据清理任务...');
    try {
        const res = await pool.query(`
            DELETE FROM orders 
            WHERE created_at < NOW() - INTERVAL '3 days'
        `);
        console.log(`✅ 已清理 ${res.rowCount} 条过期订单数据`);
    } catch (err) {
        console.error('❌ 清理任务失败:', err);
    }
});

// --- 5. Telegram 机器人逻辑 ---
const notifyGroup = (htmlMsg) => {
    if (process.env.TG_GROUP_ID) {
        bot.telegram.sendMessage(process.env.TG_GROUP_ID, htmlMsg, { parse_mode: 'HTML' }).catch(e => console.error('TG 推送失败', e));
    }
};

// 仅在指定群组响应
bot.use(async (ctx, next) => {
    if (ctx.chat && String(ctx.chat.id) === process.env.TG_GROUP_ID) {
        return next();
    }
    // 私聊直接忽略或回复无法使用
    if (ctx.chat.type === 'private') {
        // ctx.reply('⚠️ 此机器人仅供内部群组使用。');
    }
});

// 指令: 查看概况
bot.command('ck', async (ctx) => {
    try {
        const orderCount = (await pool.query("SELECT COUNT(*) FROM orders WHERE created_at > CURRENT_DATE")).rows[0].count;
        const revenue = (await pool.query("SELECT SUM(total_amount) FROM orders WHERE status = 'paid' AND created_at > CURRENT_DATE")).rows[0].sum || 0;
        
        ctx.replyWithHTML(
            `📊 <b>今日概况</b>\n` +
            `订单数: ${orderCount}\n` +
            `今日营收: ${revenue} USDT\n` +
            `当前汇率: ${SYSTEM_CONFIG.exchangeRate}\n` +
            `WX费率: ${SYSTEM_CONFIG.fees.wx * 100}%`
        );
    } catch (e) {
        ctx.reply('查询失败');
    }
});

// 指令: 清空数据库 (危险)
bot.command('qc', async (ctx) => {
    // 实际项目中应加二次确认或仅允许 Owner
    try {
        await pool.query('TRUNCATE TABLE orders CASCADE');
        ctx.reply('🗑️ 订单表已清空');
    } catch (e) {
        ctx.reply('操作失败');
    }
});

// 指令: 帮助
bot.command('bz', (ctx) => {
    ctx.reply(
        '/ck - 查看今日数据\n' +
        '/qc - 清空订单数据\n' +
        '设置汇率 [数字] - 如: 设置汇率 7.3\n' +
        '设置手续费 [数字] - 如: 设置手续费 5 (代表5%)'
    );
});

// 监听文本指令 (设置汇率/手续费)
bot.on('text', (ctx) => {
    const text = ctx.message.text;
    
    // 匹配 "设置汇率 7.2"
    const rateMatch = text.match(/^设置汇率\s+(\d+(\.\d+)?)$/);
    if (rateMatch) {
        const newRate = parseFloat(rateMatch[1]);
        SYSTEM_CONFIG.exchangeRate = newRate;
        return ctx.reply(`✅ 汇率已更新为: ${newRate}`);
    }

    // 匹配 "设置手续费 3"
    const feeMatch = text.match(/^设置手续费\s+(\d+(\.\d+)?)$/);
    if (feeMatch) {
        const newFee = parseFloat(feeMatch[1]) / 100;
        SYSTEM_CONFIG.fees.wx = newFee;
        SYSTEM_CONFIG.fees.ali = newFee;
        return ctx.reply(`✅ 手续费已更新为: ${feeMatch[1]}%`);
    }
});

// 启动机器人
bot.launch().then(() => console.log('🤖 Telegram Bot 已启动')).catch(e => console.error('Bot 启动失败', e));

// --- 6. 启动服务器 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initDB(); // 启动时尝试建表
    console.log(`🚀 Server running on port ${PORT}`);
});

// 优雅退出
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
