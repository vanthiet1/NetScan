const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'backend', '.env') });

const axios = require('axios');
const net = require('net');
const pLimit = require('p-limit');
const { exec } = require('child_process');
const { Bonjour } = require('bonjour-service');
const dns = require('dns').promises;
const os = require('os');
const ping = require('ping');
const Store = require('electron-store');
const fs = require('fs');
const deviceTracker = require('./device-tracker');
const telegramBot = require('./telegram-bot');
const findDevices = require('local-devices');


const store = new Store();
const limit = pLimit(20); // Concurrency = 20
const bonjour = new Bonjour();
const bonjourNames = {};

let mainWindow;
let isScanning = false;
let backgroundScanInterval;

async function performBackgroundScan() {
    if (isScanning) return;
    
    console.log('[App] Performing background scan for tracking...');
    try {
        // Use local-devices (ARP scan) - much faster and more accurate than pinging 254 IPs
        const discovered = await findDevices();
        const devices = discovered.map(d => ({
            ip: d.ip,
            mac: d.mac,
            name: (!d.name || d.name === '?') ? d.ip : d.name,
            online: true
        }));
        
        // Update tracker and get changes
        deviceTracker.updateDevices(devices).then(changes => {
            if (changes) {
                changes.cameOnline.forEach(d => telegramBot.sendAlert(d, 'online'));
                changes.wentOffline.forEach(d => telegramBot.sendAlert(d, 'offline'));
            }
        }).catch(err => {
            console.error('[Tracker] Background update error:', err.message);
        });

        // Notify UI for real-time updates
        if (mainWindow) {
            mainWindow.webContents.send('network-update', { devices });
        }
        
        console.log(`[App] Background scan complete. Found ${devices.length} devices.`);
    } catch (err) {
        console.error('[App] Background scan failed:', err.message);
    }
}


function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        backgroundColor: '#0f172a',
        title: "NetScan Pro - Professional Network Analyzer"
    });

    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        // Open DevTools in development
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, 'frontend/dist/index.html'));
    }
}

// Start Bonjour Discovery
bonjour.find({}, (service) => {
    if (service.addresses && service.addresses.length > 0) {
        service.addresses.forEach(addr => {
            if (!bonjourNames[addr]) bonjourNames[addr] = [];
            if (!bonjourNames[addr].some(s => s.name === service.name)) {
                bonjourNames[addr].push({
                    name: service.name,
                    type: service.type,
                    port: service.port,
                    txt: service.txt
                });
            }
        });
    }
});

// --- Network Utilities ---

function getLocalSubnet() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const parts = iface.address.split('.');
                parts.pop();
                return { 
                    subnet: parts.join('.'), 
                    fullIp: iface.address 
                };
            }
        }
    }
    return { subnet: '192.168.1', fullIp: '127.0.0.1' };
}

async function getMacAddress(ip) {
    return new Promise((resolve) => {
        const command = process.platform === 'win32' ? `arp -a ${ip}` : `arp -n ${ip}`;
        exec(command, (error, stdout) => {
            if (error) return resolve('00:00:00:00:00:00');
            const macRegex = /(([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2}))/;
            const match = stdout.match(macRegex);
            resolve(match ? match[0].toUpperCase().replace(/-/g, ':') : '00:00:00:00:00:00');
        });
    });
}

