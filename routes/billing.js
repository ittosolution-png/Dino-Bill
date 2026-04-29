const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
const { notifyInvoiceCreated, notifyPaymentReceived, notifyIsolation } = require('../helpers/notification');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = 25;
        const offset = (page - 1) * perPage;
        const search = req.query.search || '';
        const statusFilter = req.query.status || 'all';

        let conditions = [];
        let params = [];
        if (statusFilter !== 'all') { conditions.push('i.status = ?'); params.push(statusFilter); }
        if (search) { conditions.push('(c.name LIKE ? OR c.pppoe_username LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

        const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const [invoices] = await pool.query(
            `SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.pppoe_username, c.status as customer_status, p.name as package_name
             FROM invoices i 
             LEFT JOIN customers c ON i.customer_id = c.id
             LEFT JOIN packages p ON i.package_id = p.id
             ${whereClause} ORDER BY i.created_at DESC LIMIT ${perPage} OFFSET ${offset}`,
            params
        );
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ${whereClause}`, params);
        const [[{ paid }]] = await pool.query("SELECT COUNT(*) as paid FROM invoices WHERE status='paid'");
        const [[{ unpaid }]] = await pool.query("SELECT COUNT(*) as unpaid FROM invoices WHERE status='unpaid'");
        const [[{ overdue }]] = await pool.query("SELECT COUNT(*) as overdue FROM invoices WHERE status='unpaid' AND due_date < CURDATE()");
        const [[{ totalRevenue }]] = await pool.query("SELECT COALESCE(SUM(amount),0) as totalRevenue FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW())");
        const [customers] = await pool.query("SELECT id, name, pppoe_username FROM customers ORDER BY name ASC");

        res.render('billing', {
            user: req.session, invoices, customers,
            stats: { paid, unpaid, overdue, totalRevenue },
            pagination: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
            search, statusFilter, currentPage: 'billing'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

// POST - Create invoice manually + send WA
router.post('/api/create', async (req, res) => {
    const { customer_id, amount, due_date, description } = req.body;
    try {
        const [[customer]] = await pool.query('SELECT *, (SELECT price FROM packages WHERE id = customers.package_id) as package_price FROM customers WHERE id = ?', [customer_id]);
        if (!customer) return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });

        const invAmount = amount || customer.package_price || 0;
        const invDue = due_date || new Date(new Date().getFullYear(), new Date().getMonth(), customer.isolation_date || 20).toISOString().split('T')[0];

        await pool.query(
            'INSERT INTO invoices (customer_id, package_id, amount, due_date, status, description) VALUES (?, ?, ?, ?, ?, ?)',
            [customer_id, customer.package_id, invAmount, invDue, 'unpaid', description || '']
        );

        // Send WA notification
        await notifyInvoiceCreated(pool, customer, invAmount, invDue);

        res.json({ success: true, message: 'Invoice berhasil dibuat & notifikasi WA terkirim' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Generate bulk for all active customers this month + send WA
router.post('/api/generate-bulk', async (req, res) => {
    try {
        const [customers] = await pool.query(`SELECT c.*, p.price as package_price FROM customers c LEFT JOIN packages p ON c.package_id = p.id WHERE c.status = 'active'`);
        let created = 0;
        const month = new Date().getMonth() + 1;
        const year = new Date().getFullYear();

        for (const c of customers) {
            const [[exists]] = await pool.query('SELECT id FROM invoices WHERE customer_id=? AND MONTH(due_date)=? AND YEAR(due_date)=?', [c.id, month, year]);
            if (!exists) {
                const day = c.isolation_date || 20;
                const dueDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?, ?, ?, ?, ?)', [c.id, c.package_id, c.package_price || 0, dueDate, 'unpaid']);
                created++;
                
                // Send WA notification (async, don't block)
                notifyInvoiceCreated(pool, c, c.package_price || 0, dueDate).catch(() => {});
            }
        }
        res.json({ success: true, message: `${created} invoice berhasil di-generate. Notifikasi WA sedang dikirim.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Pay invoice (also unisolate customer + MikroTik + WA)
router.post('/api/:id/pay', async (req, res) => {
    try {
        const [[inv]] = await pool.query('SELECT * FROM invoices WHERE id=?', [req.params.id]);
        if (!inv) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });

        await pool.query("UPDATE invoices SET status='paid', paid_at=NOW(), payment_method=? WHERE id=?", [req.body.payment_method || 'Manual', req.params.id]);

        // Auto-unisolate customer + enable on MikroTik
        const [[cust]] = await pool.query(
            "SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?",
            [inv.customer_id]
        );
        if (cust && cust.status === 'isolated') {
            await pool.query("UPDATE customers SET status='active' WHERE id=?", [inv.customer_id]);
            if (cust.pppoe_username && cust.r_ip) {
                const routerData = { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port };
                await mikrotik.enablePPPoESecret(routerData, cust.pppoe_username);
            }
        }

        // Send WA notification
        if (cust) await notifyPaymentReceived(pool, cust, inv.amount);

        res.json({ success: true, message: 'Invoice lunas & pelanggan diaktifkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Unisolate only (without paying)
router.post('/api/:id/unisolate', async (req, res) => {
    try {
        const [[inv]] = await pool.query('SELECT * FROM invoices WHERE id=?', [req.params.id]);
        if (!inv) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
        
        const [[cust]] = await pool.query(
            "SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?",
            [inv.customer_id]
        );
        
        await pool.query("UPDATE customers SET status='active' WHERE id=?", [inv.customer_id]);
        
        // Enable on MikroTik
        if (cust && cust.pppoe_username && cust.r_ip) {
            const routerData = { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port };
            await mikrotik.enablePPPoESecret(routerData, cust.pppoe_username);
        }
        
        res.json({ success: true, message: 'Pelanggan berhasil dibuka isolirnya (tagihan tetap belum lunas)' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Defer invoice to next month
router.post('/api/:id/defer', async (req, res) => {
    try {
        const [[inv]] = await pool.query('SELECT i.*, c.isolation_date FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id=?', [req.params.id]);
        if (!inv || inv.status !== 'unpaid') return res.json({ success: false, message: 'Invoice tidak valid' });

        const oldDue = new Date(inv.due_date);
        const newDue = new Date(oldDue);
        newDue.setMonth(newDue.getMonth() + 1);
        const newDueStr = newDue.toISOString().split('T')[0];

        await pool.query("UPDATE invoices SET due_date=?, description=CONCAT(IFNULL(description,''),' [Ditunda dari ',due_date,']') WHERE id=?", [newDueStr, req.params.id]);

        // Also unisolate if isolated + enable MikroTik
        const [[cust]] = await pool.query(
            "SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?",
            [inv.customer_id]
        );
        if (cust && cust.status === 'isolated') {
            await pool.query("UPDATE customers SET status='active' WHERE id=? AND status='isolated'", [inv.customer_id]);
            if (cust.pppoe_username && cust.r_ip) {
                const routerData = { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port };
                await mikrotik.enablePPPoESecret(routerData, cust.pppoe_username);
            }
        }

        res.json({ success: true, message: `Invoice ditunda ke ${newDueStr}` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT - Edit invoice
router.put('/api/:id', async (req, res) => {
    const { amount, due_date, status } = req.body;
    try {
        const fields = ['amount=?', 'due_date=?', 'status=?'];
        const vals = [amount, due_date, status];
        if (status === 'paid') { fields.push('paid_at=NOW()'); }
        vals.push(req.params.id);
        await pool.query(`UPDATE invoices SET ${fields.join(',')} WHERE id=?`, vals);

        // Auto-unisolate if marked paid
        if (status === 'paid') {
            const [[inv]] = await pool.query('SELECT customer_id FROM invoices WHERE id=?', [req.params.id]);
            if (inv) await pool.query("UPDATE customers SET status='active' WHERE id=? AND status='isolated'", [inv.customer_id]);
        }
        res.json({ success: true, message: 'Invoice diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Delete invoice
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM invoices WHERE id = ? AND status != "paid"', [req.params.id]);
        res.json({ success: true, message: 'Invoice dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Run auto-isolir manually + MikroTik + WA
router.post('/api/run-isolir', async (req, res) => {
    try {
        const [overdueInvoices] = await pool.query(`
            SELECT DISTINCT i.customer_id 
            FROM invoices i 
            WHERE i.status = 'unpaid' AND i.due_date < CURDATE()
        `);

        let count = 0;
        for (const row of overdueInvoices) {
            const result = await pool.query("UPDATE customers SET status='isolated' WHERE id=? AND status='active'", [row.customer_id]);
            if (result[0].affectedRows > 0) {
                count++;
                // Disable on MikroTik + send WA
                const [[cust]] = await pool.query(
                    "SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?",
                    [row.customer_id]
                );
                if (cust) {
                    if (cust.pppoe_username && cust.r_ip) {
                        const routerData = { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port };
                        mikrotik.disablePPPoESecret(routerData, cust.pppoe_username).catch(() => {});
                    }
                    notifyIsolation(pool, cust).catch(() => {});
                }
            }
        }
        res.json({ success: true, message: `Auto-isolir selesai. ${count} pelanggan baru diisolir.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Send WA reminder for unpaid invoices
router.post('/api/send-reminders', async (req, res) => {
    try {
        const { notifyReminder } = require('../helpers/notification');
        const [unpaidInvoices] = await pool.query(`
            SELECT i.*, c.name, c.phone FROM invoices i 
            JOIN customers c ON i.customer_id = c.id 
            WHERE i.status = 'unpaid' AND c.phone IS NOT NULL AND c.phone != ''
            ORDER BY i.due_date ASC
        `);

        let sent = 0;
        for (const inv of unpaidInvoices) {
            const dueStr = new Date(inv.due_date).toLocaleDateString('id-ID');
            await notifyReminder(pool, inv, inv.amount, dueStr);
            sent++;
        }
        res.json({ success: true, message: `${sent} reminder WA telah dikirim.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
