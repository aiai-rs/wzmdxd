require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// --- 优化：增加内存缓存 ---
let cache = {
    publicData: null,
    cacheTime: 0,
    announcements: {}
};

// --- Security: Rate Limiting ---
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- Static Files ---
if (!fs.existsSync('uploads')) { 
    fs.mkdirSync('uploads', { recursive: true });
    fs.mkdirSync('uploads/thumbs', { recursive: true });
}
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Security: File Upload Filter - 优化上传速度 ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { 
        cb(null, 'uploads/') 
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('只允许上传图片文件 (jpeg, jpg, png, gif, webp)'));
    }
};

const upload = multer({ 
    storage: storage, 
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
    }
});

// --- 图片压缩函数 ---
async function compressImage(filePath) {
    try {
        const compressedPath = path.join('uploads/thumbs', path.basename(filePath));
        await sharp(filePath)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(compressedPath);
        return compressedPath;
    } catch (error) {
        console.error('图片压缩失败:', error);
        return filePath;
    }
}

// --- Environment Variables ---
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const TRON_WALLET_ADDRESS = process.env.TRON_WALLET_ADDRESS;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456';
let ADMIN_TOKEN_STORE = null;

if (!DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
const ALLOWED_GROUP_ID = TG_CHAT_ID;

// --- Middleware: Admin Auth ---
const authAdmin = (req, res, next) => {
    const token = req.headers['authorization'];
    if (token && token === ADMIN_TOKEN_STORE) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// --- TG Bot Logic ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';
    if (msg.chat.type === 'private') return;
    if (chatId !== ALLOWED_GROUP_ID) {
        bot.sendMessage(chatId, "⚠️ 未授权群组，再见！").then(() => bot.leaveChat(chatId));
        return;
    }
    if (text.startsWith('设置汇率 ')) {
        const rate = parseFloat(text.split(' ')[1]);
        if (!isNaN(rate) && rate > 0) {
            await pool.query("INSERT INTO settings (key, value) VALUES ('exchange_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [rate.toString()]);
            cache.publicData = null; // 清除缓存
            bot.sendMessage(chatId, `✅ 汇率已更新为: 1 USDT = ${rate} CNY`);
        }
    }
    if (text.startsWith('设置手续费 ')) {
        const fee = parseFloat(text.split(' ')[1]);
        if (!isNaN(fee) && fee >= 0) {
            await pool.query("INSERT INTO settings (key, value) VALUES ('fee_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [fee.toString()]);
            cache.publicData = null; // 清除缓存
            bot.sendMessage(chatId, `✅ 支付手续费已更新为: ${fee}%`);
        }
    }
    if (text === '/sc') {
        try { await pool.query("DELETE FROM orders"); bot.sendMessage(chatId, "🗑️ 所有订单及物流信息已清除。"); } catch (e) { bot.sendMessage(chatId, "❌ " + e.message); }
    }
    if (text === '/qc') {
        try { await pool.query("TRUNCATE products, orders, messages, users RESTART IDENTITY"); bot.sendMessage(chatId, "💥 数据库已完全清空。"); } catch (e) { bot.sendMessage(chatId, "❌ " + e.message); }
    }
    if (text === '/bz') {
        bot.sendMessage(chatId, "Set Rate: 汇率\nSet Fee: 手续费\n/sc: 删订单\n/qc: 清库");
    }
});

// --- DB Init ---
async function initDB() {
    try {
        const client = await pool.connect();
        await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, contact TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC DEFAULT 0`);
        // 新增：用户显示名
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`);

        await client.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT, price TEXT, stock INTEGER, category TEXT, description TEXT, type TEXT DEFAULT 'virtual', image_url TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_id TEXT UNIQUE, product_name TEXT, contact TEXT, payment_method TEXT, status TEXT DEFAULT '待支付', user_id INTEGER, usdt_amount NUMERIC, cny_amount NUMERIC, snapshot_rate NUMERIC, shipping_info TEXT, expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_amount NUMERIC DEFAULT 0`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS qrcode_url TEXT`);
        // 新增：订单通知状态
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_qrcode BOOLEAN DEFAULT FALSE`);

        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, session_id TEXT, sender TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        // 新增：消息已读状态
        await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE`);
        await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

        // 新增：充值订单表
        await client.query(`CREATE TABLE IF NOT EXISTS recharge_orders (
            id SERIAL PRIMARY KEY,
            order_id TEXT UNIQUE,
            user_id INTEGER,
            amount NUMERIC,
            payment_method TEXT,
            status TEXT DEFAULT '待支付',
            qrcode_url TEXT,
            notified_qrcode BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP
        )`);

        // 新增：提现订单表
        await client.query(`CREATE TABLE IF NOT EXISTS withdraw_orders (
            id SERIAL PRIMARY KEY,
            order_id TEXT UNIQUE,
            user_id INTEGER,
            amount NUMERIC,
            fee NUMERIC,
            actual_amount NUMERIC,
            payment_method TEXT,
            status TEXT DEFAULT '待处理',
            created_at TIMESTAMP DEFAULT NOW()
        )`);

        const checkFee = await client.query("SELECT * FROM settings WHERE key = 'fee_rate'");
        if (checkFee.rowCount === 0) await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['fee_rate', '0']);

        console.log("Database Schema Updated");
        client.release();
    } catch (err) { console.error("DB Init Error:", err); }
}
initDB();

