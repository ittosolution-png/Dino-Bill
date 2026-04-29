const express = require('express');
const router = express.Router();
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const [packages] = await pool.query('SELECT * FROM packages ORDER BY price ASC');
        res.render('packages', { user: req.session, packages, currentPage: 'packages' });
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

router.post('/api', async (req, res) => {
    const { name, price, speed_limit, description } = req.body;
    try {
        await pool.query('INSERT INTO packages (name, price, speed_limit, description) VALUES (?, ?, ?, ?)', [name, price, speed_limit, description]);
        res.json({ success: true, message: 'Paket berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id', async (req, res) => {
    const { name, price, speed_limit, description } = req.body;
    try {
        await pool.query('UPDATE packages SET name=?, price=?, speed_limit=?, description=? WHERE id=?', [name, price, speed_limit, description, req.params.id]);
        res.json({ success: true, message: 'Paket berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM packages WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Paket berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/mikrotik-profiles', async (req, res) => {
    try {
        const mikrotik = require('../helpers/mikrotik');
        const [routers] = await pool.query('SELECT * FROM routers LIMIT 1'); // Use the first router to get profiles
        if (routers.length === 0) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });
        
        const result = await mikrotik.getPPPProfiles(routers[0]);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
