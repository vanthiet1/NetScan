const TelegramBot = require('node-telegram-bot-api');
const tracker = require('./device-tracker');

const BOT_TOKEN = '8615397892:AAEdL8pi8SbwjndlF4a5c5RUxaKPsNKpmh8';

let bot;
const chatIds = new Set();

// --- Helpers ---

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

// --- Bot setup ---

function start() {
    try {
        bot = new TelegramBot(BOT_TOKEN, { polling: true });

        bot.onText(/\/start/, (msg) => {
            chatIds.add(msg.chat.id);
            bot.sendMessage(msg.chat.id,
                '🎉 <b>Chào mừng đến NetScan Pro Bot!</b>\n\n' +
                'Các lệnh khả dụng:\n' +
                '📊 /report - Xem báo cáo hôm nay\n' +
                '🟢 /online - Xem thiết bị đang online\n\n' +
                '<i>Bot sẽ gửi báo cáo tự động hằng ngày lúc 22:00.</i>',
                { parse_mode: 'HTML' }
            );
        });

        bot.onText(/\/report/, async (msg) => {
            chatIds.add(msg.chat.id);
            const text = await buildDailyReport();
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        bot.onText(/\/online/, async (msg) => {
            chatIds.add(msg.chat.id);
            const text = await buildOnlineMsg();
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        // Daily report at 22:00 Vietnam time (UTC+7)
        scheduleDailyReport();

        console.log('[TelegramBot] Started');
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

function stop() {
    if (bot) bot.stopPolling();
}

module.exports = { start, stop };
