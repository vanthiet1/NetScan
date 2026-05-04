require('dotenv').config();
const express = require('express');

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
const cors = require('cors');
const find = require('local-devices');
const axios = require('axios');
const net = require('net');
const pLimit = require('p-limit');
const limit = pLimit(5); // Reduced to 5 to save RAM on low-tier servers
const { Bonjour } = require('bonjour-service');
const bonjour = new Bonjour();
const dns = require('dns').promises;
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const { auth, admin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('Connected to MongoDB');
        initAdmin();
    })
    .catch(err => console.error('MongoDB connection error:', err));

async function initAdmin() {
    try {
        const adminExists = await User.findOne({ username: process.env.ADMIN_USERNAME });
        if (!adminExists) {
            const newAdmin = new User({
                username: process.env.ADMIN_USERNAME,
                password: process.env.ADMIN_PASSWORD,
                role: 'admin'
            });
            await newAdmin.save();
            console.log('Default admin created:', process.env.ADMIN_USERNAME);
        }
    } catch (err) {
        console.error('Error initializing admin:', err);
    }
}

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            "https://scan-ip-connect-wifi.vercel.app",
            "http://localhost:3000",
            "http://localhost:5173"
        ];

        // Flexible check: allow if it matches or starts with the domain
        const isAllowed = allowedOrigins.some(ao => origin.startsWith(ao));

        if (isAllowed) {
            callback(null, true);
        } else {
            console.warn('CORS Blocked for origin:', origin);
            callback(null, false); // Don't throw error, just don't allow
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    optionsSuccessStatus: 200 // Some legacy browsers choke on 204
}));
app.use(express.json());

const vendorCache = {
    '00:00:0C': 'Cisco',
    '00:05:02': 'Apple',
    '00:0C:29': 'VMware',
    '00:15:5D': 'Microsoft',
    '00:1A:11': 'Google',
    '00:0A:EB': 'TP-Link',
    '00:1E:0B': 'HP',
    '00:25:B3': 'HP',
    '84:34:97': 'HP',
    '38:BB:23': 'Samsung',
    'BC:B1:F3': 'Samsung',
    '00:07:AB': 'Samsung',
    '00:14:22': 'Dell',
    '00:21:70': 'Dell',
    '00:01:4A': 'Sony',
    '00:13:A9': 'Sony',
    '00:03:47': 'Intel',
    '00:0C:F1': 'Intel',
    '18:59:36': 'Xiaomi',
    '28:6C:07': 'Xiaomi',
    '00:00:85': 'Canon',
    '00:17:88': 'Philips Hue',
    '00:11:32': 'Synology',
    'D8:D3:85': 'Hikvision',
    'BC:AD:28': 'Espressif (IoT)'
};

async function getVendor(mac) {
    if (!mac || mac === '00:00:00:00:00:00') return 'Unknown';
    const oui = mac.substring(0, 8).toUpperCase();
    if (vendorCache[oui]) return vendorCache[oui];

    // Cap cache size to 100 entries
    if (Object.keys(vendorCache).length > 100) {
        const keys = Object.keys(vendorCache);
        delete vendorCache[keys[0]];
    }

    try {
        const response = await axios.get(`https://api.macvendors.com/${mac}`, { timeout: 1500 });
        vendorCache[oui] = response.data;
        return response.data;
    } catch (error) {
        return 'Network Device';
    }
}

function checkPort(ip, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, ip);
    });
}

/**
 * Bonjour / mDNS Discovery
 */
const bonjourNames = {}; // IP -> Friendly Name

// Start browsing for common services
const servicesToBrowse = ['http', 'smb', 'ipp', 'workstation', 'airplay', 'raop'];
servicesToBrowse.forEach(type => {
    const browser = bonjour.find({ type });
    browser.on('up', (service) => {
        if (service.addresses && service.addresses.length > 0) {
            const ip = service.addresses[0];
            const name = service.name;

            // Cap Bonjour cache
            if (Object.keys(bonjourNames).length > 100) {
                delete bonjourNames[Object.keys(bonjourNames)[0]];
            }

            if (name && !name.includes('?')) {
                bonjourNames[ip] = name;
            }
        }
    });
});

async function resolveHostname(ip, fallbackName) {
    // 1. Check Bonjour Cache first (most likely to have "Friendly Name")
    if (bonjourNames[ip]) return bonjourNames[ip];

    // 2. Clean up fallbackName
    let currentName = fallbackName || '';
    if (currentName === '?' || currentName === '*' || !currentName || currentName.toLowerCase().includes('unknown')) {
        currentName = ip;
    }

    // 3. Try Reverse DNS (Standard)
    try {
        const hostnames = await dns.reverse(ip);
        if (hostnames && hostnames.length > 0) return hostnames[0].replace(/\.$/, '');
    } catch (e) {
        // Ignore reverse DNS failure
    }

    return currentName;
}

