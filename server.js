const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const http = require('http'); // 新增
const { Server } = require("socket.io"); // 新增
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg'); 
const cloudinary = require('cloudinary').v2;
const stream = require('stream');
const cron = require('node-cron');

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app); // 将 app 包装进 http server
// 初始化 Socket.io，允许跨域
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const rateLimit = require('express-rate-limit');

// 定义登录限流器：15分钟内最多尝试5次
const loginLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, 
	max: 5, 
	message: { success: false, msg: "尝试次数过多，请15分钟后再试" },
    standardHeaders: true,
	legacyHeaders: false,
});

// 定义全局限流器：1分钟最多200次请求 (防止DDoS)
const apiLimiter = rateLimit({
	windowMs: 1 * 60 * 1000, 
	max: 200, 
    standardHeaders: true,
	legacyHeaders: false,
});

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_GROUP_ID = process.env.TG_ADMIN_GROUP_ID; 
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    cloudinary.config({
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET
    });
}

if (!TG_BOT_TOKEN || !TG_ADMIN_GROUP_ID || !ADMIN_TOKEN || !DATABASE_URL) {
    console.error("❌ 错误: 环境变量缺失。请检查 TG_BOT_TOKEN, TG_ADMIN_GROUP_ID, ADMIN_TOKEN, DATABASE_URL");
    process.exit(1);
}
// ==========================================
// 🔌 Socket.io 连接逻辑
// ==========================================
io.on('connection', (socket) => {
    console.log('用户已连接:', socket.id);

    // 客户端加入房间 (房间号就是 session_id)
    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`Socket ${socket.id} 加入房间: ${room}`);
    });

 socket.on('disconnect', () => {
        console.log('用户断开连接:', socket.id);
    });
});

