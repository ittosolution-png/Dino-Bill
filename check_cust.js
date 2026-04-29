require('dotenv').config();
const mysql = require('mysql2/promise');

async function check() {
    try {
        const pool = await mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'dino_bill'
        });
        const [[{ count }]] = await pool.query("SELECT COUNT(*) as count FROM customers");
        console.log("TOTAL_CUSTOMERS=" + count);
        process.exit();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
check();
