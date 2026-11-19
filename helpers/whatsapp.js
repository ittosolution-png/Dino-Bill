const nodeCrypto = require('crypto');
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    try {
        globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
    } catch (e) {
        console.error('[WA-LOCAL] Crypto polyfill error:', e.message);
    }
}

const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers, 
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', '.baileys_auth');

let sock = null;
let qrData = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, WAITING_QR, READY, RECONNECTING
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
let cachedVersion = null;
let lastUser = null;
let isInitializing = false;

/**
 * Check if a valid session exists in .baileys_auth
 */
function hasSession() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return false;
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        const stat = fs.statSync(credsPath);
        return stat.size > 50;
    } catch (e) {
        return false;
    }
}

/**
 * Fetch latest Baileys version with cached fallback and generous timeout
 */
async function getBaileysVersion() {
    if (cachedVersion) return cachedVersion;
    let version = [2, 3000, 1043857760]; // Tested stable modern version
    try {
        const vRes = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ]);
        if (vRes && vRes.version) {
            version = vRes.version;
            cachedVersion = version;
        }
    } catch (e) {
        console.log('[WA-LOCAL] Could not fetch latest version remotely, using fallback version:', version);
    }
    return version;
}

/**
 * Safely tear down existing socket and clean up event listeners
 */
async function cleanSocket() {
    if (sock) {
        try {
            console.log('[WA-LOCAL] Closing existing socket connection...');
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.end(undefined);
        } catch (e) {}
        sock = null;
        await delay(500); // Give OS socket a moment to release
    }
}

/**
 * Schedule reconnection with backoff
 */
function scheduleReconnect(pool, delayMs) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connectionStatus = 'RECONNECTING';
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        initWhatsApp(pool).catch(e => console.error('[WA-LOCAL] Reconnect error:', e.message));
    }, delayMs);
}

/**
 * Initialize WhatsApp Baileys Client
 */
async function initWhatsApp(pool) {
    if (isInitializing) {
        console.log('[WA-LOCAL] Connection setup already in progress, skipping duplicate call.');
        return;
    }
    isInitializing = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        await cleanSocket();

        console.log('[WA-LOCAL] Initializing local WhatsApp client (Baileys)...');
        connectionStatus = hasSession() ? 'RECONNECTING' : 'INITIALIZING';

        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const version = await getBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            syncFullHistory: false,
            shouldSyncHistoryDevices: () => false,
            maxMsgRetryCount: 3,
            markOnlineOnConnect: true,
            getMessage: async () => ({ conversation: '' })
        });

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (err) {
                console.error('[WA-LOCAL] Error saving credentials:', err.message);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WA-LOCAL] QR RECEIVED! Generating DataURL...');
                try {
                    qrData = await qrcode.toDataURL(qr);
                    connectionStatus = 'WAITING_QR';
                    console.log('[WA-LOCAL] QR DataURL ready.');
                } catch (err) {
                    console.error('[WA-LOCAL] QR DataURL Error:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
                const errMessage = lastDisconnect?.error?.message || lastDisconnect?.error || 'Unknown';
                console.log(`[WA-LOCAL] Connection closed. Status: ${statusCode || 'none'} (${errMessage})`);

                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                const isConnectionReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

                // 1. Explicitly logged out by user from WhatsApp app or revoked by WhatsApp server
                if (isLoggedOut) {
                    console.log('[WA-LOCAL] Logged out by server/user. Clearing credentials folder...');
                    connectionStatus = 'DISCONNECTED';
                    qrData = null;
                    lastUser = null;
                    reconnectAttempts = 0;
                    try {
                        if (fs.existsSync(AUTH_DIR)) {
                            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        }
                    } catch (e) {}
                    return;
                }

                // 2. Connection replaced (another active socket)
                if (isConnectionReplaced) {
                    console.log('[WA-LOCAL] Connection replaced by another session. Will not reconnect immediately.');
                    connectionStatus = 'DISCONNECTED';
                    return;
                }

                // 3. Status 515: pairing restart required (occurs right after QR scan)
                if (isRestartRequired) {
                    console.log('[WA-LOCAL] QR scanned! Restarting connection to finalize session...');
                    reconnectAttempts = 0;
                    scheduleReconnect(pool, 1000);
                    return;
                }

                // 4. Any other disconnect (network glitch, socket timeout, 428, 503, 408)
                // If a session exists, AUTOMATICALLY RECONNECT with backoff!
                if (hasSession()) {
                    reconnectAttempts++;
                    const delayMs = Math.min(3000 * Math.pow(1.5, Math.min(reconnectAttempts - 1, 6)), MAX_RECONNECT_DELAY);
                    console.log(`[WA-LOCAL] Session disconnected. Auto-reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})...`);
                    scheduleReconnect(pool, delayMs);
                    return;
                }

                // 5. Idle / unauthenticated (QR code timed out and user hasn't scanned yet)
                console.log('[WA-LOCAL] Client disconnected/idle (no active session). Stopping to save CPU.');
                connectionStatus = 'DISCONNECTED';
                qrData = null;

            } else if (connection === 'connecting') {
                if (!qrData && connectionStatus !== 'READY') {
                    connectionStatus = hasSession() ? 'RECONNECTING' : 'INITIALIZING';
                }
            } else if (connection === 'open') {
                console.log('[WA-LOCAL] CLIENT IS READY AND CONNECTED! ✅');
                connectionStatus = 'READY';
                qrData = null;
                reconnectAttempts = 0;
                if (sock?.user) {
                    const rawId = sock.user.id ? sock.user.id.split(':')[0] : '';
                    lastUser = {
                        id: rawId,
                        name: sock.user.name || sock.user.notify || rawId
                    };
                    console.log(`[WA-LOCAL] Connected account: ${lastUser.name} (+${lastUser.id})`);
                }
            }
        });
    } catch (err) {
        console.error('[WA-LOCAL] Init Exception:', err.message);
        connectionStatus = 'DISCONNECTED';
    } finally {
        isInitializing = false;
    }
}

