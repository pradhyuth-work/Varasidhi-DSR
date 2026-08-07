// Local development server. Loads .env, ensures the schema exists, then starts
// a normal always-on Express listener. In production Vercel uses api/index.js
// instead and never runs this file.
import "dotenv/config";
import app from "./server.js";
import { initializeDatabase, closeDatabase } from "./database.js";

const port = Number(process.env.PORT || 3000);

try {
  await initializeDatabase();
  const server = app.listen(port, "0.0.0.0", () => {
    console.info(`DSR Route System listening on http://localhost:${port}`);
  });
  const shutdown = async () => {
    server.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error("Database initialization failed", error);
  process.exit(1);
}