// --- USDT Check ---
async function checkUsdtDeposits() {
    if (!TRON_WALLET_ADDRESS) return;
    try {
        const pending = await pool.query("SELECT * FROM orders WHERE status = '待支付' AND payment_method = 'USDT' AND expires_at > NOW()");
        if (pending.rows.length === 0) return;
        const url = `https://api.trongrid.io/v1/accounts/${TRON_WALLET_ADDRESS}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
        const res = await axios.get(url);
        const txs = res.data.data;

        for (const order of pending.rows) {
            const expectedAmount = parseFloat(order.usdt_amount);
            const match = txs.find(tx => {
                const txAmount = parseFloat(tx.value) / 1000000;
                const txTime = tx.block_timestamp;
                const orderTime = new Date(order.created_at).getTime();
                return Math.abs(txAmount - expectedAmount) < 0.000001 && txTime >= orderTime;
            });

            if (match) {
                await pool.query("UPDATE orders SET status = '已支付' WHERE id = $1", [order.id]);
                
                // 计算找零并存入用户余额
                const exactPrice = parseFloat(order.usdt_amount) - (order.fee_amount || 0);
                const overpaid = parseFloat(match.value) / 1000000 - exactPrice;
                if (overpaid > 0.000001) {
                    await pool.query(
                        "UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2",
                        [overpaid.toFixed(4), order.user_id]
                    );
                }
                
                sendTG(`✅ **USDT 到账成功**\n订单编码: \`${order.order_id}\`\n金额: ${expectedAmount} USDT\n客户已自动发货`);
            }
        }
    } catch (e) { console.error("USDT Check Error:", e.message); }
}
setInterval(checkUsdtDeposits, 30000);

function sendTG(text) {
    if (bot && TG_CHAT_ID) bot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown' }).catch(e => console.log(e.message));
}

// --- APIs ---

// 1. Admin Auth
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if(username === ADMIN_USER && password === ADMIN_PASS) {
        ADMIN_TOKEN_STORE = 'adm_' + Math.random().toString(36).substr(2) + Date.now();
        res.json({ success: true, token: ADMIN_TOKEN_STORE });
    } else {
        res.json({ success: false, msg: 'Invalid Credentials' });
    }
});

