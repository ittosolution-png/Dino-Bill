require('dotenv').config();
const mysql = require('mysql2/promise');

async function checkSchema() {
    try {
        const pool = await mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        });
        const [tables] = await pool.query("SHOW TABLES");
        console.log("Tables:", tables.map(t => Object.values(t)[0]));
        
        const [columns] = await pool.query("DESCRIBE map_cables");
        console.log("map_cables columns:", columns.map(c => ({ field: c.Field, type: c.Type })));
        
        process.exit();
    } catch (e) {
        console.error("Error:", e.message);
        process.exit(1);
    }
}
checkSchema();
