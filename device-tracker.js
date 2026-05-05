const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

// --- Schemas ---

const sessionSchema = new mongoose.Schema({
    ip: { type: String, required: true },
    mac: { type: String, default: 'Unknown' },
    name: { type: String, default: '' },
    onlineAt: { type: Date, required: true },
    offlineAt: { type: Date, default: null },
    duration: { type: Number, default: 0 }, // seconds
    date: { type: String, required: true, index: true } // YYYY-MM-DD
});

const stateSchema = new mongoose.Schema({
    ip: { type: String, required: true, unique: true },
    mac: { type: String, default: 'Unknown' },
    name: { type: String, default: '' },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date },
    currentSessionStart: { type: Date, default: null }
});

let Session, State;
let connected = false;

// --- Helpers ---

function getToday() {
    const now = new Date();
    // UTC+7 Vietnam
    const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return local.toISOString().split('T')[0];
}

// --- Public API ---

async function connect() {
    try {
        await mongoose.connect(MONGO_URI);
        Session = mongoose.model('DeviceSession', sessionSchema);
        State = mongoose.model('DeviceState', stateSchema);
        connected = true;
        console.log('[Tracker] MongoDB connected');
        return true;
    } catch (err) {
        console.error('[Tracker] MongoDB error:', err.message);
        return false;
    }
}

// In-memory state for real-time tracking (independent of MongoDB)
const memoryState = new Map();
let isInitialRun = true;

async function updateDevices(onlineDevices) {
    const now = new Date();
    const dateStr = getToday();
    const onlineIPs = new Set(onlineDevices.map(d => d.ip));

    const cameOnline = [];
    const wentOffline = [];

    // --- 1. Detect Changes (In-Memory) ---
    for (const device of onlineDevices) {
        const prevState = memoryState.get(device.ip);
        if (prevState && !prevState.isOnline) {
            cameOnline.push({ ...device, name: device.name || device.ip });
        }
        
        memoryState.set(device.ip, { 
            isOnline: true, 
            lastSeen: now, 
            mac: device.mac, 
            name: device.name || device.ip 
        });
    }

    for (const [ip, state] of memoryState.entries()) {
        if (state.isOnline && !onlineIPs.has(ip)) {
            wentOffline.push({ ip, mac: state.mac, name: state.name });
            memoryState.set(ip, { ...state, isOnline: false, lastSeen: now });
        }
    }

    // --- 2. Database Logging (Only if connected) ---
    if (connected) {
        try {
            // Devices that came online: Start sessions
            for (const device of cameOnline) {
                await Session.create({
                    ip: device.ip,
                    mac: device.mac || 'Unknown',
                    name: device.name || device.ip,
                    onlineAt: now,
                    date: dateStr
                });
                
                await State.findOneAndUpdate(
                    { ip: device.ip },
                    { $set: { isOnline: true, lastSeen: now, currentSessionStart: now, mac: device.mac, name: device.name } },
                    { upsert: true }
                );
            }

            // Devices that went offline: End sessions
            for (const device of wentOffline) {
                const session = await Session.findOne({
                    ip: device.ip,
                    offlineAt: null
                }).sort({ onlineAt: -1 });

                if (session) {
                    session.offlineAt = now;
                    session.duration = Math.round((now - session.onlineAt) / 1000);
                    await session.save();
                }

                await State.findOneAndUpdate(
                    { ip: device.ip },
                    { $set: { isOnline: false, lastSeen: now, currentSessionStart: null } }
                );
            }

            // Update remaining online devices' lastSeen in DB
            const stillOnline = onlineDevices.filter(d => !cameOnline.some(c => c.ip === d.ip));
            if (stillOnline.length > 0) {
                await State.updateMany(
                    { ip: { $in: stillOnline.map(d => d.ip) } },
                    { $set: { lastSeen: now, isOnline: true } }
                );
            }
        } catch (dbErr) {
            console.error('[Tracker] DB Update Error (Logging skipped):', dbErr.message);
        }
    }

    // --- 3. Return results (Suppress if initial run) ---
    const result = { cameOnline, wentOffline };

    if (isInitialRun) {
        isInitialRun = false;
        return { cameOnline: [], wentOffline: [] };
    }

    return result;
}

async function updateDeviceName(ip, name) {
    if (!connected || !name || name === ip) return;
    await State.findOneAndUpdate({ ip }, { $set: { name } });
    await Session.updateMany({ ip, offlineAt: null }, { $set: { name } });
}

async function getOnlineDevices() {
    const online = [];
    for (const [ip, state] of memoryState.entries()) {
        if (state.isOnline) {
            online.push({ ip, ...state });
        }
    }
    
    // If memory is empty but DB is connected, try DB as backup
    if (online.length === 0 && connected) {
        return State.find({ isOnline: true }).lean();
    }
    
    return online;
}

async function getTodayReport() {
    if (!connected) return null;
    const dateStr = getToday();
    const sessions = await Session.find({ date: dateStr }).sort({ onlineAt: 1 }).lean();
    const states = await State.find({}).lean();
    return { sessions, states, date: dateStr };
}

async function getUsageStats(days = 7) {
    if (!connected) return null;
    
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    
    // Get all sessions in the range
    const sessions = await Session.find({
        onlineAt: { $gte: cutoff }
    }).lean();

    // Group by MAC (or IP if MAC unknown)
    const stats = {};
    for (const s of sessions) {
        const id = s.mac !== 'Unknown' ? s.mac : s.ip;
        if (!stats[id]) {
            stats[id] = {
                name: s.name || s.ip,
                ip: s.ip,
                mac: s.mac,
                totalDuration: 0,
                sessionCount: 0
            };
        }
        stats[id].totalDuration += s.duration;
        stats[id].sessionCount++;
        if (s.name && s.name !== s.ip) stats[id].name = s.name;
    }

    return Object.values(stats).sort((a, b) => b.totalDuration - a.totalDuration);
}

module.exports = { connect, updateDevices, updateDeviceName, getOnlineDevices, getTodayReport, getUsageStats };

