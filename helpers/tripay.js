/**
 * Tripay Payment Gateway Helper
 */
const axios = require('axios');
const crypto = require('crypto');

/**
 * Get Tripay settings from DB
 */
async function getTripaySettings(pool) {
    const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tripay_api_key','tripay_private_key','tripay_merchant_code','tripay_mode','tripay_channels')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = (r.setting_value || '').trim());
    return s;
}

function getBaseUrl(mode) {
    return mode === 'production'
        ? 'https://tripay.co.id/api/'
        : 'https://tripay.co.id/api-sandbox/';
}

/**
 * Generate Tripay signature
 */
function generateSignature(merchantCode, merchantRef, amount, privateKey) {
    return crypto
        .createHmac('sha256', privateKey)
        .update(merchantCode + merchantRef + amount)
        .digest('hex');
}

/**
 * Get available payment channels
 */
async function getPaymentChannels(pool) {
    try {
        const s = await getTripaySettings(pool);
        if (!s.tripay_api_key) return { success: false, message: 'Tripay belum dikonfigurasi' };

        const baseUrl = getBaseUrl(s.tripay_mode);
        const res = await axios.get(`${baseUrl}merchant/payment-channel`, {
            headers: { 
                Authorization: 'Bearer ' + s.tripay_api_key,
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        let channels = res.data.data || [];
        
        // Filter by allowed channels if specified
        if (s.tripay_channels) {
            const allowed = s.tripay_channels.split(',').map(c => c.trim().toUpperCase());
            channels = channels.filter(c => allowed.includes(c.code.toUpperCase()));
        }

        return { success: true, data: channels };
    } catch (e) {
        const msg = (e.response && e.response.data && e.response.data.message) ? e.response.data.message : e.message;
        return { success: false, message: msg };
    }
}

/**
 * Create a Tripay transaction
 * @param {Object} pool - database pool
 * @param {Object} params - { method, merchantRef, amount, customerName, customerPhone, items, callbackUrl, returnUrl }
 */
async function createTransaction(pool, params) {
    try {
        const s = await getTripaySettings(pool);
        if (!s.tripay_api_key || !s.tripay_private_key || !s.tripay_merchant_code) {
            return { success: false, message: 'Konfigurasi Tripay belum lengkap' };
        }

        const signature = generateSignature(
            s.tripay_merchant_code,
            params.merchantRef,
            params.amount,
            s.tripay_private_key
        );

        const expiry = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 hours

        const body = {
            method: params.method,
            merchant_ref: params.merchantRef,
            amount: params.amount,
            customer_name: params.customerName,
            customer_email: params.customerEmail || 'customer@dino.net',
            customer_phone: params.customerPhone || '',
            order_items: params.items || [
                { name: 'Tagihan Internet', price: params.amount, quantity: 1 }
            ],
            callback_url: params.callbackUrl || '',
            return_url: params.returnUrl || '',
            expired_time: expiry,
            signature: signature
        };

        const res = await axios.post(
            `${getBaseUrl(s.tripay_mode)}transaction/create`,
            body,
            {
                headers: {
                    Authorization: 'Bearer ' + s.tripay_api_key,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        if (res.data.success) {
            return {
                success: true,
                data: {
                    reference: res.data.data.reference,
                    checkout_url: res.data.data.checkout_url,
                    pay_code: res.data.data.pay_code,
                    pay_url: res.data.data.pay_url,
                    amount: res.data.data.amount,
                    expired_time: res.data.data.expired_time,
                    qr_url: res.data.data.qr_url
                }
            };
        }
        return { success: false, message: res.data.message || 'Gagal membuat transaksi' };
    } catch (e) {
        const msg = (e.response && e.response.data && e.response.data.message) ? e.response.data.message : e.message;
        return { success: false, message: msg };
    }
}

/**
 * Verify Tripay callback signature
 */
function verifyCallback(callbackData, privateKey) {
    const signature = crypto
        .createHmac('sha256', privateKey)
        .update(JSON.stringify(callbackData))
        .digest('hex');
    return signature;
}

module.exports = {
    getTripaySettings,
    getPaymentChannels,
    createTransaction,
    verifyCallback
};
