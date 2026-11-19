const express = require('express');
const router = express.Router();
const { sendWhatsApp, sendTelegram, sendTelegramPppoe } = require('../helpers/notification');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
let pool;

// Configure multer for logo uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../public/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'customer_portal_logo-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|webp|svg/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Hanya file gambar yang diperbolehkan!'));
    },
    limits: { fileSize: 2 * 1024 * 1024 } // limit 2MB
});

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM settings');
        const settings = {};
        rows.forEach(s => settings[s.setting_key] = s.setting_value);
        res.render('settings', { user: req.session, settings, currentPage: 'settings' });
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

router.get('/whatsapp-status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const { getStatus } = require('../helpers/whatsapp');
    res.json(getStatus());
});

router.post('/whatsapp-restart', async (req, res) => {
    const { restartWhatsApp } = require('../helpers/whatsapp');
    restartWhatsApp(pool).catch(e => console.error('[WA-RESTART] Error:', e.message));
    res.json({ success: true, message: 'Menghubungkan ulang WhatsApp...' });
});

router.post('/whatsapp-logout', async (req, res) => {
    const { logoutWhatsApp } = require('../helpers/whatsapp');
    logoutWhatsApp(pool).catch(e => console.error('[WA-LOGOUT] Error:', e.message));
    res.json({ success: true, message: 'Sesi WhatsApp berhasil dihapus. Silakan scan QR baru.' });
});

