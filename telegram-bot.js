const TelegramBot = require('node-telegram-bot-api');
const tracker = require('./device-tracker');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const Store = require('electron-store');
const store = new Store();

let bot;
const chatIds = new Set(store.get('telegram_chat_ids', []));

// --- Helpers ---

function getVendor(mac) {
    if (!mac || mac === '00:00:00:00:00:00' || mac === 'Unknown') return 'Không xác định';
    try {
        const ouiPath = path.join(__dirname, 'oui.json');
        if (fs.existsSync(ouiPath)) {
            const ouiData = JSON.parse(fs.readFileSync(ouiPath, 'utf8'));
            const prefix = mac.substring(0, 8).toUpperCase();
            if (ouiData[prefix]) return ouiData[prefix];
        }
    } catch (e) { }
    return 'Không xác định';
}

function guessOS(ip) {
    return new Promise((resolve) => {
        const command = process.platform === 'win32' ? `ping -n 1 -w 1000 ${ip}` : `ping -c 1 -W 1 ${ip}`;
        exec(command, (error, stdout) => {
            if (error) return resolve('Unknown');
            const ttlMatch = stdout.match(/TTL=(\d+)/i) || stdout.match(/ttl=(\d+)/i);
            if (ttlMatch) {
                const ttl = parseInt(ttlMatch[1]);
                if (ttl <= 64) return resolve('Linux/Android/iOS');
                if (ttl <= 128) return resolve('Windows');
                if (ttl <= 255) return resolve('Network Gear');
            }
            resolve('Unknown');
        });
    });
}

function guessDeviceType(vendor) {
    if (!vendor || vendor === 'Không xác định') return 'PC/Other';
    const lowerVendor = vendor.toLowerCase();
    if (lowerVendor.includes('apple')) return 'Mac/iPhone';
    if (lowerVendor.includes('samsung') || lowerVendor.includes('huawei') || lowerVendor.includes('xiaomi') || lowerVendor.includes('oppo') || lowerVendor.includes('vivo')) return 'Mobile';
    if (lowerVendor.includes('cisco') || lowerVendor.includes('tp-link') || lowerVendor.includes('ubiquiti') || lowerVendor.includes('mikrotik') || lowerVendor.includes('d-link') || lowerVendor.includes('netgear') || lowerVendor.includes('vietnam post')) return 'Router/Network Gear';
    if (lowerVendor.includes('hp') || lowerVendor.includes('canon') || lowerVendor.includes('epson') || lowerVendor.includes('brother')) return 'Máy in (Printer)';
    if (lowerVendor.includes('sony') || lowerVendor.includes('lg') || lowerVendor.includes('panasonic') || lowerVendor.includes('hikvision') || lowerVendor.includes('dahua')) return 'Media/Camera';
    return 'PC/Other';
}

function fmt(seconds) {
    if (!seconds || seconds <= 0) return '0 phút';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m} phút`;
}

function fmtTime(date) {
    if (!date) return '--:--';
    const d = new Date(date);
    const local = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    return local.toISOString().substring(11, 16);
}

function esc(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Report builders (HTML parse mode) ---

async function buildDailyReport() {
    const report = await tracker.getTodayReport();
    if (!report) return '❌ Không thể kết nối database.';

    const { sessions, states, date } = report;
    const onlineCount = states.filter(s => s.isOnline).length;
    const allIPs = new Set(sessions.map(s => s.ip));
    const totalDevices = allIPs.size;

    // Group sessions by IP
    const byIP = {};
    for (const s of sessions) {
        if (!byIP[s.ip]) byIP[s.ip] = { name: s.name, mac: s.mac, sessions: [] };
        byIP[s.ip].sessions.push(s);
        if (s.name && s.name !== s.ip) byIP[s.ip].name = s.name;
    }

    let msg = `📊 <b>NetScan Pro - Báo Cáo Ngày</b>\n`;
    msg += `📅 Ngày: <code>${date}</code>\n\n`;
    msg += `📈 <b>Tổng quan:</b>\n`;
    msg += `├ Thiết bị phát hiện: <b>${totalDevices}</b>\n`;
    msg += `├ Đang online: <b>${onlineCount}</b>\n`;
    msg += `└ Đang offline: <b>${Math.max(0, totalDevices - onlineCount)}</b>\n\n`;
    msg += `📋 <b>Chi tiết hoạt động:</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;

    let idx = 1;
    for (const [ip, data] of Object.entries(byIP)) {
        const state = states.find(s => s.ip === ip);
        const isOnline = state?.isOnline;
        const icon = isOnline ? '🟢' : '🔴';
        const displayName = esc(data.name || ip);

        let totalDur = 0;
        const lines = [];

        for (const s of data.sessions) {
            const on = fmtTime(s.onlineAt);
            if (s.offlineAt) {
                const off = fmtTime(s.offlineAt);
                lines.push(`   🟢 ${on} → 🔴 ${off} (${fmt(s.duration)})`);
                totalDur += s.duration;
            } else {
                const dur = Math.round((Date.now() - new Date(s.onlineAt).getTime()) / 1000);
                lines.push(`   🟢 ${on} → ⏳ Đang online (${fmt(dur)})`);
                totalDur += dur;
            }
        }

        msg += `\n${idx}. ${icon} <b>${displayName}</b>\n`;
        msg += `   📍 <code>${ip}</code> | <code>${data.mac}</code>\n`;
        msg += lines.join('\n') + '\n';
        msg += `   ⏱️ Tổng: <b>${fmt(totalDur)}</b>\n`;
        idx++;
    }

    if (totalDevices === 0) {
        msg += '\n<i>Chưa có dữ liệu hoạt động hôm nay.</i>\n';
    }

    return msg;
}