// 2. File Upload (Protected) - 优化上传速度
app.post('/api/upload', authAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or invalid type' });
    
    try {
        // 压缩图片
        const compressedPath = await compressImage(req.file.path);
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${path.basename(compressedPath)}`;
        
        res.json({ 
            success: true, 
            url: fileUrl,
            thumbUrl: fileUrl.replace('uploads/', 'uploads/thumbs/')
        });
    } catch (error) {
        console.error('上传失败:', error);
        res.status(500).json({ error: '文件上传失败' });
    }
});

// 3. Public Data (Sort by pinned) - 增加缓存
app.get('/api/public/data', async (req, res) => {
    // 使用缓存，5秒内重复请求返回缓存数据
    const now = Date.now();
    if (cache.publicData && (now - cache.cacheTime) < 5000) {
        return res.json(cache.publicData);
    }
    
    try {
        const p = await pool.query('SELECT * FROM products ORDER BY is_pinned DESC, id DESC');
        const c = await pool.query('SELECT DISTINCT category FROM products');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const rate = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const fee = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const popup = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        const result = {
            products: p.rows,
            categories: c.rows.map(r => r.category),
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '[]'),
            rate: parseFloat(rate.rows[0]?.value || '7.0'),
            feeRate: parseFloat(fee.rows[0]?.value || '0'),
            showPopup: popup.rows[0]?.value === 'true'
        };
        
        // 缓存结果
        cache.publicData = result;
        cache.cacheTime = now;
        
        res.json(result);
    } catch (e) { 
        console.error('获取公开数据错误:', e);
        res.status(500).json({error: e.message}); 
    }
});

// 4. User Auth (Hashed) - 添加密码确认和显示名
app.post('/api/user/register', async (req, res) => {
    const { contact, password, confirmPassword, displayName } = req.body;
    
    if (!contact || !password || !confirmPassword) {
        return res.status(400).json({ success: false, msg: '请填写所有必填项' });
    }
    
    if (password !== confirmPassword) {
        return res.json({ success: false, msg: '两次密码不一致' });
    }
    
    if (password.length < 6) {
        return res.json({ success: false, msg: '密码长度至少6位' });
    }
    
    try {
        // 检查用户是否已存在
        const existingUser = await pool.query("SELECT * FROM users WHERE contact = $1", [contact]);
        if (existingUser.rows.length > 0) {
            return res.json({ success: false, msg: '该账号已存在' });
        }
        
        // 创建新用户
        const hash = await bcrypt.hash(password, 10);
        const ins = await pool.query(
            "INSERT INTO users (username, contact, password, display_name, created_at) VALUES ($1, $1, $2, $3, NOW()) RETURNING id, contact, display_name",
            [contact, hash, displayName || contact]
        );
        
        res.json({ 
            success: true, 
            userId: ins.rows[0].id,
            contact: ins.rows[0].contact,
            displayName: ins.rows[0].display_name
        });
    } catch(e) { 
        console.error('注册错误:', e);
        res.status(500).json({success: false, msg: '注册失败'}); 
    }
});

app.post('/api/user/login', async (req, res) => {
    const { contact, password } = req.body;
    if(!contact || !password) return res.status(400).json({success: false, msg: "需要账号和密码"});
    
    try {
        let user = await pool.query("SELECT * FROM users WHERE contact = $1", [contact]);
        if (user.rows.length === 0) {
            return res.json({ success: false, msg: "账号不存在" });
        } else {
            const match = await bcrypt.compare(password, user.rows[0].password);
            if (!match) return res.json({ success: false, msg: "密码错误" });
            res.json({ 
                success: true, 
                userId: user.rows[0].id,
                contact: user.rows[0].contact,
                displayName: user.rows[0].display_name || user.rows[0].contact
            });
        }
    } catch(e) { 
        console.error('登录错误:', e);
        res.status(500).json({success: false, msg: "登录失败"}); 
    }
});

// 5. 获取用户信息
app.get('/api/user/info/:userId', async (req, res) => {
    try {
        const user = await pool.query('SELECT id, contact, display_name, balance, created_at FROM users WHERE id = $1', [req.params.userId]);
        if (user.rows.length === 0) return res.json({ success: false, msg: '用户不存在' });
        
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        const balance = parseFloat(user.rows[0].balance || 0);
        const cnyBalance = (balance * rate).toFixed(2);
        
        res.json({ 
            success: true, 
            user: user.rows[0],
            balance: balance.toFixed(4), 
            cnyBalance 
        });
    } catch (e) { 
        console.error('获取用户信息错误:', e);
        res.status(500).json({success: false, msg: '获取用户信息失败'}); 
    }
});

// 6. 修改密码
app.post('/api/user/change_password', async (req, res) => {
    const { userId, oldPassword, newPassword, confirmPassword } = req.body;
    
    if (!userId || !oldPassword || !newPassword || !confirmPassword) {
        return res.json({ success: false, msg: '请填写所有必填项' });
    }
    
    if (newPassword !== confirmPassword) {
        return res.json({ success: false, msg: '两次新密码不一致' });
    }
    
    if (newPassword.length < 6) {
        return res.json({ success: false, msg: '新密码长度至少6位' });
    }
    
    try {
        // 验证旧密码
        const user = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        if (user.rows.length === 0) {
            return res.json({ success: false, msg: '用户不存在' });
        }
        
        const match = await bcrypt.compare(oldPassword, user.rows[0].password);
        if (!match) {
            return res.json({ success: false, msg: '原密码错误' });
        }
        
        // 更新密码
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, userId]);
        
        res.json({ success: true, msg: '密码修改成功' });
    } catch (e) {
        console.error('修改密码错误:', e);
        res.status(500).json({ success: false, msg: '修改密码失败' });
    }
});

// 7. 充值
app.post('/api/user/recharge', async (req, res) => {
    const { userId, amount, paymentMethod } = req.body;
    try {
        const orderId = 'RECH-' + Date.now().toString().slice(-8);
        
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        const feeRes = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const feePercent = parseFloat(feeRes.rows[0]?.value || '0');
        
        let usdtAmount = parseFloat(amount);
        let cnyAmount = usdtAmount * rate;
        let feeAmount = 0;
        
        if (paymentMethod !== 'USDT') {
            feeAmount = cnyAmount * (feePercent / 100);
            cnyAmount = cnyAmount + feeAmount;
        } else {
            // USDT充值增加随机小数
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000;
            usdtAmount = parseFloat((parseFloat(amount) + randomDecimal).toFixed(4));
        }
        
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        
        await pool.query(
            `INSERT INTO recharge_orders (order_id, user_id, amount, payment_method, expires_at) VALUES ($1, $2, $3, $4, $5)`,
            [orderId, userId, usdtAmount, paymentMethod, expiresAt]
        );
        
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';
        
        let notif = `💰 **充值订单**\n订单编码: \`${orderId}\`\n用户: ${contactStr}\n支付: ${paymentMethod}`;
        if (paymentMethod === 'USDT') {
            notif += `\n需付: \`${usdtAmount}\` USDT\n钱包: ${TRON_WALLET_ADDRESS}`;
        } else {
            notif += `\n需付: ¥${cnyAmount.toFixed(2)} (含手续费${feePercent}%)`;
        }
        
        sendTG(notif);
        
        res.json({ 
            success: true, 
            orderId, 
            usdtAmount, 
            cnyAmount: cnyAmount.toFixed(2), 
            wallet: TRON_WALLET_ADDRESS 
        });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 8. 获取充值记录
app.get('/api/user/recharge/:userId', async (req, res) => {
    try {
        const records = await pool.query(
            'SELECT * FROM recharge_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
            [req.params.userId]
        );
        res.json({ success: true, records: records.rows });
    } catch (e) {
        console.error('获取充值记录错误:', e);
        res.status(500).json({ success: false, msg: '获取充值记录失败' });
    }
});

// 9. 获取提现记录
app.get('/api/user/withdraw/:userId', async (req, res) => {
    try {
        const records = await pool.query(
            'SELECT * FROM withdraw_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
            [req.params.userId]
        );
        res.json({ success: true, records: records.rows });
    } catch (e) {
        console.error('获取提现记录错误:', e);
        res.status(500).json({ success: false, msg: '获取提现记录失败' });
    }
});

// 10. 提现
app.post('/api/user/withdraw', async (req, res) => {
    const { userId, amount, paymentMethod } = req.body;
    try {
        const user = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
        if (user.rows.length === 0) return res.json({ success: false, msg: '用户不存在' });
        
        const balance = parseFloat(user.rows[0].balance || 0);
        const withdrawAmount = parseFloat(amount);
        
        // 检查最低提现金额
        if (withdrawAmount < 10) {
            return res.json({ success: false, msg: '最低提现金额为10 USDT' });
        }
        
        if (balance < withdrawAmount) {
            return res.json({ success: false, msg: '余额不足' });
        }
        
        let fee = 0;
        let actualAmount = withdrawAmount;
        
        if (paymentMethod === '微信' || paymentMethod === '支付宝') {
            fee = withdrawAmount * 0.01; // 1%手续费
            actualAmount = withdrawAmount - fee;
        }
        
        const orderId = 'WITH-' + Date.now().toString().slice(-8);
        
        await pool.query(
            `INSERT INTO withdraw_orders (order_id, user_id, amount, fee, actual_amount, payment_method) VALUES ($1, $2, $3, $4, $5, $6)`,
            [orderId, userId, withdrawAmount, fee, actualAmount, paymentMethod]
        );
        
        // 冻结余额
        await pool.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2',
            [withdrawAmount, userId]
        );
        
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';
        
        let notif = `💰 **提现申请**\n订单编码: \`${orderId}\`\n用户: ${contactStr}\n提现: ${withdrawAmount} USDT\n方式: ${paymentMethod}`;
        if (fee > 0) {
            notif += `\n手续费: ${fee.toFixed(4)} USDT\n实际到账: ${actualAmount.toFixed(4)} USDT`;
        }
        
        sendTG(notif);
        
        res.json({ 
            success: true, 
            orderId, 
            amount: withdrawAmount,
            fee,
            actualAmount 
        });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 11. Order Logic (单个商品)
app.post('/api/order', async (req, res) => {
    const { userId, productId, paymentMethod, shippingInfo, quantity = 1, useBalance = 0 } = req.body;
    try {
        const prod = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (prod.rows.length === 0) return res.json({ success: false, msg: '商品不存在' });

        const pData = prod.rows[0];
        const basePrice = parseFloat(pData.price.replace(/[^\d.]/g, '')) * quantity;
        const orderId = 'ORD-' + Date.now().toString().slice(-6);
        
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        const feeRes = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const feePercent = parseFloat(feeRes.rows[0]?.value || '0');

        let usdtAmount = basePrice;
        let cnyAmount = basePrice * rate;
        let feeAmount = 0;
        let expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        if (paymentMethod !== 'USDT') {
            feeAmount = cnyAmount * (feePercent / 100);
            cnyAmount = cnyAmount + feeAmount;
        }

        if (paymentMethod === 'USDT') {
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000;
            usdtAmount = parseFloat((basePrice + randomDecimal).toFixed(4));
            
            // 使用余额抵扣
            const useBalanceAmount = parseFloat(useBalance || 0);
            if (useBalanceAmount > 0) {
                const user = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
                const userBalance = parseFloat(user.rows[0]?.balance || 0);
                
                if (useBalanceAmount > userBalance) {
                    return res.json({ success: false, msg: '余额不足' });
                }
                
                if (useBalanceAmount >= usdtAmount) {
                    return res.json({ success: false, msg: '余额支付不能超过订单金额' });
                }
                
                // 扣除余额
                await pool.query(
                    'UPDATE users SET balance = balance - $1 WHERE id = $2',
                    [useBalanceAmount, userId]
                );
                
                usdtAmount = parseFloat((usdtAmount - useBalanceAmount).toFixed(4));
            }
        }

        await pool.query(
            `INSERT INTO orders 
            (order_id, product_name, contact, payment_method, status, user_id, usdt_amount, cny_amount, snapshot_rate, shipping_info, expires_at, fee_amount, quantity) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, 
            [orderId, pData.name, 'RegUser', paymentMethod, '待支付', userId, usdtAmount, cnyAmount.toFixed(2), rate, JSON.stringify(shippingInfo || {}), expiresAt, feeAmount.toFixed(2), quantity]
        );

        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';

        let notif = `💰 **新订单**\n订单编码: \`${orderId}\`\n商品: ${pData.name}\n数量: ${quantity}\n用户: ${contactStr}\n支付: ${paymentMethod}`;
        if (paymentMethod === 'USDT') notif += `\n需付: \`${usdtAmount}\` USDT`;
        else notif += `\n需付: ¥${cnyAmount.toFixed(2)} (含手续费${feePercent}%)`;

        if (pData.type === 'physical') {
            notif += `\n\n📦 **发货信息**\n收件人: ${shippingInfo.name}\n电话: ${shippingInfo.tel}\n地址: ${shippingInfo.addr}`;
        }

        sendTG(notif);
        res.json({ success: true, orderId, usdtAmount, cnyAmount: cnyAmount.toFixed(2), wallet: TRON_WALLET_ADDRESS });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 12. 批量订单（购物车）
app.post('/api/order/batch', async (req, res) => {
    const { userId, items, paymentMethod, shippingInfo, useBalance = 0 } = req.body;
    try {
        if (!items || items.length === 0) return res.json({ success: false, msg: '商品列表为空' });
        
        const orderId = 'BATCH-' + Date.now().toString().slice(-6);
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        const feeRes = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const feePercent = parseFloat(feeRes.rows[0]?.value || '0');
        
        let totalUsdt = 0;
        let productNames = [];
        
        // 计算总价和检查库存
        for (const item of items) {
            const prod = await pool.query('SELECT * FROM products WHERE id = $1', [item.productId]);
            if (prod.rows.length === 0) {
                return res.json({ success: false, msg: `商品ID ${item.productId} 不存在` });
            }
            
            const pData = prod.rows[0];
            const itemPrice = parseFloat(pData.price.replace(/[^\d.]/g, '')) * item.quantity;
            totalUsdt += itemPrice;
            productNames.push(`${pData.name} x${item.quantity}`);
        }
        
        let usdtAmount = totalUsdt;
        let cnyAmount = totalUsdt * rate;
        let feeAmount = 0;
        let expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        
        if (paymentMethod !== 'USDT') {
            feeAmount = cnyAmount * (feePercent / 100);
            cnyAmount = cnyAmount + feeAmount;
        }
        
        if (paymentMethod === 'USDT') {
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000;
            usdtAmount = parseFloat((totalUsdt + randomDecimal).toFixed(4));
            
            // 使用余额抵扣
            const useBalanceAmount = parseFloat(useBalance || 0);
            if (useBalanceAmount > 0) {
                const user = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
                const userBalance = parseFloat(user.rows[0]?.balance || 0);
                
                if (useBalanceAmount > userBalance) {
                    return res.json({ success: false, msg: '余额不足' });
                }
                
                if (useBalanceAmount >= usdtAmount) {
                    return res.json({ success: false, msg: '余额支付不能超过订单金额' });
                }
                
                // 扣除余额
                await pool.query(
                    'UPDATE users SET balance = balance - $1 WHERE id = $2',
                    [useBalanceAmount, userId]
                );
                
                usdtAmount = parseFloat((usdtAmount - useBalanceAmount).toFixed(4));
            }
        }
        
        // 创建主订单记录
        await pool.query(
            `INSERT INTO orders 
            (order_id, product_name, contact, payment_method, status, user_id, usdt_amount, cny_amount, snapshot_rate, shipping_info, expires_at, fee_amount, quantity) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, 
            [orderId, productNames.join(' + '), 'RegUser', paymentMethod, '待支付', userId, usdtAmount, cnyAmount.toFixed(2), rate, JSON.stringify(shippingInfo || {}), expiresAt, feeAmount.toFixed(2), items.reduce((sum, item) => sum + item.quantity, 0)]
        );
        
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';
        
        let notif = `💰 **批量订单**\n订单编码: \`${orderId}\`\n商品: ${productNames.join(', ')}\n用户: ${contactStr}\n支付: ${paymentMethod}`;
        if (paymentMethod === 'USDT') notif += `\n需付: \`${usdtAmount}\` USDT`;
        else notif += `\n需付: ¥${cnyAmount.toFixed(2)} (含手续费${feePercent}%)`;
        
        if (shippingInfo && shippingInfo.name) {
            notif += `\n\n📦 **发货信息**\n收件人: ${shippingInfo.name}\n电话: ${shippingInfo.tel}\n地址: ${shippingInfo.addr}`;
        }
        
        sendTG(notif);
        res.json({ success: true, orderId, usdtAmount, cnyAmount: cnyAmount.toFixed(2), wallet: TRON_WALLET_ADDRESS });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 13. 修改支付方式
app.post('/api/order/change_payment', async (req, res) => {
    const { orderId, userId, newPaymentMethod } = req.body;
    try {
        const order = await pool.query(
            "SELECT * FROM orders WHERE order_id = $1 AND user_id = $2 AND status = '待支付'",
            [orderId, userId]
        );
        
        if (order.rows.length === 0) {
            return res.json({ success: false, msg: '订单不存在或无法修改' });
        }
        
        const oldOrder = order.rows[0];
        const baseUsdt = oldOrder.usdt_amount - oldOrder.fee_amount;
        
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        const feeRes = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const feePercent = parseFloat(feeRes.rows[0]?.value || '0');
        
        let usdtAmount = baseUsdt;
        let cnyAmount = baseUsdt * rate;
        let feeAmount = 0;
        
        if (newPaymentMethod !== 'USDT') {
            feeAmount = cnyAmount * (feePercent / 100);
            cnyAmount = cnyAmount + feeAmount;
        } else {
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000;
            usdtAmount = parseFloat((baseUsdt + randomDecimal).toFixed(4));
        }
        
        await pool.query(
            "UPDATE orders SET payment_method = $1, usdt_amount = $2, cny_amount = $3, fee_amount = $4, expires_at = $5 WHERE order_id = $6",
            [newPaymentMethod, usdtAmount, cnyAmount.toFixed(2), feeAmount, new Date(Date.now() + 30 * 60 * 1000), orderId]
        );
        
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';
        
        let notif = `🔄 **支付方式修改**\n订单编码: \`${orderId}\`\n用户: ${contactStr}\n新支付方式: ${newPaymentMethod}`;
        if (newPaymentMethod === 'USDT') {
            notif += `\n需付: \`${usdtAmount}\` USDT`;
        } else {
            notif += `\n需付: ¥${cnyAmount.toFixed(2)} (含手续费${feePercent}%)`;
        }
        
        sendTG(notif);
        res.json({ success: true, orderId, usdtAmount, cnyAmount: cnyAmount.toFixed(2) });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 14. 用户确认支付
app.post('/api/order/confirm_payment', async (req, res) => {
    const { orderId, userId } = req.body;
    try {
        const order = await pool.query(
            "SELECT * FROM orders WHERE order_id = $1 AND user_id = $2 AND status = '待支付'",
            [orderId, userId]
        );
        
        if (order.rows.length === 0) {
            return res.json({ success: false, msg: '订单不存在' });
        }
        
        await pool.query(
            "UPDATE orders SET status = '已支付' WHERE order_id = $1",
            [orderId]
        );
        
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';
        
        sendTG(`✅ **用户确认支付**\n订单编码: \`${orderId}\`\n用户: ${contactStr}\n用户已确认完成支付`);
        
        res.json({ success: true });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 15. 用户报告二维码问题
app.post('/api/order/report_qrcode', async (req, res) => {
    const { orderId, userId, reason } = req.body;
    try {
        const order = await pool.query(
            "SELECT * FROM orders WHERE order_id = $1 AND user_id = $2",
            [orderId, userId]
        );
        
        if (order.rows.length === 0) {
            return res.json({ success: false, msg: '订单不存在' });
        }
        
        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';
        
        sendTG(`⚠️ **二维码问题报告**\n订单编码: \`${orderId}\`\n用户: ${contactStr}\n问题: ${reason || '未说明原因'}`);
        
        res.json({ success: true });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// 16. 获取订单详情（包含二维码状态）
app.get('/api/order/detail/:orderId', async (req, res) => {
    try {
        const order = await pool.query('SELECT * FROM orders WHERE order_id = $1', [req.params.orderId]);
        if (order.rows.length === 0) {
            return res.json({ success: false, msg: '订单不存在' });
        }
        res.json({ success: true, order: order.rows[0] });
    } catch (e) {
        console.error('获取订单详情错误:', e);
        res.status(500).json({ success: false, msg: '获取订单详情失败' });
    }
});

// 17. 检查新消息（用于红点通知）
app.get('/api/chat/unread/:sessionId', async (req, res) => {
    try {
        const unread = await pool.query(
            "SELECT COUNT(*) as count FROM messages WHERE session_id = $1 AND sender = 'admin' AND is_read = false",
            [req.params.sessionId]
        );
        res.json({ success: true, count: parseInt(unread.rows[0].count) });
    } catch (e) {
        console.error('检查未读消息错误:', e);
        res.status(500).json({ success: false, msg: '检查未读消息失败' });
    }
});

// 18. 标记消息为已读
app.post('/api/chat/mark_read/:sessionId', async (req, res) => {
    try {
        await pool.query(
            "UPDATE messages SET is_read = true WHERE session_id = $1 AND sender = 'admin'",
            [req.params.sessionId]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('标记消息已读错误:', e);
        res.status(500).json({ success: false, msg: '标记消息已读失败' });
    }
});

// Cancel Order
app.post('/api/order/cancel', async (req, res) => {
    const { orderId, userId } = req.body;
    try {
        const check = await pool.query("SELECT * FROM orders WHERE order_id = $1 AND user_id = $2", [orderId, userId]);
        if(check.rows.length === 0) return res.json({success:false, msg:'订单不存在'});
        if(check.rows[0].status !== '待支付') return res.json({success:false, msg:'无法取消'});
        
        await pool.query("UPDATE orders SET status = '已取消' WHERE order_id = $1", [orderId]);
        res.json({success: true});
    } catch(e) { 
        console.error(e);
        res.status(500).json({success:false, msg: e.message}); 
    }
});

// Admin Operations (Protected)

// 上传支付二维码 - 优化通知
app.post('/api/admin/order/upload_qrcode', authAdmin, upload.single('qrcode'), async (req, res) => {
    try {
        const { orderId, orderType = 'order' } = req.body;
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: '没有上传文件' });
        }
        
        // 压缩图片
        const compressedPath = await compressImage(req.file.path);
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${path.basename(compressedPath)}`;
        
        let tableName = 'orders';
        if (orderType === 'recharge') {
            tableName = 'recharge_orders';
        }
        
        await pool.query(
            `UPDATE ${tableName} SET qrcode_url = $1, notified_qrcode = false WHERE order_id = $2`,
            [fileUrl, orderId]
        );
        
        // 获取用户信息发送通知
        if (orderType === 'order') {
            const order = await pool.query(
                "SELECT o.*, u.contact FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.order_id = $1",
                [orderId]
            );
            if (order.rows.length > 0) {
                const contact = order.rows[0].contact || '用户';
                sendTG(`📱 **二维码已上传**\n订单编码: \`${orderId}\`\n用户: ${contact}\n用户可扫码支付`);
            }
        } else if (orderType === 'recharge') {
            const recharge = await pool.query(
                "SELECT r.*, u.contact FROM recharge_orders r LEFT JOIN users u ON r.user_id = u.id WHERE r.order_id = $1",
                [orderId]
            );
            if (recharge.rows.length > 0) {
                const contact = recharge.rows[0].contact || '用户';
                sendTG(`📱 **充值二维码已上传**\n订单编码: \`${orderId}\`\n用户: ${contact}\n用户可扫码支付`);
            }
        }
        
        res.json({ success: true, qrcodeUrl: fileUrl });
    } catch (e) { 
        console.error("上传二维码错误:", e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// 检查需要通知的二维码
app.get('/api/order/check_qrcode/:orderId', async (req, res) => {
    try {
        const order = await pool.query(
            "SELECT qrcode_url, notified_qrcode FROM orders WHERE order_id = $1",
            [req.params.orderId]
        );
        
        if (order.rows.length === 0) {
            return res.json({ success: false, msg: '订单不存在' });
        }
        
        const hasQrcode = !!order.rows[0].qrcode_url;
        const notified = order.rows[0].notified_qrcode;
        
        // 如果二维码存在且未通知过，标记为已通知
        if (hasQrcode && !notified) {
            await pool.query(
                "UPDATE orders SET notified_qrcode = true WHERE order_id = $1",
                [req.params.orderId]
            );
        }
        
        res.json({ 
            success: true, 
            hasQrcode, 
            qrcodeUrl: order.rows[0].qrcode_url,
            needsNotification: hasQrcode && !notified
        });
    } catch (e) {
        console.error('检查二维码错误:', e);
        res.status(500).json({ success: false, msg: '检查二维码失败' });
    }
});

// 检查充值订单二维码
app.get('/api/recharge/check_qrcode/:orderId', async (req, res) => {
    try {
        const recharge = await pool.query(
            "SELECT qrcode_url, notified_qrcode FROM recharge_orders WHERE order_id = $1",
            [req.params.orderId]
        );
        
        if (recharge.rows.length === 0) {
            return res.json({ success: false, msg: '订单不存在' });
        }
        
        const hasQrcode = !!recharge.rows[0].qrcode_url;
        const notified = recharge.rows[0].notified_qrcode;
        
        // 如果二维码存在且未通知过，标记为已通知
        if (hasQrcode && !notified) {
            await pool.query(
                "UPDATE recharge_orders SET notified_qrcode = true WHERE order_id = $1",
                [req.params.orderId]
            );
        }
        
        res.json({ 
            success: true, 
            hasQrcode, 
            qrcodeUrl: recharge.rows[0].qrcode_url,
            needsNotification: hasQrcode && !notified
        });
    } catch (e) {
        console.error('检查充值二维码错误:', e);
        res.status(500).json({ success: false, msg: '检查充值二维码失败' });
    }
});

app.post('/api/admin/order/ship', authAdmin, async (req, res) => {
    const { orderId, trackingNumber } = req.body;
    try {
        await pool.query("UPDATE orders SET tracking_number = $1 WHERE order_id = $2", [trackingNumber, orderId]);
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.post('/api/admin/update/hiring', authAdmin, async (req, res) => {
    try { 
        const val = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        await pool.query("INSERT INTO settings (key, value) VALUES ('hiring', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [val]); 
        cache.publicData = null; // 清除缓存
        res.json({ success: true }); 
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.post('/api/admin/confirm_pay', authAdmin, async (req, res) => {
    const { orderId } = req.body;
    try {
        await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [orderId]);
        res.json({ success: true });
    } catch(e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.post('/api/admin/update/popup', authAdmin, async (req, res) => {
    try {
        await pool.query("INSERT INTO settings (key, value) VALUES ('announcement_popup', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [req.body.open ? 'true':'false']);
        cache.publicData = null; // 清除缓存
        res.json({ success: true });
    } catch(e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.post('/api/admin/update/announcement', authAdmin, async (req, res) => {
    try { 
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'announcement'", [req.body.text]); 
        cache.publicData = null; // 清除缓存
        res.json({ success: true }); 
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// Create Product
app.post('/api/admin/product', authAdmin, async (req, res) => {
    const { name, price, stock, category, desc, type, imageUrl } = req.body;
    try {
        await pool.query('INSERT INTO products (name, price, stock, category, description, type, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [name, price, stock, category, desc, type, imageUrl]);
        cache.publicData = null; // 清除缓存
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// Edit Product
app.put('/api/admin/product/:id', authAdmin, async (req, res) => {
    const { name, price, stock, category, desc, type, imageUrl } = req.body;
    try {
        await pool.query('UPDATE products SET name=$1, price=$2, stock=$3, category=$4, description=$5, type=$6, image_url=$7 WHERE id=$8', 
            [name, price, stock, category, desc, type, imageUrl, req.params.id]);
        cache.publicData = null; // 清除缓存
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// Delete Product
app.delete('/api/admin/product/:id', authAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
        cache.publicData = null; // 清除缓存
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// Pin Product
app.post('/api/admin/product/pin/:id', authAdmin, async (req, res) => {
    try {
        // Toggle pin
        const curr = await pool.query('SELECT is_pinned FROM products WHERE id=$1', [req.params.id]);
        const newVal = !curr.rows[0].is_pinned;
        await pool.query('UPDATE products SET is_pinned=$1 WHERE id=$2', [newVal, req.params.id]);
        cache.publicData = null; // 清除缓存
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// 获取所有用户（管理员）
app.get('/api/admin/users', authAdmin, async (req, res) => {
    try {
        const users = await pool.query(
            'SELECT id, contact, display_name, balance, created_at FROM users ORDER BY created_at DESC'
        );
        res.json({ success: true, users: users.rows });
    } catch (e) {
        console.error('获取用户列表错误:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Chat & Admin Data
app.post('/api/chat/send', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'user', text]);
        sendTG(`💬 **客户消息**\nID: \`${sessionId}\`\n内容: ${text}`);
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.get('/api/chat/history/:sid', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [req.params.sid]);
        res.json(r.rows);
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.post('/api/admin/reply', authAdmin, async (req, res) => {
    const { sessionId, text } = req.body;
    try { 
        await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'admin', text]); 
        res.json({ success: true }); 
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [req.params.id]);
        res.json(r.rows.length > 0 ? r.rows[0] : { status: '未找到' });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// Get User Orders
app.get('/api/order', async (req, res) => {
    try {
        if (req.query.userId) {
            const list = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.query.userId]);
            return res.json(list.rows);
        }
        res.json([]);
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// Admin All Data (Protected)
app.get('/api/admin/all', authAdmin, async (req, res) => {
    try {
        const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const msgs = await pool.query('SELECT * FROM messages ORDER BY created_at ASC');
        const products = await pool.query('SELECT * FROM products ORDER BY is_pinned DESC, id DESC');
        const users = await pool.query('SELECT id, contact, display_name, balance, created_at FROM users ORDER BY created_at DESC');
        
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const r = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const f = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const p = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        let chats = {};
        msgs.rows.forEach(m => {
            if(!chats[m.session_id]) chats[m.session_id] = [];
            chats[m.session_id].push(m);
        });

        res.json({
            orders: orders.rows,
            products: products.rows,
            users: users.rows, // 添加用户列表
            chats: chats,
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '[]'),
            rate: r.rows[0]?.value || '7.0',
            feeRate: f.rows[0]?.value || '0',
            popup: p.rows[0]?.value === 'true'
        });
    } catch (e) { 
        console.error(e);
        res.status(500).json({success: false, error: e.message}); 
    }
});

// 404处理
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'API未找到' });
});

// 错误处理
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({ success: false, error: '服务器内部错误' });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
