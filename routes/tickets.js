const express = require('express');
const router = express.Router();
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const statusFilter = req.query.status || 'all';
        let whereClause = '';
        if (statusFilter === 'open') whereClause = "WHERE t.status = 'open'";
        else if (statusFilter === 'closed') whereClause = "WHERE t.status = 'closed'";

        const [tickets] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
            FROM trouble_tickets t 
            LEFT JOIN customers c ON t.customer_id = c.id 
            ${whereClause}
            ORDER BY t.status ASC, t.priority DESC, t.created_at DESC
        `);
        const [customers] = await pool.query('SELECT id, name FROM customers ORDER BY name ASC');
        const [technicians] = await pool.query('SELECT id, name, username FROM technician_users ORDER BY name ASC');
        
        const [[{ openCount }]] = await pool.query("SELECT COUNT(*) as openCount FROM trouble_tickets WHERE status='open'");
        const [[{ closedCount }]] = await pool.query("SELECT COUNT(*) as closedCount FROM trouble_tickets WHERE status='closed'");
        const [[{ highCount }]] = await pool.query("SELECT COUNT(*) as highCount FROM trouble_tickets WHERE status='open' AND priority='high'");

        res.render('tickets', { 
            user: req.session, tickets, customers, technicians,
            stats: { open: openCount, closed: closedCount, high: highCount },
            statusFilter, currentPage: 'tickets'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

// Create ticket
router.post('/api/create', async (req, res) => {
    const { customer_id, title, description, priority } = req.body;
    try {
        await pool.query(
            'INSERT INTO trouble_tickets (customer_id, title, description, priority, status) VALUES (?, ?, ?, ?, ?)',
            [customer_id || null, title, description, priority || 'normal', 'open']
        );
        res.json({ success: true, message: 'Tiket berhasil dibuat' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Close ticket (with closed_at timestamp)
router.post('/api/:id/close', async (req, res) => {
    try {
        await pool.query("UPDATE trouble_tickets SET status='closed', closed_at=NOW() WHERE id=?", [req.params.id]);
        res.json({ success: true, message: 'Tiket berhasil ditutup' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Reopen ticket
router.post('/api/:id/reopen', async (req, res) => {
    try {
        await pool.query("UPDATE trouble_tickets SET status='open', closed_at=NULL WHERE id=?", [req.params.id]);
        res.json({ success: true, message: 'Tiket berhasil dibuka kembali' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Update ticket (edit)
router.put('/api/:id', async (req, res) => {
    const { title, description, priority } = req.body;
    try {
        await pool.query(
            'UPDATE trouble_tickets SET title=?, description=?, priority=? WHERE id=?',
            [title, description, priority || 'normal', req.params.id]
        );
        res.json({ success: true, message: 'Tiket berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get ticket detail
router.get('/api/:id', async (req, res) => {
    try {
        const [[ticket]] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
            FROM trouble_tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            WHERE t.id = ?
        `, [req.params.id]);
        if (!ticket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
        res.json({ success: true, data: ticket });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Delete ticket
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM trouble_tickets WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Tiket berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
