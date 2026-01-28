const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg'); // PostgreSQL 客户端

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 🔑 环境变量配置
// ==========================================
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN; 
const TG_ADMIN_GROUP_ID = process.env.TG_ADMIN_GROUP_ID; 
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// 安全检查
if (!TG_BOT_TOKEN || !TG_ADMIN_GROUP_ID || !ADMIN_TOKEN || !DATABASE_URL) {
    console.error("❌ 错误: 环境变量缺失。请检查 TG_BOT_TOKEN, TG_ADMIN_GROUP_ID, ADMIN_TOKEN, DATABASE_URL");
    process.exit(1);
}

// ==========================================
// 🐘 数据库连接 (Neon)
// ==========================================
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 初始化数据库表
const initDB = async () => {
    try {
        const client = await pool.connect();
        
        // 1. 用户表
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                user_id BIGINT,
                product_name TEXT,
                payment_method TEXT,
                usdt_amount NUMERIC(10, 4),
                cny_amount NUMERIC(10, 2),
                status TEXT DEFAULT '待支付',
                shipping_info TEXT,
                tracking_number TEXT,
                qrcode_url TEXT,
                proof TEXT,
                wallet TEXT, 
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id BIGINT,
                amount NUMERIC(10, 4),
                address TEXT,
                status TEXT DEFAULT '处理中',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. 商品表
        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id BIGINT PRIMARY KEY,
                name TEXT NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                stock INT DEFAULT 0,
                category TEXT,
                type TEXT,
                description TEXT,
                image_url TEXT,
                is_pinned BOOLEAN DEFAULT FALSE
            );
        `);

        // 3. 订单表 (包含钱包地址 wallet)
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                user_id BIGINT,
                product_name TEXT,
                payment_method TEXT,
                usdt_amount NUMERIC(10, 4),
                cny_amount NUMERIC(10, 2),
                status TEXT DEFAULT '待支付',
                shipping_info TEXT,
                tracking_number TEXT,
                qrcode_url TEXT,
                proof TEXT,
                wallet TEXT, 
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 4. 招聘表
        await client.query(`
            CREATE TABLE IF NOT EXISTS hiring (
                id SERIAL PRIMARY KEY,
                title TEXT,
                content TEXT,
                contact TEXT
            );
        `);

        // 5. 聊天记录表
        await client.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                sender TEXT,
                content TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                is_initiate BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 6. 系统设置表 (KV存储)
        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);

        // 初始化默认设置
        const defaults = [
            ['rate', '7.0'],
            ['feeRate', '0'],
            ['announcement', '欢迎来到 NEXUS 商城'],
            ['popup', 'true'],
            ['walletAddress', '请联系客服获取地址'] // 默认钱包
        ];

        for (const [k, v] of defaults) {
            await client.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [k, v]);
        }

        console.log("✅ 数据库表结构初始化完成");
        client.release();
    } catch (err) {
        console.error("❌ 数据库初始化失败:", err);
    }
};

initDB();

// 数据库辅助函数
const getSetting = async (key) => {
    const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return res.rows.length > 0 ? res.rows[0].value : null;
};
const setSetting = async (key, value) => {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value.toString()]);
};


// ==========================================
// 🤖 Telegram 机器人逻辑
// ==========================================
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

const sendTgNotify = (text) => {
    bot.sendMessage(TG_ADMIN_GROUP_ID, text, { parse_mode: 'HTML' }).catch(e => console.error("TG发送失败:", e.message));
};

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const type = msg.chat.type;
    const text = msg.text ? msg.text.trim() : '';

    // 1. 私聊静默
    if (type === 'private') return;

    // 2. 非管理员群自动退群
    if (chatId.toString() !== TG_ADMIN_GROUP_ID.toString()) {
        console.log(`⚠️ 未授权群组 ${chatId}，正在退出...`);
        bot.leaveChat(chatId).catch(()=>{});
        return; 
    }

    // --- 管理员指令 ---

    // /bz 帮助
    if (text === '/bz' || text === '/help') {
        const helpMsg = `
<b>🤖 NEXUS 控台指令</b>
━━━━━━━━━━━━━━
1. <b>/ck</b> - 查看数据统计
2. <b>/qc</b> - ⚠️ 清空所有数据
3. <b>设置汇率 [数值]</b>
4. <b>设置手续费 [数值]</b>
5. <b>设置钱包 [地址]</b> - 修改USDT收款地址
6. <b>/fix_db</b> - 修复数据库字段缺失
        `;
        bot.sendMessage(chatId, helpMsg, { parse_mode: 'HTML' });
    }

    // /ck 查看数据
    else if (text === '/ck') {
        try {
            const u = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count;
            const o = (await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count;
            const p = (await pool.query('SELECT COUNT(*) FROM products')).rows[0].count;
            const r = await getSetting('rate');
            const f = await getSetting('feeRate');
            const w = await getSetting('walletAddress');

            const stats = `
<b>📊 实时数据统计</b>
━━━━━━━━━━━━━━
👤 用户: ${u} | 📦 订单: ${o} | 🛒 商品: ${p}
💰 汇率: ${r} | 💸 手续费: ${f}%
👛 钱包: <code>${w}</code>
            `;
            bot.sendMessage(chatId, stats, { parse_mode: 'HTML' });
        } catch (e) { bot.sendMessage(chatId, "❌ 读取失败: " + e.message); }
    }

    // /qc 清空数据
    else if (text === '/qc') {
        try {
            await pool.query('TRUNCATE users, orders, chats');
            bot.sendMessage(chatId, "🗑️ <b>用户、订单、聊天记录已清空！</b>", { parse_mode: 'HTML' });
        } catch(e) { bot.sendMessage(chatId, "❌ 操作失败"); }
    }

    // 设置汇率
    else if (text.startsWith('设置汇率 ')) {
        const val = parseFloat(text.split(' ')[1]);
        if (!isNaN(val)) {
            await setSetting('rate', val);
            bot.sendMessage(chatId, `✅ 汇率已设为: ${val}`);
        }
    }

    // 设置手续费
    else if (text.startsWith('设置手续费 ')) {
        const val = parseFloat(text.split(' ')[1]);
        if (!isNaN(val)) {
            await setSetting('feeRate', val);
            bot.sendMessage(chatId, `✅ 手续费已设为: ${val}%`);
        }
    }

    // 设置钱包
    else if (text.startsWith('设置钱包 ')) {
        const addr = text.split(' ')[1];
        if (addr && addr.length > 10) {
            await setSetting('walletAddress', addr);
            bot.sendMessage(chatId, `✅ <b>收款地址已更新</b>\n<code>${addr}</code>`, {parse_mode:'HTML'});
        } else {
            bot.sendMessage(chatId, "❌ 地址格式不对");
        }
    }

    // 数据库修复 (防止 wallet 字段报错)
    else if (text === '/fix_db') {
        try {
            await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet TEXT;');
            bot.sendMessage(chatId, "✅ 数据库字段修复完成");
        } catch(e) { bot.sendMessage(chatId, "❌ " + e.message); }
    }
});


// ==========================================
// 🌐 服务器配置
// ==========================================

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options('*', cors());

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

const adminAuth = (req, res, next) => {
    if(req.headers['authorization'] === ADMIN_TOKEN) next();
    else res.status(401).json({msg:'Unauthorized'});
};


// ==========================================
// 🛒 前端 API
// ==========================================

// 1. 公共数据
app.get('/api/public/data', async (req, res) => {
    try {
        const prods = await pool.query('SELECT * FROM products WHERE stock > 0 OR is_pinned = TRUE ORDER BY is_pinned DESC, id DESC');
        const hiring = await pool.query('SELECT * FROM hiring');
        
        const rate = await getSetting('rate');
        const feeRate = await getSetting('feeRate');
        const announcement = await getSetting('announcement');
        const popup = await getSetting('popup');
        const wallet = await getSetting('walletAddress');

        const categories = [...new Set(prods.rows.map(p => p.category))];

        res.json({
            products: prods.rows,
            categories,
            hiring: hiring.rows,
            rate: parseFloat(rate),
            feeRate: parseFloat(feeRate),
            announcement,
            showPopup: popup === 'true',
            wallet // 将钱包地址传给前端
        });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 2. 注册
app.post('/api/user/register', async (req, res) => {
    const { contact, password, uid } = req.body;
    try {
        const check = await pool.query('SELECT id FROM users WHERE contact = $1', [contact]);
        if(check.rows.length > 0) return res.json({success:false, msg:'用户已存在'});

        const id = uid || Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO users (id, contact, password, balance) VALUES ($1, $2, $3, 0)', [id, contact, password]);
        res.json({ success: true, isNew: true, userId: id, uid: id, balance: 0 });
    } catch(e) { res.json({success:false, msg: e.message}); }
});

// 3. 登录
app.post('/api/user/login', async (req, res) => {
    const { contact, password } = req.body;
    try {
        const resDb = await pool.query('SELECT * FROM users WHERE contact = $1 AND password = $2', [contact, password]);
        if(resDb.rows.length > 0) {
            const u = resDb.rows[0];
            res.json({ success: true, userId: u.id, uid: u.id, balance: parseFloat(u.balance) });
        } else {
            res.json({ success: false, msg: '账号或密码错误' });
        }
    } catch(e) { res.json({success:false, msg: e.message}); }
});

// 4. 获取余额
app.get('/api/user/balance', async (req, res) => {
    try {
        const resDb = await pool.query('SELECT balance FROM users WHERE id = $1', [req.query.userId]);
        if(resDb.rows.length > 0) res.json({ success: true, balance: parseFloat(resDb.rows[0].balance) });
        else res.json({ success: false });
    } catch(e) { res.json({success:false}); }
});

// 5. 修改密码 (前端要求直接修改)
app.post('/api/user/change-password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    try {
        // 先验证旧密码
        const userRes = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) return res.json({success: false, msg: '用户不存在'});
        
        if (userRes.rows[0].password !== oldPassword) {
            return res.json({success: false, msg: '旧密码错误'});
        }

        // 更新密码
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [newPassword, userId]);
        res.json({success: true, msg: '修改成功'});
    } catch (e) {
        console.error(e);
        res.json({success: false, msg: '服务器错误'});
    }
});

// 6. 提交订单
app.post('/api/order', async (req, res) => {
    const { userId, productId, paymentMethod, shippingInfo, useBalance, balanceAmount } = req.body;
    
    try {
        const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        
        let prodName = "购物车商品";
        let amount = 0;

        if (productId !== 'cart') {
            const prodRes = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
            const prod = prodRes.rows[0];
            if(prod) {
                prodName = prod.name;
                amount = parseFloat(prod.price);
                await pool.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [productId]);
            }
        } else {
            amount = req.body.totalAmount || 10; 
        }

        let finalUSDT = amount;
        if(useBalance && user && parseFloat(user.balance) > 0) {
            const deduct = Math.min(parseFloat(user.balance), amount);
            finalUSDT -= deduct;
            await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [deduct, userId]);
        }

        const rate = parseFloat(await getSetting('rate'));
        const feeRate = parseFloat(await getSetting('feeRate'));
        const cnyAmount = (finalUSDT * rate * (1 + feeRate/100)).toFixed(2);
        
        const orderId = 'ORD-' + Date.now();
        // 获取当前数据库中的钱包地址
        const wallet = await getSetting('walletAddress');

        await pool.query(
            `INSERT INTO orders (order_id, user_id, product_name, payment_method, usdt_amount, cny_amount, shipping_info, wallet, expires_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '30 minutes')`,
            [orderId, userId, prodName, paymentMethod, finalUSDT.toFixed(4), cnyAmount, JSON.stringify(shippingInfo), wallet]
        );

        // TG 推送
        let tgMsg = `🆕 <b>新订单提醒</b>\n\n单号: <code>${orderId}</code>\n用户: ${user ? user.contact : userId}\n商品: ${prodName}\n支付: ${paymentMethod}\n金额: ${finalUSDT.toFixed(4)} USDT`;
        if(paymentMethod !== 'USDT') tgMsg += `\n⚠️ <b>需要人工处理</b>`;
        sendTgNotify(tgMsg);

        res.json({ success: true, orderId, usdtAmount: finalUSDT.toFixed(4), cnyAmount, wallet });

    } catch(e) { console.error(e); res.json({success:false, msg: e.message}); }
});

// 7. 获取订单
app.get('/api/order', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.query.userId]);
        res.json(result.rows);
    } catch(e) { res.json([]); }
});

app.post('/api/recharge', async (req, res) => {
    const { userId, amount, method } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if(!user) return res.json({success:false, msg:'User not found'});

        const usdtAmount = parseFloat(amount);
        const rate = parseFloat(await getSetting('rate'));
        const cnyAmount = (usdtAmount * rate).toFixed(2);
        
        const orderId = 'RCG-' + Date.now();
        const wallet = await getSetting('walletAddress');

        await pool.query(
            `INSERT INTO orders (order_id, user_id, product_name, payment_method, usdt_amount, cny_amount, wallet, expires_at) 
             VALUES ($1, $2, '余额充值', $3, $4, $5, $6, NOW() + INTERVAL '30 minutes')`,
            [orderId, userId, method, usdtAmount.toFixed(4), cnyAmount, wallet]
        );

        sendTgNotify(`💰 <b>新充值订单</b>\n单号: <code>${orderId}</code>\n用户: ${user.contact}\n金额: ${usdtAmount} USDT`);
        res.json({ success: true, orderId, usdtAmount: usdtAmount.toFixed(4), cnyAmount, wallet });
    } catch(e) { res.json({success:false, msg: e.message}); }
});

app.get('/api/user/records', async (req, res) => {
    const { userId, type } = req.query; 
    try {
        if (type === 'withdraw') {
            const result = await pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
            res.json(result.rows);
        } else if (type === 'recharge') {
            const result = await pool.query("SELECT * FROM orders WHERE user_id = $1 AND product_name = '余额充值' ORDER BY created_at DESC", [userId]);
            res.json(result.rows);
        } else {
            res.json([]);
        }
    } catch(e) { res.json([]); }
});

// 8. 确认支付凭证
app.post('/api/order/confirm-payment', async (req, res) => {
    const { orderId, proof } = req.body;
    try {
        await pool.query("UPDATE orders SET proof = $1, status = '待审核' WHERE order_id = $2", [proof, orderId]);
        sendTgNotify(`📸 <b>用户上传凭证</b>\n单号: <code>${orderId}</code>\n请进后台审核。`);
        res.json({success:true});
    } catch(e) { res.json({success:false}); }
});

// 9. 二维码异常
app.post('/api/order/report-qr-issue', async (req, res) => {
    sendTgNotify(`🚨 <b>二维码异常反馈</b>\n单号: <code>${req.body.orderId}</code>`);
    res.json({success:true});
});

// 10. 提现申请
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, address } = req.body;
    try {
        const val = parseFloat(amount);
        const userRes = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
        if(userRes.rows[0].balance < val) return res.json({success:false, msg:'余额不足'});

        await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [val, userId]);
        
        await pool.query('INSERT INTO withdrawals (user_id, amount, address) VALUES ($1, $2, $3)', [userId, val, address]);

        sendTgNotify(`💸 <b>新提现申请</b>\n用户ID: ${userId}\n金额: ${val} USDT\n地址: <code>${address}</code>`);
        res.json({success:true});
    } catch(e) { res.json({success:false, msg:'Error'}); }
});

// 11. 聊天
app.post('/api/chat/send', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO chats (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'user', text]);
        sendTgNotify(`💬 <b>客服消息</b>\n来自: ${sessionId}\n内容: ${text}`);
        res.json({ success: true });
    } catch(e) { res.json({success:false}); }
});

app.get('/api/chat/history/:sid', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM chats WHERE session_id = $1 ORDER BY created_at ASC', [req.params.sid]);
        res.json(result.rows);
    } catch(e) { res.json([]); }
});

// ==========================================
// 🔧 后台管理 (Admin)
// ==========================================
app.post('/api/admin/login', (req, res) => {
    if(req.body.username === 'admin' && req.body.password === ADMIN_TOKEN) 
        res.json({success:true, token: ADMIN_TOKEN});
    else res.json({success:false, msg:'Error'});
});

app.get('/api/admin/all', adminAuth, async (req, res) => {
    try {
        const users = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
        const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const products = await pool.query('SELECT * FROM products ORDER BY id DESC');
        const hiring = await pool.query('SELECT * FROM hiring');
        const chatsRes = await pool.query('SELECT * FROM chats ORDER BY created_at ASC');
        
        let chats = {};
        chatsRes.rows.forEach(msg => {
            if(!chats[msg.session_id]) chats[msg.session_id] = [];
            chats[msg.session_id].push(msg);
        });

        const rate = await getSetting('rate');
        const feeRate = await getSetting('feeRate');
        const announcement = await getSetting('announcement');
        const popup = await getSetting('popup');

        res.json({
            users: users.rows,
            orders: orders.rows,
            products: products.rows,
            hiring: hiring.rows,
            chats,
            rate,
            feeRate,
            announcement,
            popup: popup === 'true'
        });
    } catch(e) { res.status(500).json({}); }
});

app.post('/api/admin/user/balance', adminAuth, async (req, res) => {
    const { userId, amount, type } = req.body;
    try {
        const val = parseFloat(amount);
        let sql = '';
        if(type === 'add') sql = 'UPDATE users SET balance = balance + $1 WHERE id = $2';
        if(type === 'subtract') sql = 'UPDATE users SET balance = GREATEST(0, balance - $1) WHERE id = $2';
        if(type === 'set') sql = 'UPDATE users SET balance = $1 WHERE id = $2';
        await pool.query(sql, [val, userId]);
        res.json({success:true});
    } catch(e) { res.json({success:false}); }
});

app.post('/api/admin/chat/initiate', adminAuth, async (req, res) => {
    const sid = `user_${req.body.userId}`;
    await pool.query("INSERT INTO chats (session_id, sender, content, is_initiate) VALUES ($1, 'admin', '客服已接入', TRUE)", [sid]);
    res.json({success:true, sessionId: sid});
});

app.post('/api/admin/reply', adminAuth, async (req, res) => {
    const { sessionId, text } = req.body;
    await pool.query("INSERT INTO chats (session_id, sender, content) VALUES ($1, 'admin', $2)", [sessionId, text]);
    res.json({success:true});
});

app.post('/api/upload', adminAuth, upload.single('file'), (req, res) => {
    if (req.file) {
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        const dataURI = `data:${req.file.mimetype};base64,${b64}`;
        res.json({ success: true, url: dataURI });
    } else {
        res.json({ success: false, error: 'No file' });
    }
});

app.post('/api/admin/order/ship', adminAuth, (req, res) => {
    const { orderId, trackingNumber } = req.body;
    // 这里简单处理，实际应更新数据库状态
    pool.query("UPDATE orders SET tracking_number = $1, status = '已发货' WHERE order_id = $2", [trackingNumber, orderId]);
    sendTgNotify(`🚚 <b>订单已发货</b>\n单号: <code>${orderId}</code>\n物流: ${trackingNumber}`);
    res.json({success:true});
});

app.post('/api/admin/order/upload_qrcode', adminAuth, upload.single('qrcode'), (req, res) => {
    const { orderId } = req.body;
    if(req.file) {
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        const dataURI = `data:${req.file.mimetype};base64,${b64}`;
        pool.query("UPDATE orders SET qrcode_url = $1 WHERE order_id = $2", [dataURI, orderId]);
        sendTgNotify(`✅ <b>收款码已上传</b>\n单号: <code>${orderId}</code>`);
        res.json({success:true});
    } else res.json({success:false});
});

app.post('/api/admin/update/announcement', adminAuth, async (req, res) => {
    await setSetting('announcement', req.body.text);
    res.json({success:true});
});
app.post('/api/admin/update/popup', adminAuth, async (req, res) => {
    await setSetting('popup', req.body.open);
    res.json({success:true});
});

// 商品增删改
app.post('/api/admin/product', adminAuth, async (req, res) => {
    const { name, price, stock, category, type, desc, imageUrl } = req.body;
    await pool.query(
        'INSERT INTO products (id, name, price, stock, category, type, description, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [Date.now(), name, price, stock, category, type, desc, imageUrl]
    );
    res.json({success:true});
});
app.put('/api/admin/product/:id', adminAuth, async (req, res) => {
    const { name, price, stock, category, type, desc, imageUrl } = req.body;
    await pool.query(
        'UPDATE products SET name=$1, price=$2, stock=$3, category=$4, type=$5, description=$6, image_url=$7 WHERE id=$8',
        [name, price, stock, category, type, desc, imageUrl, req.params.id]
    );
    res.json({success:true});
});
app.delete('/api/admin/product/:id', adminAuth, async (req, res) => {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({success:true});
});
// 招聘更新
app.post('/api/admin/update/hiring', adminAuth, async (req, res) => {
    const list = req.body; // array
    // 简单暴力：清空重写
    await pool.query('TRUNCATE hiring');
    for (const job of list) {
        await pool.query('INSERT INTO hiring (title, content, contact) VALUES ($1, $2, $3)', [job.title, job.content, job.contact]);
    }
    res.json({success:true});
});
app.post('/api/admin/confirm_pay', adminAuth, async (req, res) => {
    await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [req.body.orderId]);
    res.json({success:true});
});


app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
