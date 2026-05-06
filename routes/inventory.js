const express = require('express');
const router = express.Router();

let pool;

router.setPool = (p) => {
    pool = p;
};

// GET inventory list
router.get('/', async (req, res) => {
    try {
        const [items] = await pool.query('SELECT * FROM inventory ORDER BY name ASC');
        res.render('inventory', { 
            items, 
            user: req.session,
            currentPage: 'inventory' 
        });
    } catch (err) {
        console.error("INVENTORY_GET_ERROR:", err);
        res.status(500).send("Inventory error: " + err.message + "\nStack: " + err.stack);
    }
});

// API: Add/Update item
router.post('/api/save', async (req, res) => {
    const { id, name, category, stock, unit, description } = req.body;
    try {
        if (id) {
            await pool.query(
                'UPDATE inventory SET name=?, category=?, stock=?, unit=?, description=? WHERE id=?',
                [name, category, stock, unit, description, id]
            );
        } else {
            await pool.query(
                'INSERT INTO inventory (name, category, stock, unit, description) VALUES (?, ?, ?, ?, ?)',
                [name, category, stock, unit, description]
            );
        }
        res.json({ success: true, message: "Data barang berhasil disimpan" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API: Delete item
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM inventory WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: "Barang berhasil dihapus" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