async function scanPorts(ip) {
    const commonPorts = {
        21: 'FTP',
        22: 'SSH',
        23: 'Telnet',
        53: 'DNS',
        80: 'HTTP',
        443: 'HTTPS',
        445: 'SMB',
        515: 'LPD (Printer)',
        548: 'AFP (Apple)',
        554: 'RTSP',
        631: 'IPP (Printer)',
        1900: 'SSDP',
        3000: 'Dev-Server',
        3389: 'RDP',
        5000: 'Synology/UPnP',
        5357: 'WSD (Printer)',
        8000: 'Camera-SDK',
        8008: 'Chromecast',
        8009: 'Google-Home',
        8080: 'HTTP-Alt',
        8443: 'HTTPS-Alt',
        9100: 'JetDirect (Printer)',
        32400: 'Plex'
    };
    const results = [];
    // Sequential scan per device to avoid flooding its network stack
    for (const [port, service] of Object.entries(commonPorts)) {
        try {
            if (await checkPort(ip, parseInt(port))) {
                results.push({ port: parseInt(port), service: service });
            }
        } catch (err) {
            // Silently skip failed port checks
        }
    }
    return results;
}

function detectDeviceDetails(vendor, services, name) {
    let os = 'Unknown';
    let deviceType = 'PC'; // Default to PC if active

    const vendorLower = (vendor || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    const ports = services.map(s => s.port);

    // 1. Detect by Port (High Confidence)
    if (ports.includes(9100) || ports.includes(631) || ports.includes(515) || ports.includes(5357)) {
        deviceType = 'Printer';
        os = 'Printer';
    } else if (ports.includes(554) || ports.includes(8000) || ports.includes(8554)) {
        deviceType = 'Camera';
        os = 'Camera';
    } else if (ports.includes(8008) || ports.includes(8009)) {
        deviceType = 'Smart Device';
        os = 'Google Cast';
    } else if (ports.includes(32400) || ports.includes(5000)) {
        deviceType = 'Server';
        os = 'NAS';
    } else if (ports.includes(3389)) {
        os = 'Windows';
        deviceType = 'PC';
    } else if (ports.includes(53)) {
        deviceType = 'Router';
        os = 'Router';
    } else if (ports.includes(22)) {
        os = 'Linux/SSH';
    }

    // 2. Detect by Vendor
    if (vendorLower.includes('apple')) {
        if (nameLower.includes('iphone') || nameLower.includes('ipad') || nameLower.includes('watch') || nameLower.includes('mobile')) {
            deviceType = 'Mobile';
            os = 'iOS';
        } else if (nameLower.includes('tv')) {
            deviceType = 'Smart Device';
            os = 'tvOS';
        } else {
            deviceType = 'PC';
            os = 'macOS';
        }
    } else if (vendorLower.includes('samsung')) {
        if (nameLower.includes('tv')) {
            deviceType = 'TV';
            os = 'Tizen';
        } else {
            deviceType = 'Mobile';
            if (os === 'Unknown') os = 'Android';
        }
    } else if (vendorLower.includes('sony') && nameLower.includes('tv')) {
        deviceType = 'TV';
        os = 'Android TV';
    } else if (vendorLower.includes('huawei') || vendorLower.includes('xiaomi') || vendorLower.includes('oppo') || vendorLower.includes('vivo') || vendorLower.includes('google')) {
        deviceType = 'Mobile';
        if (os === 'Unknown') os = 'Android';
    } else if (vendorLower.includes('microsoft')) {
        os = 'Windows';
        deviceType = 'PC';
    } else if (vendorLower.includes('hp') || vendorLower.includes('canon') || vendorLower.includes('epson') || vendorLower.includes('brother')) {
        deviceType = 'Printer';
        if (os === 'Unknown') os = 'Printer';
    } else if (vendorLower.includes('synology') || vendorLower.includes('qnap')) {
        deviceType = 'Server';
        os = 'NAS';
    } else if (vendorLower.includes('cisco') || vendorLower.includes('tp-link') || vendorLower.includes('asus') || vendorLower.includes('netgear') || vendorLower.includes('d-link') || vendorLower.includes('ubiquiti') || vendorLower.includes('mikrotik')) {
        deviceType = 'Router';
        if (os === 'Unknown') os = 'Router';
    } else if (vendorLower.includes('hikvision') || vendorLower.includes('dahua')) {
        deviceType = 'Camera';
        if (os === 'Unknown') os = 'Camera';
    } else if (vendorLower.includes('espressif')) {
        deviceType = 'IoT';
        os = 'FreeRTOS';
    }

    // 3. Detect by Name (Hostname)
    if (nameLower.includes('android') || nameLower.includes('phone') || nameLower.includes('iphone') || nameLower.includes('mobile')) {
        deviceType = 'Mobile';
        if (os === 'Unknown' || os.includes('Linux')) os = nameLower.includes('iphone') ? 'iOS' : 'Android';
    } else if (nameLower.includes('printer') || nameLower.includes('print') || nameLower.includes('epson') || nameLower.includes('hp-')) {
        deviceType = 'Printer';
        if (os === 'Unknown') os = 'Printer';
    } else if (nameLower.includes('tv') || nameLower.includes('smarttv') || nameLower.includes('bravia') || nameLower.includes('lg-')) {
        deviceType = 'TV';
        if (os === 'Unknown') os = 'Smart TV';
    } else if (nameLower.includes('router') || nameLower.includes('gateway') || nameLower.includes('tplink') || nameLower.includes('asus') || nameLower.includes('ap-')) {
        deviceType = 'Router';
        if (os === 'Unknown') os = 'Router';
    } else if (nameLower.includes('camera') || nameLower.includes('ipc') || nameLower.includes('dvr') || nameLower.includes('nvr') || nameLower.includes('hik-')) {
        deviceType = 'Camera';
        if (os === 'Unknown') os = 'Camera';
    } else if (nameLower.includes('nas') || nameLower.includes('synology') || nameLower.includes('server')) {
        deviceType = 'Server';
        if (os === 'Unknown') os = 'NAS';
    } else if (nameLower.includes('desktop') || nameLower.includes('laptop') || nameLower.includes('pc-')) {
        deviceType = 'PC';
        if (os === 'Unknown') os = 'Windows/Linux';
    }

    return { os, deviceType };
}

/**
 * Auth Routes
 */
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        const token = jwt.sign(
            { id: user._id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        res.json({ token, user: { username: user.username, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * User Management (Admin Only)
 */
app.get('/api/users', auth, admin, async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', auth, admin, async (req, res) => {
    const { username, password, role } = req.body;
    try {
        const newUser = new User({ username, password, role });
        await newUser.save();
        res.json({ success: true, user: { username, role } });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/users/:id', auth, admin, async (req, res) => {
    const { password, role } = req.body;
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (password) user.password = password;
        if (role) user.role = role;

        await user.save();
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/users/:id', auth, admin, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * Quick scan - returns basic info immediately
 */
// Store discovered devices for background monitoring
let monitoredDevices = [];

app.get('/scan-network', auth, async (req, res) => {
    console.log('Starting quick network scan...');
    try {
        // Safety timeout for the scanner (15 seconds)
        const scanTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Scan timeout - Network range too large or unreachable')), 15000)
        );

        const devices = await Promise.race([find(), scanTimeout]);

        const formatted = await Promise.all(devices.map(d => limit(async () => {
            // Fix generic hostnames directly
            let name = d.name;
            if (!name || name === '?' || name === '*' || name.toLowerCase().includes('unknown')) {
                name = d.ip;
            }

            return {
                ip: d.ip,
                mac: d.mac,
                name: name
            };
        })));

        monitoredDevices = formatted; // Update monitored list
        res.json({
            success: true,
            count: formatted.length,
            devices: formatted
        });
    } catch (error) {
        console.error('Scan error:', error.message);
        // Return success with empty list to keep the UI alive instead of a 502/crash
        res.json({
            success: true,
            count: 0,
            devices: [],
            error: error.message === 'Scan timeout - Network range too large or unreachable'
                ? 'Mạng quá lớn hoặc không thể quét trên Cloud. Hãy thử chạy Backend cục bộ.'
                : error.message
        });
    }
});

const { exec } = require('child_process');

/**
 * Helper to measure latency using ping
 */
function getLatency(ip) {
    return new Promise((resolve) => {
        const start = Date.now();
        // On Windows: ping -n 1
        // On Linux/Mac: ping -c 1
        const command = process.platform === 'win32' ? `ping -n 1 -w 1000 ${ip}` : `ping -c 1 -W 1 ${ip}`;

        const child = exec(command, { timeout: 2000 }, (error, stdout) => {
            if (error) {
                resolve(null); // Ping failed
                return;
            }

            // Extract time from output (e.g., "time=5ms" or "time<1ms")
            const match = stdout.match(/time[=<]([\d.]+)ms/);
            if (match) {
                resolve(parseFloat(match[1]));
            } else {
                resolve(Date.now() - start);
            }
        });

        child.on('error', () => resolve(null));
    });
}

/**
 * Detailed info for a specific device
 */
app.get('/device-info', auth, async (req, res) => {
    const { ip, mac, name } = req.query;
    if (!ip || !mac) return res.status(400).json({ error: 'IP and MAC required' });

    try {
        // Wrap everything in the global limit to prevent overwhelming the OS
        const result = await limit(async () => {
            const betterName = await resolveHostname(ip, name);
            const vendor = await getVendor(mac);
            const services = await scanPorts(ip);
            const latency = await getLatency(ip);
            const { os, deviceType } = detectDeviceDetails(vendor, services, betterName);

            return {
                vendor,
                services,
                latency,
                os,
                deviceType,
                name: betterName,
                lastSeen: new Date().toISOString()
            };
        });

        res.json(result);
    } catch (error) {
        console.error(`Device info error for ${ip}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Notification System
 */
let clients = [];
const notificationHistory = [];

// SSE Endpoint for real-time notifications
app.get('/notifications/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevent buffering on Railway/Nginx
    res.flushHeaders();

    // Send initial keep-alive
    res.write(': keep-alive\n\n');

    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 25000); // Send every 25s to prevent timeout

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    clients.push(newClient);

    req.on('close', () => {
        clearInterval(keepAlive);
        clients = clients.filter(c => c.id !== clientId);
    });
});

// Endpoint to RECEIVE notification from another device
app.post('/receive-notification', (req, res) => {
    const { title, message, from, type } = req.body;
    console.log(`Notification received from ${from}: ${title}`);

    const notification = {
        id: Date.now(),
        title: title || 'New Message',
        message: message || '',
        from: from || req.ip,
        type: type || 'info',
        timestamp: new Date().toISOString()
    };

    notificationHistory.push(notification);

    // Limit history to 50 items to prevent memory leak
    if (notificationHistory.length > 50) {
        notificationHistory.shift();
    }

    // Push to all connected SSE clients
    clients.forEach(c => {
        c.res.write(`data: ${JSON.stringify(notification)}\n\n`);
    });

    res.json({ success: true });
});

// Health check endpoint
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Endpoint to SEND notification to other device(s)
app.post('/send-notification', async (req, res) => {
    const { targets, title, message, type } = req.body;

    if (!targets || !Array.isArray(targets)) {
        return res.status(400).json({ error: 'Targets array is required' });
    }

    const results = await Promise.all(targets.map(async (ip) => {
        try {
            await axios.post(`http://${ip}:5000/receive-notification`, {
                title,
                message,
                type,
                from: 'Another NetScan User'
            }, { timeout: 3000 });
            return { ip, status: 'success' };
        } catch (error) {
            console.error(`Failed to send notification to ${ip}:`, error.message);
            return { ip, status: 'failed', error: error.message };
        }
    }));

    res.json({ success: true, results });
});

// History endpoint
app.get('/notifications/history', (req, res) => {
    res.json(notificationHistory);
});

/**
 * Background Realtime Latency Monitor
 * Pings all known devices every 10 seconds and pushes updates to SSE clients
 */
setInterval(async () => {
    if (monitoredDevices.length === 0 || clients.length === 0) return;

    // Use concurrency limit to prevent OOM
    const updates = await Promise.all(
        monitoredDevices.map(d => limit(async () => {
            try {
                const latency = await getLatency(d.ip);
                return { ip: d.ip, mac: d.mac, latency };
            } catch (err) {
                return { ip: d.ip, mac: d.mac, latency: null };
            }
        }))
    );

    const payload = JSON.stringify({ type: 'latency-update', updates });
    clients.forEach(c => {
        try {
            c.res.write(`data: ${payload}\n\n`);
        } catch (err) {
            // Handle stale client
        }
    });
}, 10000);

// Memory monitor - logs every 1 minute
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`[Memory] RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`);

    // Emergency cleanup if memory is very high (> 400MB)
    if (used.rss > 400 * 1024 * 1024) {
        console.warn('CRITICAL: Memory usage high, clearing caches...');
        for (let key in vendorCache) delete vendorCache[key];
        for (let key in bonjourNames) delete bonjourNames[key];
        monitoredDevices = [];
    }
}, 60000);

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://0.0.0.0:${PORT}`));
