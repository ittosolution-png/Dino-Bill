const mysql = require('mysql2/promise');
require('dotenv').config();

async function update() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'dino_db',
        waitForConnections: true,
        connectionLimit: 10
    });

    try {
        await pool.query('ALTER TABLE hioso_olts ADD COLUMN IF NOT EXISTS last_profile VARCHAR(50) DEFAULT NULL');
        console.log('Database updated: added last_profile column.');
    } catch (e) {
        console.error('Update failed:', e.message);
    } finally {
        await pool.end();
    }
}

update();
