require('dotenv').config();
const mysql = require('mysql2/promise');

async function check() {
    try {
        const pool = await mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: 'dino_db'
        });
        const [custs] = await pool.query("SELECT id, name FROM customers");
        console.log("JSON_START");
        console.log(JSON.stringify({ count: custs.length, samples: custs.slice(0, 5) }));
        console.log("JSON_END");
        process.exit();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
check();
