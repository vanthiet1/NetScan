const mongoose = require('mongoose');

const MONGO_URI = 'mongodb+srv://vanthietfrontend_db_user:V1dWJCbW7dVZINF5@netscan.evwulcm.mongodb.net/netscan?appName=netscan';

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

async function updateDevices(onlineDevices) {
    if (!connected) return;

    const now = new Date();
    const dateStr = getToday();
    const onlineIPs = new Set(onlineDevices.map(d => d.ip));

    // Previous states
    const prevStates = await State.find({}).lean();
    const prevOnlineIPs = new Set(
        prevStates.filter(s => s.isOnline).map(s => s.ip)
    );

    // --- Devices that came online ---
    for (const device of onlineDevices) {
        const wasOnline = prevOnlineIPs.has(device.ip);

        if (!wasOnline) {
            // New session
            await Session.create({
                ip: device.ip,
                mac: device.mac || 'Unknown',
                name: device.name || device.ip,
                onlineAt: now,
                date: dateStr
            });
        }

        const updateData = {
            mac: device.mac || 'Unknown',
            name: device.name || device.ip,
            isOnline: true,
            lastSeen: now
        };
        if (!wasOnline) {
            updateData.currentSessionStart = now;
        }

        await State.findOneAndUpdate(
            { ip: device.ip },
            { $set: updateData },
            { upsert: true }
        );
    }

    // --- Devices that went offline ---
    for (const state of prevStates) {
        if (state.isOnline && !onlineIPs.has(state.ip)) {
            const session = await Session.findOne({
                ip: state.ip,
                offlineAt: null
            }).sort({ onlineAt: -1 });

            if (session) {
                session.offlineAt = now;
                session.duration = Math.round((now - session.onlineAt) / 1000);
                await session.save();
            }

            await State.findOneAndUpdate(
                { ip: state.ip },
                { $set: { isOnline: false, lastSeen: now, currentSessionStart: null } }
            );
        }
    }
}

async function updateDeviceName(ip, name) {
    if (!connected || !name || name === ip) return;
    await State.findOneAndUpdate({ ip }, { $set: { name } });
    await Session.updateMany({ ip, offlineAt: null }, { $set: { name } });
}

async function getOnlineDevices() {
    if (!connected) return [];
    return State.find({ isOnline: true }).lean();
}

async function getTodayReport() {
    if (!connected) return null;
    const dateStr = getToday();
    const sessions = await Session.find({ date: dateStr }).sort({ onlineAt: 1 }).lean();
    const states = await State.find({}).lean();
    return { sessions, states, date: dateStr };
}

module.exports = { connect, updateDevices, updateDeviceName, getOnlineDevices, getTodayReport };
