const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// Helper: get first available router
async function getRouter() {
    const [routers] = await pool.query('SELECT * FROM routers LIMIT 1');
    return routers.length > 0 ? routers[0] : null;
}

// GET /hotspot — Fetch real hotspot users from MikroTik
router.get('/', async (req, res) => {
    try {
        const routerData = await getRouter();
        let users = [];
        let profiles = [{ name: 'default' }];
        let active = [];
        let routerOnline = false;

        if (routerData) {
            const usersResult = await mikrotik.getHotspotUsers(routerData);
            if (usersResult.success) {
                users = usersResult.data;
                routerOnline = true;
            }

            const profilesResult = await mikrotik.getHotspotProfiles(routerData);
            if (profilesResult.success && profilesResult.data.length > 0) {
                profiles = profilesResult.data;
            }

            const activeResult = await mikrotik.getHotspotActive(routerData);
            if (activeResult.success) {
                active = activeResult.data;
                // Mark online users
                const activeSet = new Set(active.map(a => a.user));
                users = users.map(u => ({
                    ...u,
                    isOnline: activeSet.has(u.name)
                }));
            }
        }

        res.render('hotspot', { user: req.session, users, profiles, routerOnline, routerData, currentPage: 'hotspot' });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// POST /hotspot/api/user/add — Add hotspot user to MikroTik
router.post('/api/user/add', async (req, res) => {
    const { username, password, profile } = req.body;
    try {
        const routerData = await getRouter();
        if (!routerData) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });

        const result = await mikrotik.addHotspotUser(routerData, username, password, profile || 'default');
        if (result.success) {
            res.json({ success: true, message: `User hotspot "${username}" berhasil ditambahkan ke ${routerData.name}` });
        } else {
            res.json({ success: false, message: `Gagal: ${result.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /hotspot/api/user/:name — Remove hotspot user from MikroTik
router.delete('/api/user/:name', async (req, res) => {
    try {
        const routerData = await getRouter();
        if (!routerData) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });

        const result = await mikrotik.removeHotspotUser(routerData, req.params.name);
        if (result.success) {
            res.json({ success: true, message: `User "${req.params.name}" berhasil dihapus dari router` });
        } else {
            res.json({ success: false, message: `Gagal: ${result.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /hotspot/api/profile/add — Add hotspot profile to MikroTik
router.post('/api/profile/add', async (req, res) => {
    const { name, rateLimit, sharedUsers } = req.body;
    try {
        const routerData = await getRouter();
        if (!routerData) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });

        const result = await mikrotik.addHotspotProfile(routerData, name, rateLimit, sharedUsers || 1);
        if (result.success) {
            res.json({ success: true, message: `Profile "${name}" berhasil ditambahkan` });
        } else {
            res.json({ success: false, message: `Gagal: ${result.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /hotspot/api/generate — Generate vouchers (DB only)
router.post('/api/generate', async (req, res) => {
    const { count, profile, price, length, prefix } = req.body;
    try {
        const vouchers = [];
        for (let i = 0; i < (count || 10); i++) {
            const code = (prefix || '') + Math.random().toString(36).substring(2, 2 + (length || 6)).toUpperCase();
            vouchers.push([code, price || 0, profile || 'default']);
        }
        
        if (vouchers.length > 0) {
            await pool.query('INSERT IGNORE INTO vouchers (code, price, profile) VALUES ?', [vouchers]);
        }
        
        res.json({ success: true, message: `${vouchers.length} voucher berhasil digenerate` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /hotspot/api/voucher/:id — Delete a single voucher
router.delete('/api/voucher/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM vouchers WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Voucher berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /hotspot/api/vouchers/used — Delete all used vouchers
router.delete('/api/vouchers/used', async (req, res) => {
    try {
        const [result] = await pool.query("DELETE FROM vouchers WHERE status = 'used'");
        res.json({ success: true, message: `${result.affectedRows} voucher used berhasil dihapus` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /hotspot/print
router.get('/print', async (req, res) => {
    const { ids } = req.query;
    try {
        let vouchers;
        if (ids) {
            const idList = ids.split(',').map(id => parseInt(id));
            [vouchers] = await pool.query('SELECT * FROM vouchers WHERE id IN (?)', [idList]);
        } else {
            [vouchers] = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 50');
        }
        res.render('print_vouchers', { vouchers });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// GET /hotspot/vouchers
router.get('/vouchers', async (req, res) => {
    try {
        const [vouchers] = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 100');
        res.render('vouchers', { user: req.session, vouchers, currentPage: 'vouchers' });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

module.exports = router;
