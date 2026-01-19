require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const axios = require('axios');
const multer = require('multer'); // 新增：图片上传
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- 新增：静态资源托管 (解决图片无法显示问题) ---
// 确保 uploads 文件夹存在
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
// 允许外部访问 uploads 目录下的文件
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- 新增：Multer 配置 (图片存储) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        // 防止文件名冲突，使用时间戳
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- 环境变量 ---
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const TRON_WALLET_ADDRESS = process.env.TRON_WALLET_ADDRESS;

if (!DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
const ALLOWED_GROUP_ID = TG_CHAT_ID;

// --- TG Bot 逻辑升级 (新增指令) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';

    if (msg.chat.type === 'private') return;
    if (chatId !== ALLOWED_GROUP_ID) {
        bot.sendMessage(chatId, "⚠️ 未授权群组，再见！").then(() => bot.leaveChat(chatId));
        return;
    }

    // 汇率设置
    if (text.startsWith('设置汇率 ')) {
        const rate = parseFloat(text.split(' ')[1]);
        if (!isNaN(rate) && rate > 0) {
            await pool.query("INSERT INTO settings (key, value) VALUES ('exchange_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [rate.toString()]);
            bot.sendMessage(chatId, `✅ 汇率已更新为: 1 USDT = ${rate} CNY`);
        }
    }
    
    // 新增：手续费设置 (微信/支付宝)
    if (text.startsWith('设置手续费 ')) {
        const fee = parseFloat(text.split(' ')[1]);
        if (!isNaN(fee) && fee >= 0) {
            await pool.query("INSERT INTO settings (key, value) VALUES ('fee_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [fee.toString()]);
            bot.sendMessage(chatId, `✅ 支付手续费已更新为: ${fee}%`);
        }
    }

    // --- 新增管理员指令 ---
    // /sc 删除所有订单
    if (text === '/sc') {
        try {
            await pool.query("DELETE FROM orders");
            bot.sendMessage(chatId, "🗑️ 所有订单及物流信息已清除。");
        } catch (e) { bot.sendMessage(chatId, "❌ 操作失败: " + e.message); }
    }

    // /qc 清空数据库 (危险)
    if (text === '/qc') {
        try {
            await pool.query("TRUNCATE products, orders, messages, users RESTART IDENTITY");
            bot.sendMessage(chatId, "💥 数据库已完全清空 (产品/订单/消息/用户)。");
        } catch (e) { bot.sendMessage(chatId, "❌ 操作失败: " + e.message); }
    }

    // /bz 指令说明
    if (text === '/bz') {
        const help = `
🤖 **机器人指令说明**
---------------------------
Set Rate: 设置汇率 7.2
Set Fee:  设置手续费 3 (即3%)
---------------------------
/sc  -> 删除所有订单
/qc  -> 清空全站数据 (慎用)
/bz  -> 显示此帮助
        `;
        bot.sendMessage(chatId, help);
    }
});

// --- 数据库初始化 (增量更新) ---
async function initDB() {
    try {
        const client = await pool.connect();
        
        // Users: 增加密码字段
        await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, contact TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT`);

        // Products: 确保有 image_url
        await client.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT, price TEXT, stock INTEGER, category TEXT, description TEXT, type TEXT DEFAULT 'virtual', image_url TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        
        // Orders: 增加物流单号、手续费记录
        await client.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_id TEXT UNIQUE, product_name TEXT, contact TEXT, payment_method TEXT, status TEXT DEFAULT '待支付', user_id INTEGER, usdt_amount NUMERIC, cny_amount NUMERIC, snapshot_rate NUMERIC, shipping_info TEXT, expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_amount NUMERIC DEFAULT 0`);

        await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, session_id TEXT, sender TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

        // 初始化默认手续费
        const checkFee = await client.query("SELECT * FROM settings WHERE key = 'fee_rate'");
        if (checkFee.rowCount === 0) await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['fee_rate', '0']);

        console.log("Database Schema Updated");
        client.release();
    } catch (err) { console.error("DB Init Error:", err); }
}
initDB();

