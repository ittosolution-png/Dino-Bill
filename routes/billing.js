const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
const { notifyInvoiceCreated, notifyPaymentReceived, notifyIsolation } = require('../helpers/notification');
const { logActivity } = require('../helpers/logger');
const { isolateCustomer, unisolateCustomer } = require('../helpers/customer_status');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const activePool = pool || (req.app && req.app.locals ? req.app.locals.pool : null);
        if (!activePool) {
            return res.status(500).send("Database pool initialization error.");
        }
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

        const [
            [invoices],
            [[{ total }]],
            [[statsRow]],
            [customers]
        ] = await Promise.all([
            activePool.query(`SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.pppoe_username, c.status as customer_status, p.name as package_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id LEFT JOIN packages p ON i.package_id = p.id ${whereClause} ORDER BY i.created_at DESC LIMIT ${perPage} OFFSET ${offset}`, params),
            activePool.query(`SELECT COUNT(*) as total FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ${whereClause}`, params),
            activePool.query(`SELECT SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) as paid, SUM(CASE WHEN status='unpaid' THEN 1 ELSE 0 END) as unpaid, SUM(CASE WHEN status='unpaid' AND due_date < CURDATE() THEN 1 ELSE 0 END) as overdue, COALESCE(SUM(CASE WHEN status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW()) THEN amount ELSE 0 END), 0) as totalRevenue FROM invoices`),
            activePool.query("SELECT id, name, pppoe_username FROM customers ORDER BY name ASC")
        ]);

        const paid = statsRow?.paid || 0;
        const unpaid = statsRow?.unpaid || 0;
        const overdue = statsRow?.overdue || 0;
        const totalRevenue = statsRow?.totalRevenue || 0;

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

        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Create Invoice', req.ip, `Manually created invoice for customer ID: ${customer_id} (Rp ${invAmount})`);
        res.json({ success: true, message: 'Invoice berhasil dibuat & notifikasi WA terkirim' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Generate bulk for all active customers this month + send WA
router.post('/api/generate-bulk', async (req, res) => {
    try {
        const [customers] = await pool.query(`SELECT c.*, p.price as package_price FROM customers c LEFT JOIN packages p ON c.package_id = p.id WHERE c.status = 'active' AND (c.billing_method IS NULL OR c.billing_method = 'fixed')`);
        let created = 0;
        const month = new Date().getMonth() + 1;
        const year = new Date().getFullYear();
        const { getSettings } = require('../helpers/notification');
        const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
        const waLimit = parseInt(s.wa_limit) || 50;
        const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
        let sentCount = 0;

        for (const c of customers) {
            const [[exists]] = await pool.query('SELECT id FROM invoices WHERE customer_id=? AND MONTH(due_date)=? AND YEAR(due_date)=?', [c.id, month, year]);
            if (!exists) {
                const day = c.isolation_date || 20;
                const dueDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?, ?, ?, ?, ?)', [c.id, c.package_id, c.package_price || 0, dueDate, 'unpaid']);
                created++;
                
                // Send WA notification only if within limit, but always notify Telegram
                const canSendWA = sentCount < waLimit;
                await notifyInvoiceCreated(pool, c, c.package_price || 0, dueDate, { wa: canSendWA, tg: true });
                if (canSendWA) {
                    sentCount++;
                    if (sentCount < waLimit && sentCount < customers.length) {
                        await new Promise(r => setTimeout(r, waDelay));
                    } else {
                        await new Promise(r => setTimeout(r, 500)); // Delay to avoid Telegram API rate limit
                    }
                } else {
                    await new Promise(r => setTimeout(r, 500)); // Delay to avoid Telegram API rate limit
                }
            }
        }
        res.json({ success: true, message: `${created} invoice berhasil di-generate dan notifikasi WA dikirim dengan jeda.` });
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

        // Auto-unisolate customer + restore on MikroTik/RADIUS
        const [[cust]] = await pool.query("SELECT * FROM customers WHERE id=?", [inv.customer_id]);
        if (cust && cust.status === 'isolated') {
            await unisolateCustomer(pool, inv.customer_id, req.app.locals);
        }

        // Send WA notification
        if (cust) {
            await notifyPaymentReceived(pool, cust, inv.amount);

            // --- Rolling Billing Logic ---
            const today = new Date();
            const currentDay = today.getDate();
            let billingMethod = cust.billing_method || 'fixed';

            // Auto-switch to rolling if paid on/after 25th
            if (currentDay >= 25) {
                billingMethod = 'rolling';
                await pool.query("UPDATE customers SET billing_method='rolling' WHERE id=?", [cust.id]);
            }

            // If rolling, generate next invoice due in 30 days
            if (billingMethod === 'rolling') {
                const nextDue = new Date();
                nextDue.setDate(nextDue.getDate() + 30);
                const nextDueStr = nextDue.toISOString().split('T')[0];
                
                const [[exists]] = await pool.query('SELECT id FROM invoices WHERE customer_id=? AND due_date=?', [cust.id, nextDueStr]);
                if (!exists) {
                    // Ambil data pelanggan terbaru setelah unisolate (pastikan package_id asli/bukan isolir)
                    const [[freshCust]] = await pool.query('SELECT package_id FROM customers WHERE id=?', [cust.id]);
                    const targetPkgId = freshCust?.package_id || cust.package_id;

                    const [pkg] = await pool.query('SELECT price FROM packages WHERE id=?', [targetPkgId]);
                    let amount = pkg[0] && pkg[0].price !== null && pkg[0].price !== undefined ? parseFloat(pkg[0].price) : 0;
                    
                    // Fallback jika paket tidak ditemukan atau bernilai 0: ambil nominal dari tagihan sebelumnya
                    if (amount <= 0 && inv.amount && parseFloat(inv.amount) > 0) {
                        amount = parseFloat(inv.amount);
                    }

                    await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status, description) VALUES (?, ?, ?, ?, ?, ?)', 
                        [cust.id, targetPkgId, amount, nextDueStr, 'unpaid', 'Tagihan Rolling 30 Hari']);
                }
            }
        }

        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Manual Payment', req.ip, `Marked invoice ID: ${req.params.id} as paid manually`);
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
        
        await unisolateCustomer(pool, inv.customer_id, req.app.locals);
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

        // Also unisolate if isolated + restore MikroTik/RADIUS
        const [[cust]] = await pool.query("SELECT status FROM customers WHERE id=?", [inv.customer_id]);
        if (cust && cust.status === 'isolated') {
            await unisolateCustomer(pool, inv.customer_id, req.app.locals);
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
            if (inv) {
                const [[cust]] = await pool.query("SELECT status FROM customers WHERE id=?", [inv.customer_id]);
                if (cust && cust.status === 'isolated') {
                    await unisolateCustomer(pool, inv.customer_id, req.app.locals);
                }
            }
        }
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Edit Invoice', req.ip, `Edited invoice ID: ${req.params.id}`);
        res.json({ success: true, message: 'Invoice diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Delete invoice
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM invoices WHERE id = ? AND status != "paid"', [req.params.id]);
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Delete Invoice', req.ip, `Deleted invoice ID: ${req.params.id}`);
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

        const { getSettings } = require('../helpers/notification');
        const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
        const waLimit = parseInt(s.wa_limit) || 50;
        const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
        let sentCount = 0;
        let count = 0;

        for (const row of overdueInvoices) {
            // Check if active before isolating to avoid double-isolating
            const [[checkCust]] = await pool.query("SELECT status FROM customers WHERE id = ?", [row.customer_id]);
            if (checkCust && checkCust.status === 'active') {
                try {
                    await isolateCustomer(pool, row.customer_id, req.app.locals);
                    count++;
                    const [[cust]] = await pool.query("SELECT * FROM customers WHERE id=?", [row.customer_id]);
                    if (cust) {
                        const canSendWA = sentCount < waLimit;
                        await notifyIsolation(pool, cust, { wa: canSendWA, tg: true });
                        if (canSendWA) {
                            sentCount++;
                            await new Promise(r => setTimeout(r, waDelay));
                        } else {
                            await new Promise(r => setTimeout(r, 500)); // Delay to avoid Telegram API rate limit
                        }
                    }
                } catch (err) {
                    console.error(`[Auto-Isolir API] Gagal isolir pelanggan #${row.customer_id}:`, err.message);
                }
            }
        }
        res.json({ success: true, message: `Auto-isolir selesai. ${count} pelanggan baru diisolir dan dikirimi WA.` });
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

        const { getSettings } = require('../helpers/notification');
        const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
        const waLimit = parseInt(s.wa_limit) || 50;
        const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
        let sentCount = 0;

        for (const inv of unpaidInvoices) {
            if (sentCount >= waLimit) break;
            const dueStr = new Date(inv.due_date).toLocaleDateString('id-ID');
            await notifyReminder(pool, inv, inv.amount, dueStr);
            sentCount++;
            if (sentCount < unpaidInvoices.length) await new Promise(r => setTimeout(r, waDelay));
        }
        res.json({ success: true, message: `${sentCount} reminder WA telah dikirim dengan jeda.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
