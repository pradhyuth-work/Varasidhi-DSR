import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Type parsers — keep parity with the old SQLite return shapes:
//   * int8 (bigint: COUNT / SUM of integers) -> JS number, not string.
//   * timestamp / timestamptz -> raw string (so created_at serialises like the
//     old TEXT column instead of a JS Date / ISO string).
// ---------------------------------------------------------------------------
types.setTypeParser(20, (val) => (val === null ? null : Number(val))); // int8
types.setTypeParser(1114, (val) => val); // timestamp
types.setTypeParser(1184, (val) => val); // timestamptz

// Allow the DB password to live in its own env var (DB_PASSWORD) so it never has
// to be URL-encoded by hand inside the connection string. If the string still
// contains the literal [YOUR-PASSWORD] placeholder and DB_PASSWORD is set, we
// substitute it (URL-encoded). A password baked directly into the URL also works.
export function resolveConnectionString(conn) {
  const pw = process.env.DB_PASSWORD;
  if (conn && pw && conn.includes("[YOUR-PASSWORD]")) {
    return conn.replace("[YOUR-PASSWORD]", encodeURIComponent(pw));
  }
  return conn;
}

const connectionString = resolveConnectionString(
  process.env.DATABASE_URL || process.env.DIRECT_URL,
);
if (!connectionString) {
  throw new Error("DATABASE_URL (or DIRECT_URL) must be set to connect to Postgres.");
}

// SSL on for remote hosts (Supabase requires it); off for a local Postgres so
// local dev / testing against localhost works. rejectUnauthorized:false keeps
// it simple across the Supabase pooler cert chain.
export const sslFor = (conn) =>
  /@(localhost|127\.0\.0\.1)[:/]/.test(conn) ? false : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString,
  ssl: sslFor(connectionString),
  max: 3,
});

// ---------------------------------------------------------------------------
// SQL helpers: the whole codebase uses `?` placeholders and expects sqlite3's
// { id, changes } from writes. Translate `?` -> `$n` and, for INSERTs, append
// `RETURNING id` so `run()` can report the new row id.
// ---------------------------------------------------------------------------
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const isInsert = (sql) => /^\s*insert\s/i.test(sql);
const hasReturning = (sql) => /\breturning\b/i.test(sql);

function prepareWrite(sql) {
  let text = toPg(sql);
  if (isInsert(sql) && !hasReturning(sql)) text += " RETURNING id";
  return text;
}

// Build the { run, get, all } surface bound to a given executor (the pool, or a
// single checked-out client inside a transaction).
function makeApi(executor) {
  return {
    async run(sql, params = []) {
      const result = await executor.query(prepareWrite(sql), params);
      return { id: result.rows?.[0]?.id, changes: result.rowCount };
    },
    async get(sql, params = []) {
      const result = await executor.query(toPg(sql), params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await executor.query(toPg(sql), params);
      return result.rows;
    },
  };
}

const poolApi = makeApi(pool);

export const database = {
  ...poolApi,
  // exec runs raw SQL with no parameters (schema files, multi-statement blocks).
  async exec(sql) {
    await pool.query(sql);
  },
};

// ---------------------------------------------------------------------------
// withTransaction: check out ONE client, run BEGIN..COMMIT on it, and hand the
// caller a { run, get, all } bound to that same client. This replaces the old
// pattern of exec("BEGIN") + database.run(...), which would scatter statements
// across different pooled connections and break the transaction.
// ---------------------------------------------------------------------------
export async function withTransaction(fn) {
  const client = await pool.connect();
  const tx = makeApi(client);
  try {
    await client.query("BEGIN");
    const out = await fn(tx, client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is more useful to the caller.
    }
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Ensure the schema exists. Used by local dev boot and the migration/apply
// scripts — NOT called per serverless request.
// ---------------------------------------------------------------------------
export async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(schema);
}

export async function closeDatabase() {
  await pool.end();
}
