/**
 * Notification Helper - WhatsApp & Telegram
 * Sends notifications via configured providers
 */
const http = require('http');
const https = require('https');
const axios = require('axios');

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
        if (!s.wa_api_url) {
            console.log('[WA] API URL not configured, skipping');
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
                    console.log(`[WA] Sent to ${phone}: ${res.statusCode}`);
                    resolve({ success: res.statusCode < 400, message: data.slice(0, 100) });
                });
            });
            req.on('error', e => {
                console.error(`[WA] Error sending to ${phone}:`, e.message);
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

/**
 * Send Telegram message via Bot API
 */
async function sendTelegram(pool, message) {
    try {
        const s = await getSettings(pool, ['telegram_bot_token', 'telegram_chat_id']);
        if (!s.telegram_bot_token || !s.telegram_chat_id) {
            console.log('[TG] Bot token or chat ID not configured, skipping');
            return { success: false, message: 'Telegram belum dikonfigurasi' };
        }

        const url = `https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`;
        const res = await axios.post(url, {
            chat_id: s.telegram_chat_id,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });

        console.log(`[TG] Sent: ${res.status}`);
        return { success: true, message: 'Terkirim' };
    } catch (e) {
        console.error('[TG] Error:', e.message);
        return { success: false, message: e.message };
    }
}

/**
 * Notify when invoice is created
 */
async function notifyInvoiceCreated(pool, customer, amount, dueDate) {
    if (!customer.phone) return;
    const s = await getSettings(pool, ['company_name', 'msg_invoice_created']);
    const companyName = s.company_name || 'Dino-Bill ISP';
    let msg = s.msg_invoice_created || `📄 *Tagihan Baru*\n\nYth. {name},\nTagihan internet Anda telah diterbitkan.\n\n💰 Nominal: Rp {amount}\n📅 Jatuh Tempo: {due_date}\n\nSegera lakukan pembayaran sebelum jatuh tempo untuk menghindari pemutusan layanan.\n\n{company}`;
    
    msg = msg.replace(/{name}/g, customer.name)
             .replace(/{amount}/g, parseFloat(amount).toLocaleString('id-ID'))
             .replace(/{due_date}/g, dueDate)
             .replace(/{company}/g, companyName)
             .replace(/{phone}/g, customer.phone);

    await sendWhatsApp(pool, customer.phone, msg);
    await sendTelegram(pool, `📄 Invoice baru: <b>${customer.name}</b> - Rp ${parseFloat(amount).toLocaleString('id-ID')} (Due: ${dueDate})`);
}

/**
 * Notify when payment is received
 */
async function notifyPaymentReceived(pool, customer, amount) {
    if (!customer.phone) return;
    const s = await getSettings(pool, ['company_name', 'msg_payment_received']);
    const companyName = s.company_name || 'Dino-Bill ISP';
    let msg = s.msg_payment_received || `✅ *Pembayaran Diterima*\n\nYth. {name},\nPembayaran Anda telah kami terima.\n\n💰 Nominal: Rp {amount}\n📅 Tanggal: {due_date}\n\nTerima kasih atas pembayaran Anda.\n\n{company}`;
    
    msg = msg.replace(/{name}/g, customer.name)
             .replace(/{amount}/g, parseFloat(amount).toLocaleString('id-ID'))
             .replace(/{due_date}/g, new Date().toLocaleDateString('id-ID'))
             .replace(/{company}/g, companyName)
             .replace(/{phone}/g, customer.phone);

    await sendWhatsApp(pool, customer.phone, msg);
    await sendTelegram(pool, `✅ Bayar: <b>${customer.name}</b> - Rp ${parseFloat(amount).toLocaleString('id-ID')}`);
}

/**
 * Notify when customer is isolated
 */
async function notifyIsolation(pool, customer) {
    if (!customer.phone) return;
    const s = await getSettings(pool, ['company_name', 'company_phone', 'msg_isolation']);
    const companyName = s.company_name || 'Dino-Bill ISP';
    let msg = s.msg_isolation || `⚠️ *Layanan Diisolir*\n\nYth. {name},\nLayanan internet Anda telah diisolir karena tagihan belum terbayar.\n\nSilahkan segera melakukan pembayaran untuk mengaktifkan kembali layanan Anda.\n\n{company}`;
    
    msg = msg.replace(/{name}/g, customer.name)
             .replace(/{company}/g, companyName)
             .replace(/{phone}/g, customer.phone);

    await sendWhatsApp(pool, customer.phone, msg);
    await sendTelegram(pool, `⚠️ Isolir: <b>${customer.name}</b>`);
}

/**
 * Notify reminder before due date
 */
async function notifyReminder(pool, customer, amount, dueDate) {
    if (!customer.phone) return;
    const s = await getSettings(pool, ['company_name', 'msg_reminder']);
    const companyName = s.company_name || 'Dino-Bill ISP';
    let msg = s.msg_reminder || `🔔 *Pengingat Tagihan*\n\nYth. {name},\nTagihan internet Anda akan segera jatuh tempo.\n\n💰 Nominal: Rp {amount}\n📅 Jatuh Tempo: {due_date}\n\nSegera lakukan pembayaran untuk menghindari pemutusan layanan.\n\n{company}`;

    msg = msg.replace(/{name}/g, customer.name)
             .replace(/{amount}/g, parseFloat(amount).toLocaleString('id-ID'))
             .replace(/{due_date}/g, dueDate)
             .replace(/{company}/g, companyName)
             .replace(/{phone}/g, customer.phone);

    await sendWhatsApp(pool, customer.phone, msg);
}

module.exports = {
    sendWhatsApp,
    sendTelegram,
    notifyInvoiceCreated,
    notifyPaymentReceived,
    notifyIsolation,
    notifyReminder,
    getSettings
};
