/**
 * Notification Helper - WhatsApp & Telegram
 * Sends notifications via configured providers
 */
const http = require('http');
const https = require('https');
const axios = require('axios');

const { sendLocalWhatsApp } = require('./whatsapp');

/**
 * Get notification settings from database
 */
async function getSettings(pool, keys) {
    const [rows] = await pool.query(
        `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
        keys
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = r.setting_value);
    return s;
}

/**
 * Send WhatsApp message via configured provider
 */
async function sendWhatsApp(pool, phone, message) {
    try {
        const s = await getSettings(pool, ['wa_api_url', 'wa_api_key', 'wa_sender', 'wa_provider']);
        const provider = s.wa_provider || 'local';

        // Local Baileys
        if (provider === 'local') {
            return await sendLocalWhatsApp(phone, message);
        }

        if (!s.wa_api_key) {
            console.log(`[WA-${provider.toUpperCase()}] API Key not configured, skipping`);
            return { success: false, message: 'WA API Key belum diatur' };
        }

        // --- Fonnte (api.fonnte.com) ---
        // Docs: https://docs.fonnte.com
        // Auth: header "Authorization: <token>" (NO "Bearer" prefix)
        // Body: form-data or JSON with "target" and "message"
        if (provider === 'fonnte') {
            const endpoint = 'https://api.fonnte.com/send';
            const postData = new URLSearchParams({
                target: phone,
                message: message,
                countryCode: '62'
            }).toString();

            return new Promise((resolve) => {
                const options = {
                    hostname: 'api.fonnte.com',
                    port: 443,
                    path: '/send',
                    method: 'POST',
                    headers: {
                        'Authorization': s.wa_api_key,  // Fonnte: NO "Bearer" prefix
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', d => data += d);
                    res.on('end', () => {
                        console.log(`[WA-FONNTE] Sent to ${phone}: HTTP ${res.statusCode} | ${data.slice(0, 150)}`);
                        try {
                            const parsed = JSON.parse(data);
                            const ok = parsed.status === true || parsed.status === 'true' || res.statusCode < 400;
                            resolve({ success: ok, message: parsed.reason || parsed.message || data.slice(0, 100) });
                        } catch {
                            resolve({ success: res.statusCode < 400, message: data.slice(0, 100) });
                        }
                    });
                });
                req.on('error', e => {
                    console.error(`[WA-FONNTE] Error sending to ${phone}:`, e.message);
                    resolve({ success: false, message: e.message });
                });
                req.setTimeout(15000, () => {
                    req.destroy();
                    resolve({ success: false, message: 'Fonnte request timeout' });
                });
                req.write(postData);
                req.end();
            });
        }

        // --- Generic providers: MPWA, Wablas, Custom ---
        if (!s.wa_api_url) {
            console.log(`[WA-${provider.toUpperCase()}] API URL not configured, skipping`);
            return { success: false, message: 'WA API URL belum diatur' };
        }

        const url = new URL(s.wa_api_url);
        const postData = JSON.stringify({
            target: phone,
            message: message,
            token: s.wa_api_key,
            sender: s.wa_sender
        });

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${s.wa_api_key}`
            }
        };

        return new Promise((resolve) => {
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request(options, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    console.log(`[WA-${provider.toUpperCase()}] Sent to ${phone}: ${res.statusCode}`);
                    resolve({ success: res.statusCode < 400, message: data.slice(0, 100) });
                });
            });
            req.on('error', e => {
                console.error(`[WA-${provider.toUpperCase()}] Error sending to ${phone}:`, e.message);
                resolve({ success: false, message: e.message });
            });
            req.setTimeout(10000, () => {
                req.destroy();
                resolve({ success: false, message: 'Timeout' });
            });
            req.write(postData);
            req.end();
        });
    } catch (e) {
        console.error('[WA] Error:', e.message);
        return { success: false, message: e.message };
    }
}

async function sendTelegramWithCredentials(message, botToken, chatId, logPrefix = '[TG]') {
    if (!botToken || !chatId) {
        return { success: false, message: 'Bot token atau chat ID belum diisi' };
    }
    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const res = await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
        console.log(`${logPrefix} Sent: ${res.status}`);
        return { success: true, message: 'Terkirim' };
    } catch (e) {
        console.error(`${logPrefix} Error:`, e.message);
        return { success: false, message: e.message };
    }
}

/** Bot Telegram umum (billing, isolir, laporan harian, dll.) */
async function sendTelegram(pool, message) {
    const s = await getSettings(pool, ['telegram_bot_token', 'telegram_chat_id']);
    if (!s.telegram_bot_token || !s.telegram_chat_id) {
        console.log('[TG] Bot token or chat ID not configured, skipping');
        return { success: false, message: 'Telegram umum belum dikonfigurasi' };
    }
    return sendTelegramWithCredentials(message, s.telegram_bot_token, s.telegram_chat_id, '[TG]');
}

