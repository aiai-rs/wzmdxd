const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg'); // 引入 Postgres 客户端

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 🔑 环境变量 (Render 配置)
// ==========================================
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN; 
const TG_ADMIN_GROUP_ID = process.env.TG_ADMIN_GROUP_ID; 
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL; // Neon 的连接字符串

// 检查配置
if (!TG_BOT_TOKEN || !TG_ADMIN_GROUP_ID || !ADMIN_TOKEN || !DATABASE_URL) {
    console.error("❌ 错误: 环境变量缺失。请检查 TG_BOT_TOKEN, TG_ADMIN_GROUP_ID, ADMIN_TOKEN, DATABASE_URL");
    process.exit(1);
}

// ==========================================
// 🐘 PostgreSQL 连接池 (Neon)
// ==========================================
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Neon 需要 SSL
    }
});

// 初始化数据库表结构
const initDB = async () => {
    try {
        const client = await pool.connect();
        
        // 1. 用户表
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY,
                contact TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                balance NUMERIC(10, 4) DEFAULT 0,
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

        // 3. 订单表
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
        await client.query(`INSERT INTO settings (key, value) VALUES ('rate', '7.0') ON CONFLICT DO NOTHING;`);
        await client.query(`INSERT INTO settings (key, value) VALUES ('feeRate', '0') ON CONFLICT DO NOTHING;`);
        await client.query(`INSERT INTO settings (key, value) VALUES ('announcement', '欢迎来到小暗网') ON CONFLICT DO NOTHING;`);
        await client.query(`INSERT INTO settings (key, value) VALUES ('popup', 'true') ON CONFLICT DO NOTHING;`);

        console.log("✅ 数据库表结构初始化完成 (Neon)");
        client.release();
    } catch (err) {
        console.error("❌ 数据库初始化失败:", err);
    }
};

initDB();

// 辅助函数：获取设置
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

    if (type === 'private') return; // 私聊静默

    if (chatId.toString() !== TG_ADMIN_GROUP_ID.toString()) {
        bot.leaveChat(chatId).catch(()=>{});
        return; 
    }

    // /bz 指令
    if (text === '/bz' || text === '/help') {
        const helpMsg = `
<b>🤖 小暗网 控台指令手册 (Neon版)</b>

1. <b>/ck</b> - 查看数据库统计
2. <b>/qc</b> - ⚠️ 清空所有数据 (慎用)
3. <b>设置汇率 [数字]</b> - 修改USDT汇率
4. <b>设置手续费 [数字]</b> - 修改手续费%
        `;
        bot.sendMessage(chatId, helpMsg, { parse_mode: 'HTML' });
    }

    // /ck 指令
    else if (text === '/ck') {
        try {
            const userCount = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count;
            const orderCount = (await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count;
            const prodCount = (await pool.query('SELECT COUNT(*) FROM products')).rows[0].count;
            const rate = await getSetting('rate');
            const fee = await getSetting('feeRate');

            const stats = `
<b>📊 小暗网 数据库统计</b>
━━━━━━━━━━━━━━
👤 用户总数: ${userCount}
📦 订单总数: ${orderCount}
🛒 商品总数: ${prodCount}
💰 当前汇率: ${rate}
💸 手续费率: ${fee}%
            `;
            bot.sendMessage(chatId, stats, { parse_mode: 'HTML' });
        } catch (e) {
            bot.sendMessage(chatId, "❌ 读取数据库失败: " + e.message);
        }
    }

    // /qc 指令
    else if (text === '/qc') {
        try {
            await pool.query('TRUNCATE users, orders, chats');
            bot.sendMessage(chatId, "🗑️ <b>用户、订单、聊天记录已清空！</b>", { parse_mode: 'HTML' });
        } catch(e) {
            bot.sendMessage(chatId, "❌ 清空失败");
        }
    }

    // 设置汇率
    else if (text.startsWith('设置汇率 ')) {
        const rate = parseFloat(text.split(' ')[1]);
        if (!isNaN(rate)) {
            await setSetting('rate', rate);
            bot.sendMessage(chatId, `✅ <b>汇率已更新</b>: ${rate}`, { parse_mode: 'HTML' });
        }
    }

    // 设置手续费
    else if (text.startsWith('设置手续费 ')) {
        const fee = parseFloat(text.split(' ')[1]);
        if (!isNaN(fee)) {
            await setSetting('feeRate', fee);
            bot.sendMessage(chatId, `✅ <b>手续费已更新</b>: ${fee}%`, { parse_mode: 'HTML' });
        }
    }
});


// ==========================================
// 🌐 Express 配置
// ==========================================
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });
const adminAuth = (req, res, next) => {
    if(req.headers['authorization'] === ADMIN_TOKEN) next();
    else res.status(401).json({msg:'Unauthorized'});
};


// ==========================================
// 🛒 API 路由 (已适配 Postgres)
// ==========================================