async function buildOnlineMsg() {
    const devices = await tracker.getOnlineDevices();

    if (devices.length === 0) {
        return '🔴 <b>Không có thiết bị nào đang online.</b>';
    }

    let msg = `🟢 <b>Thiết Bị Đang Online (${devices.length})</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;

    for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        const name = esc(d.name || d.ip);
        const since = fmtTime(d.currentSessionStart);
        const dur = d.currentSessionStart
            ? Math.round((Date.now() - new Date(d.currentSessionStart).getTime()) / 1000)
            : 0;

        msg += `\n${i + 1}. <b>${name}</b>\n`;
        msg += `   📍 IP: <code>${d.ip}</code>\n`;
        msg += `   🔗 MAC: <code>${d.mac}</code>\n`;
        msg += `   🕐 Online từ: ${since}\n`;
        msg += `   ⏱️ Thời gian: ${fmt(dur)}\n`;
    }

    return msg;
}

async function buildStatsReport(days = 7) {
    const stats = await tracker.getUsageStats(days);
    if (!stats) return '❌ Không thể kết nối database.';

    if (stats.length === 0) {
        return `📊 <b>Thống kê ${days} ngày qua</b>\n<i>Chưa có dữ liệu.</i>`;
    }

    let msg = `📊 <b>Thống Kê Sử Dụng (${days} ngày qua)</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;

    for (let i = 0; i < Math.min(stats.length, 15); i++) {
        const s = stats[i];
        const name = esc(s.name);
        msg += `\n${i + 1}. <b>${name}</b>\n`;
        msg += `   ⏱️ Tổng: <b>${fmt(s.totalDuration)}</b> (${s.sessionCount} lần)\n`;
        msg += `   📍 IP: <code>${s.ip}</code>\n`;
    }

    return msg;
}

// --- Bot setup ---