/** Bot Telegram khusus notifikasi PPPoE online/offline */
async function sendTelegramPppoe(pool, message) {
    const s = await getSettings(pool, ['pppoe_telegram_bot_token', 'pppoe_telegram_chat_id']);
    if (!s.pppoe_telegram_bot_token || !s.pppoe_telegram_chat_id) {
        console.log('[TG-PPPoE] Bot PPPoE belum dikonfigurasi, skipping');
        return { success: false, message: 'Bot Telegram PPPoE belum dikonfigurasi' };
    }
    return sendTelegramWithCredentials(
        message,
        s.pppoe_telegram_bot_token,
        s.pppoe_telegram_chat_id,
        '[TG-PPPoE]'
    );
}

/**
 * Notify when invoice is created
 */
async function notifyInvoiceCreated(pool, customer, amount, dueDate, options = {}) {
    const shouldSendWA = options.wa !== false;
    const shouldSendTG = options.tg !== false;

    if (shouldSendWA && customer && customer.phone) {
        const s = await getSettings(pool, ['company_name', 'msg_invoice_created']);
        const companyName = s.company_name || 'Dino-Bill ISP';
        let msg = s.msg_invoice_created || `📄 *Tagihan Baru*\n\nYth. {name},\nTagihan internet Anda telah diterbitkan.\n\n💰 Nominal: Rp {amount}\n📅 Jatuh Tempo: {due_date}\n\nSegera lakukan pembayaran sebelum jatuh tempo untuk menghindari pemutusan layanan.\n\n{company}`;
        
        msg = msg.replace(/{name}/g, customer.name || '')
                 .replace(/{amount}/g, parseFloat(amount).toLocaleString('id-ID'))
                 .replace(/{due_date}/g, dueDate)
                 .replace(/{company}/g, companyName)
                 .replace(/{phone}/g, customer.phone);

        await sendWhatsApp(pool, customer.phone, msg);
    }
    
    if (shouldSendTG && customer) {
        await sendTelegram(pool, `📄 Invoice baru: <b>${customer.name || '-'}</b> - Rp ${parseFloat(amount).toLocaleString('id-ID')} (Due: ${dueDate})`);
    }
}

/**
 * Notify when payment is received
 */
async function notifyPaymentReceived(pool, customer, amount, options = {}) {
    const shouldSendWA = options.wa !== false;
    const shouldSendTG = options.tg !== false;

    if (shouldSendWA && customer && customer.phone) {
        const s = await getSettings(pool, ['company_name', 'msg_payment_received']);
        const companyName = s.company_name || 'Dino-Bill ISP';
        let msg = s.msg_payment_received || `✅ *Pembayaran Diterima*\n\nYth. {name},\nPembayaran Anda telah kami terima.\n\n💰 Nominal: Rp {amount}\n📅 Tanggal: {due_date}\n\nTerima kasih atas pembayaran Anda.\n\n{company}`;
        
        msg = msg.replace(/{name}/g, customer.name || '')
                 .replace(/{amount}/g, parseFloat(amount).toLocaleString('id-ID'))
                 .replace(/{due_date}/g, new Date().toLocaleDateString('id-ID'))
                 .replace(/{company}/g, companyName)
                 .replace(/{phone}/g, customer.phone);

        await sendWhatsApp(pool, customer.phone, msg);
    }
    
    if (shouldSendTG && customer) {
        await sendTelegram(pool, `✅ Bayar: <b>${customer.name || '-'}</b> - Rp ${parseFloat(amount).toLocaleString('id-ID')}`);
    }
}

/**
 * Notify when customer is isolated
 */
async function notifyIsolation(pool, customer, options = {}) {
    const shouldSendWA = options.wa !== false;
    const shouldSendTG = options.tg !== false;

    if (shouldSendWA && customer && customer.phone) {
        const s = await getSettings(pool, ['company_name', 'company_phone', 'msg_isolation']);
        const companyName = s.company_name || 'Dino-Bill ISP';
        let msg = s.msg_isolation || `⚠️ *Layanan Diisolir*\n\nYth. {name},\nLayanan internet Anda telah diisolir karena tagihan belum terbayar.\n\nSilahkan segera melakukan pembayaran untuk mengaktifkan kembali layanan Anda.\n\n{company}`;
        
        msg = msg.replace(/{name}/g, customer.name || '')
                 .replace(/{company}/g, companyName)
                 .replace(/{phone}/g, customer.phone);

        await sendWhatsApp(pool, customer.phone, msg);
    }
    
    if (shouldSendTG && customer) {
        await sendTelegram(pool, `⚠️ Isolir: <b>${customer.name || '-'}</b>`);
    }
}

