const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
dotenv.config();

async function updateSchema() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
    });

    try {
        await connection.query("ALTER TABLE hioso_onus ADD COLUMN IF NOT EXISTS tx_power VARCHAR(20) DEFAULT '0.00' AFTER sn;");
        console.log("Column tx_power added successfully (if not exists)");
    } catch (e) {
        console.error("Error adding column:", e.message);
    } finally {
        await connection.end();
    }
}

updateSchema();
