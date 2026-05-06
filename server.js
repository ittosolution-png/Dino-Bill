const express = require('express');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const dotenv = require('dotenv');

// Check if .env exists, if not, we are in "install mode"
const envPath = path.join(__dirname, '.env');
const isInstalled = fs.existsSync(envPath);

if (isInstalled) {
  dotenv.config();
}

const app = express();
const PORT = process.env.APP_PORT || 3999;

// Background Task Requirements
const cron = require('node-cron');
const { notifyIsolation, notifyInvoiceCreated, notifyReminder } = require('./helpers/notification');
const mikrotikHelper = require('./helpers/mikrotik');
const bcrypt = require('bcryptjs');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let pool; // Global database pool
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: true
}));

// Localization Middleware
const locales = {
  id: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'id.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8'))
};

app.use((req, res, next) => {
  const lang = req.session.lang || 'id';
  res.locals.lang = lang;
  res.locals.t = locales[lang] || locales['id'];
  next();
});

app.get('/set-lang/:lang', (req, res) => {
  const lang = req.params.lang;
  if (['id', 'en'].includes(lang)) {
    req.session.lang = lang;
  }
  res.redirect('back');
});

// Setup Routes
if (!isInstalled) {
  console.log("No .env found. Running in Install Mode.");
  
  // Redirect all traffic to /install
  app.use((req, res, next) => {
    if (!req.path.startsWith('/install') && !req.path.startsWith('/assets')) {
      return res.redirect('/install');
    }
    next();
  });

  app.get('/install', (req, res) => {
    res.render('installer', { step: 1, error: null });
  });

  app.post('/install/setup', async (req, res) => {
    const { dbHost, dbUser, dbPass, dbName } = req.body;
    
    // Test DB Connection
    try {
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection({
        host: dbHost,
        user: dbUser,
        password: dbPass
      });
      
      // Create DB if not exists
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
      await connection.query(`USE \`${dbName}\`;`);
      
      // Create Users table and insert default admin
      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'admin',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      const bcrypt = require('bcryptjs');
      const hashedPass = await bcrypt.hash('admin', 10);
      
      // Check if admin exists
      const [rows] = await connection.query(`SELECT * FROM users WHERE username = 'admin'`);
      if (rows.length === 0) {
        await connection.query(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [hashedPass]);
      }
      
      // Generate .env file
      const envContent = `DB_HOST=${dbHost}
DB_PORT=3306
DB_NAME=${dbName}
DB_USER=${dbUser}
DB_PASS=${dbPass}
APP_PORT=3999
APP_NAME=Dino-Bill
NODE_ENV=production
SESSION_SECRET=${Math.random().toString(36).substring(2, 15)}
`;
      fs.writeFileSync(envPath, envContent);
      
      // Needs restart or dynamic reload
      res.render('installer', { step: 'success', error: null });
      
      setTimeout(() => {
        console.log("Restarting server to apply .env changes...");
        process.exit(0); // PM2 or nodemon will restart it
      }, 3000);
      
    } catch (err) {
      res.render('installer', { step: 1, error: "Database Connection Failed: " + err.message });
    }
  });

} else {
  // App is installed, load normal routes
  const mysql = require('mysql2/promise');
  const bcrypt = require('bcryptjs');
  
  // Create DB pool
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });


  // Auto-initialize tables that might be missing
  pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      speed_limit VARCHAR(50),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      address TEXT,
      package_id INT,
      router_id INT,
      pppoe_username VARCHAR(50),
      pppoe_password VARCHAR(50),
      billing_method VARCHAR(20) DEFAULT 'fixed',
      isolation_date INT DEFAULT 20,
      lat VARCHAR(30),
      lng VARCHAR(30),
      portal_password VARCHAR(255),
      email VARCHAR(100),
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Add missing columns if upgrade from old schema
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS router_id INT`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS isolation_date INT DEFAULT 20`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_method VARCHAR(20) DEFAULT 'fixed'`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS lat VARCHAR(30)`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS lng VARCHAR(30)`).catch(() => {});
  pool.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
  pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS package_id INT`).catch(() => {});
  pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP NULL`).catch(() => {});
  pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
  pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'Manual'`).catch(() => {});
  pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50) DEFAULT ''`).catch(() => {});
  pool.query(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`).catch(() => {});
  pool.query(`ALTER TABLE trouble_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP NULL`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_password VARCHAR(255) NULL`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS pppoe_password VARCHAR(100) DEFAULT '123456'`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(100)`).catch(() => {});
  pool.query(`ALTER TABLE trouble_tickets ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
  pool.query(`ALTER TABLE hioso_olts ADD COLUMN IF NOT EXISTS last_profile VARCHAR(100)`).catch(() => {});
  // Safer migration for 'brand' column
  pool.query("SHOW COLUMNS FROM hioso_olts LIKE 'brand'").then(([rows]) => {
    if (rows.length === 0) {
        return pool.query("ALTER TABLE hioso_olts ADD COLUMN brand VARCHAR(50) DEFAULT 'HIOSO'");
    }
  }).catch(() => {});
  pool.query(`ALTER TABLE hioso_onus ADD COLUMN IF NOT EXISTS mac VARCHAR(100)`).catch(() => {});
  pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS odp_id INT`).catch(() => {});

  pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      package_id INT,
      invoice_number VARCHAR(50) DEFAULT '',
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) DEFAULT 'unpaid',
      description TEXT,
      payment_method VARCHAR(50) DEFAULT 'Manual',
      due_date DATE,
      paid_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS routers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      ip_address VARCHAR(50) NOT NULL,
      username VARCHAR(50) NOT NULL,
      password VARCHAR(100) NOT NULL,
      port INT DEFAULT 8728,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setting_key VARCHAR(50) NOT NULL UNIQUE,
      setting_value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);
  
  // Initialize Default Settings for Full Autopilot
  const defaultSettings = [
    ['auto_billing_enabled', '1'],
    ['auto_isolate_enabled', '1'],
    ['reminder_days_before', '3'],
    ['auto_generate_day', '1'],
    ['late_tolerance_days', '0'],
    ['invoice_prefix', 'INV'],
    ['currency', 'IDR'],
    ['timezone', 'Asia/Jakarta'],
    ['wa_provider', 'external'],
    ['wa_api_token', ''],
    ['wa_api_url', ''],
    ['wa_delay', '5'],
    ['wa_limit', '50']
];
  for (const [key, val] of defaultSettings) {
    pool.query('INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, val]).catch(() => {});
  }

  pool.query(`
    CREATE TABLE IF NOT EXISTS technician_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      phone VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS sales_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      balance DECIMAL(15,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS trouble_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      title VARCHAR(200),
      description TEXT,
      status VARCHAR(20) DEFAULT 'open',
      priority VARCHAR(20) DEFAULT 'normal',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS map_objects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL, -- 'server', 'odp'
      lat VARCHAR(50) NOT NULL,
      lng VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS map_cables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100),
      path TEXT NOT NULL, -- JSON array of [lat, lng]
      color VARCHAR(20) DEFAULT '#3b82f6',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);
  
  pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(50),
      stock INT DEFAULT 0,
      unit VARCHAR(20) DEFAULT 'pcs',
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      profile VARCHAR(50),
      status VARCHAR(20) DEFAULT 'unused',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS hioso_olts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      host VARCHAR(100) NOT NULL,
      port INT DEFAULT 161,
      community VARCHAR(100) DEFAULT 'public',
      web_user VARCHAR(100) DEFAULT 'admin',
      web_password VARCHAR(100) DEFAULT 'admin',
      status VARCHAR(20) DEFAULT 'active',
      last_profile VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS hioso_onus (
      id INT AUTO_INCREMENT PRIMARY KEY,
      olt_id INT NOT NULL,
      onu_index VARCHAR(100) NOT NULL,
      name VARCHAR(100),
      sn VARCHAR(100),
      tx_power VARCHAR(20),
      rx_power VARCHAR(20),
      status VARCHAR(50),
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY (olt_id, onu_index)
    )
  `).catch(console.error);

  // Global Settings Middleware
  app.use(async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings');
      const settings = {};
      rows.forEach(r => settings[r.setting_key] = r.setting_value);
      res.locals.settings = settings;
      next();
    } catch (err) {
      console.error("Settings Middleware Error:", err);
      res.locals.settings = {};
      next();
    }
  });

  // Daily Admin Report Cron (Run at 08:30 AM)
  cron.schedule('30 8 * * *', async () => {
    try {
      console.log('[CRON] Sending Daily Admin Report...');
      const [[stats]] = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM customers) as total_cust,
          (SELECT COUNT(*) FROM customers WHERE status='active') as active_cust,
          (SELECT COUNT(*) FROM customers WHERE status='isolated') as isolated_cust,
          (SELECT COUNT(*) FROM trouble_tickets WHERE status='open') as open_tickets,
          (SELECT COALESCE(SUM(amount),0) FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW())) as revenue_month
        FROM (SELECT 1) as t
      `);

      const { sendWhatsApp, sendTelegram } = require('./helpers/notification');
      const [adminRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'wa_admin'");
      const adminPhone = adminRows[0] ? adminRows[0].setting_value : null;

      const reportMsg = `📊 *Laporan Harian Dino-Bill*\n\n` +
        `👥 Pelanggan: ${stats.total_cust} (${stats.active_cust} Aktif, ${stats.isolated_cust} Isolir)\n` +
        `🎫 Tiket Terbuka: ${stats.open_tickets}\n` +
        `💰 Omset Bln Ini: Rp ${parseFloat(stats.revenue_month).toLocaleString('id-ID')}\n\n` +
        `Sistem berjalan normal. ✅`;

      if (adminPhone) await sendWhatsApp(pool, adminPhone, reportMsg).catch(() => {});
      await sendTelegram(pool, reportMsg).catch(() => {});
    } catch (e) {
      console.error('[CRON] Admin Report Error:', e.message);
    }
  });

  // Removed redundant manual setInterval scheduler (runDailyTasks) 
  // as tasks are now handled by node-cron jobs below for better precision.


  // Auth Middleware
  const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
      return res.redirect('/login');
    }
    next();
  };

  const requireRole = (role) => {
    return (req, res, next) => {
      if (!req.session.userId) return res.redirect('/login');
      if (req.session.role !== 'admin' && req.session.role !== role) {
        return res.status(403).send("Forbidden: Anda tidak memiliki akses ke halaman ini.");
      }
      next();
    };
  };

  const acsRoutes = require('./routes/acs');
  acsRoutes.setPool(pool);
  app.use('/acs', requireAuth, acsRoutes);

  const oltRoutes = require('./routes/olt');
  oltRoutes.setPool(pool);
  app.use('/olt', requireAuth, oltRoutes);

  app.get('/technician', requireRole('technician'), async (req, res) => {
    try {
        const search = req.query.search || '';
        let tickets = [];
        let searchResults = [];

        // 1. Get Open Tickets
        [tickets] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.address as customer_address, c.phone as customer_phone, c.pppoe_username, c.lat, c.lng 
            FROM trouble_tickets t 
            JOIN customers c ON t.customer_id = c.id 
            WHERE t.status = "open" 
            ORDER BY t.priority DESC, t.created_at ASC`);

        // 2. Handle Search if provided
        if (search) {
            [searchResults] = await pool.query(`
                SELECT c.*, p.name as package_name, 
                       u.rx_power, u.status as onu_status, u.onu_index, u.olt_id, o.name as olt_name
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                LEFT JOIN hioso_onus u ON u.id = (
                    SELECT id FROM hioso_onus 
                    WHERE (name = c.pppoe_username OR name = c.name) AND name IS NOT NULL AND name != ''
                    ORDER BY status DESC, last_updated DESC 
                    LIMIT 1
                )
                LEFT JOIN hioso_olts o ON u.olt_id = o.id
                WHERE c.phone LIKE ? OR c.pppoe_username LIKE ? OR c.name LIKE ?
                LIMIT 10
            `, [`%${search}%`, `%${search}%`, `%${search}%`]);
        }

        // 3. Get all customers with coordinates for the map
        const [customerMarkers] = await pool.query(`
            SELECT id, name, lat, lng, status, address, pppoe_username 
            FROM customers 
            WHERE lat IS NOT NULL AND lng IS NOT NULL
        `);

        // 4. Get map objects and cables
        const [mapObjects] = await pool.query('SELECT * FROM map_objects');
        const [mapCables] = await pool.query('SELECT * FROM map_cables');

        res.render('technician_portal', { 
            user: req.session, 
            tickets, 
            searchResults,
            customerMarkers,
            mapObjects,
            mapCables: mapCables.map(c => ({ ...c, path: JSON.parse(c.path) })),
            search,
            currentPage: 'technician' 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Portal error: " + e.message);
    }
  });

  // API to fetch real-time Wifi SSID from GenieACS
  app.get('/technician/api/wifi-info', requireRole('technician'), async (req, res) => {
    const { pppoe } = req.query;
    if (!pppoe) return res.json({ success: false, message: 'PPPoE user required' });

    try {
        const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass')");
        const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);
        
        if (!s.acs_url) return res.json({ success: false, message: 'ACS not configured' });

        const axios = require('axios');
        const auth = s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined;
        
        // Find device by PPPoE username
        const query = {
            "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username": pppoe
        };
        const projection = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase";

        const response = await axios.get(`${s.acs_url}/devices`, {
            params: { query: JSON.stringify(query), projection },
            auth,
            timeout: 5000
        });

        if (response.data && response.data.length > 0) {
            const dev = response.data[0];
            const getVal = (p) => {
                const parts = p.split('.');
                let v = dev;
                for (const pt of parts) {
                  v = (v && v[pt]) ? v[pt] : undefined;
                }
                return (v && v._value) ? v._value : v;
            };
            const ssid = getVal('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            const pass = getVal('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase');
            res.json({ success: true, ssid: ssid || 'Unknown', password: pass || 'Unknown' });
        } else {
            res.json({ success: false, message: 'Device not found in ACS' });
        }
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
  });

  // API to fetch real-time ONU Signal (RX Power) from OLT
  app.get('/technician/api/onu-info', requireRole('technician'), async (req, res) => {
    const { olt_id, index } = req.query;
    if (!olt_id || !index) return res.json({ success: false, message: 'OLT ID and Index required' });

    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT not found' });

        const HiosoOLT = require('./helpers/olt');
        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        
        // Fetch real-time data
        const data = await helper.getOnuData(index, olt.last_profile);
        
        // Update database with latest values
        await pool.query(
            'UPDATE hioso_onus SET rx_power = ?, status = ?, last_updated = NOW() WHERE olt_id = ? AND onu_index = ?',
            [data.rx_power, data.status, olt_id, index]
        );

        res.json({ success: true, rx_power: data.rx_power, status: data.status });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
  });

  // API to fetch active PPPoE connections from all routers that are NOT in the database
  app.get('/api/mikrotik/active-pppoe-unlinked', requireAuth, async (req, res) => {
    try {
        const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
        if (routers.length === 0) return res.json({ success: false, message: 'No active routers' });

        const [existingCustomers] = await pool.query("SELECT pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != ''");
        const existingNames = new Set(existingCustomers.map(c => c.pppoe_username));

        const MikroTik = require('./helpers/mikrotik');
        let allActive = [];

        for (const router of routers) {
            const result = await MikroTik.getActiveConnections(router);
            if (result.success) {
                // Filter ones not in database
                const unlinked = result.data.filter(c => !existingNames.has(c.name));
                allActive = allActive.concat(unlinked.map(c => ({ 
                    username: c.name, 
                    address: c.address, 
                    uptime: c.uptime,
                    router_id: router.id, 
                    router_name: router.name 
                })));
            }
        }

        res.json({ success: true, data: allActive });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
  });


  app.get('/sales', requireRole('sales'), async (req, res) => {
    const [leads] = await pool.query('SELECT * FROM customers ORDER BY created_at DESC LIMIT 20');
    const [[{ totalLeads }]] = await pool.query('SELECT COUNT(*) as totalLeads FROM customers');
    const [[{ closingMonth }]] = await pool.query('SELECT COUNT(*) as closingMonth FROM customers WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())');
    const [packages] = await pool.query('SELECT * FROM packages ORDER BY price ASC');
    const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');
    res.render('sales_portal', { 
        user: req.session, 
        leads, 
        totalLeads, 
        closingMonth, 
        packages,
        routers,
        commission: closingMonth * 50000,
        currentPage: 'sales'
    });
  });

  const mapRouter = require('./routes/map');
  mapRouter.setPool(pool);
  app.use('/map', requireAuth, mapRouter);

  app.get('/map', requireAuth, async (req, res) => {
    const [customers] = await pool.query(`
        SELECT c.*, o.lat as odp_lat, o.lng as odp_lng, o.name as odp_name 
        FROM customers c 
        LEFT JOIN map_objects o ON c.odp_id = o.id 
        WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL
    `);
    const [objects] = await pool.query('SELECT * FROM map_objects');
    const [cables] = await pool.query('SELECT * FROM map_cables');
    res.render('map', { 
        user: req.session, 
        customers, 
        objects,
        cables: cables.map(c => ({ ...c, path: JSON.parse(c.path) })),
        currentPage: 'map' 
    });
  });

  app.get('/api/mikrotik/traffic', requireAuth, async (req, res) => {
    try {
      const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
      const trafficData = [];
      const mikrotik = require('./helpers/mikrotik');
      
      for (const r of routers) {
        // Try ether1 as default, if fails it will just return 0
        const result = await mikrotik.getInterfaceTraffic(r, 'ether1');
        if (result.success) {
          trafficData.push({
            router_id: r.id,
            router_name: r.name,
            rx: parseInt(result.data.rx),
            tx: parseInt(result.data.tx)
          });
        }
      }
      res.json({ success: true, data: trafficData });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  const hotspotRoutes = require('./routes/hotspot');
  hotspotRoutes.setPool(pool);
  app.use('/hotspot', requireAuth, hotspotRoutes);
  app.use('/vouchers', (req, res) => res.redirect('/hotspot/vouchers'));

  app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login', { error: null });
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
      if (rows.length > 0) {
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (match) {
          req.session.userId = user.id;
          req.session.role = user.role;
          req.session.username = user.username;
          
          if (user.role === 'technician') return res.redirect('/technician');
          if (user.role === 'sales') return res.redirect('/sales');
          return res.redirect('/');
        }
      }
      res.render('login', { error: 'Invalid username or password' });
    } catch (err) {
      res.render('login', { error: 'Database error occurred' });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/', requireAuth, async (req, res) => {
    try {
      const [[{ totalCustomers }]] = await pool.query("SELECT COUNT(*) as totalCustomers FROM customers");
      const [[{ activeCustomers }]] = await pool.query("SELECT COUNT(*) as activeCustomers FROM customers WHERE status='active'");
      const [[{ isolatedCustomers }]] = await pool.query("SELECT COUNT(*) as isolatedCustomers FROM customers WHERE status='isolated'");
      const [[{ unpaidInvoices }]] = await pool.query("SELECT COUNT(*) as unpaidInvoices FROM invoices WHERE status='unpaid'");
      const [[{ overdueInvoices }]] = await pool.query("SELECT COUNT(*) as overdueInvoices FROM invoices WHERE status='unpaid' AND due_date < CURDATE()");
      const [[{ totalRevenue }]] = await pool.query("SELECT COALESCE(SUM(amount),0) as totalRevenue FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW())");
      const [[{ openTickets }]] = await pool.query("SELECT COUNT(*) as openTickets FROM trouble_tickets WHERE status='open'");

      // Monthly revenue for chart (last 6 months)
      const monthlyRevenue = [];
      const monthlyCustomers = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const m = d.getMonth() + 1;
        const y = d.getFullYear();
        const label = d.toLocaleString('id-ID', { month: 'short', year: 'numeric' });
        const [[{ rev }]] = await pool.query("SELECT COALESCE(SUM(amount),0) as rev FROM invoices WHERE status='paid' AND MONTH(paid_at)=? AND YEAR(paid_at)=?", [m, y]);
        const [[{ cnt }]] = await pool.query("SELECT COUNT(*) as cnt FROM customers WHERE MONTH(created_at)=? AND YEAR(created_at)=?", [m, y]);
        monthlyRevenue.push({ month: label, revenue: parseFloat(rev) });
        monthlyCustomers.push({ month: label, count: parseInt(cnt) });
      }

      const [recentInvoices] = await pool.query(
        `SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ORDER BY i.created_at DESC LIMIT 10`
      );
      const [recentCustomers] = await pool.query(
        `SELECT c.*, p.name as package_name FROM customers c LEFT JOIN packages p ON c.package_id = p.id ORDER BY c.created_at DESC LIMIT 5`
      );

      const [[oltStats]] = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="Up" THEN 1 ELSE 0 END) as online FROM hioso_onus');
      const [[routerStats]] = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as online FROM routers');

      res.render('dashboard', {
        user: req.session,
        stats: { totalCustomers, activeCustomers, isolatedCustomers, unpaidInvoices, overdueInvoices, totalRevenue, openTickets },
        monthlyRevenue, monthlyCustomers, recentInvoices, recentCustomers,
        oltStats: oltStats || { total: 0, online: 0 },
        routerStats: routerStats || { total: 0, online: 0 },
        currentPage: 'dashboard'
      });
    } catch (err) {
      console.error(err);
      res.render('dashboard', { 
        user: req.session, 
        stats: {}, 
        monthlyRevenue: [], 
        monthlyCustomers: [], 
        recentInvoices: [], 
        recentCustomers: [],
        oltStats: { total: 0, online: 0 },
        routerStats: { total: 0, online: 0 },
        currentPage: 'dashboard'
      });
    }
  });

  // Register Routes
  const customersRouter = require('./routes/customers');
  customersRouter.setPool(pool);
  app.use('/customers', requireAuth, customersRouter);

  const billingRouter = require('./routes/billing');
  billingRouter.setPool(pool);
  app.use('/billing', requireAuth, billingRouter);

  const mikrotikRouter = require('./routes/mikrotik');
  mikrotikRouter.setPool(pool);
  app.use('/mikrotik', requireAuth, mikrotikRouter);

  const settingsRouter = require('./routes/settings');
  settingsRouter.setPool(pool);
  app.use('/settings', requireAuth, settingsRouter);

  const portalRoutes = require('./routes/portal');
  portalRoutes.setPool(pool);
  app.use('/portal', portalRoutes);

  const packagesRouter = require('./routes/packages');
  packagesRouter.setPool(pool);
  app.use('/packages', requireAuth, packagesRouter);

  const ticketsRouter = require('./routes/tickets');
  ticketsRouter.setPool(pool);
  app.use('/tickets', requireAuth, ticketsRouter);

  const inventoryRouter = require('./routes/inventory');
  inventoryRouter.setPool(pool);
  app.use('/inventory', requireAuth, inventoryRouter);

  // Background Tasks / Cron Jobs

  // Daily at midnight: auto-isolate overdue customers + MikroTik + WA
  cron.schedule('0 0 * * *', async () => {
    try {
      console.log('[CRON] Running daily auto-isolir...');
      const [overdueRows] = await pool.query(
        `SELECT DISTINCT i.customer_id FROM invoices i
         WHERE i.status = 'unpaid' AND i.due_date < CURDATE()`
      );
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;
      let count = 0;

      for (const row of overdueRows) {
        if (sentCount >= waLimit) break;
        const [result] = await pool.query(
          "UPDATE customers SET status='isolated' WHERE id=? AND status='active'", [row.customer_id]
        );
        if (result.affectedRows > 0) {
          count++;
          // Disable on MikroTik + send WA
          const [[cust]] = await pool.query(
            "SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?",
            [row.customer_id]
          );
          if (cust) {
            if (cust.pppoe_username && cust.r_ip) {
              mikrotikHelper.disablePPPoESecret(
                { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port },
                cust.pppoe_username
              ).catch(() => {});
            }
            await notifyIsolation(pool, cust);
            sentCount++;
            await new Promise(r => setTimeout(r, waDelay));
          }
        }
      }
      console.log(`[CRON] Auto-isolir done. ${count} customers isolated and notified.`);
    } catch (e) {
      console.error('[CRON] Auto-isolir error:', e.message);
    }
  });


  // Daily at 8 AM: send WA reminder for invoices due in 3 days
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log('[CRON] Sending payment reminders...');
      const [upcoming] = await pool.query(
        `SELECT i.*, c.name, c.phone FROM invoices i
         JOIN customers c ON i.customer_id = c.id
         WHERE i.status = 'unpaid' AND i.due_date = DATE_ADD(CURDATE(), INTERVAL 3 DAY)
         AND c.phone IS NOT NULL AND c.phone != ''`
      );
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;

      for (const inv of upcoming) {
        if (sentCount >= waLimit) break;
        const dueStr = new Date(inv.due_date).toLocaleDateString('id-ID');
        await notifyReminder(pool, inv, inv.amount, dueStr);
        sentCount++;
        await new Promise(r => setTimeout(r, waDelay));
      }
      console.log(`[CRON] Reminders sent: ${sentCount}`);
    } catch (e) {
      console.error('[CRON] Reminder error:', e.message);
    }
  });

  // Monthly on 1st: generate invoices for all active customers + send WA
  cron.schedule('0 6 1 * *', async () => {
    try {
      console.log('[CRON] Generating monthly invoices...');
      const [customers] = await pool.query(
        `SELECT c.*, p.price as package_price FROM customers c 
         LEFT JOIN packages p ON c.package_id = p.id WHERE c.status = 'active' AND (c.billing_method IS NULL OR c.billing_method = 'fixed')`
      );
      const month = new Date().getMonth() + 1;
      const year = new Date().getFullYear();
      let created = 0;
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;

      for (const c of customers) {
        if (sentCount >= waLimit) break;
        const [[exists]] = await pool.query(
          'SELECT id FROM invoices WHERE customer_id=? AND MONTH(due_date)=? AND YEAR(due_date)=?',
          [c.id, month, year]
        );
        if (!exists) {
          const day = c.isolation_date || 20;
          const dueDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          await pool.query(
            'INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?,?,?,?,?)',
            [c.id, c.package_id, c.package_price || 0, dueDate, 'unpaid']
          );
          created++;
          // Send WA notification (sequential)
          await notifyInvoiceCreated(pool, c, c.package_price || 0, dueDate);
          sentCount++;
          await new Promise(r => setTimeout(r, waDelay));
        }
      }
      console.log(`[CRON] Monthly invoices: ${created} created and notified.`);
    } catch (e) {
      console.error('[CRON] Invoice generation error:', e.message);
    }
  });

  // Export CSV - Customers
  app.get('/export/customers', requireAuth, async (req, res) => {
    try {
      const [customers] = await pool.query(
        `SELECT c.id, c.name, c.phone, c.address, p.name as package_name, p.price as package_price,
                c.pppoe_username, c.billing_method, c.isolation_date, c.status, c.created_at
         FROM customers c LEFT JOIN packages p ON c.package_id = p.id ORDER BY c.name ASC`
      );
      let csv = 'ID,Nama,Telepon,Alamat,Paket,Harga,PPPoE,Metode,Tgl Isolir,Status,Tgl Daftar\n';
      for (const c of customers) {
        csv += `${c.id},"${c.name}","${c.phone || ''}","${c.address || ''}","${c.package_name || ''}",${c.package_price || 0},"${c.pppoe_username || ''}","${c.billing_method || 'fixed'}",${c.isolation_date || 20},${c.status},"${new Date(c.created_at).toLocaleDateString('id-ID')}"\n`;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pelanggan-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send('\uFEFF' + csv); // BOM for Excel UTF-8
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Export CSV - Invoices
  app.get('/export/invoices', requireAuth, async (req, res) => {
    try {
      const [invoices] = await pool.query(
        `SELECT i.id, c.name as customer_name, c.pppoe_username, i.amount, i.status, i.due_date, i.paid_at, i.created_at
         FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ORDER BY i.created_at DESC`
      );
      let csv = 'ID,Pelanggan,PPPoE,Nominal,Status,Jatuh Tempo,Tanggal Bayar,Dibuat\n';
      for (const i of invoices) {
        csv += `${i.id},"${i.customer_name || ''}","${i.pppoe_username || ''}",${i.amount},${i.status},"${i.due_date || ''}","${i.paid_at ? new Date(i.paid_at).toLocaleDateString('id-ID') : ''}","${new Date(i.created_at).toLocaleDateString('id-ID')}"\n`;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send('\uFEFF' + csv);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Admin Profile - GET
  app.get('/profile', requireAuth, async (req, res) => {
    try {
      const [[user]] = await pool.query('SELECT id, username, role, created_at FROM users WHERE id=?', [req.session.userId]);
      res.render('profile', { user: req.session, profile: user, currentPage: 'profile' });
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Admin Profile - Change Password
  app.post('/profile/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
      const [[user]] = await pool.query('SELECT * FROM users WHERE id=?', [req.session.userId]);
      const match = await bcrypt.compare(current_password, user.password);
      if (!match) return res.json({ success: false, message: 'Password lama salah' });
      const hashed = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE users SET password=? WHERE id=?', [hashed, req.session.userId]);
      res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Tripay Callback Webhook (no auth - called by Tripay server)
  app.post('/api/tripay/callback', async (req, res) => {
    try {
      const crypto = require('crypto');
      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'tripay_private_key'");
      if (!settingsRows.length) return res.status(400).json({ success: false });

      const privateKey = settingsRows[0].setting_value;
      const callbackSignature = req.headers['x-callback-signature'] || '';
      const json = JSON.stringify(req.body);
      const signature = crypto.createHmac('sha256', privateKey).update(json).digest('hex');

      if (callbackSignature !== signature) {
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      const { merchant_ref, status } = req.body;
      if (status === 'PAID') {
        const invId = merchant_ref.split('-')[1];
        if (invId) {
          await pool.query("UPDATE invoices SET status='paid', paid_at=NOW(), payment_method='Tripay' WHERE id=?", [invId]);
          
          // Auto-unisolate + MikroTik Activation
          const [[cust]] = await pool.query(`
            SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port 
            FROM invoices i 
            JOIN customers c ON i.customer_id = c.id 
            LEFT JOIN routers r ON c.router_id = r.id 
            WHERE i.id = ?`, [invId]);

          if (cust) {
            await pool.query("UPDATE customers SET status='active' WHERE id=? AND status='isolated'", [cust.id]);
            
            // Re-enable on MikroTik
            if (cust.pppoe_username && cust.r_ip) {
              await mikrotikHelper.enablePPPoESecret(
                { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port },
                cust.pppoe_username
              ).catch(e => console.error(`[Callback] MikroTik activation failed: ${e.message}`));
            }

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
              
              // Check if invoice for next period already exists to avoid duplicates
              const [[exists]] = await pool.query('SELECT id FROM invoices WHERE customer_id=? AND due_date=?', [cust.id, nextDueStr]);
              if (!exists) {
                const [pkg] = await pool.query('SELECT price FROM packages WHERE id=?', [cust.package_id]);
                const amount = pkg[0] ? pkg[0].price : 0;
                await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?, ?, ?, ?, ?)', 
                  [cust.id, cust.package_id, amount, nextDueStr, 'unpaid']);
              }
            }
          }
          console.log(`[Tripay] Payment received & Service activated for invoice #${invId}`);
        }
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Tripay] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Print Invoice
  app.get('/print/invoice', requireAuth, async (req, res) => {
    try {
      const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) return res.redirect('/billing');
      const placeholders = ids.map(() => '?').join(',');
      const [invoices] = await pool.query(
        `SELECT i.*, c.name as customer_name, c.address as customer_address, c.pppoe_username,
                p.name as package_name
         FROM invoices i
         LEFT JOIN customers c ON i.customer_id = c.id
         LEFT JOIN packages p ON c.package_id = p.id
         WHERE i.id IN (${placeholders})`, ids
      );
      const [rows] = await pool.query('SELECT * FROM settings');
      const settings = {};
      rows.forEach(r => settings[r.setting_key] = r.setting_value);
      res.render('print_invoice', { user: req.session, invoices, settings });
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Import Customers CSV
  app.post('/import/customers', requireAuth, async (req, res) => {
    try {
      const csv = req.body.csv_data || '';
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.json({ success: false, message: 'File CSV kosong atau tidak valid' });
      let imported = 0, skipped = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const [, name, phone, address, , , pppoe, method, isolDate, status] = cols;
        if (!name) { skipped++; continue; }
        try {
          await pool.query(
            'INSERT INTO customers (name, phone, address, pppoe_username, billing_method, isolation_date, status) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE phone=VALUES(phone)',
            [name, phone || '', address || '', pppoe || '', method || 'fixed', parseInt(isolDate) || 20, status || 'active']
          );
          imported++;
        } catch { skipped++; }
      }
      res.json({ success: true, message: `Import selesai: ${imported} berhasil, ${skipped} dilewati` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Github Auto-Updater Endpoint (secured with auth)
  app.post('/api/system/update', requireAuth, async (req, res) => {
    const simpleGit = require('simple-git');
    const git = simpleGit(__dirname);
    try {
      // Force reset local changes if any, then pull (to ensure smooth update on server)
      // await git.reset('hard'); 
      await git.pull('origin', 'main');
      
      const { exec } = require('child_process');
      exec('npm install', (error, stdout, stderr) => {
        if (error) {
           console.error(`npm install error: ${error}`);
           return res.status(500).json({ success: false, message: "Update pulled, but npm install failed. Please run manually." });
        }
        res.json({ success: true, message: "Aplikasi berhasil diperbarui. Server akan restart dalam 3 detik." });
        
        // Use PM2 to restart if available, otherwise just exit and let nodemon/pm2 handle it
        setTimeout(() => {
          console.log("Restarting for update...");
          process.exit(0);
        }, 3000);
      });
    } catch (e) {
      console.error('Update Error:', e.message);
      res.status(500).json({ success: false, message: "Gagal menarik update: " + e.message });
    }
  });
}

const server = app.listen(PORT, () => {
  console.log(`Dino-Bill running on http://localhost:${PORT}`);
  
  // Initialize WhatsApp after server is up
  if (isInstalled) {
    const { initWhatsApp } = require('./helpers/whatsapp');
    initWhatsApp(pool).catch(err => console.error('[WA-INIT] Error:', err));
  }
});
server.setTimeout(300000); // 5 minutes timeout for long OLT syncs
