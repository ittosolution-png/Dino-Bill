const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let client;
let qrData = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, READY, AUTHENTICATED

async function initWhatsApp(pool) {
    // If client already exists, destroy it first
    if (client) {
        try {
            console.log('[WA-LOCAL] Destroying existing client before re-init...');
            await client.destroy();
        } catch (e) {
            console.error('[WA-LOCAL] Destroy error:', e.message);
        }
    }

    console.log('[WA-LOCAL] Initializing local WhatsApp client...');
    connectionStatus = 'INITIALIZING';
    qrData = null; // Clear old QR

    const fs = require('fs');
    const paths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/opt/google/chrome/google-chrome',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];

    let chromePath = null;
    for (const p of paths) {
        if (fs.existsSync(p)) {
            chromePath = p;
            break;
        }
    }

    if (chromePath) {
        console.log('[WA-LOCAL] Found Chrome at:', chromePath);
    } else {
        console.error('[WA-LOCAL] Chrome executable NOT FOUND in common paths!');
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
            headless: true,
            executablePath: chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-features=site-per-process',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        }
    });

    client.on('qr', (qr) => {
        console.log('[WA-LOCAL] QR RECEIVED! Generating DataURL...');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('[WA-LOCAL] QR DataURL Error:', err.message);
            } else {
                qrData = url;
                console.log('[WA-LOCAL] QR DataURL ready.');
            }
        });
        connectionStatus = 'DISCONNECTED';
    });

    client.on('authenticated', () => {
        console.log('[WA-LOCAL] AUTHENTICATED SUCCESS!');
        connectionStatus = 'AUTHENTICATED';
        qrData = null;
    });

    client.on('auth_failure', msg => {
        console.error('[WA-LOCAL] AUTHENTICATION FAILURE:', msg);
        connectionStatus = 'DISCONNECTED';
    });

    client.on('ready', () => {
        console.log('[WA-LOCAL] CLIENT IS READY!');
        connectionStatus = 'READY';
        qrData = null;
    });

    client.on('loading_screen', (percent, message) => {
        console.log('[WA-LOCAL] LOADING:', percent, '%', message);
        connectionStatus = 'INITIALIZING';
    });

    client.on('disconnected', (reason) => {
        console.log('[WA-LOCAL] Client was logged out', reason);
        connectionStatus = 'DISCONNECTED';
        // Auto-restart on disconnect after 5s
        setTimeout(() => initWhatsApp(pool), 5000);
    });

    try {
        await client.initialize();
    } catch (e) {
        console.error('[WA-LOCAL] Initialization Error:', e.message);
        connectionStatus = 'DISCONNECTED';
    }
}

async function restartWhatsApp(pool) {
    return await initWhatsApp(pool);
}

async function sendLocalWhatsApp(phone, message) {
    if (connectionStatus !== 'READY') {
        return { success: false, message: 'WhatsApp tidak terhubung' };
    }
    try {
        let formatted = phone.replace(/\D/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.slice(1);
        const chatId = formatted + "@c.us";
        await client.sendMessage(chatId, message);
        return { success: true };
    } catch (e) {
        return { success: false, message: e.message };
    }
}

function getStatus() {
    return { status: connectionStatus, qr: qrData };
}

module.exports = {
    initWhatsApp,
    restartWhatsApp,
    sendLocalWhatsApp,
    getStatus
};