// [新增] 定义广播函数，通知所有后台管理员刷新数据
const notifyAdminUpdate = () => {
    io.emit('admin_update', { timestamp: Date.now() });
};

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDB = async () => {
    try {
        const client = await pool.connect();
        
       // 1. 用户表 (修改：增加 invite_code 和 invited_by)
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY,
                contact TEXT NOT NULL,
                password TEXT NOT NULL,
                balance NUMERIC(10, 4) DEFAULT 0,
                invite_code TEXT, 
                invited_by BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. 订单表
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

        // 3. 提现表
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

        // 4. 商品表
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

        // 5. 招聘表
        await client.query(`
            CREATE TABLE IF NOT EXISTS hiring (
                id SERIAL PRIMARY KEY,
                title TEXT,
                content TEXT,
                contact TEXT
            );
        `);

        // 6. 聊天记录表
        await client.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                sender TEXT,
                content TEXT,
                msg_type TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                is_initiate BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

       // 7. 系统设置表
        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
		
		// [新增] 8. 分类排序表
        await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
                name TEXT PRIMARY KEY,
                priority INT DEFAULT 0
            );
        `);

       // 8. 资金明细表 (替换审计日志)
        await client.query(`
            CREATE TABLE IF NOT EXISTS balance_logs (
                id SERIAL PRIMARY KEY,
                user_id BIGINT,
                type TEXT, 
                amount NUMERIC(10, 4),
                remark TEXT,
                balance_after NUMERIC(10, 4), 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // 自动修复旧表结构（防止报错）
        try { await client.query("ALTER TABLE balance_logs ADD COLUMN IF NOT EXISTS balance_after NUMERIC(10, 4)"); } catch(e){}

        // 初始化默认设置
        const defaults = [
            ['rate', '7.0'],
            ['feeRate', '0'],
            ['announcement', '欢迎来到 NEXUS 商城'],
            ['popup', 'true'],
            ['walletAddress', '请联系客服获取地址']
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

// 广播全局数据函数
const broadcastGlobalUpdate = async () => {
    try {
        const prods = await pool.query('SELECT * FROM products ORDER BY is_pinned DESC, id DESC');
        const rate = await getSetting('rate');
        const feeRate = await getSetting('feeRate');
        const announcement = await getSetting('announcement');
        
        // [新增] 获取招聘信息和更多设置
        const hiring = await pool.query('SELECT * FROM hiring');
        const popup = await getSetting('popup');
        const wallet = await getSetting('walletAddress');

        // [修改] 获取分类并按照数据库中的优先级排序
        const distinctCats = [...new Set(prods.rows.map(p => p.category))];
        const prioritiesRes = await pool.query('SELECT name, priority FROM categories');
        const pMap = {};
        prioritiesRes.rows.forEach(r => pMap[r.name] = r.priority);
        
        // 排序：优先级数字越大越靠前，如果没设置则默认为0
        const categories = distinctCats.sort((a, b) => (pMap[b] || 0) - (pMap[a] || 0));

        io.emit('global_update', {
            products: prods.rows,
            categories,
            // [新增] 推送更多数据
            hiring: hiring.rows,
            showPopup: popup === 'true',
            wallet,
            rate: parseFloat(rate),
            feeRate: parseFloat(feeRate),
            announcement
        });
    } catch(e) { console.error("Broadcast Error", e); }
};

// 🕒 定时任务：每1.5小时随机减少库存 (随机范围 1-5)
setInterval(async () => {
    try {
        // 使用 SQL 的 random() 函数，让每一行商品减去的库存数都不同
        await pool.query(`
            UPDATE products 
            SET stock = GREATEST(0, stock - floor(random() * 5 + 1)::int) 
            WHERE stock > 0
        `);
        console.log(`📉 自动减库存: 所有商品已随机减少 1-5 个库存`);
        broadcastGlobalUpdate(); // 广播更新
    } catch(e) { console.error("Auto Reduce Stock Error", e); }
}, 90 * 60 * 1000); // 90分钟 = 1.5小时

// 🕒 定时任务：每天凌晨0点清理3天前的“非核心”数据
cron.schedule('0 0 * * *', async () => {
    try {
        console.log('🔄 开始每日数据清理...');
        
        // 1. 清理旧订单 (3天前) - 对应前端"订单"
        await pool.query("DELETE FROM orders WHERE created_at < NOW() - INTERVAL '3 days'");
        
        // 2. 清理旧提现记录 (3天前) - 对应前端"提现记录"
        await pool.query("DELETE FROM withdrawals WHERE created_at < NOW() - INTERVAL '3 days'");
        
        // 3. 清理旧聊天记录 (3天前) - 对应客服聊天
        await pool.query("DELETE FROM chats WHERE created_at < NOW() - INTERVAL '3 days'");
        
        // 4. 清理旧资金明细 (3天前) - 对应前端"资金明细"
        // 注意：这只会删除流水记录，不会影响用户的当前余额(balance)
        await pool.query("DELETE FROM balance_logs WHERE created_at < NOW() - INTERVAL '7 days'");

        console.log('✅ 清理完成：已删除3天前的 [订单/提现/聊天/流水]');
    } catch (e) {
        console.error('❌ 清理失败:', e);
    }
});
// ☁️ 辅助函数：上传图片到 Cloudinary
const uploadToCloud = (buffer) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "nexus_store_products" },
            (error, result) => {
                if (result) resolve(result.secure_url);
                else reject(error);
            }
        );
        stream.Readable.from(buffer).pipe(uploadStream);
    });
};

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
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

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
            // --- 1. 基础业务数据 ---
            const u = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count;
            const o = (await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count;
            const p = (await pool.query('SELECT COUNT(*) FROM products')).rows[0].count;
            
            // --- 2. 数据库存储空间 (Neon Free: 500MB) ---
            // 查询实际占用字节数
            const dbSizeQuery = await pool.query("SELECT pg_database_size(current_database()) as size");
            const dbSizeBytes = parseInt(dbSizeQuery.rows[0].size);
            const dbUsedMB = (dbSizeBytes / 1024 / 1024).toFixed(2);
            const dbTotalMB = 500; // ⚠️ Neon 免费版存储限制为 500MB
            const dbFreeMB = (dbTotalMB - dbUsedMB).toFixed(2);
            const dbPercent = Math.min(100, (dbUsedMB / dbTotalMB) * 100).toFixed(1);

            // --- 3. 服务器内存 (Render Paid) ---
            const mem = process.memoryUsage();
            const ramUsedMB = (mem.rss / 1024 / 1024).toFixed(2);
            const ramTotalMB = 512; // Render Starter 内存限制
            const ramFreeMB = (ramTotalMB - ramUsedMB).toFixed(2);
            const ramPercent = Math.min(100, (ramUsedMB / ramTotalMB) * 100).toFixed(1);

            // --- 4. Cloudinary 积分 (图片流量) ---
            let cloudInfo = "📡 获取失败";
            let cloudBar = "";
            try {
                const cloudRes = await cloudinary.api.usage();
                if (cloudRes && cloudRes.credits) {
                    const cUsed = cloudRes.credits.usage.toFixed(2);
                    const cLimit = cloudRes.credits.limit; 
                    const cPercent = cloudRes.credits.used_percent.toFixed(1);
                    const cLeft = (cLimit - cUsed).toFixed(2);
                    
                    const filled = Math.round(cPercent / 10);
                    const empty = 10 - filled;
                    const bar = '■'.repeat(filled) + '□'.repeat(empty);

                    cloudInfo = `额度: ${cLimit} | 剩余: ${cLeft}\n已用: ${cUsed} (${cPercent}%)`;
                    cloudBar = `\n${bar}`;
                }
            } catch (err) {
                cloudInfo = "⚠️ Cloudinary API 未配置或报错";
            }

            // --- 5. 进度条绘制函数 ---
            const drawBar = (percent) => {
                const filled = Math.round(percent / 10);
                const empty = 10 - filled;
                return '■'.repeat(filled) + '□'.repeat(empty);
            };

            // --- 6. 运行时间 ---
            const uptime = process.uptime();
            const d = Math.floor(uptime / 86400);
            const h = Math.floor((uptime % 86400) / 3600);
            const m = Math.floor((uptime % 3600) / 60);
            const runTimeStr = `${d}天 ${h}小时 ${m}分`;

            // --- 7. 系统设置 ---
            const r = await getSetting('rate');
            const f = await getSetting('feeRate');
            const w = await getSetting('walletAddress');

            const stats = `
<b>📊  资源监控面板 (Neon版)</b>
━━━━━━━━━━━━━━━━━━
<b>⏱️ 运行状态</b>
Running: <code>${runTimeStr}</code>

<b>💾 服务器内存 (Render)</b>
总量: ${ramTotalMB} MB | 剩余: ${ramFreeMB} MB
已用: ${ramUsedMB} MB (${ramPercent}%)
${drawBar(ramPercent)}

<b>🗄️ 数据库存储 (Neon)</b>
总量: ${dbTotalMB} MB | 剩余: ${dbFreeMB} MB
已用: ${dbUsedMB} MB (${dbPercent}%)
${drawBar(dbPercent)}
<i>(注: Neon免费版限制500MB存储，流量通常不限)</i>

<b>☁️ 图片托管 (Cloudinary)</b>
${cloudInfo}${cloudBar}

<b>📈 业务数据统计</b>
👥 用户总数: ${u}
📦 订单总数: ${o}
🛒 商品库存: ${p}

<b>⚙️ 参数设置</b>
汇率: ${r} | 手续费: ${f}%
钱包: <code>${w}</code>
            `;
            
            bot.sendMessage(chatId, stats, { parse_mode: 'HTML' });
        } catch (e) { 
            console.error(e);
            bot.sendMessage(chatId, "❌ 监控数据读取失败: " + e.message); 
        }
    }

    // /qc 清空数据
    else if (text === '/qc') {
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🧹 仅清空 订单/提现/充值", callback_data: 'qc_transactions' }],
                    [{ text: "💥 ⚠️ 删数据库 (清空所有)", callback_data: 'qc_everything' }],
                    [{ text: "❌ 取消", callback_data: 'qc_cancel' }]
                ]
            }
        };
        bot.sendMessage(chatId, "⚠️ <b>高危操作：请选择清理模式</b>", { parse_mode: 'HTML', ...opts });
    }

  // 设置汇率
    else if (text.startsWith('设置汇率 ')) {
        const val = parseFloat(text.split(' ')[1]);
        if (!isNaN(val)) {
            await setSetting('rate', val);
            bot.sendMessage(chatId, `✅ 汇率已设为: ${val}`);
            await broadcastGlobalUpdate(); // [新增]
        }
    }

    // 设置手续费
    else if (text.startsWith('设置手续费 ')) {
        const val = parseFloat(text.split(' ')[1]);
        if (!isNaN(val)) {
            await setSetting('feeRate', val);
            bot.sendMessage(chatId, `✅ 手续费已设为: ${val}%`);
            await broadcastGlobalUpdate(); // [新增]
        }
    }

    // 设置钱包
    else if (text.startsWith('设置钱包 ')) {
        const addr = text.split(' ')[1];
        if (addr && addr.length > 10) {
            await setSetting('walletAddress', addr);
            bot.sendMessage(chatId, `✅ <b>收款地址已更新</b>\n<code>${addr}</code>`, {parse_mode:'HTML'});
            await broadcastGlobalUpdate(); // [新增]
        } else {
            bot.sendMessage(chatId, "❌ 地址格式不对");
        }
    }

