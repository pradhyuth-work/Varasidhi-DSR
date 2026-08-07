// Vercel serverless entrypoint. The whole Express app (static files, /api
// routes, and the SPA catch-all) is served through this single function.
// vercel.json rewrites every path to /api so behaviour matches the original
// single-origin server. Schema init is NOT run here — it's applied once via
// `npm run db:schema` against Supabase.
import app from "../server.js";

export default app;
