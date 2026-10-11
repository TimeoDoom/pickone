// Applique shema.sql sur la base définie dans DATABASE_URL
const fs = require("fs");
const path = require("path");
const db = require("./db");

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "shema.sql"), "utf8");
    await db.query(sql);
    console.log("✔ Tables créées / à jour.");
  } catch (err) {
    console.error("✘ Erreur :", err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