/**
 * Reconnect WhatsApp WITHOUT deleting session credentials
 */
async function restartWhatsApp(pool) {
    console.log('[WA-LOCAL] Manual reconnect triggered. Preserving credentials & re-establishing connection...');
    reconnectAttempts = 0;
    qrData = null;
    return await initWhatsApp(pool);
}

/**
 * Explicit logout & wipe credentials to allow pairing with a new WhatsApp number
 */
async function logoutWhatsApp(pool) {
    console.log('[WA-LOCAL] Manual logout requested. Clearing credentials & resetting session...');
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    connectionStatus = 'DISCONNECTED';
    qrData = null;
    lastUser = null;
    reconnectAttempts = 0;

    await cleanSocket();

    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[WA-LOCAL] Error removing auth dir:', e.message);
    }

    // Re-initialize to generate a fresh QR code
    return await initWhatsApp(pool);
}

/**
 * Send local WhatsApp message via active socket
 */
async function sendLocalWhatsApp(phone, message) {
    // If socket is reconnecting, give it up to 3 seconds grace period before failing
    if (connectionStatus !== 'READY' || !sock) {
        if (connectionStatus === 'RECONNECTING' || connectionStatus === 'INITIALIZING') {
            for (let i = 0; i < 6; i++) {
                await delay(500);
                if (connectionStatus === 'READY' && sock) break;
            }
        }
        if (connectionStatus !== 'READY' || !sock) {
            return { success: false, message: `WhatsApp tidak terhubung (status: ${connectionStatus})` };
        }
    }
    try {
        let formatted = phone.replace(/\D/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.slice(1);
        const chatId = formatted + '@s.whatsapp.net';
        await sock.sendMessage(chatId, { text: message });
        return { success: true };
    } catch (e) {
        console.error('[WA-LOCAL] Error sending message:', e);
        return { success: false, message: e.message };
    }
}

/**
 * Get current WhatsApp status
 */
function getStatus() {
    return { 
        status: connectionStatus, 
        qr: qrData,
        hasSession: hasSession(),
        user: lastUser
    };
}

module.exports = {
    initWhatsApp,
    restartWhatsApp,
    logoutWhatsApp,
    sendLocalWhatsApp,
    getStatus
};
