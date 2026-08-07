// Apply db/schema.sql to Supabase. Uses the DIRECT connection (port 5432),
// which is the right endpoint for DDL. Run once before migrating data:
//   node scripts/apply-schema.mjs
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "db", "schema.sql");

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set DIRECT_URL (or DATABASE_URL) in .env first.");
  process.exit(1);
}

const ssl = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)
  ? false
  : { rejectUnauthorized: false };
const client = new pg.Client({ connectionString, ssl });

try {
  await client.connect();
  const schema = fs.readFileSync(schemaPath, "utf8");
  await client.query(schema);
  console.log("✓ Schema applied successfully.");
} catch (error) {
  console.error("✗ Failed to apply schema:", error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
