const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

async function run() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'dino_db'
    });

    try {
        await pool.query("ALTER TABLE customers ADD COLUMN installation_status VARCHAR(20) DEFAULT 'pending'");
        console.log('Column installation_status added');
    } catch(e) {
        console.log('Column installation_status might already exist:', e.message);
    }
    process.exit(0);
}
run();
