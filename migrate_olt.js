require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
    const pool = await mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'dino_bill'
    });
    
    try {
        console.log("Cleaning up duplicates...");
        await pool.query("DELETE t1 FROM hioso_onus t1 INNER JOIN hioso_onus t2 WHERE t1.id < t2.id AND t1.olt_id = t2.olt_id AND t1.onu_index = t2.onu_index");
        
        console.log("Adding Unique Index...");
        await pool.query("ALTER TABLE hioso_onus ADD UNIQUE KEY olt_onu_idx (olt_id, onu_index)");
        console.log("Migration successful!");
    } catch (e) {
        console.error("Migration error (maybe already exists):", e.message);
    } finally {
        process.exit();
    }
}

migrate();
