// One-time data migration: copy every row from the local SQLite dsr.db into
// Supabase Postgres, preserving primary keys, then fix the identity sequences.
//
// Usage:
//   node scripts/migrate-data.mjs [--db <path-to-dsr.db>] [--prune <sessionId,...>]
//
// Defaults to the original Replit app's database if --db is not given.
// The load is idempotent: it TRUNCATEs the target tables (RESTART IDENTITY
// CASCADE) and reloads them from SQLite, so re-running produces the same result.
import "dotenv/config";
import path from "node:path";
import process from "node:process";
import sqlite3 from "sqlite3";
import pg from "pg";

// ---- args ----------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const DEFAULT_DB =
  "/Users/tejasparvathappa/Downloads/Sales-Route-Manager-F-main/artifacts/dsr-route-system/dsr.db";
const sqlitePath = getArg("--db") || DEFAULT_DB;
const pruneSessionIds = (getArg("--prune") || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

// Tables in FK-safe insertion order.
const TABLES = [
  "profiles",
  "products",
  "dsr_sessions",
  "dsr_items",
  "payments",
  "purchases",
  "stock_returns",
];

// Inject DB_PASSWORD into the [YOUR-PASSWORD] placeholder (URL-encoded).
const resolveConn = (conn) => {
  const pw = process.env.DB_PASSWORD;
  return conn && pw && conn.includes("[YOUR-PASSWORD]")
    ? conn.replace("[YOUR-PASSWORD]", encodeURIComponent(pw))
    : conn;
};

const connectionString = resolveConn(process.env.DIRECT_URL || process.env.DATABASE_URL);
if (!connectionString) {
  console.error("Set DIRECT_URL (or DATABASE_URL) in .env first.");
  process.exit(1);
}

// ---- sqlite helpers ------------------------------------------------------
const sqlite = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
const readAll = (sql) =>
  new Promise((resolve, reject) =>
    sqlite.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

// ---- run -----------------------------------------------------------------
const ssl = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)
  ? false
  : { rejectUnauthorized: false };
const client = new pg.Client({ connectionString, ssl });

try {
  await client.connect();
  console.log(`Source SQLite : ${sqlitePath}`);
  console.log(`Target        : Postgres (DIRECT_URL)\n`);

  await client.query("BEGIN");

  // Clear existing rows so the migration mirrors SQLite exactly.
  await client.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);

  for (const table of TABLES) {
    const rows = await readAll(`SELECT * FROM ${table}`);
    if (rows.length === 0) {
      console.log(`  ${table.padEnd(14)} 0 rows`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const colList = cols.join(", ");
    for (const row of rows) {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const values = cols.map((c) => row[c]);
      await client.query(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`,
        values,
      );
    }
    console.log(`  ${table.padEnd(14)} ${rows.length} rows`);
  }

  // Optionally drop test sessions (cascades to their items/payments).
  if (pruneSessionIds.length) {
    await client.query(`DELETE FROM dsr_sessions WHERE id = ANY($1::int[])`, [
      pruneSessionIds,
    ]);
    console.log(`\n  pruned sessions: ${pruneSessionIds.join(", ")}`);
  }

  // Reset identity sequences so future inserts don't collide with copied ids.
  for (const table of TABLES) {
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1),
         (SELECT COUNT(*) FROM ${table}) > 0
       )`,
      [table],
    );
  }

  await client.query("COMMIT");
  console.log("\n✓ Data migration complete. Sequences reset.");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* ignore */ }
  console.error("\n✗ Migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await client.end();
  sqlite.close();
}
