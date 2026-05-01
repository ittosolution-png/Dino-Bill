const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let client;
let qrData = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, READY, AUTHENTICATED

async function initWhatsApp(pool) {
    console.log('[WA-LOCAL] Initializing local WhatsApp client...');
    connectionStatus = 'INITIALIZING';

    const fs = require('fs');
    const paths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/opt/google/chrome/google-chrome'
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
                '--single-process',
                '--disable-gpu'
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
                console.log('[WA-LOCAL] QR DataURL ready to be displayed.');
            }
        });
        connectionStatus = 'DISCONNECTED';
    });

    client.on('authenticated', () => {
        console.log('[WA-LOCAL] AUTHENTICATED SUCCESS! Session saved.');
        connectionStatus = 'AUTHENTICATED';
        qrData = null;
    });

    client.on('auth_failure', msg => {
        console.error('[WA-LOCAL] AUTHENTICATION FAILURE:', msg);
        connectionStatus = 'DISCONNECTED';
    });

    client.on('ready', () => {
        console.log('[WA-LOCAL] CLIENT IS READY! You can now send messages.');
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
        client.initialize(); // Try to restart
    });

    try {
        await client.initialize();
    } catch (e) {
        console.error('[WA-LOCAL] Initialization Error:', e.message);
        connectionStatus = 'DISCONNECTED';
    }
}

async function sendLocalWhatsApp(phone, message) {
    if (connectionStatus !== 'READY') {
        console.warn('[WA-LOCAL] Client is not ready. Status:', connectionStatus);
        return { success: false, message: 'WhatsApp tidak terhubung' };
    }

    try {
        // Format phone number: remove '+' and ensure it starts with 62 or other country code
        let formatted = phone.replace(/\D/g, '');
        if (formatted.startsWith('0')) {
            formatted = '62' + formatted.slice(1);
        }
        const chatId = formatted + "@c.us";
        await client.sendMessage(chatId, message);
        console.log(`[WA-LOCAL] Message sent to ${formatted}`);
        return { success: true };
    } catch (e) {
        console.error('[WA-LOCAL] Send Error:', e.message);
        return { success: false, message: e.message };
    }
}

function getStatus() {
    return {
        status: connectionStatus,
        qr: qrData
    };
}

module.exports = {
    initWhatsApp,
    sendLocalWhatsApp,
    getStatus
};