// 1. 公共数据
app.get('/api/public/data', async (req, res) => {
    try {
        const prods = await pool.query('SELECT * FROM products WHERE stock > 0 OR is_pinned = TRUE ORDER BY is_pinned DESC, id DESC');
        const hiring = await pool.query('SELECT * FROM hiring');
        const rate = await getSetting('rate');
        const feeRate = await getSetting('feeRate');
        const ann = await getSetting('announcement');
        const pop = await getSetting('popup');

        const categories = [...new Set(prods.rows.map(p => p.category))];

        res.json({
            products: prods.rows,
            categories,
            hiring: hiring.rows,
            rate: parseFloat(rate),
            feeRate: parseFloat(feeRate),
            announcement: ann,
            showPopup: pop === 'true'
        });
    } catch(e) { console.error(e); res.status(500).json({error: e.message}); }
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
        const result = await pool.query('SELECT * FROM users WHERE contact = $1 AND password = $2', [contact, password]);
        if(result.rows.length > 0) {
            const u = result.rows[0];
            res.json({ success: true, userId: u.id, uid: u.id, balance: parseFloat(u.balance) });
        } else {
            res.json({ success: false, msg: '账号或密码错误' });
        }
    } catch(e) { res.json({success:false, msg: e.message}); }
});

// 4. 获取余额
app.get('/api/user/balance', async (req, res) => {
    try {
        const result = await pool.query('SELECT balance FROM users WHERE id = $1', [req.query.userId]);
        if(result.rows.length > 0) res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
        else res.json({ success: false });
    } catch(e) { res.json({success:false}); }
});

// 5. 修改密码
app.post('/api/user/change-password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    try {
        const user = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        if(user.rows.length === 0) return res.json({success:false, msg:'用户不存在'});
        if(user.rows[0].password !== oldPassword) return res.json({success:false, msg:'旧密码错误'});

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [newPassword, userId]);
        res.json({success:true, msg:'修改成功'});
    } catch(e) { res.json({success:false, msg: e.message}); }
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
                // 扣库存
                await pool.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [productId]);
            }
        } else {
            amount = req.body.totalAmount || 10; 
        }

        let finalUSDT = amount;
        if(useBalance && user && parseFloat(user.balance) > 0) {
            const balance = parseFloat(user.balance);
            const deduct = Math.min(balance, amount);
            finalUSDT -= deduct;
            // 扣余额
            await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [deduct, userId]);
        }

        const rate = parseFloat(await getSetting('rate'));
        const feeRate = parseFloat(await getSetting('feeRate'));
        const cnyAmount = (finalUSDT * rate * (1 + feeRate/100)).toFixed(2);
        
        const orderId = 'ORD-' + Date.now();
        const wallet = 'Txxxxxxxxxxxxxxxxxxxxxx'; // 收款地址

        await pool.query(
            `INSERT INTO orders (order_id, user_id, product_name, payment_method, usdt_amount, cny_amount, shipping_info, wallet, expires_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '30 minutes')`,
            [orderId, userId, prodName, paymentMethod, finalUSDT.toFixed(4), cnyAmount, JSON.stringify(shippingInfo), wallet]
        );

        // TG 推送
        let tgMsg = `🆕 <b>新订单提醒</b>\n\n单号: <code>${orderId}</code>\n用户: ${user ? user.contact : userId}\n商品: ${prodName}\n支付: ${paymentMethod}\n金额: ${finalUSDT.toFixed(4)} USDT`;
        if(paymentMethod !== 'USDT') tgMsg += `\n⚠️ <b>待收款</b>`;
        sendTgNotify(tgMsg);

        res.json({ success: true, orderId, usdtAmount: finalUSDT.toFixed(4), cnyAmount, wallet });

    } catch(e) { console.error(e); res.json({success:false, msg: e.message}); }
});

// 7. 获取订单列表
app.get('/api/order', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.query.userId]);
        res.json(result.rows);
    } catch(e) { res.json([]); }
});

// 8. 确认支付凭证
app.post('/api/order/confirm-payment', async (req, res) => {
    const { orderId, proof } = req.body;
    try {
        await pool.query("UPDATE orders SET proof = $1, status = '待审核' WHERE order_id = $2", [proof, orderId]);
        sendTgNotify(`📸 <b>支付凭证上传</b>\n单号: <code>${orderId}</code>\n请进后台审核。`);
        res.json({success:true});
    } catch(e) { res.json({success:false}); }
});

// 9. 二维码异常
app.post('/api/order/report-qr-issue', async (req, res) => {
    sendTgNotify(`🚨 <b>二维码异常</b>\n单号: <code>${req.body.orderId}</code>`);
    res.json({success:true});
});

// 10. 聊天
app.post('/api/chat/send', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO chats (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'user', text]);
        sendTgNotify(`💬 <b>在线客服</b>\nID: ${sessionId}\n消息: ${text}`);
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
// 🔧 后台管理接口 (Admin)
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
        
        // 整理聊天记录
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
    } catch(e) { console.error(e); res.status(500).json({}); }
});

// 后台修改余额
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

// 后台发起聊天
app.post('/api/admin/chat/initiate', adminAuth, async (req, res) => {
    const sid = `user_${req.body.userId}`;
    await pool.query("INSERT INTO chats (session_id, sender, content, is_initiate) VALUES ($1, 'admin', '客服已接入', TRUE)", [sid]);
    res.json({success:true, sessionId: sid});
});

// 后台回复
app.post('/api/admin/reply', adminAuth, async (req, res) => {
    const { sessionId, text } = req.body;
    await pool.query("INSERT INTO chats (session_id, sender, content) VALUES ($1, 'admin', $2)", [sessionId, text]);
    res.json({success:true});
});

// 后台商品管理 (增删改)
app.post('/api/admin/product', adminAuth, async (req, res) => {
    const { name, price, stock, category, type, desc, imageUrl } = req.body;
    const id = Date.now();
    await pool.query(
        'INSERT INTO products (id, name, price, stock, category, type, description, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, name, price, stock, category, type, desc, imageUrl]
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

// 启动
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} (Neon DB)`);
});
