const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');
        
        // Check status of each router
        const routersWithStatus = [];
        for (const r of routers) {
            const status = await mikrotik.checkStatus(r);
            routersWithStatus.push({
                ...r,
                online: status.success,
                identity: status.identity || null,
                error: status.message || null
            });
        }
        
        res.render('mikrotik', { user: req.session, routers: routersWithStatus, currentPage: 'mikrotik' });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

router.post('/api/add', async (req, res) => {
    const { name, ip_address, username, password, port } = req.body;
    try {
        await pool.query(
            'INSERT INTO routers (name, ip_address, username, password, port) VALUES (?, ?, ?, ?, ?)',
            [name, ip_address, username, password, port || 8728]
        );
        res.json({ success: true, message: 'Router berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id', async (req, res) => {
    const { name, ip_address, username, password, port } = req.body;
    try {
        const fields = ['name=?', 'ip_address=?', 'username=?', 'port=?'];
        const values = [name, ip_address, username, port || 8728];
        if (password) { fields.push('password=?'); values.push(password); }
        values.push(req.params.id);
        await pool.query(`UPDATE routers SET ${fields.join(',')} WHERE id=?`, values);
        res.json({ success: true, message: 'Router berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM routers WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Router berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Real sync PPPoE secrets from MikroTik
router.post('/api/:id/sync', async (req, res) => {
    try {
        const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [req.params.id]);
        if (!routerData) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

        // Fetch PPPoE secrets from router
        const secretsResult = await mikrotik.getPPPoESecrets(routerData);
        if (!secretsResult.success) {
            return res.json({ success: false, message: `Gagal terhubung ke ${routerData.ip_address}: ${secretsResult.message}` });
        }

        // Fetch active connections
        const activeResult = await mikrotik.getActiveConnections(routerData);
        const activeUsers = new Set();
        if (activeResult.success) {
            activeResult.data.forEach(a => activeUsers.add(a.name));
        }

        // Match secrets with customers in DB
        let synced = 0, notFound = 0;
        for (const secret of secretsResult.data) {
            const [existing] = await pool.query(
                'SELECT id FROM customers WHERE pppoe_username = ?', [secret.name]
            );
            if (existing.length > 0) {
                const isActive = activeUsers.has(secret.name) && !secret.disabled;
                await pool.query(
                    'UPDATE customers SET router_id = ?, status = ? WHERE pppoe_username = ?',
                    [routerData.id, isActive ? 'active' : 'isolated', secret.name]
                );
                synced++;
            } else {
                notFound++;
            }
        }

        // Get system info
        const sysResult = await mikrotik.getSystemResource(routerData);
        const sysInfo = sysResult.success ? ` | ${sysResult.data.boardName} v${sysResult.data.version}` : '';

        res.json({
            success: true,
            message: `Sinkronisasi selesai${sysInfo}. ${synced} pelanggan diperbarui, ${notFound} user PPPoE tidak terkait di database.`
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Check router status
router.post('/api/:id/check', async (req, res) => {
    try {
        const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [req.params.id]);
        if (!routerData) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

        const status = await mikrotik.checkStatus(routerData);
        if (status.success) {
            const sysResult = await mikrotik.getSystemResource(routerData);
            const sys = sysResult.success ? sysResult.data : null;
            res.json({
                success: true,
                message: `✅ Router ${routerData.name} online (${status.identity})`,
                data: sys
            });
        } else {
            res.json({ success: false, message: `❌ Router ${routerData.name} offline: ${status.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /mikrotik/pppoe-active
router.get('/pppoe-active', async (req, res) => {
    try {
        const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');
        const allActive = [];
        
        for (const r of routers) {
            const activeResult = await mikrotik.getActiveConnections(r);
            if (activeResult.success) {
                activeResult.data.forEach(conn => {
                    allActive.push({
                        ...conn,
                        routerName: r.name
                    });
                });
            }
        }
        
        res.render('pppoe_active', { 
            user: req.session, 
            activeConnections: allActive, 
            currentPage: 'pppoe_active' 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching active connections: " + err.message);
    }
});

module.exports = router;