router.post('/api/save', async (req, res) => {
    try {
        const entries = req.body;
        for (const [key, value] of Object.entries(entries)) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        // Invalidate in-memory settings cache so next request loads fresh data
        if (req.app.locals.invalidateSettingsCache) {
            req.app.locals.invalidateSettingsCache();
        }
        if (entries.wa_provider === 'local') {
            const { initWhatsApp } = require('../helpers/whatsapp');
            initWhatsApp(pool).catch(e => console.error('[WA-INIT-SAVE] Error:', e.message));
        }
        res.json({ success: true, message: 'Pengaturan berhasil disimpan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/upload-logo', upload.single('logo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah' });
        }
        const logoUrl = '/uploads/' + req.file.filename;
        // Simpan ke database settings
        await pool.query(
            'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            ['customer_portal_logo', logoUrl, logoUrl]
        );
        res.json({ success: true, message: 'Logo berhasil diunggah', logoUrl });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/clear-logo', async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM settings WHERE setting_key = ?',
            ['customer_portal_logo']
        );
        res.json({ success: true, message: 'Logo berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/upload-qris', upload.single('qris'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah' });
        }
        const qrisUrl = '/uploads/' + req.file.filename;
        // Simpan ke database settings
        await pool.query(
            'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            ['manual_payment_qris', qrisUrl, qrisUrl]
        );
        res.json({ success: true, message: 'QRIS berhasil diunggah', qrisUrl });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/clear-qris', async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM settings WHERE setting_key = ?',
            ['manual_payment_qris']
        );
        res.json({ success: true, message: 'QRIS berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/upload-pwa-icon', upload.single('pwa_icon'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah' });
        }
        const iconUrl = '/uploads/' + req.file.filename;
        await pool.query(
            'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            ['pwa_icon_url', iconUrl, iconUrl]
        );
        res.json({ success: true, message: 'Ikon PWA berhasil diunggah', iconUrl });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/generate-pwa', async (req, res) => {
    try {
        const { pwa_app_name, pwa_short_name, pwa_theme_color, pwa_app_url } = req.body;
        
        // Save to DB
        const entries = { pwa_app_name, pwa_short_name, pwa_theme_color, pwa_app_url };
        for (const [key, value] of Object.entries(entries)) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }

        // Get Icon
        const [iconRow] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "pwa_icon_url"');
        const iconUrl = iconRow.length > 0 ? iconRow[0].setting_value : '/img/logo.png';

        // Generate manifest.json
        const manifest = {
            name: pwa_app_name || "Dino Bill Customer",
            short_name: pwa_short_name || "DinoBill",
            start_url: "/portal",
            display: "standalone",
            background_color: pwa_theme_color || "#3B82F6",
            theme_color: pwa_theme_color || "#3B82F6",
            icons: [
                {
                    src: iconUrl,
                    sizes: "192x192",
                    type: "image/png"
                },
                {
                    src: iconUrl,
                    sizes: "512x512",
                    type: "image/png"
                }
            ]
        };

        const publicDir = path.join(__dirname, '../public');
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }
        
        fs.writeFileSync(path.join(publicDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        res.json({ success: true, message: 'PWA Manifest berhasil digenerate' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/download-android-source', async (req, res) => {
    try {
        const { app_name, url, color } = req.query;
        if (!app_name || !url) return res.status(400).send('Missing app_name or url');

        const archiverModule = await import('archiver');
        res.attachment('Android_Source_Code.zip');
        const archive = new archiverModule.ZipArchive({ zlib: { level: 9 } });
        
        archive.on('error', function(err) {
            throw err;
        });

        archive.pipe(res);

        // Generate minimal Android project structure
        const safeName = app_name.replace(/[^a-zA-Z0-9]/g, '');
        const packageName = 'com.dinobill.' + safeName.toLowerCase();
        const packagePath = 'com/dinobill/' + safeName.toLowerCase();

        archive.append(`
buildscript {
    repositories { google(); mavenCentral() }
    dependencies { classpath 'com.android.tools.build:gradle:8.1.0' }
}
allprojects {
    repositories { google(); mavenCentral() }
}
        `.trim(), { name: 'build.gradle' });

        archive.append(`
pluginManagement {
    repositories { gradlePluginPortal(); google(); mavenCentral() }
}
rootProject.name = "${app_name}"
include ':app'
        `.trim(), { name: 'settings.gradle' });

        archive.append(`
plugins {
    id 'com.android.application'
}
android {
    namespace '${packageName}'
    compileSdk 34
    defaultConfig {
        applicationId "${packageName}"
        minSdk 24
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
        `.trim(), { name: 'app/build.gradle' });

        archive.append(`
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.Light.NoActionBar">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
        `.trim(), { name: 'app/src/main/AndroidManifest.xml' });

        archive.append(`
package ${packageName};

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
        
        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        
        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("${url}");
    }
    
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
        `.trim(), { name: `app/src/main/java/${packagePath}/MainActivity.java` });

        archive.append(`
<resources>
    <string name="app_name">${app_name}</string>
</resources>
        `.trim(), { name: 'app/src/main/res/values/strings.xml' });

        archive.finalize();
    } catch (e) {
        console.error(e);
        if (!res.headersSent) res.status(500).send(e.message);
    }
});

router.post('/api/test-wa', async (req, res) => {
    const { phone, message } = req.body;
    try {
        const result = await sendWhatsApp(pool, phone, message || 'Test dari Dino-Bill ✅');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-telegram', async (req, res) => {
    const { message } = req.body;
    try {
        const result = await sendTelegram(pool, message || '✅ Test Telegram umum dari Dino-Bill');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-telegram-pppoe', async (req, res) => {
    const { message } = req.body;
    try {
        const result = await sendTelegramPppoe(
            pool,
            message || '✅ Test Bot Telegram PPPoE dari Dino-Bill'
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-pppoe-monitor', async (req, res) => {
    try {
        const { runPppoeMonitor } = require('../helpers/pppoe_monitor');
        const result = await runPppoeMonitor(pool);
        if (result.skipped) {
            const reasons = {
                disabled: 'Monitor PPPoE nonaktif. Aktifkan di tab Telegram.',
                pppoe_telegram_not_configured: 'Isi Bot Token dan Chat ID khusus PPPoE (bot kedua) terlebih dahulu.',
                no_routers: 'Tidak ada router MikroTik aktif.'
            };
            return res.json({ success: false, message: reasons[result.reason] || 'Monitor dilewati.' });
        }
        res.json({
            success: true,
            message: `Monitor selesai. ${result.checked} pelanggan dicek, ${result.notified} notifikasi dikirim (hanya jika status berubah).`
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-acs', async (req, res) => {
    const { url } = req.body;
    try {
        const axios = require('axios');
        const response = await axios.get(`${url}/devices`, { timeout: 10000 });
        res.json({ success: true, message: `Berhasil! Terhubung ke GenieACS. HTTP ${response.status}` });
    } catch (e) {
        res.json({ success: false, message: `Gagal terhubung ke ACS: ${e.message}` });
    }
});



router.post('/api/test-tripay', async (req, res) => {
    try {
        const tripay = require('../helpers/tripay');
        const channels = await tripay.getPaymentChannels(pool);
        if (channels.success) {
            const names = channels.data.slice(0, 5).map(c => c.name).join(', ');
            res.json({ success: true, message: `Berhasil! ${channels.data.length} channel tersedia: ${names}...`, channels: channels.data });
        } else {
            res.json({ success: false, message: channels.message });
        }
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET - List users
router.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, username, role, telegram_id, created_at FROM users ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Add user
router.post('/api/users', async (req, res) => {
    const { username, password, role, telegram_id } = req.body;
    try {
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password, role, telegram_id) VALUES (?, ?, ?, ?)', [username, hashed, role || 'admin', telegram_id || null]);
        res.json({ success: true, message: 'User berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Remove user
router.delete('/api/users/:id', async (req, res) => {
    try {
        if (req.params.id == req.session.userId) {
            return res.status(400).json({ success: false, message: 'Tidak bisa menghapus diri sendiri' });
        }

        const [userCheck] = await pool.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
        if (userCheck.length > 0 && userCheck[0].username === 'admin') {
            return res.status(400).json({ success: false, message: 'Akun admin utama tidak boleh dihapus' });
        }

        await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'User berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
