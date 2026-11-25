require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function checkConnection() {
  try {
    await client.connect();
    console.log("🚀 ¡CONEXIÓN EXITOSA! Tu backend ya habla con PostgreSQL.");
    const res = await client.query('SELECT NOW()');
    console.log("Hora del servidor en la nube:", res.rows[0].now);
    await client.end();
  } catch (err) {
    console.error("❌ ERROR DE CONEXIÓN:", err.message);
  }
}

checkConnection();