// 数据库修复 (防止 wallet 字段报错)
    else if (text === '/fix_db') {
        try {
            await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet TEXT;');
            await pool.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS msg_type TEXT;');
            
            // [新增] 修复缺失的 source 字段，防止报错
            await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT;');
            await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT;');
            await pool.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS source TEXT;');

            bot.sendMessage(chatId, "✅ 数据库字段修复完成");
        } catch(e) { bot.sendMessage(chatId, "❌ " + e.message); }
    }
});
bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;

    try {
        if (action === 'qc_transactions') {
            await pool.query('TRUNCATE orders, withdrawals');
            await bot.editMessageText("🧹 <b>交易数据（订单、提现）已清空！</b>\n用户和聊天记录保留。", { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
        } else if (action === 'qc_everything') {
            await pool.query('TRUNCATE users, orders, products, hiring, chats, withdrawals, settings');
            await bot.editMessageText("💥 <b>数据库已完全重置！</b>\n所有数据已永久删除。", { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
        } else if (action === 'qc_cancel') {
            await bot.editMessageText("✅ 操作已取消", { chat_id: chatId, message_id: msg.message_id });
        
        // ================= 提现确认 =================
        } else if (action.startsWith('wd_confirm_')) {
            const parts = action.split('_');
            const wdId = parts[2];
            const userId = parts[3];

            await pool.query("UPDATE withdrawals SET status = '已完成' WHERE id = $1", [wdId]);
            
            const notifySid = `user_${userId}`;
            const content = '✅ 您的提现已处理，请查收。';
            
           // 🟢 1. 插入时获取时间 (RETURNING created_at)
            const resDb = await pool.query("INSERT INTO chats (session_id, sender, content, msg_type) VALUES ($1, 'admin', $2, 'text') RETURNING created_at", [notifySid, content]);
            
            // 🟢 2. [新增] 立即广播给前端
            io.to(notifySid).emit('new_message', { 
                session_id: notifySid, 
                sender: 'admin', 
                content: content, 
                msg_type: 'text',
                created_at: resDb.rows[0].created_at 
            });

            // 【新增】告诉前端刷新提现列表状态（变更为已完成）
            io.to(notifySid).emit('order_update');

            const newCaption = msg.caption ? msg.caption + "\n\n✅ <b>已打款</b>" : msg.text + "\n\n✅ <b>已打款</b>";
            const opts = { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } };
            if (msg.caption) await bot.editMessageCaption(newCaption, opts);
            else await bot.editMessageText(newCaption, opts);

        // ================= 提现驳回 =================
        } else if (action.startsWith('wd_reject_')) {
            const parts = action.split('_');
            const wdId = parts[2];
            const userId = parts[3];
            const amount = parseFloat(parts[4]);

            await pool.query("UPDATE withdrawals SET status = '已驳回' WHERE id = $1", [wdId]);
            await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amount, userId]);
            
            // 记录资金明细
            await logBalance(pool, userId, '提现退回', amount, `提现申请(ID:${wdId})被驳回`);

           const notifySid = `user_${userId}`;
            const content = '❌ 您的提现已被驳回，资金已退回余额。';

            // 🟢 1. 插入时获取时间
            const resDb = await pool.query("INSERT INTO chats (session_id, sender, content, msg_type) VALUES ($1, 'admin', $2, 'text') RETURNING created_at", [notifySid, content]);

            // 🟢 2. [新增] 立即广播给前端
            io.to(notifySid).emit('new_message', { 
                session_id: notifySid, 
                sender: 'admin', 
                content: content, 
                msg_type: 'text', 
                created_at: resDb.rows[0].created_at 
            });

            // 【新增】告诉前端刷新余额 (因为钱退回来了)
            io.to(notifySid).emit('order_update');

            const newCaption = msg.caption ? msg.caption + "\n\n❌ <b>已驳回</b>" : msg.text + "\n\n❌ <b>已驳回</b>";
            const opts = { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } };
            if (msg.caption) await bot.editMessageCaption(newCaption, opts);
            else await bot.editMessageText(newCaption, opts);

        // ================= 支付确认 =================
        } else if (action.startsWith('pay_confirm_')) {
            const parts = action.split('_');
            const orderId = parts[2];
            const userId = parts[3];

            const orderRes = await pool.query("SELECT * FROM orders WHERE order_id = $1", [orderId]);
            const order = orderRes.rows[0];

            if (order && order.status !== '已支付') {
                await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [orderId]);
                
                if (order.product_name === '余额充值') {
                    await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [parseFloat(order.usdt_amount), userId]);
                }

               const notifySid = `user_${userId}`;
                const content = '✅ 您的支付已确认，订单正在处理中。';

                // 🟢 1. 插入时获取时间
                const resDb = await pool.query("INSERT INTO chats (session_id, sender, content, msg_type) VALUES ($1, 'admin', $2, 'text') RETURNING created_at", [notifySid, content]);

                // 🟢 2. [新增] 立即广播给前端
                io.to(notifySid).emit('new_message', { 
                    session_id: notifySid, 
                    sender: 'admin', 
                    content: content, 
                    msg_type: 'text', 
                    created_at: resDb.rows[0].created_at 
                });

                // 【新增】告诉前端刷新余额和订单状态
                io.to(notifySid).emit('order_update');

                const newCaption = msg.caption ? msg.caption + "\n\n✅ <b>已确认收款</b>" : "✅ <b>已确认收款</b>";
                await bot.editMessageCaption(newCaption, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
            }

// ================= 支付驳回 (修改版) =================
        } else if (action.startsWith('pay_reject_')) {
            const parts = action.split('_');
            const orderId = parts[2];
            const userId = parts[3];

            await pool.query("UPDATE orders SET status = '待支付', proof = NULL WHERE order_id = $1", [orderId]);

            const notifySid = `user_${userId}`;
            const rejectMsg = `❌ 订单 ${orderId} 支付核实失败。\n原因：客服反应这笔款项未收到,请稍等客服稍后会于你联系。\n订单状态已重置，请核对后重新上传凭证。`;
            
            // 2. 插入聊天记录
            const resDb = await pool.query("INSERT INTO chats (session_id, sender, content, msg_type) VALUES ($1, 'admin', $2, 'text') RETURNING created_at", [notifySid, rejectMsg]);

            // 3. Socket 广播通知前端
            io.to(notifySid).emit('new_message', { 
                session_id: notifySid, 
                sender: 'admin', 
                content: rejectMsg, 
                msg_type: 'text',
                created_at: resDb.rows[0].created_at 
            });

            const newCaption = msg.caption ? msg.caption + "\n\n❌ <b>已驳回 (重置为待支付)</b>" : "❌ <b>已驳回</b>";
            await bot.editMessageCaption(newCaption, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        }
    } catch (e) {
        console.error("TG Callback Error:", e);
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

// 应用全局限流
app.use('/api/', apiLimiter);
// 特别应用登录限流
app.use('/api/user/login', loginLimiter);

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 }
});

// 新增：记录资金变动辅助函数 (修改版：记录余额快照)
const logBalance = async (client, userId, type, amount, remark) => {
    // 先查询当前最新余额
    const res = await client.query("SELECT balance FROM users WHERE id = $1", [userId]);
    const currentBal = res.rows[0] ? res.rows[0].balance : 0;
    
    await client.query(
        "INSERT INTO balance_logs (user_id, type, amount, remark, balance_after) VALUES ($1, $2, $3, $4, $5)",
        [userId, type, amount, remark, currentBal]
    );
};

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
        