// --- USDT 监听 (保持原有逻辑) ---
// ... (此处保留你原有的 checkUsdtDeposits 函数，不做修改) ...
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
                sendTG(`✅ **USDT 到账成功**\n单号: ${order.order_id}\n金额: ${expectedAmount} USDT\n客户已自动发货`);
            }
        }
    } catch (e) { console.error("USDT Check Error:", e.message); }
}
setInterval(checkUsdtDeposits, 30000);

function sendTG(text) {
    if (bot && TG_CHAT_ID) bot.sendMessage(TG_CHAT_ID, text, { parse_mode: 'Markdown' }).catch(e => console.log(e.message));
}

// --- API 接口 ---

// 新增：图片上传接口
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // 返回完整 URL
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

// 公共数据 (增加手续费返回)
app.get('/api/public/data', async (req, res) => {
    try {
        const p = await pool.query('SELECT * FROM products ORDER BY id DESC');
        const c = await pool.query('SELECT DISTINCT category FROM products');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const rate = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const fee = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'"); // 新增
        const popup = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        res.json({
            products: p.rows,
            categories: c.rows.map(r => r.category),
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '{}'),
            rate: parseFloat(rate.rows[0]?.value || '7.0'),
            feeRate: parseFloat(fee.rows[0]?.value || '0'), // 新增
            showPopup: popup.rows[0]?.value === 'true'
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// 升级：用户注册/登录 (带密码和简单验证)
app.post('/api/user/login', async (req, res) => {
    const { contact, password } = req.body;
    if(!contact || !password) return res.status(400).json({error: "Need contact and password"});
    
    try {
        let user = await pool.query("SELECT * FROM users WHERE contact = $1", [contact]);
        if (user.rows.length === 0) {
            // 自动注册
            const ins = await pool.query("INSERT INTO users (username, contact, password) VALUES ($1, $1, $2) RETURNING id", [contact, password]);
            return res.json({ success: true, userId: ins.rows[0].id, isNew: true });
        } else {
            // 校验密码
            if (user.rows[0].password !== password) {
                return res.json({ success: false, msg: "密码错误" });
            }
            res.json({ success: true, userId: user.rows[0].id });
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 升级：下单接口 (计算手续费 + 格式化地址)
app.post('/api/order', async (req, res) => {
    const { userId, productId, paymentMethod, shippingInfo } = req.body;
    try {
        const prod = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (prod.rows.length === 0) return res.json({ success: false, msg: '商品不存在' });

        const pData = prod.rows[0];
        const basePrice = parseFloat(pData.price.replace(/[^\d.]/g, ''));
        const orderId = 'ORD-' + Date.now().toString().slice(-6);
        
        const rateRes = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const rate = parseFloat(rateRes.rows[0]?.value || '7.0');
        
        const feeRes = await pool.query("SELECT value FROM settings WHERE key = 'fee_rate'");
        const feePercent = parseFloat(feeRes.rows[0]?.value || '0');

        let usdtAmount = basePrice;
        let cnyAmount = basePrice * rate;
        let feeAmount = 0;
        let finalStatus = '待支付';
        let expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        // 手续费逻辑
        if (paymentMethod !== 'USDT') {
            feeAmount = cnyAmount * (feePercent / 100);
            cnyAmount = cnyAmount + feeAmount;
        }

        // USDT 随机小数
        if (paymentMethod === 'USDT') {
            const randomDecimal = (Math.floor(Math.random() * 9000) + 1000) / 10000;
            usdtAmount = parseFloat((basePrice + randomDecimal).toFixed(4));
        }

        // 插入订单
        await pool.query(
            `INSERT INTO orders 
            (order_id, product_name, contact, payment_method, status, user_id, usdt_amount, cny_amount, snapshot_rate, shipping_info, expires_at, fee_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, 
            [orderId, pData.name, 'RegUser', paymentMethod, finalStatus, userId, usdtAmount, cnyAmount.toFixed(2), rate, JSON.stringify(shippingInfo || {}), expiresAt, feeAmount.toFixed(2)]
        );

        const userRes = await pool.query("SELECT contact FROM users WHERE id = $1", [userId]);
        const contactStr = userRes.rows[0]?.contact || 'Unknown';

        // 格式化 TG 通知
        let notif = `💰 **新订单**\n单号: \`${orderId}\`\n商品: ${pData.name}\n用户: ${contactStr}\n支付: ${paymentMethod}`;
        if (paymentMethod === 'USDT') notif += `\n需付: \`${usdtAmount}\` USDT`;
        else notif += `\n需付: ¥${cnyAmount.toFixed(2)} (含手续费${feePercent}%)`;

        if (pData.type === 'physical') {
            // 结构化地址显示
            notif += `\n\n📦 **发货信息**\n收件人: ${shippingInfo.name}\n电话: ${shippingInfo.tel}\n地址: ${shippingInfo.addr}`;
        }

        sendTG(notif);
        res.json({ success: true, orderId, usdtAmount, cnyAmount: cnyAmount.toFixed(2), wallet: TRON_WALLET_ADDRESS });
    } catch (e) { console.error(e); res.status(500).json({error: e.message}); }
});

// 新增：更新物流单号 (管理员)
app.post('/api/admin/order/ship', async (req, res) => {
    const { orderId, trackingNumber } = req.body;
    try {
        await pool.query("UPDATE orders SET tracking_number = $1 WHERE order_id = $2", [trackingNumber, orderId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

// 修复：招聘信息更新 (JSON 解析问题)
app.post('/api/admin/update/hiring', async (req, res) => {
    try { 
        // 确保存储的是 JSON 字符串
        const val = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        await pool.query("INSERT INTO settings (key, value) VALUES ('hiring', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [val]); 
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({error: e.message}); }
});

// 其他原有接口保持不变... (query, admin/all, etc.)
app.get('/api/order/:id', async (req, res) => {
    try {
        if (req.query.userId) {
            const list = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.query.userId]);
            return res.json(list.rows);
        }
        const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [req.params.id]);
        res.json(r.rows.length > 0 ? r.rows[0] : { status: '未找到' });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/confirm_pay', async (req, res) => {
    const { orderId } = req.body;
    try {
        await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [orderId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/update/popup', async (req, res) => {
    try {
        await pool.query("INSERT INTO settings (key, value) VALUES ('announcement_popup', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [req.body.open ? 'true':'false']);
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/product', async (req, res) => {
    const { name, price, stock, category, desc, type, imageUrl } = req.body;
    try {
        await pool.query('INSERT INTO products (name, price, stock, category, description, type, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [name, price, stock, category, desc, type, imageUrl]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/chat/send', async (req, res) => {
    const { sessionId, text } = req.body;
    try {
        await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'user', text]);
        sendTG(`💬 **客户消息**\nID: \`${sessionId}\`\n内容: ${text}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.get('/api/chat/history/:sid', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [req.params.sid]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.get('/api/admin/all', async (req, res) => {
    try {
        const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const msgs = await pool.query('SELECT * FROM messages ORDER BY created_at ASC');
        const a = await pool.query("SELECT value FROM settings WHERE key = 'announcement'");
        const h = await pool.query("SELECT value FROM settings WHERE key = 'hiring'");
        const r = await pool.query("SELECT value FROM settings WHERE key = 'exchange_rate'");
        const p = await pool.query("SELECT value FROM settings WHERE key = 'announcement_popup'");
        
        let chats = {};
        msgs.rows.forEach(m => {
            if(!chats[m.session_id]) chats[m.session_id] = [];
            chats[m.session_id].push(m);
        });

        res.json({
            orders: orders.rows,
            chats: chats,
            announcement: a.rows[0]?.value || '',
            hiring: JSON.parse(h.rows[0]?.value || '{}'),
            rate: r.rows[0]?.value || '7.0',
            popup: p.rows[0]?.value === 'true'
        });
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.post('/api/admin/update/announcement', async (req, res) => {
    try { await pool.query("UPDATE settings SET value = $1 WHERE key = 'announcement'", [req.body.text]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});
app.post('/api/admin/reply', async (req, res) => {
    const { sessionId, text } = req.body;
    try { await pool.query('INSERT INTO messages (session_id, sender, content) VALUES ($1, $2, $3)', [sessionId, 'admin', text]); res.json({ success: true }); } catch (e) { res.status(500).json({error: e.message}); }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
