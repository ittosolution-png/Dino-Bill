const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
const { notifyIsolation, notifyPaymentReceived, notifyTechnicianNewCustomer, notifyInvoiceCreated } = require('../helpers/notification');
const { logActivity } = require('../helpers/logger');
const { isolateCustomer, unisolateCustomer } = require('../helpers/customer_status');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

const requireAdmin = (req, res, next) => {
    if (req.session.role !== 'admin') {
        if (req.session.role === 'sales') return res.redirect('/sales');
        if (req.session.role === 'technician') return res.redirect('/technician');
        return res.redirect('/login');
    }
    next();
};

const requireAdminOrSales = (req, res, next) => {
    if (req.session.role !== 'admin' && req.session.role !== 'sales') {
        return res.status(403).json({ success: false, message: 'Forbidden: Anda tidak memiliki akses.' });
    }
    next();
};

// GET - List customers
router.get('/', requireAdmin, async (req, res) => {
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

        const [
            [customers],
            [[{ total }]],
            [[custStats]],
            [packages],
            [routers],
            [odps],
            [technicians],
            [activeDbSessions]
        ] = await Promise.all([
            pool.query(`SELECT c.*, p.name as package_name, p.price as package_price, r.name as router_name FROM customers c LEFT JOIN packages p ON c.package_id = p.id LEFT JOIN routers r ON c.router_id = r.id ${whereClause} ORDER BY c.created_at DESC LIMIT ${perPage} OFFSET ${offset}`, params),
            pool.query(`SELECT COUNT(*) as total FROM customers c ${whereClause}`, params),
            pool.query(`SELECT COUNT(*) as totalCount, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activeCount, SUM(CASE WHEN status = 'isolated' THEN 1 ELSE 0 END) as isolatedCount FROM customers`),
            pool.query('SELECT * FROM packages ORDER BY name ASC'),
            pool.query('SELECT * FROM routers ORDER BY name ASC'),
            pool.query("SELECT id, name FROM map_objects WHERE type = 'odp' ORDER BY name ASC"),
            pool.query("SELECT id, username, telegram_id FROM users WHERE role = 'technician' ORDER BY username ASC"),
            pool.query("SELECT pppoe_username, last_ip FROM pppoe_session_state WHERE is_online = 1 AND last_ip IS NOT NULL AND last_ip != ''").catch(() => [[]])
        ]);

        const activeCount = custStats?.activeCount || 0;
        const isolatedCount = custStats?.isolatedCount || 0;
        const totalCount = custStats?.totalCount || 0;

        const allActiveSessions = new Map();
        if (activeDbSessions && Array.isArray(activeDbSessions)) {
            activeDbSessions.forEach(s => {
                if (s.pppoe_username) allActiveSessions.set(s.pppoe_username, s.last_ip);
            });
        }

        // Attach active IP to customers
        customers.forEach(c => {
            if (c.pppoe_username && allActiveSessions.has(c.pppoe_username)) {
                c.current_ip = allActiveSessions.get(c.pppoe_username);
            } else {
                c.current_ip = null;
            }
        });

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
router.post('/', requireAdminOrSales, async (req, res) => {
    const { name, email, phone, address, package_id, router_id, pppoe_username, pppoe_password, isolation_date, billing_method, lat, lng, odp_id, technician_id } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO customers (name, email, phone, address, package_id, router_id, pppoe_username, pppoe_password, isolation_date, billing_method, lat, lng, odp_id, technician_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email || null, phone, address, package_id || null, router_id || null, pppoe_username, pppoe_password, isolation_date || 20, billing_method || 'fixed', lat || null, lng || null, odp_id || null, technician_id || null, 'active']
        );
        const newCustomerId = result.insertId;

        // === PRORATED BILLING LOGIC ===
        // Hitung biaya pemakaian prorata untuk tagihan pertama
        let invAmount = 0;
        let invDesc = 'Tagihan Pertama';
        let dueDate = '';
        
        const isolDate = parseInt(isolation_date || 20);
        const today = new Date();
        const currentDay = today.getDate();
        const currentMonth = today.getMonth() + 1;
        const currentYear = today.getFullYear();
        
        let targetMonth = currentMonth;
        let targetYear = currentYear;
        let daysUsed = 0;

        if (currentDay < isolDate) {
            daysUsed = isolDate - currentDay;
        } else if (currentDay > isolDate) {
            const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
            daysUsed = (daysInMonth - currentDay) + isolDate;
            targetMonth++;
            if (targetMonth > 12) {
                targetMonth = 1;
                targetYear++;
            }
        } else {
            daysUsed = 30; // Pasang tepat di tanggal isolir (anggap full month)
            targetMonth++;
            if (targetMonth > 12) {
                targetMonth = 1;
                targetYear++;
            }
        }

        dueDate = `${targetYear}-${String(targetMonth).padStart(2,'0')}-${String(isolDate).padStart(2,'0')}`;

        if (package_id) {
            const [[pkg]] = await pool.query('SELECT price, name FROM packages WHERE id=?', [package_id]);
            if (pkg) {
                const packagePrice = parseFloat(pkg.price || 0);
                if (daysUsed < 30 && daysUsed > 0) {
                    invAmount = Math.round((packagePrice / 30) * daysUsed);
                    invDesc = `Tagihan Prorata (${daysUsed} hari pemakaian)`;
                } else {
                    invAmount = packagePrice;
                    invDesc = `Tagihan Full Bulan Pertama`;
                }
                
                // Generate the invoice
                await pool.query(
                    'INSERT INTO invoices (customer_id, package_id, amount, due_date, status, description) VALUES (?, ?, ?, ?, ?, ?)',
                    [newCustomerId, package_id, invAmount, dueDate, 'unpaid', invDesc]
                );
                
                // Notify the customer about their first bill
                try {
                    const cInfo = { name, phone, pppoe_username };
                    await notifyInvoiceCreated(pool, cInfo, invAmount, dueDate);
                } catch (err) {
                    console.error('[WA] Gagal kirim notif invoice prorata:', err.message);
                }
            }
        }
        // === END PRORATED BILLING LOGIC ===

        // Add PPPoE secret to MikroTik or RADIUS if router is selected
        if (router_id && pppoe_username) {
            const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [router_id]);
            if (routerData) {
                const [pkgs] = await pool.query('SELECT speed_limit FROM packages WHERE id=?', [package_id]);
                const profile = pkgs.length > 0 && pkgs[0].speed_limit ? pkgs[0].speed_limit : 'default';
                
                if (req.app.locals.radiusHelper && routerData.connection_method === 'radius') {
                    await req.app.locals.radiusHelper.addRadiusUser(pppoe_username, pppoe_password || '123456', profile);
                } else {
                    const result = await mikrotik.addPPPoESecret(routerData, pppoe_username, pppoe_password || '123456', profile);
                    if (!result.success) {
                        console.log(`[MikroTik] Gagal tambah PPPoE: ${result.message}`);
                    }
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

        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Add Customer', req.ip, `Added new customer: ${name}`);
        res.json({ success: true, message: 'Customer berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/:id', requireAdmin, async (req, res) => {
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
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Edit Customer', req.ip, `Updated customer ID: ${req.params.id} (${name})`);
        res.json({ success: true, message: 'Customer berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Delete customer
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        // Remove PPPoE from MikroTik or RADIUS first
        const [[customer]] = await pool.query('SELECT c.*, r.* FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?', [req.params.id]);
        if (customer && customer.pppoe_username && customer.ip_address) {
            if (req.app.locals.radiusHelper && customer.connection_method === 'radius') {
                await req.app.locals.radiusHelper.removeRadiusUser(customer.pppoe_username);
            } else {
                await mikrotik.removePPPoESecret(customer, customer.pppoe_username);
            }
        }

        await pool.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Delete Customer', req.ip, `Deleted customer ID: ${req.params.id} (${customer ? customer.name : 'Unknown'})`);
        res.json({ success: true, message: 'Customer berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Isolate (also disable/move in MikroTik + send WA)
router.post('/:id/isolate', requireAdmin, async (req, res) => {
    try {
        await isolateCustomer(pool, req.params.id, req.app.locals);

        // Fetch customer again for notification and logs
        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id=?', [req.params.id]);

        // Send WA notification
        await notifyIsolation(pool, customer);

        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Isolate Customer', req.ip, `Manually isolated customer ID: ${req.params.id} (${customer.name})`);
        res.json({ success: true, message: 'Customer berhasil di-isolate' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Unisolate (also enable/restore in MikroTik)
router.post('/:id/unisolate', requireAdmin, async (req, res) => {
    try {
        await unisolateCustomer(pool, req.params.id, req.app.locals);

        // Fetch customer again for logs
        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id=?', [req.params.id]);

        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Unisolate Customer', req.ip, `Manually unisolated customer ID: ${req.params.id} (${customer.name})`);
        res.json({ success: true, message: 'Customer berhasil di-unisolate' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET - Pay process page
router.get('/:id/pay', requireAdmin, async (req, res) => {
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
router.post('/:id/pay', requireAdmin, async (req, res) => {
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

        // Unisolate if was isolated + restore on MikroTik/RADIUS
        if (customer.status === 'isolated') {
            await unisolateCustomer(pool, req.params.id, req.app.locals);
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
                    // Ambil data pelanggan terbaru setelah unisolate
                    const [[freshCust]] = await pool.query('SELECT package_id FROM customers WHERE id=?', [customer.id]);
                    const targetPkgId = freshCust?.package_id || customer.package_id;

                    const [pkg] = await pool.query('SELECT price FROM packages WHERE id=?', [targetPkgId]);
                    let amount = pkg[0] && pkg[0].price !== null && pkg[0].price !== undefined ? parseFloat(pkg[0].price) : 0;

                    // Fallback jika paket tidak ditemukan atau bernilai 0
                    if (amount <= 0 && customer.package_price && parseFloat(customer.package_price) > 0) {
                        amount = parseFloat(customer.package_price);
                    }
                    if (amount <= 0 && totalAmount && parseFloat(totalAmount) > 0 && count > 0) {
                        amount = Math.round(parseFloat(totalAmount) / count);
                    }

                    await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status, description) VALUES (?, ?, ?, ?, ?, ?)', 
                        [customer.id, targetPkgId, amount, nextDueStr, 'unpaid', 'Tagihan Rolling 30 Hari']);
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