function start() {
    try {
        bot = new TelegramBot(BOT_TOKEN, { polling: true });

        bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            if (!chatIds.has(chatId)) {
                chatIds.add(chatId);
                store.set('telegram_chat_ids', Array.from(chatIds));
            }

            bot.sendMessage(chatId, "🚀 <b>NetScan Pro Bot</b> đã sẵn sàng!\n\nTôi sẽ thông báo cho bạn ngay khi có thiết bị mới kết nối vào mạng.\n\nCác lệnh khả dụng:\n/stats - Thống kê sử dụng 7 ngày\n/online - Các thiết bị đang online\n/report - Báo cáo hoạt động hôm nay\n/test - Kiểm tra kết nối", { parse_mode: 'HTML' });
        });

        bot.onText(/\/test/, (msg) => {
            bot.sendMessage(msg.chat.id, "✅ Kết nối tới Bot Telegram thành công! Hệ thống cảnh báo đang hoạt động.");
        });

        bot.onText(/\/report/, async (msg) => {
            chatIds.add(msg.chat.id);
            store.set('telegram_chat_ids', Array.from(chatIds));
            const text = await buildDailyReport();
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        bot.onText(/\/online/, async (msg) => {
            chatIds.add(msg.chat.id);
            store.set('telegram_chat_ids', Array.from(chatIds));
            const text = await buildOnlineMsg();
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        bot.onText(/\/stats/, async (msg) => {
            chatIds.add(msg.chat.id);
            store.set('telegram_chat_ids', Array.from(chatIds));
            const text = await buildStatsReport(7);
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        // Daily report at 22:00 Vietnam time (UTC+7)
        scheduleDailyReport();

        // Notify startup
        if (chatIds.size > 0) {
            for (const id of chatIds) {
                bot.sendMessage(id, "🔔 <b>Hệ thống giám sát NetScan Pro đã khởi động.</b>\nCảnh báo Real-time đang hoạt động...", { parse_mode: 'HTML' }).catch(() => { });
            }
        }

        console.log(`[TelegramBot] Started with ${chatIds.size} users`);
    } catch (err) {
        console.error('[TelegramBot] Error:', err.message);
    }
}

function scheduleDailyReport() {
    let lastSentDate = '';

    setInterval(async () => {
        const now = new Date();
        const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
        const h = local.getUTCHours();
        const today = local.toISOString().split('T')[0];

        // Send once at 22:xx
        if (h === 22 && lastSentDate !== today) {
            lastSentDate = today;
            await sendReportToAll();
        }
    }, 60 * 1000);
}

async function sendReportToAll() {
    if (chatIds.size === 0) return;
    const text = await buildDailyReport();
    for (const id of chatIds) {
        try {
            await bot.sendMessage(id, text, { parse_mode: 'HTML' });
        } catch (err) {
            console.error(`[TelegramBot] Send failed ${id}:`, err.message);
        }
    }
}

async function sendAlert(device, type) {
    if (chatIds.size === 0 || !bot) return;

    const icon = type === 'online' ? '🟢' : '🔴';
    const title = type === 'online' ? 'Thiết bị vừa kết nối' : 'Thiết bị đã ngắt kết nối';

    const customNames = store.get('customNames', {});
    const nameStr = customNames[device.mac] || (device.name && device.name !== '?' && device.name !== device.ip ? device.name : `Thiết bị ${device.ip}`);
    const name = esc(nameStr);

    let msg = `${icon} <b>${title}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `👤 Tên: <b>${name}</b>\n`;
    msg += `📍 IP: <code>${device.ip}</code>\n`;
    if (device.mac) msg += `🔗 MAC: <code>${device.mac}</code>\n`;
    msg += `⏰ Thời gian: ${new Date().toLocaleTimeString('vi-VN')}\n`;

    for (const id of chatIds) {
        try {
            await bot.sendMessage(id, msg, { parse_mode: 'HTML' });
        } catch (err) { }
    }
}

async function sendScanReport(devices) {
    if (chatIds.size === 0 || !bot) return;

    let headerMsg = `🔍 <b>Kết Quả Quét Mạng Tổng Hợp</b>\n`;
    headerMsg += `━━━━━━━━━━━━━━━━━━\n`;
    headerMsg += `📱 Tổng số thiết bị: <b>${devices.length}</b>\n`;

    // Thống kê lịch sử trong ngày
    let historyStats = {};
    const reportData = await tracker.getTodayReport();
    if (reportData && reportData.sessions) {
        reportData.sessions.forEach(s => {
            if (!historyStats[s.ip]) historyStats[s.ip] = 0;
            historyStats[s.ip] += s.duration;
            if (!s.offlineAt) {
                historyStats[s.ip] += Math.round((Date.now() - new Date(s.onlineAt).getTime()) / 1000);
            }
        });
    }

    if (!reportData) {
        headerMsg += `\n⚠️ <i>Lịch sử không khả dụng (Lỗi MongoDB).</i>`;
    }

    for (const id of chatIds) {
        try {
            await bot.sendMessage(id, headerMsg, { parse_mode: 'HTML' });
        } catch (err) { }
    }

    const CHUNK_SIZE = 8; // Small chunks for table readability
    const customNames = store.get('customNames', {});

    for (let i = 0; i < devices.length; i += CHUNK_SIZE) {
        const chunk = devices.slice(i, i + CHUNK_SIZE);
        let msg = `<pre>`;
        msg += `STT | IP      | TÊN & HĐH\n`;
        msg += `----|---------|------------------\n`;
        
        for (let j = 0; j < chunk.length; j++) {
            const d = chunk[j];
            const idx = (i + j + 1).toString().padEnd(3);
            const ipTail = d.ip.split('.').pop().padEnd(7);
            const name = (customNames[d.mac] || d.name || d.ip).substring(0, 12);
            const os = (d.os || '??').substring(0, 4);
            
            msg += `${idx}| .${ipTail}| ${name} (${os})\n`;
        }
        msg += `</pre>\n`;
        
        // Detailed cards for the same chunk
        msg += `<b>Chi tiết nhóm ${Math.floor(i/CHUNK_SIZE) + 1}:</b>\n`;
        for (let j = 0; j < chunk.length; j++) {
            const d = chunk[j];
            const name = esc(customNames[d.mac] || d.name || d.ip);
            const vendor = esc(d.vendor || 'Unknown');
            const type = esc(d.deviceType || 'PC');
            
            msg += `🔹 <b>${name}</b> (${d.ip})\n`;
            msg += `   └ 🏭 ${vendor} | 🖥️ ${type} | 🔗 ${d.mac.substring(0, 8)}\n`;
        }

        for (const id of chatIds) {
            try {
                await bot.sendMessage(id, msg, { parse_mode: 'HTML' });
            } catch (err) { }
        }
    }
}

function stop() {
    if (bot) bot.stopPolling();
}

module.exports = { start, stop, sendAlert, sendScanReport };