async function getVendor(mac) {
    if (!mac || mac === '00:00:00:00:00:00' || mac === 'Unknown') return 'Unknown';
    try {
        const ouiPath = path.join(__dirname, 'oui.json');
        if (fs.existsSync(ouiPath)) {
            const ouiData = JSON.parse(fs.readFileSync(ouiPath, 'utf8'));
            const prefix = mac.substring(0, 8).toUpperCase();
            if (ouiData[prefix]) return ouiData[prefix];
        }
        
        // Fallback to online API if not in offline DB
        const response = await axios.get(`https://api.macvendors.com/${mac}`, { timeout: 1500 });
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

async function getHttpTitle(ip, port) {
    try {
        const protocol = port === 443 ? 'https' : 'http';
        const response = await axios.get(`${protocol}://${ip}:${port}`, { timeout: 2000 });
        const match = response.data.match(/<title>(.*?)<\/title>/i);
        return match ? match[1].trim() : 'No Title';
    } catch (e) {
        return null;
    }
}

async function getHostname(ip) {
    try {
        const names = await dns.reverse(ip);
        return names && names.length > 0 ? names[0] : null;
    } catch (e) {
        return null;
    }
}

async function getNetBIOSName(ip) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve(null);
        exec(`nbtstat -A ${ip}`, (error, stdout) => {
            if (error) return resolve(null);
            const lines = stdout.split('\n');
            for (let line of lines) {
                if (line.includes('<00>') && line.includes('UNIQUE')) {
                    const match = line.match(/^\s*(\S+)/);
                    if (match && match[1] !== 'WORKGROUP') return resolve(match[1].trim());
                }
            }
            resolve(null);
        });
    });
}