const prods = await pool.query('SELECT * FROM products ORDER BY is_pinned DESC, id DESC');
const hiring = await pool.query('SELECT * FROM hiring');
        
        const rate = await getSetting('rate');
        const feeRate = await getSetting('feeRate');
        const announcement = await getSetting('announcement');
        const popup = await getSetting('popup');
        const wallet = await getSetting('walletAddress');

        // [修改] 获取分类并按照数据库中的优先级排序
        const distinctCats = [...new Set(prods.rows.map(p => p.category))];
        const prioritiesRes = await pool.query('SELECT name, priority FROM categories');
        const pMap = {};
        prioritiesRes.rows.forEach(r => pMap[r.name] = r.priority);
        const categories = distinctCats.sort((a, b) => (pMap[b] || 0) - (pMap[a] || 0));

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

// 1.1 缺货登记
app.post('/api/notify-restock', async (req, res) => {
    const { contact, productName } = req.body;
    sendTgNotify(`📢 <b>缺货补货提醒</b>\n商品: ${productName}\n客户联系: ${contact}\n请尽快补货！`);
    res.json({success: true});
});

// 1.2 裂变可视化数据
app.get('/api/user/team', async (req, res) => {
    const { userId } = req.query;
    try {
// 获取我邀请的人
        const teamRes = await pool.query(`
            SELECT id, contact, created_at, 
            (
                SELECT COALESCE(SUM(amount), 0) 
                FROM balance_logs 
                WHERE user_id = $1 
                  AND type = '佣金返利' 
                  AND remark LIKE '好友 ' || users.id || ' %'
            ) as earned
            FROM users WHERE invited_by = $1 ORDER BY created_at DESC
        `, [userId]);
        
        // 计算总收益
        const totalRes = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM balance_logs WHERE user_id = $1 AND type = '佣金返利'", [userId]);
        
        res.json({ success: true, list: teamRes.rows, total: parseFloat(totalRes.rows[0].total) });
    } catch(e) { res.json({success: false, list: [], total: 0}); }
});

// 2. 注册
app.post('/api/user/register', async (req, res) => {
    const { contact, password, uid, inviteCode, source } = req.body; // 【修改】接收 source
    try {
        const check = await pool.query('SELECT id FROM users WHERE contact = $1', [contact]);
        if(check.rows.length > 0) return res.json({success:false, msg:'用户已存在'});

        const id = uid || Math.floor(100000 + Math.random() * 900000);
        // 安全修复：加密密码
        const hashedPassword = await bcrypt.hash(password, 10);
        // 生成我的邀请码 (修改为4位随机码)
        const myInviteCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        let inviterId = null;
        if (inviteCode) {
            // [修改点]：强制转为大写，并去除空格
            const upperInviteCode = inviteCode.toUpperCase().trim(); 
            const inviterRes = await pool.query('SELECT id FROM users WHERE invite_code = $1', [upperInviteCode]);
            if (inviterRes.rows.length > 0) inviterId = inviterRes.rows[0].id;
        }

       await pool.query(
            'INSERT INTO users (id, contact, password, balance, invite_code, invited_by, source) VALUES ($1, $2, $3, 0, $4, $5, $6)', 
            [id, contact, hashedPassword, myInviteCode, inviterId, source || 'xaw888.com'] // 【修改】写入来源
        );
        
        // [新增] 通知后台有新用户
        notifyAdminUpdate();

        res.json({ success: true, isNew: true, userId: id, uid: id, balance: 0, inviteCode: myInviteCode });
    } catch(e) { res.json({success:false, msg: e.message}); }
});

// 3. 登录
app.post('/api/user/login', async (req, res) => {
    const { contact, password } = req.body;
    try {
        const resDb = await pool.query('SELECT * FROM users WHERE contact = $1', [contact]);
        if(resDb.rows.length > 0) {
            const u = resDb.rows[0];
            // 安全修复：比对加密密码
            const match = await bcrypt.compare(password, u.password);
            if (match) {
                res.json({ success: true, userId: u.id, uid: u.id, balance: parseFloat(u.balance), inviteCode: u.invite_code });
            } else {
                res.json({ success: false, msg: '账号或密码错误' });
            }
        } else {
            res.json({ success: false, msg: '账号或密码错误' });
        }
    } catch(e) { res.json({success:false, msg: e.message}); }
});

