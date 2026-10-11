const { Pool, types } = require("pg");
require("dotenv").config();

// NUMERIC (oid 1700) est renvoyé en string par pg : on le convertit en nombre
types.setTypeParser(1700, (v) => parseFloat(v));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Serverless (Vercel) : chaque instance garde très peu de connexions ouvertes
  max: process.env.VERCEL ? 3 : 10,
  idleTimeoutMillis: 10000,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Exécute fn(client) dans une vraie transaction sur UNE seule connexion
// (avec pool.query("BEGIN") les requêtes peuvent partir sur des connexions différentes).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  pool,
};
