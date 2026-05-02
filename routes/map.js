const express = require('express');
const router = express.Router();

let pool;

router.setPool = (p) => {
    pool = p;
};

// GET all map data
router.get('/api/data', async (req, res) => {
    try {
        const [customers] = await pool.query('SELECT id, name, lat, lng, status, address FROM customers WHERE lat IS NOT NULL AND lng IS NOT NULL');
        const [objects] = await pool.query('SELECT * FROM map_objects');
        const [cables] = await pool.query('SELECT * FROM map_cables');
        
        res.json({
            success: true,
            customers,
            objects,
            cables: cables.map(c => ({
                ...c,
                path: JSON.parse(c.path)
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// SAVE Map Object (Server/ODP)
router.post('/api/objects', async (req, res) => {
    const { name, type, lat, lng } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO map_objects (name, type, lat, lng) VALUES (?, ?, ?, ?)',
            [name, type, lat, lng]
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// SAVE Cable Path
router.post('/api/cables', async (req, res) => {
    const { name, path, color } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO map_cables (name, path, color) VALUES (?, ?, ?)',
            [name, JSON.stringify(path), color || '#3b82f6']
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE Map Object
router.delete('/api/objects/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM map_objects WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE Cable
router.delete('/api/cables/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM map_cables WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
