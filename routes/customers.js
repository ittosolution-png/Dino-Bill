const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
const { notifyIsolation, notifyPaymentReceived, notifyTechnicianNewCustomer } = require('../helpers/notification');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// GET - List customers
router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = 20;
        const offset = (page - 1) * perPage;
        const search = req.query.search || '';
        const filter = req.query.filter || 'all';

        let conditions = [];
        let params = [];

        if (filter === 'active') conditions.push("c.status = 'active'");
        else if (filter === 'isolated') conditions.push("c.status = 'isolated'");
        else if (filter === 'unpaid') {
            const m = new Date().getMonth() + 1;
            const y = new Date().getFullYear();
            conditions.push(`c.status = 'active' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND MONTH(i.due_date) = ${m} AND YEAR(i.due_date) = ${y} AND i.status = 'paid')`);
        }
        if (search) {
            conditions.push("(c.name LIKE ? OR c.phone LIKE ? OR c.pppoe_username LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const [customers] = await pool.query(
            `SELECT c.*, p.name as package_name, p.price as package_price, r.name as router_name
             FROM customers c 
             LEFT JOIN packages p ON c.package_id = p.id
             LEFT JOIN routers r ON c.router_id = r.id
             ${whereClause} ORDER BY c.created_at DESC LIMIT ${perPage} OFFSET ${offset}`,
            params
        );

        const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM customers c ${whereClause}`, params);
        const [[{ activeCount }]] = await pool.query("SELECT COUNT(*) as activeCount FROM customers WHERE status = 'active'");
        const [[{ isolatedCount }]] = await pool.query("SELECT COUNT(*) as isolatedCount FROM customers WHERE status = 'isolated'");
        const [[{ totalCount }]] = await pool.query("SELECT COUNT(*) as totalCount FROM customers");
        const [packages] = await pool.query('SELECT * FROM packages ORDER BY name ASC');
        const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');
        const [odps] = await pool.query("SELECT id, name FROM map_objects WHERE type = 'odp' ORDER BY name ASC");
        const [technicians] = await pool.query("SELECT id, username, telegram_id FROM users WHERE role = 'technician' ORDER BY username ASC");

        res.render('customers', {
            user: req.session, customers, packages, routers, odps, technicians,
            pagination: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
            stats: { total: totalCount, active: activeCount, isolated: isolatedCount },
            search, filter, currentPage: 'customers'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

// POST - Create customer
router.post('/', async (req, res) => {
    const { name, email, phone, address, package_id, router_id, pppoe_username, pppoe_password, isolation_date, billing_method, lat, lng, odp_id, technician_id } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO customers (name, email, phone, address, package_id, router_id, pppoe_username, pppoe_password, isolation_date, billing_method, lat, lng, odp_id, technician_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email || null, phone, address, package_id || null, router_id || null, pppoe_username, pppoe_password, isolation_date || 20, billing_method || 'fixed', lat || null, lng || null, odp_id || null, technician_id || null, 'active']
        );
        const newCustomerId = result.insertId;

        // Add PPPoE secret to MikroTik if router is selected
        if (router_id && pppoe_username) {
            const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [router_id]);
            if (routerData) {
                const [pkgs] = await pool.query('SELECT speed_limit FROM packages WHERE id=?', [package_id]);
                const profile = pkgs.length > 0 && pkgs[0].speed_limit ? pkgs[0].speed_limit : 'default';
                const result = await mikrotik.addPPPoESecret(routerData, pppoe_username, pppoe_password || '123456', profile);
                if (!result.success) {
                    console.log(`[MikroTik] Gagal tambah PPPoE: ${result.message}`);
                }
            }
        }

        // Notify Technician via Telegram
        if (technician_id) {
            const [[tech]] = await pool.query('SELECT username, telegram_id FROM users WHERE id = ?', [technician_id]);
            const [[pkg]] = await pool.query('SELECT name FROM packages WHERE id = ?', [package_id]);
            if (tech && tech.telegram_id) {
                await notifyTechnicianNewCustomer(pool, tech, {
                    name, phone, address, 
                    package_name: pkg ? pkg.name : '-',
                    pppoe_username
                });
            }
        }

        res.json({ success: true, message: 'Customer berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const { name, email, phone, address, package_id, router_id, pppoe_username, pppoe_password, isolation_date, billing_method, lat, lng, odp_id, technician_id } = req.body;
    try {
        let query = 'UPDATE customers SET name=?, email=?, phone=?, address=?, package_id=?, router_id=?, pppoe_username=?, isolation_date=?, billing_method=?, lat=?, lng=?, odp_id=?, technician_id=?, updated_at=NOW()';
        let values = [name, email || null, phone, address, package_id || null, router_id || null, pppoe_username, isolation_date || 20, billing_method || 'fixed', lat || null, lng || null, odp_id || null, technician_id || null];
        
        if (pppoe_password) {
            query += ', pppoe_password=?';
            values.push(pppoe_password);
        }
        
        query += ' WHERE id=?';
        values.push(req.params.id);
        
        await pool.query(query, values);
        res.json({ success: true, message: 'Customer berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Delete customer
router.delete('/:id', async (req, res) => {
    try {
        // Remove PPPoE from MikroTik first
        const [[customer]] = await pool.query('SELECT c.*, r.* FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?', [req.params.id]);
        if (customer && customer.pppoe_username && customer.ip_address) {
            await mikrotik.removePPPoESecret(customer, customer.pppoe_username);
        }

        await pool.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Customer berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Isolate (also disable in MikroTik + send WA)
router.post('/:id/isolate', async (req, res) => {
    try {
        const [[customer]] = await pool.query(
            'SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?',
            [req.params.id]
        );
        if (!customer) return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });

        await pool.query("UPDATE customers SET status='isolated' WHERE id=?", [req.params.id]);

        // Disable PPPoE on MikroTik
        if (customer.pppoe_username && customer.r_ip) {
            const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
            const result = await mikrotik.disablePPPoESecret(routerData, customer.pppoe_username);
            if (!result.success) console.log(`[MikroTik] Gagal isolir ${customer.pppoe_username}: ${result.message}`);
        }

        // Send WA notification
        await notifyIsolation(pool, customer);

        res.json({ success: true, message: 'Customer berhasil di-isolate' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Unisolate (also enable in MikroTik)
router.post('/:id/unisolate', async (req, res) => {
    try {
        const [[customer]] = await pool.query(
            'SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?',
            [req.params.id]
        );
        if (!customer) return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });

        await pool.query("UPDATE customers SET status='active' WHERE id=?", [req.params.id]);

        // Enable PPPoE on MikroTik
        if (customer.pppoe_username && customer.r_ip) {
            const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
            const result = await mikrotik.enablePPPoESecret(routerData, customer.pppoe_username);
            if (!result.success) console.log(`[MikroTik] Gagal unisolir ${customer.pppoe_username}: ${result.message}`);
        }

        res.json({ success: true, message: 'Customer berhasil di-unisolate' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET - Pay process page
router.get('/:id/pay', async (req, res) => {
    try {
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const [[customer]] = await pool.query(
            `SELECT c.*, p.name as package_name, p.price as package_price 
             FROM customers c LEFT JOIN packages p ON c.package_id = p.id 
             WHERE c.id = ?`, [req.params.id]
        );
        if (!customer) return res.redirect('/customers');

        const [paidRows] = await pool.query(
            "SELECT MONTH(due_date) as m FROM invoices WHERE customer_id=? AND YEAR(due_date)=? AND status='paid'",
            [req.params.id, year]
        );
        const paidMonths = paidRows.map(r => r.m);

        const [payHistory] = await pool.query(
            "SELECT * FROM invoices WHERE customer_id=? AND status='paid' ORDER BY due_date DESC LIMIT 6",
            [req.params.id]
        );

        res.render('pay_process', { user: req.session, customer, paidMonths, payHistory, currentYear: year, currentPage: 'customers' });
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

// POST - Process payment for selected months
router.post('/:id/pay', async (req, res) => {
    const { months, year } = req.body;
    try {
        if (!months || months.length === 0) {
            return res.json({ success: false, message: 'Pilih minimal 1 bulan' });
        }
        const [[customer]] = await pool.query(
            `SELECT c.*, p.price as package_price FROM customers c LEFT JOIN packages p ON c.package_id = p.id WHERE c.id = ?`,
            [req.params.id]
        );
        if (!customer) return res.json({ success: false, message: 'Pelanggan tidak ditemukan' });

        let count = 0;
        let totalAmount = 0;
        for (const m of months) {
            const day = customer.isolation_date || 20;
            const dueDate = `${year}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            
            const [[existing]] = await pool.query(
                "SELECT id FROM invoices WHERE customer_id=? AND MONTH(due_date)=? AND YEAR(due_date)=? AND status='unpaid'",
                [req.params.id, m, year]
            );

            if (existing) {
                await pool.query("UPDATE invoices SET status='paid', paid_at=NOW(), payment_method=? WHERE id=?", [req.body.payment_method || 'Manual', existing.id]);
            } else {
                await pool.query(
                    "INSERT INTO invoices (customer_id, package_id, amount, due_date, status, paid_at, payment_method) VALUES (?,?,?,?,'paid',NOW(),?)",
                    [req.params.id, customer.package_id, customer.package_price || 0, dueDate, req.body.payment_method || 'Manual']
                );
            }
            totalAmount += parseFloat(customer.package_price || 0);
            count++;
        }

        // Unisolate if was isolated + enable on MikroTik
        if (customer.status === 'isolated') {
            await pool.query("UPDATE customers SET status='active' WHERE id=?", [req.params.id]);
            if (customer.pppoe_username) {
                const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [customer.router_id]);
                if (routerData) {
                    await mikrotik.enablePPPoESecret(routerData, customer.pppoe_username);
                }
            }
        }

        // Send WA notification
        if (customer) {
            await notifyPaymentReceived(pool, customer, totalAmount);

            // --- Rolling Billing Logic ---
            const today = new Date();
            const currentDay = today.getDate();
            let billingMethod = customer.billing_method || 'fixed';

            // Auto-switch to rolling if paid on/after 25th
            if (currentDay >= 25) {
                billingMethod = 'rolling';
                await pool.query("UPDATE customers SET billing_method='rolling' WHERE id=?", [customer.id]);
            }

            // If rolling, generate next invoice due in 30 days
            if (billingMethod === 'rolling') {
                const nextDue = new Date();
                nextDue.setDate(nextDue.getDate() + 30);
                const nextDueStr = nextDue.toISOString().split('T')[0];
                
                const [[exists]] = await pool.query('SELECT id FROM invoices WHERE customer_id=? AND due_date=?', [customer.id, nextDueStr]);
                if (!exists) {
                    await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?, ?, ?, ?, ?)', 
                        [customer.id, customer.package_id, customer.package_price || 0, nextDueStr, 'unpaid']);
                }
            }
        }

        res.json({ success: true, message: `Pembayaran ${count} bulan berhasil diproses. Pelanggan diaktifkan kembali.` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