app.delete('/api/admin/user/:id', adminAuth, async (req, res) => {
    try {
        const uid = req.params.id;
        await pool.query('DELETE FROM users WHERE id = $1', [uid]);
        await pool.query('DELETE FROM orders WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [uid]);
        await pool.query('DELETE FROM chats WHERE session_id = $1', [`user_${uid}`]);
        res.json({success: true});
    } catch(e) {
        res.status(500).json({success: false, msg: e.message});
    }
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

// 6. 提交订单 (安全修复版)
app.post('/api/order', async (req, res) => {
    // 接收 cartItems 而不是 totalAmount
    // 【修改】下方增加了 source
    const { userId, productId, cartItems, paymentMethod, shippingInfo, useBalance, contactInfo, source } = req.body;
    
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // 开启事务

        const userRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        
        let prodName = "";
        let amount = 0;

        // 逻辑分支：购物车结算 vs 单品购买
        if (productId === 'cart') {
            prodName = "购物车商品";
            if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
                throw new Error("购物车为空");
            }

            // 提取ID并查询数据库真实价格
            const itemIds = cartItems.map(i => i.id);
            const dbProdsRes = await client.query('SELECT id, price, name, stock FROM products WHERE id = ANY($1)', [itemIds]);
            const dbProds = dbProdsRes.rows;

            for (const item of cartItems) {
                // [安全修复] 校验购买数量必须为正整数
                if (parseInt(item.quantity) <= 0) throw new Error(`商品数量必须大于0`);

                // 强制转换 ID 为字符串进行比较
                const dbItem = dbProds.find(p => p.id.toString() === item.id.toString());
                if (!dbItem) throw new Error(`商品ID ${item.id} 已下架`);
                if (dbItem.stock < item.quantity) throw new Error(`商品 ${dbItem.name} 库存不足`);
                
                // 后端累加价格 (安全核心)
                amount += parseFloat(dbItem.price) * parseInt(item.quantity);
                
                // 扣减库存
                await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.id]);
            }
        } else {
            // 单品购买
            const prodRes = await client.query('SELECT * FROM products WHERE id = $1', [productId]);
            const prod = prodRes.rows[0];
            if(prod) {
                if (prod.stock <= 0) throw new Error('商品库存不足');
                prodName = prod.name;
                amount = parseFloat(prod.price);
                // [安全修复] 确保库存不会被扣减为负数 (虽然上面检查了，但为了数据库安全建议加个保险)
                await client.query('UPDATE products SET stock = GREATEST(0, stock - 1) WHERE id = $1', [productId]);
            } else {
                throw new Error('商品不存在');
            }
        }

        let finalUSDT = amount;
        if(useBalance && user && parseFloat(user.balance) > 0) {
            const deduct = Math.min(parseFloat(user.balance), amount);
            finalUSDT -= deduct;
            // 扣余额
            await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [deduct, userId]);
            // 记录资金明细
            await logBalance(client, userId, '购物消费', -deduct, `订单 ${prodName} 余额抵扣`);
        }

        const rate = parseFloat(await getSetting('rate'));
        const feeRate = parseFloat(await getSetting('feeRate'));
        const cnyAmount = (finalUSDT * rate * (1 + feeRate/100)).toFixed(2);
        
        // 改良：XAW-5位随机数字
        const orderId = 'XAW-' + Math.floor(10000 + Math.random() * 90000);
        const wallet = await getSetting('walletAddress');
        const finalShippingInfo = { ...shippingInfo, contact_method: contactInfo };

        let orderStatus = '待支付';
        if (finalUSDT <= 0) {
            orderStatus = '已支付';
            // 新增：余额全额支付成功，触发消费返利
            // 注意：这里按商品原价(amount)算返利，还是按实际付出的余额(deduct)算？通常按商品价值算比较大方，或者按deduct算。
            // 这里我们按商品总价值 amount 计算，刺激消费。
            // 由于事务还没提交，我们最好在在这里不await这个辅助函数以免死锁，或者放在COMMIT之后。
            // 为了安全，建议放在 COMMIT 之后执行。
        }

        // 插入订单
        // 【修改】增加了 source 字段
        await client.query(
            `INSERT INTO orders (order_id, user_id, product_name, payment_method, usdt_amount, cny_amount, status, shipping_info, wallet, source, expires_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + INTERVAL '30 minutes')`,
            [orderId, userId, prodName, paymentMethod, finalUSDT.toFixed(4), cnyAmount, orderStatus, JSON.stringify(finalShippingInfo), wallet, source || 'xaw888.com']
        );

        await client.query('COMMIT');

        // === 新增代码开始 ===
        if (orderStatus === '已支付') {
            // 异步执行返利，不阻塞订单响应
            handleReferralBonus(userId, amount, '消费'); 
        }
        // === 新增代码结束 ===

        let tgMsg = `🆕 <b>新订单提醒</b>\n\n单号: <code>${orderId}</code>\n用户: ${user ? user.contact : userId}\n联系: ${contactInfo}\n商品: ${prodName}\n需付: ${finalUSDT.toFixed(4)} USDT`;
        if (finalUSDT <= 0) tgMsg += `\n✅ <b>余额全额抵扣，请直接发货</b>`;
        sendTgNotify(tgMsg);

        // [新增] 通知后台有新订单
        notifyAdminUpdate();

        res.json({ success: true, orderId, usdtAmount: finalUSDT.toFixed(4), cnyAmount, wallet, status: orderStatus });

    } catch(e) {
        await client.query('ROLLBACK');
        console.error(e); 
        res.json({success:false, msg: e.message}); 
    } finally {
        client.release(); 
    }
});

