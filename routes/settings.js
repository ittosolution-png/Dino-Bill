const express = require('express');
const router = express.Router();
const { sendWhatsApp, sendTelegram } = require('../helpers/notification');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM settings');
        const settings = {};
        rows.forEach(s => settings[s.setting_key] = s.setting_value);
        res.render('settings', { user: req.session, settings, currentPage: 'settings' });
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

router.get('/whatsapp-status', async (req, res) => {
    const { getStatus } = require('../helpers/whatsapp');
    res.json(getStatus());
});

router.post('/whatsapp-restart', async (req, res) => {
    const { restartWhatsApp } = require('../helpers/whatsapp');
    restartWhatsApp(pool).catch(e => console.error('[WA-RESTART] Error:', e.message));
    res.json({ success: true, message: 'Proses inisialisasi ulang WhatsApp dimulai...' });
});

router.post('/api/save', async (req, res) => {
    try {
        const entries = req.body;
        for (const [key, value] of Object.entries(entries)) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        res.json({ success: true, message: 'Pengaturan berhasil disimpan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-wa', async (req, res) => {
    const { phone, message } = req.body;
    try {
        const result = await sendWhatsApp(pool, phone, message || 'Test dari Dino-Bill ✅');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-telegram', async (req, res) => {
    const { message } = req.body;
    try {
        const result = await sendTelegram(pool, message || '✅ Test Telegram dari Dino-Bill');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-acs', async (req, res) => {
    const { url } = req.body;
    try {
        const axios = require('axios');
        const response = await axios.get(`${url}/devices`, { timeout: 4000 });
        res.json({ success: true, message: `Berhasil! Terhubung ke GenieACS. HTTP ${response.status}` });
    } catch (e) {
        res.json({ success: false, message: `Gagal terhubung ke ACS: ${e.message}` });
    }
});

router.post('/api/test-olt', async (req, res) => {
    const { ip, snmp: community } = req.body;
    try {
        const HiosoOLT = require('../helpers/olt');
        const helper = new HiosoOLT(ip, community || 'public');
        await helper.connect();
        // Just try to get one basic OID to test connection (Hostname or similar)
        const sysName = await helper.walk('1.3.6.1.2.1.1.5.0'); 
        res.json({ success: true, message: `Berhasil! OLT merespon via SNMP: ${sysName[0]?.value.toString() || 'Connected'}` });
    } catch (e) {
        res.json({ success: false, message: `Gagal SNMP ke ${ip}: ${e.message}` });
    }
});

router.post('/api/test-tripay', async (req, res) => {
    try {
        const tripay = require('../helpers/tripay');
        const channels = await tripay.getPaymentChannels(pool);
        if (channels.success) {
            const names = channels.data.slice(0, 5).map(c => c.name).join(', ');
            res.json({ success: true, message: `Berhasil! ${channels.data.length} channel tersedia: ${names}...` });
        } else {
            res.json({ success: false, message: channels.message });
        }
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET - List users
router.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Add user
router.post('/api/users', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashed, role || 'admin']);
        res.json({ success: true, message: 'User berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Remove user
router.delete('/api/users/:id', async (req, res) => {
    try {
        if (req.params.id == req.session.userId) {
            return res.status(400).json({ success: false, message: 'Tidak bisa menghapus diri sendiri' });
        }
        await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'User berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