async function getDeviceName(ip, mac) {
    try {
        // Ưu tiên 1: mDNS
        if (bonjourNames[ip] && bonjourNames[ip].length > 0) {
            // Lọc ra tên phổ biến nhất
            const name = bonjourNames[ip][0].name;
            if (name) return name;
        }

        // Ưu tiên 2: Reverse DNS
        const hostname = await getHostname(ip);
        if (hostname) {
            return hostname.split('.')[0]; 
        }

        // Ưu tiên 3: NetBIOS (Windows PC, Máy in)
        const netbios = await getNetBIOSName(ip);
        if (netbios) return netbios;

        // Fallback: MAC OUI vendor
        const vendor = await getVendor(mac);
        if (vendor && vendor !== 'Unknown') return vendor + ' Device';

        return ip;
    } catch (e) {
        return ip;
    }
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

// --- Core Scanning Logic ---

ipcMain.handle('get-local-info', () => {
    return getLocalSubnet();
});

ipcMain.handle('scan-network', async (event) => {
    if (isScanning) return { success: false, error: 'Scan already in progress' };
    isScanning = true;
    
    const { subnet } = getLocalSubnet();
    const devices = [];
    const start = 1;
    const end = 254;
    const total = end - start + 1;
    let processed = 0;

    console.log(`[App] Starting manual scan with progress on ${subnet}.0/24`);

    const scanIp = async (ip) => {
        if (!isScanning) return;
        try {
            const res = await ping.promise.probe(ip, { timeout: 1.5 });
            if (res.alive) {
                const mac = await getMacAddress(ip);
                devices.push({
                    ip,
                    mac,
                    name: ip,
                    latency: res.time !== 'unknown' ? parseFloat(res.time) : 0,
                    online: true
                });
            }
        } catch (e) {
        } finally {
            processed++;
            if (mainWindow) {
                mainWindow.webContents.send('scan-progress', {
                    current: processed,
                    total,
                    percent: Math.round((processed / total) * 100)
                });
            }
        }
    };

    const tasks = [];
    for (let i = start; i <= end; i++) {
        const ip = `${subnet}.${i}`;
        tasks.push(limit(() => scanIp(ip)));
    }

    await Promise.all(tasks);
    isScanning = false;

    // Track devices and get changes for alerts
    deviceTracker.updateDevices(devices).then(changes => {
        if (changes) {
            changes.cameOnline.forEach(d => telegramBot.sendAlert(d, 'online'));
            changes.wentOffline.forEach(d => telegramBot.sendAlert(d, 'offline'));
        }
    }).catch(err => {
        console.error('[Tracker] Update error:', err.message);
    });

    return { success: true, devices };
});

ipcMain.handle('send-notification', (event, { title, body }) => {
    new Notification({ title, body }).show();
});

ipcMain.handle('store-get', (event, key) => {
    try {
        return store.get(key);
    } catch (e) {
        console.error('Store Get Error:', e);
        return null;
    }
});

ipcMain.handle('store-set', (event, { key, value }) => {
    try {
        store.set(key, value);
        return { success: true };
    } catch (e) {
        console.error('Store Set Error:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-scan', () => {
    // Currently p-limit doesn't support easy cancellation, but we can flag it
    isScanning = false;
    return { success: true };
});

ipcMain.handle('get-device-info', async (event, { ip, mac, name }) => {
    try {
        const vendor = await getVendor(mac);
        
        // Expanded ports
        const commonPorts = { 
            21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 
            80: 'HTTP', 110: 'POP3', 135: 'RPC', 139: 'NetBIOS', 
            443: 'HTTPS', 445: 'SMB', 1433: 'MSSQL', 3306: 'MySQL', 
            3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC', 8000: 'HTTP-Alt', 
            8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 27017: 'MongoDB', 554: 'RTSP'
        };
        
        const services = [];
        for (const [port, serviceName] of Object.entries(commonPorts)) {
            if (await checkPort(ip, parseInt(port))) {
                let extra = '';
                if (port === '80' || port === '443' || port === '8080') {
                    const title = await getHttpTitle(ip, parseInt(port));
                    if (title) extra = ` (${title})`;
                }
                services.push({ port: parseInt(port), service: serviceName + extra });
            }
        }

        const reverseDns = await getHostname(ip);
        const osGuessed = await guessOS(ip);
        const bonjourInfo = bonjourNames[ip] || [];
        
        // Refined device type detection
        let deviceType = 'PC';
        const lowerVendor = vendor.toLowerCase();
        
        if (lowerVendor.includes('apple')) deviceType = 'Mac/iPhone';
        else if (lowerVendor.includes('samsung') || lowerVendor.includes('huawei') || lowerVendor.includes('xiaomi') || lowerVendor.includes('oppo') || lowerVendor.includes('vivo')) deviceType = 'Mobile';
        else if (lowerVendor.includes('cisco') || lowerVendor.includes('tp-link') || lowerVendor.includes('ubiquiti') || lowerVendor.includes('mikrotik') || lowerVendor.includes('d-link') || lowerVendor.includes('netgear')) deviceType = 'Network Gear';
        else if (lowerVendor.includes('hp') || lowerVendor.includes('canon') || lowerVendor.includes('epson') || lowerVendor.includes('brother')) deviceType = 'Printer';
        else if (lowerVendor.includes('sony') || lowerVendor.includes('lg') || lowerVendor.includes('panasonic') || lowerVendor.includes('hikvision')) deviceType = 'Media/Camera';
        else if (services.some(s => s.port === 80 || s.port === 443)) deviceType = 'Web Server/Router';
        
        if (bonjourInfo.some(s => s.type === 'printer')) deviceType = 'Printer';
        if (bonjourInfo.some(s => s.type === 'airplay' || s.type === 'raop' || s.type === 'googlecast')) deviceType = 'Media/Cast';

        const resolvedName = await getDeviceName(ip, mac);

        // Update device name in tracker for Telegram reports
        deviceTracker.updateDeviceName(ip, resolvedName).catch(() => {});

        return { 
            vendor, 
            services, 
            deviceType, 
            os: osGuessed, 
            hostname: reverseDns,
            bonjour: bonjourInfo,
            resolvedName,
            enriched: true 
        };
    } catch (error) {
        console.error('Enrichment error:', error);
        return { error: error.message, enriched: true };
    }
});

// --- App lifecycle ---
app.whenReady().then(async () => {
    createWindow();

    // Start MongoDB tracker (async, don't block)
    const dbOk = await deviceTracker.connect();
    if (!dbOk) {
        console.warn('[App] MongoDB failed - Usage history will not be saved, but real-time alerts are ACTIVE');
    }

    // Always start Telegram bot and background scanning
    telegramBot.start();
    console.log('[App] Telegram bot started');
    
    // Start background scanning for tracking (every 1 minute)
    performBackgroundScan(); // Run once immediately
    backgroundScanInterval = setInterval(performBackgroundScan, 1 * 60 * 1000);
});

app.on('window-all-closed', () => {
    telegramBot.stop();
    if (backgroundScanInterval) clearInterval(backgroundScanInterval);
    if (process.platform !== 'darwin') app.quit();
});
