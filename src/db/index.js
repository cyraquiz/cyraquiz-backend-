const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', (err) => {
  console.error('PG pool idle client error:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};