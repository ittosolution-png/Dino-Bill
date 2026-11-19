/**
 * Plugin: External RADIUS Manager
 * Description: Premium RADIUS integration with external FreeRADIUS/MikroTik User Manager databases
 */
const mysql = require('mysql2/promise');

module.exports = function(app, pool, { requireAuth }) {

    // 1. Establish/Get RADIUS DB Connection Pool dynamically
    async function getRadiusPool() {
        try {
            const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('radius_host', 'radius_port', 'radius_user', 'radius_pass', 'radius_db')");
            const config = {};
            rows.forEach(r => config[r.setting_key] = r.setting_value);

            if (!config.radius_host || !config.radius_db) {
                console.warn("[RADIUS Plugin] Database not fully configured. Using main pool as fallback.");
                return pool; // Fallback to main DB if not configured separately
            }

            return mysql.createPool({
                host: config.radius_host,
                port: parseInt(config.radius_port) || 3306,
                user: config.radius_user || 'root',
                password: config.radius_pass || '',
                database: config.radius_db,
                waitForConnections: true,
                connectionLimit: 5
            });
        } catch (e) {
            console.error("[RADIUS Plugin] Pool Creation Error:", e.message);
            return pool;
        }
    }

    // 2. Define RADIUS DB Helper Functions
    const radiusHelper = {
        addRadiusUser: async (username, password, profile = 'default') => {
            console.log(`[RADIUS Helper] Adding user: ${username} with profile: ${profile}`);
            const db = await getRadiusPool();
            try {
                // Remove if exists
                await db.query("DELETE FROM radcheck WHERE username = ?", [username]);
                await db.query("DELETE FROM radusergroup WHERE username = ?", [username]);

                // Insert into radcheck (Cleartext-Password)
                await db.query(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Cleartext-Password', ':=', ?)",
                    [username, password]
                );

                // Insert into radusergroup (assign profile/group)
                await db.query(
                    "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)",
                    [username, profile]
                );

                return { success: true };
            } catch (e) {
                console.error("[RADIUS Helper] Error adding user:", e.message);
                return { success: false, error: e.message };
            }
        },

        removeRadiusUser: async (username) => {
            console.log(`[RADIUS Helper] Removing user: ${username}`);
            const db = await getRadiusPool();
            try {
                await db.query("DELETE FROM radcheck WHERE username = ?", [username]);
                await db.query("DELETE FROM radusergroup WHERE username = ?", [username]);
                await db.query("DELETE FROM radreply WHERE username = ?", [username]);
                return { success: true };
            } catch (e) {
                console.error("[RADIUS Helper] Error removing user:", e.message);
                return { success: false, error: e.message };
            }
        },

        disableRadiusUser: async (username) => {
            console.log(`[RADIUS Helper] Disabling user: ${username}`);
            const db = await getRadiusPool();
            try {
                // Disabling is usually done by changing group to an 'isolated' group or adding a reject attribute
                // Let's remove group and add to 'isolated' group
                await db.query("DELETE FROM radusergroup WHERE username = ?", [username]);
                await db.query(
                    "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, 'isolated', 1)",
                    [username]
                );
                
                // Add Auth-Type := Reject to radcheck to immediately block connections
                await db.query("DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'", [username]);
                await db.query(
                    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Reject')",
                    [username]
                );
                return { success: true };
            } catch (e) {
                console.error("[RADIUS Helper] Error disabling user:", e.message);
                return { success: false, error: e.message };
            }
        },

        enableRadiusUser: async (username) => {
            console.log(`[RADIUS Helper] Enabling user: ${username}`);
            const db = await getRadiusPool();
            try {
                // Remove Reject attribute
                await db.query("DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'", [username]);

                // Reset group back to customer package profile
                // Find package and profile name from app database
                const [[cust]] = await pool.query(
                    "SELECT p.speed_limit FROM customers c LEFT JOIN packages p ON c.package_id = p.id WHERE c.pppoe_username = ?",
                    [username]
                );
                const profile = cust && cust.speed_limit ? cust.speed_limit : 'default';

                await db.query("DELETE FROM radusergroup WHERE username = ?", [username]);
                await db.query(
                    "INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)",
                    [username, profile]
                );
                return { success: true };
            } catch (e) {
                console.error("[RADIUS Helper] Error enabling user:", e.message);
                return { success: false, error: e.message };
            }
        }
    };

    // Attach radiusHelper globally to req.app.locals
    app.locals.radiusHelper = radiusHelper;

    // 3. Admin Routes for RADIUS Manager Settings Dashboard
    app.get('/radius-manager', requireAuth, async (req, res) => {
        // Double check in DB just in case
        if (!res.locals.plugins?.radius_manager?.is_active) {
            return res.send('<h1>Akses Ditolak</h1><p>Lisensi Anda tidak mencakup fitur ini.</p>');
        }

        try {
            // Load current settings
            const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('radius_host', 'radius_port', 'radius_user', 'radius_pass', 'radius_db')");
            const config = {};
            rows.forEach(r => config[r.setting_key] = r.setting_value);

            res.render('radius_manager_dashboard', {
                user: req.session,
                config,
                currentPage: 'radius-manager'
            });
        } catch (e) {
            res.status(500).send("Error rendering dashboard: " + e.message);
        }
    });

    app.post('/radius-manager/save', requireAuth, async (req, res) => {
        const { radius_host, radius_port, radius_user, radius_pass, radius_db } = req.body;
        try {
            const settingsToSave = [
                ['radius_host', radius_host],
                ['radius_port', radius_port || '3306'],
                ['radius_user', radius_user],
                ['radius_pass', radius_pass],
                ['radius_db', radius_db]
            ];

            for (const [key, value] of settingsToSave) {
                await pool.query(
                    "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                    [key, value, value]
                );
            }

            res.json({ success: true, message: 'Konfigurasi RADIUS berhasil disimpan!' });
        } catch (e) {
            res.json({ success: false, message: e.message });
        }
    });

    app.post('/radius-manager/test-connection', requireAuth, async (req, res) => {
        const { radius_host, radius_port, radius_user, radius_pass, radius_db } = req.body;
        try {
            const testConn = await mysql.createConnection({
                host: radius_host,
                port: parseInt(radius_port) || 3306,
                user: radius_user || 'root',
                password: radius_pass || '',
                database: radius_db,
                connectTimeout: 5000
            });
            await testConn.query("SELECT 1");
            await testConn.end();
            res.json({ success: true, message: 'Koneksi ke database RADIUS Berhasil! ✅' });
        } catch (e) {
            res.json({ success: false, message: 'Koneksi Gagal: ' + e.message });
        }
    });

    // 4. Create local EJS dashboard file automatically
    const fs = require('fs');
    const path = require('path');
    const viewPath = path.join(__dirname, '..', 'views', 'radius_manager_dashboard.ejs');

    const viewContent = `
<%- include('partials/head') %>
<%- include('partials/sidebar') %>

<style>
    .premium-container { padding: 25px; max-width: 900px; margin: 0 auto; }
    .glass-card {
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 28px;
        margin-bottom: 25px;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; }
    .form-control-premium {
        background: var(--input-bg);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 10px;
        padding: 11px 14px;
        width: 100%;
        font-size: 14px;
        outline: none;
        transition: all 0.2s;
        font-family: 'Outfit', sans-serif;
    }
    .form-control-premium:focus {
        border-color: var(--primary);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    .form-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 15px; }
    @media(max-width: 768px) { .form-grid { grid-template-columns: 1fr; } }
    .toast { position: fixed; bottom: 24px; right: 24px; background: var(--toast-bg); color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 14px 20px; z-index: 9999; display: none; font-size: 14px; }
    .toast.show { display: block; }
</style>

<main class="main">
    <%- include('partials/topbar', { title: 'RADIUS Manager' }) %>

    <div class="premium-container">
        <div class="glass-card">
            <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 6px; color: var(--text)">
                <i class="fa-solid fa-circle-nodes" style="margin-right:8px; color:var(--primary)"></i>Pengaturan RADIUS Eksternal
            </h2>
            <p style="color: var(--muted); font-size: 14px; margin-bottom: 25px;">
                Hubungkan Dino-Bill dengan database RADIUS eksternal (FreeRADIUS / User Manager MikroTik) untuk otentikasi PPPoE dan Hotspot terpusat.
            </p>

            <form id="radiusForm">
                <div class="form-grid">
                    <div class="form-group">
                        <label>Host / IP Address Database RADIUS</label>
                        <input type="text" id="radiusHost" class="form-control-premium" value="<%= config.radius_host || '' %>" placeholder="localhost atau 192.168.1.x" required>
                    </div>
                    <div class="form-group">
                        <label>Port</label>
                        <input type="number" id="radiusPort" class="form-control-premium" value="<%= config.radius_port || '3306' %>" required>
                    </div>
                </div>

                <div class="form-group">
                    <label>Nama Database RADIUS</label>
                    <input type="text" id="radiusDb" class="form-control-premium" value="<%= config.radius_db || 'radius' %>" placeholder="radius" required>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label>Username Database</label>
                        <input type="text" id="radiusUser" class="form-control-premium" value="<%= config.radius_user || 'root' %>" required>
                    </div>
                    <div class="form-group">
                        <label>Password Database</label>
                        <input type="password" id="radiusPass" class="form-control-premium" value="<%= config.radius_pass || '' %>" placeholder="Kosongkan jika tidak ada">
                    </div>
                </div>

                <div style="display:flex; gap:12px; margin-top:15px; flex-wrap: wrap;">
                    <button type="submit" class="btn btn-primary" style="flex:1; justify-content:center; padding:12px">
                        <i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Simpan Pengaturan
                    </button>
                    <button type="button" onclick="testConnection()" class="btn" style="background: rgba(139,92,246,.15); color: var(--secondary); border: 1px solid rgba(139,92,246,.3); padding:12px">
                        <i class="fa-solid fa-plug" style="margin-right:6px"></i>Uji Koneksi
                    </button>
                </div>
            </form>
        </div>
    </div>
</main>

<div class="toast" id="toast"></div>

<script>
    document.getElementById('radiusForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
            radius_host: document.getElementById('radiusHost').value,
            radius_port: document.getElementById('radiusPort').value,
            radius_db: document.getElementById('radiusDb').value,
            radius_user: document.getElementById('radiusUser').value,
            radius_pass: document.getElementById('radiusPass').value
        };

        const res = await fetch('/radius-manager/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const d = await res.json();
        showToast(d.message, d.success ? 'success' : 'error');
    });

    async function testConnection() {
        showToast('⏳ Menguji koneksi database...', 'success');
        const body = {
            radius_host: document.getElementById('radiusHost').value,
            radius_port: document.getElementById('radiusPort').value,
            radius_db: document.getElementById('radiusDb').value,
            radius_user: document.getElementById('radiusUser').value,
            radius_pass: document.getElementById('radiusPass').value
        };

        const res = await fetch('/radius-manager/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const d = await res.json();
        showToast(d.message, d.success ? 'success' : 'error');
    }

    function showToast(msg, type) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.style.borderColor = type === 'success' ? 'rgba(16,185,129,.4)' : 'rgba(239,68,68,.4)';
        t.style.color = type === 'success' ? '#10B981' : '#EF4444';
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 4000);
    }
</script>
</body>
</html>
    `;

    if (!fs.existsSync(viewPath)) {
        fs.writeFileSync(viewPath, viewContent);
    }
    console.log("External RADIUS Manager Plugin Initialized! ✅");
};