// 7. 获取订单
app.get('/api/order', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT orders.*, products.image_url 
            FROM orders 
            LEFT JOIN products ON orders.product_name = products.name 
            WHERE orders.user_id = $1 
            ORDER BY orders.created_at DESC
        `, [req.query.userId]);
        res.json(result.rows);
    } catch(e) { res.json([]); }
});

app.post('/api/order/cancel', async (req, res) => {
    const { orderId, userId } = req.body;
    try {
        const orderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1 AND user_id = $2', [orderId, userId]);
        const order = orderRes.rows[0];

        if (!order) return res.json({ success: false, msg: '订单不存在' });
        if (order.status !== '待支付') return res.json({ success: false, msg: '无法取消该订单' });

        // [修改] 用户自己取消，状态设为“已关闭”，避免前端显示红色警告
        await pool.query("UPDATE orders SET status = '已关闭' WHERE order_id = $1", [orderId]);

        if (order.product_name !== '余额充值' && order.product_name !== '购物车商品') {
            await pool.query("UPDATE products SET stock = stock + 1 WHERE name = $1", [order.product_name]);
        }

        // [新增] 用户取消订单后，通知后台管理员刷新界面
        notifyAdminUpdate();

        const paidBalance = parseFloat(order.usdt_amount) - parseFloat(order.cny_amount / 7.0); 

        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
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
        
        // 统一格式 XAW-5位随机数字
        const orderId = 'XAW-' + Math.floor(10000 + Math.random() * 90000);
        const wallet = await getSetting('walletAddress');

        await pool.query(
            `INSERT INTO orders (order_id, user_id, product_name, payment_method, usdt_amount, cny_amount, wallet, expires_at) 
             VALUES ($1, $2, '余额充值', $3, $4, $5, $6, NOW() + INTERVAL '30 minutes')`,
       [orderId, userId, method, usdtAmount.toFixed(4), cnyAmount, wallet]
        );

        sendTgNotify(`💰 <b>新充值订单</b>\n单号: <code>${orderId}</code>\n用户: ${user.contact}\n金额: ${usdtAmount} USDT`);
        
        // [新增] 通知后台有充值
        notifyAdminUpdate();

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

// 用户获取自己的资金明细
app.get('/api/user/balance_logs', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM balance_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
        res.json(result.rows);
    } catch(e) { res.status(500).json([]); }
});

// 8. 确认支付凭证
app.post('/api/order/confirm-payment', upload.single('file'), async (req, res) => {
    try {
        const orderId = req.body.orderId;
        const userId = req.body.userId;
        
        if (!req.file) {
            return res.json({success:false, msg:'请选择图片'});
        }

       try {
            await bot.sendPhoto(TG_ADMIN_GROUP_ID, req.file.buffer, {
                caption: `📸 <b>收到支付凭证</b>\n单号: <code>${orderId}</code>\n用户ID: ${userId}\n请核对金额后在后台确认。`,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ 已收到", callback_data: `pay_confirm_${orderId}_${userId}` },
                        { text: "❌ 未收到", callback_data: `pay_reject_${orderId}_${userId}` }
                    ]]
                }
            });
        } catch (tgErr) {
            console.error("TG发送失败:", tgErr);
        }

        // [修改] 确保状态更新为待审核，proof 字段只存标记，不存文件
        await pool.query("UPDATE orders SET proof = 'TG_SENT', status = '待审核' WHERE order_id = $1", [orderId]);
        
		notifyAdminUpdate();
		res.json({success:true});
    } catch(e) { 
        console.error(e);
        // 即使TG发送偶尔失败，也返回成功让用户放心，后台可联系
        res.json({success:false, msg: "网络繁忙，请联系客服核实"}); 
    }
});

// 9. 二维码异常
app.post('/api/order/report-qr-issue', async (req, res) => {
    sendTgNotify(`🚨 <b>二维码异常反馈</b>\n单号: <code>${req.body.orderId}</code>`);
    res.json({success:true});
});

// 10. 提现申请
app.post('/api/withdraw', upload.single('file'), async (req, res) => {
    try {
        const userId = req.body.userId;
        const amount = parseFloat(req.body.amount);
        
        // [安全修复] 必须校验金额为正数
        if (isNaN(amount) || amount <= 0) {
            return res.json({ success: false, msg: '金额必须大于0' });
        }

        const method = req.body.method;
        const addressText = req.body.address || '无账号信息';

        const userRes = await pool.query('SELECT balance, contact FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];

        if (user.balance < amount) return res.json({ success: false, msg: '余额不足' });

        await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, userId]);
        
        // [新增] 记录提现明细 (负数)
        await logBalance(pool, userId, '提现申请', -amount, `申请提现到 ${method}`);

        let logAddress = addressText;
        if (req.file)
            logAddress = `[${method}] 收款码已发送`;

        // [修改] 先插入数据库获取ID
        const insertRes = await pool.query('INSERT INTO withdrawals (user_id, amount, address) VALUES ($1, $2, $3) RETURNING id', [userId, amount, logAddress]);
        const withdrawId = insertRes.rows[0].id;

        // [修改] 定义按钮
        const options = {
            caption: `💸 <b>新提现申请 (${method})</b>\n用户: ${user.contact} (ID: ${userId})\n金额: ${amount} USDT\n账号: ${addressText}\nID: ${withdrawId}`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ 已打款", callback_data: `wd_confirm_${withdrawId}_${userId}` },
                    { text: "❌ 驳回", callback_data: `wd_reject_${withdrawId}_${userId}_${amount}` }
                ]]
            }
        };

     if (req.file) {
            await bot.sendPhoto(TG_ADMIN_GROUP_ID, req.file.buffer, options);
        } else {
            await bot.sendMessage(TG_ADMIN_GROUP_ID, options.caption, options);
        }
        
        // [新增] 通知后台有提现申请
        notifyAdminUpdate();

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.json({ success: false, msg: 'Error' });
    }
});

// 11. 聊天
app.post('/api/chat/send', async (req, res) => {
    // 增加 msgType 参数，默认为 'text'
    // 【修改】接收 source
    const { sessionId, text, msgType, source } = req.body; 
    const type = msgType || 'text';
    
    try {
        // 存入数据库
        // 【修改】写入 source
        const result = await pool.query(
            'INSERT INTO chats (session_id, sender, content, msg_type, source) VALUES ($1, $2, $3, $4, $5) RETURNING created_at', 
            [sessionId, 'user', text, type, source || 'xaw888.com']
        );
        
        const created_at = result.rows[0].created_at;

        // 1. 发送 TG 通知 (如果是图片，提示是图片)
        const tgContent = type === 'image' ? '[发送了一张图片]' : text;
        sendTgNotify(`💬 <b>客服消息</b>\n来自: ${sessionId}\n内容: ${tgContent}`);

        // 2. Socket 广播给管理员 (管理员在监听 'admin_room' 或者具体 session)
        // 这里为了简单，我们让前端监听自己的 session_id，后台监听特定事件，或者直接推给所有人
        // 实际上，管理员前端也应该监听这个 session_id 的房间
        io.emit('new_message', { 
            session_id: sessionId, 
            sender: 'user', 
            content: text, 
            msg_type: type,
            created_at: created_at
        });

        res.json({ success: true });
    } catch(e) { 
        console.error(e);
        res.json({success:false}); 
    }
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
        
        // 记录日志
        let remark = type === 'set' ? `客服重置余额为 ${val}` : `客服后台操作 ${type}`;
let logAmount = type === 'add' ? val : (type === 'subtract' ? -val : 0); 
        
        // 将类型显示为 '客服后台充值'
        await logBalance(pool, userId, '客服后台充值', logAmount, remark);

        // 【新增】实时通知前端刷新余额
        io.to(`user_${userId}`).emit('order_update');

        res.json({success:true});
    } catch(e) { res.json({success:false}); }
});

app.post('/api/admin/chat/initiate', adminAuth, async (req, res) => {
    const sid = `user_${req.body.userId}`;
    try {
        await pool.query("ALTER TABLE chats ADD COLUMN IF NOT EXISTS msg_type TEXT DEFAULT 'text'");
        
        const result = await pool.query("INSERT INTO chats (session_id, sender, content, msg_type, is_initiate) VALUES ($1, 'admin', '客服已接入', 'text', TRUE) RETURNING created_at", [sid]);
        
        io.to(sid).emit('new_message', { 
            session_id: sid, 
            sender: 'admin', 
            content: '客服已接入', 
            msg_type: 'text',
            created_at: result.rows[0].created_at
        });

        res.json({success:true, sessionId: sid});
    } catch (e) {
        console.error(e);
        res.status(500).json({success:false, msg: e.message});
    }
});

app.post('/api/admin/chat/read', adminAuth, async (req, res) => {
    const { sessionId } = req.body;
    await pool.query("UPDATE chats SET is_read = TRUE WHERE session_id = $1 AND sender = 'user'", [sessionId]);
    res.json({success:true});
});

app.post('/api/chat/upload', upload.single('file'), async (req, res) => {
    if (req.file) {
        try {
            const url = await uploadToCloud(req.file.buffer);
            res.json({ success: true, url: url });
        } catch (e) {
            res.json({ success: false, error: 'Upload failed' });
        }
    } else {
        res.json({ success: false, error: 'No file' });
    }
});

app.post('/api/admin/reply', adminAuth, async (req, res) => {
    const { sessionId, text, msgType } = req.body;
    const type = msgType || 'text';

    try {
        await pool.query("ALTER TABLE chats ADD COLUMN IF NOT EXISTS msg_type TEXT DEFAULT 'text'");

        const result = await pool.query(
            "INSERT INTO chats (session_id, sender, content, msg_type) VALUES ($1, 'admin', $2, $3) RETURNING created_at", 
            [sessionId, text, type]
        );

        io.to(sessionId).emit('new_message', {
            session_id: sessionId,
            sender: 'admin',
            content: text,
            msg_type: type,
            created_at: result.rows[0].created_at
        });

        res.json({success:true});
    } catch(e) {
        res.status(500).json({success:false, msg: e.message});
    }
});

app.post('/api/upload', adminAuth, upload.single('file'), async (req, res) => {
    if (req.file) {
        try {
            // 上传到 Cloudinary，返回 URL
            const url = await uploadToCloud(req.file.buffer);
            res.json({ success: true, url: url });
        } catch (e) {
            console.error(e);
            res.json({ success: false, error: 'Upload failed' });
        }
    } else {
        res.json({ success: false, error: 'No file' });
    }
});

app.post('/api/admin/order/ship', adminAuth, async (req, res) => {
    const { orderId, trackingNumber } = req.body;
    try {
        // [修改] 更新状态并返回 user_id，以便通知
        const result = await pool.query("UPDATE orders SET tracking_number = $1, status = '已发货' WHERE order_id = $2 RETURNING user_id", [trackingNumber, orderId]);
        
        // [新增] 实时通知该用户刷新订单状态
        if(result.rows.length > 0) {
            io.to(`user_${result.rows[0].user_id}`).emit('order_update');
        }

        sendTgNotify(`🚚 <b>订单已发货</b>\n单号: <code>${orderId}</code>\n物流: ${trackingNumber}`);
        res.json({success:true});
    } catch(e) {
        console.error(e);
        res.status(500).json({success:false, msg:e.message});
    }
});

app.post('/api/admin/order/upload_qrcode', adminAuth, upload.single('qrcode'), async (req, res) => {
    const { orderId } = req.body;
    if(req.file) {
       try {
           // [修改] 上传到 Cloudinary，获取短链接 URL
           const url = await uploadToCloud(req.file.buffer);
           
           // [修改] 存入 URL
           const result = await pool.query("UPDATE orders SET qrcode_url = $1, expires_at = NOW() + INTERVAL '30 minutes' WHERE order_id = $2 RETURNING user_id", [url, orderId]);
           const userId = result.rows[0]?.user_id;

           sendTgNotify(`✅ <b>收款码已上传</b>\n单号: <code>${orderId}</code>`);
           
           // 实时通知该用户刷新订单
           if(userId) {
               io.to(`user_${userId}`).emit('order_update');
           }

           // [新增] 通知后台刷新 (你之前漏了这个)
           notifyAdminUpdate();
    
           res.json({success:true});
       } catch (e) {
           console.error(e);
           res.json({success:false, msg: 'Upload failed'});
       }
    } else res.json({success:false});
});

app.post('/api/admin/update/announcement', adminAuth, async (req, res) => {
    await setSetting('announcement', req.body.text);
    await broadcastGlobalUpdate(); // [新增] 广播通知
    res.json({success:true});
});
app.post('/api/admin/update/popup', adminAuth, async (req, res) => {
    await setSetting('popup', req.body.open);
    await broadcastGlobalUpdate(); // [新增] 广播通知
    res.json({success:true});
});
// [新增] 更新分类优先级
app.post('/api/admin/category/priority', adminAuth, async (req, res) => {
    const { name, priority } = req.body;
    try {
        // 使用 upsert 语法 (如果存在则更新，不存在则插入)
        await pool.query(
            'INSERT INTO categories (name, priority) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET priority = $2',
            [name, parseInt(priority)]
        );
        // 立即广播更新前端
        await broadcastGlobalUpdate();
        res.json({success: true});
    } catch(e) {
        res.status(500).json({success: false, msg: e.message});
    }
});

// 商品增删改
app.post('/api/admin/product', adminAuth, upload.single('file'), async (req, res) => {
    try {
        const { name, price, stock, category, type, desc } = req.body;
        let imageUrl = req.body.imageUrl || ''; // 兼容旧逻辑

        // 如果上传了新文件，优先使用文件上传到 Cloudinary
        if (req.file) {
            imageUrl = await uploadToCloud(req.file.buffer);
        }
        
        // 确保是 JSON 格式字符串存储，兼容前端解析
        const imageJson = imageUrl.startsWith('[') ? imageUrl : JSON.stringify([imageUrl]);

        await pool.query(
            'INSERT INTO products (id, name, price, stock, category, type, description, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [Date.now(), name, price, stock, category, type, desc, imageJson]
        );
        
        // 立即广播更新
        await broadcastGlobalUpdate();

        res.json({success:true});
    } catch (e) {
        console.error(e);
        res.json({success:false, msg: e.message});
    }
});
app.put('/api/admin/product/:id', adminAuth, async (req, res) => {
    const { name, price, stock, category, type, desc, imageUrl } = req.body;
    await pool.query(
        'UPDATE products SET name=$1, price=$2, stock=$3, category=$4, type=$5, description=$6, image_url=$7 WHERE id=$8',
        [name, price, stock, category, type, desc, imageUrl, req.params.id]
    );
    // 立即广播更新
    await broadcastGlobalUpdate();
    res.json({success:true});
});
app.delete('/api/admin/product/:id', adminAuth, async (req, res) => {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    // 立即广播更新
    await broadcastGlobalUpdate();
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
    await broadcastGlobalUpdate(); // [新增] 广播通知
    res.json({success:true});
});
app.post('/api/admin/confirm_pay', adminAuth, async (req, res) => {
    const { orderId } = req.body;
    const client = await pool.connect(); 

    try {
        await client.query('BEGIN');

        // 1. 锁定订单行
        const orderRes = await client.query("SELECT * FROM orders WHERE order_id = $1 FOR UPDATE", [orderId]);
        const order = orderRes.rows[0];
        
        if (!order) {
            await client.query('ROLLBACK');
            return res.json({success:false, msg:'订单不存在'});
        }

        // 2. 只有当状态不是'已支付'时才处理
        if (order.status !== '已支付') {
            // 更新状态
            await client.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [orderId]);
            
            // 【关键修改】去除空格后，严格判断是否为 '余额充值'
            // 只有完全等于 '余额充值' 四个字，才当作充值处理
            // 其他所有情况（包括 '王者充值'、'话费充值' 等）全部都会进入 else 触发返利！
            const cleanName = order.product_name ? order.product_name.trim() : '';

            if (cleanName === '余额充值') {
                // === 这是一个纯充值余额的订单 ===
                const amt = parseFloat(order.usdt_amount);
                
                // 给用户加余额
                await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amt, order.user_id]);
                
                // 记录流水
                const balRes = await client.query("SELECT balance FROM users WHERE id = $1", [order.user_id]);
                const currentBal = balRes.rows[0] ? balRes.rows[0].balance : 0;
                
                await client.query(
                    "INSERT INTO balance_logs (user_id, type, amount, remark, balance_after) VALUES ($1, $2, $3, $4, $5)",
                    [order.user_id, '余额充值', amt, `订单 ${orderId} 充值到账`, currentBal]
                );

            } else {
                // === 这就是一个购买商品的订单（不管名字里有没有“充值”二字） ===
                // 【强制返利】只要走到这里，必须执行返利逻辑
                console.log(`[返利触发] 订单: ${orderId}, 商品: ${cleanName}, 用户: ${order.user_id}`);
                
                try {
                    // 使用 await 确保返利逻辑执行完
                    await handleReferralBonus(order.user_id, parseFloat(order.usdt_amount), '消费');
                } catch (bonusErr) {
                    console.error("❌ 返利发放失败:", bonusErr);
                    // 即使返利报错，也不要回滚订单状态，保证用户能收到货
                }
            }
            
            await client.query('COMMIT');

            // 通知前端刷新
            io.to(`user_${order.user_id}`).emit('order_update');
            notifyAdminUpdate();

            res.json({success:true});
        } else {
            await client.query('ROLLBACK');
            res.json({success:false, msg:'订单状态已经是已支付，请勿重复操作'});
        }
    } catch(e) {
        await client.query('ROLLBACK');
        console.error("确认支付出错:", e);
        res.status(500).json({success:false, msg:e.message});
    } finally {
        client.release();
    }
});
// ================= 新增功能区域 =================

// USDT 自动回调接口 (适配 Epusdt 或类似 Webhook)
app.post('/api/callback/usdt_notify', async (req, res) => {
    // 假设 webhook 发送: { order_id, amount, status, signature }
    const { order_id, amount, status } = req.body;
    
    // 1. 这里应该验证签名(signature)以确保安全，此处简化
    if (status !== 2 && status !== 'success') return res.send('ignored'); // 2通常代表成功

    try {
        const orderRes = await pool.query("SELECT * FROM orders WHERE order_id = $1", [order_id]);
        const order = orderRes.rows[0];

        if (order && order.status === '待支付') {
            // 校验金额是否一致 (允许 0.01 误差)
            if (Math.abs(parseFloat(amount) - parseFloat(order.usdt_amount)) < 0.1) {
                await pool.query("UPDATE orders SET status = '已支付' WHERE order_id = $1", [order_id]);
                
// 如果是充值订单，增加余额
                if (order.product_name === '余额充值') {
                    // 先给用户加余额 (这段逻辑原来在 handleRechargeSuccess 里，现在提取出来)
                    await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [parseFloat(amount), order.user_id]);
                    
                    // [修改] 关闭充值返利 (注释掉下面这行)
                    // await handleReferralBonus(order.user_id, parseFloat(amount), '充值');
                } else {
                    // 如果是直接购买商品，触发消费返利 (保持不变，确保购买商品有返利)
                    await handleReferralBonus(order.user_id, parseFloat(amount), '消费');
                }

            // 【新增】关键：通知前端刷新余额和订单状态
            io.to(`user_${order.user_id}`).emit('order_update');

            sendTgNotify(`🤖 <b>USDT 自动回调成功</b>\n单号: ${order_id}\n金额: ${amount}`);
            res.send('success');
        } else {
            res.send('amount_mismatch');
        }
    } else {
            res.send('ok'); // 订单已处理
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('error');
    }
});

// 通用辅助函数：处理返利 (充值或消费)
async function handleReferralBonus(userId, amount, type) {
    // type: '充值返利' 或 '消费返利'
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 检查是否有邀请人
        const uRes = await client.query("SELECT invited_by FROM users WHERE id = $1", [userId]);
        const inviterId = uRes.rows[0]?.invited_by;

        if (inviterId) {
            const bonus = amount * 0.05; // 5% 返利
            if (bonus > 0) {
               // 给邀请人加钱
                await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [bonus, inviterId]);
                
                // 记录资金明细
                await logBalance(client, inviterId, '佣金返利', bonus, `好友 ${userId} ${type} ${amount} USDT`);

                // 通知邀请人
                const notifySid = `user_${inviterId}`;
                const content = `💰 恭喜！您的好友完成了${type} (${amount} USDT)，您获得 ${bonus.toFixed(4)} USDT 返利！`;
                const msgRes = await client.query("INSERT INTO chats (session_id, sender, content, msg_type) VALUES ($1, 'admin', $2, 'text') RETURNING created_at", [notifySid, content]);
                
                // 实时推送消息
                io.to(notifySid).emit('new_message', { 
                    session_id: notifySid, sender: 'admin', content: content, msg_type: 'text', created_at: msgRes.rows[0].created_at 
                });

                // [新增] 关键：通知前端刷新数据(余额、邀请列表等)，这样不需要轮询也能看到钱到账
                io.to(notifySid).emit('order_update');
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Referral Bonus Error:", e);
    } finally {
        client.release();
    }
}

// 资金明细接口 (替换审计日志) - 支持按用户ID筛选
app.get('/api/admin/balance_logs', adminAuth, async (req, res) => {
    try {
        const { userId } = req.query;
        let query = `
            SELECT b.*, u.contact 
            FROM balance_logs b
            LEFT JOIN users u ON b.user_id = u.id 
        `;
        const params = [];
        
        if (userId) {
            query += ` WHERE b.user_id = $1 `;
            params.push(userId);
        }
        
        query += ` ORDER BY b.created_at DESC LIMIT 200`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch(e) { 
        console.error(e);
        res.status(500).json([]); 
    }
});

// 管理员强制取消订单 (设置状态为'已取消'，触发前端警告)
app.post('/api/admin/order/cancel', adminAuth, async (req, res) => {
    const { orderId } = req.body;
    try {
        const client = await pool.connect();
        await client.query('BEGIN');
        
        const orderRes = await client.query("SELECT * FROM orders WHERE order_id = $1", [orderId]);
        const order = orderRes.rows[0];

        if (!order) throw new Error('订单不存在');

        // 更新状态为 已取消
        await client.query("UPDATE orders SET status = '已取消' WHERE order_id = $1", [orderId]);

        // 如果该订单使用了余额支付，需要退款
        // 注意：这里只退还余额支付的部分，如果usdt_amount全额支付则退0（逻辑视具体需求定，这里假设只恢复库存，不自动退款，需人工退）
        // 简单起见，这里只回滚库存
        if (order.product_name !== '余额充值' && order.product_name !== '购物车商品') {
            await client.query("UPDATE products SET stock = stock + 1 WHERE name = $1", [order.product_name]);
        }

        await client.query('COMMIT');
        
        // 【新增】告诉前端刷新订单状态（变更为已取消）
        io.to(`user_${order.user_id}`).emit('order_update');

        client.release();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});


// ==========================================
// 🚀 安全启动流程 (确保数据库表存在后再启动)
// ==========================================
const startServer = async () => {
    try {
        console.log("⏳ 1. 正在检查/创建数据库表结构...");
        // 等待数据库完全准备好 (IF NOT EXISTS 会确保如果表存在就不重复建)
        await initDB(); 
        console.log("✅ 数据库表结构准备就绪");

        console.log("⏳ 2. 正在启动 Telegram 机器人...");
        // 数据库好了，手动启动机器人
        await bot.startPolling();
        console.log("✅ 机器人已上线");

       console.log("⏳ 3. 正在启动 Web 服务器...");
        // [修改] 使用 server.listen 而不是 app.listen
        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        }); // <--- 注意这里：必须有 }); 这三个符号

    } catch (error) {
        console.error("❌ 启动失败，请检查数据库连接:", error);
        process.exit(1); 
    }
};

startServer();