/**
 * Notify reminder before due date
 */
async function notifyReminder(pool, customer, amount, dueDate, options = {}) {
    const shouldSendWA = options.wa !== false;
    if (shouldSendWA && customer && customer.phone) {
        const s = await getSettings(pool, ['company_name', 'msg_reminder']);
        const companyName = s.company_name || 'Dino-Bill ISP';
        let msg = s.msg_reminder || `🔔 *Pengingat Tagihan*\n\nYth. {name},\nTagihan internet Anda akan segera jatuh tempo.\n\n💰 Nominal: Rp {amount}\n📅 Jatuh Tempo: {due_date}\n\nSegera lakukan pembayaran untuk menghindari pemutusan layanan.\n\n{company}`;

        msg = msg.replace(/{name}/g, customer.name || '')
                 .replace(/{amount}/g, parseFloat(amount).toLocaleString('id-ID'))
                 .replace(/{due_date}/g, dueDate)
                 .replace(/{company}/g, companyName)
                 .replace(/{phone}/g, customer.phone);

        await sendWhatsApp(pool, customer.phone, msg);
    }
}

/**
 * Notify admin when a customer uploads a payment proof
 */
async function notifyPaymentProofUploaded(pool, customer, invoice) {
    let msg = `📤 <b>BUKTI PEMBAYARAN DIUNGGAH</b>\n\n`;
    msg += `👤 Pelanggan: <b>${customer.name}</b>\n`;
    msg += `🔑 PPPoE: <code>${customer.pppoe_username || '-'}</code>\n`;
    msg += `📄 Invoice: <b>#${invoice.id}</b>\n`;
    msg += `💰 Nominal: <b>Rp ${parseFloat(invoice.amount).toLocaleString('id-ID')}</b>\n`;
    msg += `📅 Jatuh Tempo: ${new Date(invoice.due_date).toLocaleDateString('id-ID')}\n\n`;
    msg += `Silakan periksa halaman penagihan di panel admin untuk melakukan verifikasi.`;

    await sendTelegram(pool, msg);
}

/**
 * Notify technician when new customer is assigned
 */
/**
 * Notifikasi Telegram saat PPPoE pelanggan online / offline
 */
async function notifyPppoeStatusChange(pool, customer, event, routerName, conn = null) {
    const isOnline = event === 'online';
    const icon = isOnline ? '🟢' : '🔴';
    const label = isOnline ? 'ONLINE' : 'OFFLINE';

    let msg = `${icon} <b>PPPoE ${label}</b>\n\n`;
    msg += `👤 <b>${customer.name}</b>\n`;
    msg += `🔑 <code>${customer.pppoe_username}</code>\n`;
    msg += `📡 Router: ${routerName}\n`;
    if (isOnline && conn) {
        if (conn.address) msg += `🌐 IP: <code>${conn.address}</code>\n`;
        if (conn.uptime) msg += `⏱ Uptime: ${conn.uptime}\n`;
    }
    msg += `\n🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;

    return sendTelegramPppoe(pool, msg);
}

async function notifyTechnicianNewCustomer(pool, technician, customer) {
    if (!technician || !technician.telegram_id) return;
    
    const msg = `🆕 *PELANGGAN BARU*\n\n` +
                `👤 Nama: ${customer.name}\n` +
                `📱 WA: ${customer.phone}\n` +
                `🏠 Alamat: ${customer.address || '-'}\n` +
                `📦 Paket: ${customer.package_name || '-'}\n` +
                `🔑 PPPoE: ${customer.pppoe_username || '-'}\n\n` +
                `Silahkan lakukan instalasi segera.`;

    try {
        const s = await getSettings(pool, ['telegram_bot_token']);
        if (!s.telegram_bot_token) return;

        const url = `https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`;
        await axios.post(url, {
            chat_id: technician.telegram_id,
            text: msg,
            parse_mode: 'Markdown'
        }, { timeout: 10000 });
        
        console.log(`[TG] Tech Notification sent to ${technician.username}`);
    } catch (e) {
        console.error('[TG] Tech Notification Error:', e.message);
    }
}

module.exports = {
    sendWhatsApp,
    sendTelegram,
    sendTelegramPppoe,
    notifyInvoiceCreated,
    notifyPaymentReceived,
    notifyIsolation,
    notifyReminder,
    notifyPppoeStatusChange,
    notifyTechnicianNewCustomer,
    notifyPaymentProofUploaded,
    getSettings
};
