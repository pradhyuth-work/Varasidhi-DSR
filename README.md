# DSR Route System — Vercel + Supabase

Daily Sales Report / route distribution console: pick a buyer route, dispatch
stock from the warehouse, record collections, settle closing stock, and export
a month-to-date CSV. Migrated off Replit to **Vercel** (hosting) + **Supabase**
(Postgres).

- **API + frontend:** Express 5 serving `/api` and the static dashboard in `public/`
- **Database:** Supabase Postgres (accessed via `pg`)
- **Hosting:** Vercel serverless (`api/index.js` runs the whole Express app)

## Layout

| Path | Purpose |
|------|---------|
| `server.js` | Express app + all `/api` routes (exports the app) |
| `database.js` | `pg` adapter (`run/get/all/exec`) + `withTransaction` |
| `api/index.js` | Vercel serverless entrypoint (`export default app`) |
| `local.js` | Local dev server (schema init + `app.listen`) |
| `db/schema.sql` | Postgres schema + seed data (idempotent) |
| `scripts/apply-schema.mjs` | Create the schema on Supabase |
| `scripts/migrate-data.mjs` | Copy existing SQLite data into Supabase |
| `public/` | Dashboard HTML/CSS/JS (unchanged) |

## One-time setup

### 1. Create a Supabase project
Supabase dashboard → **New project**. Once ready, open **Project Settings →
Database → Connection string** and copy two strings:
- **Transaction pooler** (port **6543**) → this is `DATABASE_URL` (app runtime)
- **Direct connection** (port **5432**) → this is `DIRECT_URL` (schema + migration)

### 2. Configure env locally
```bash
cp .env.example .env
npm install
```
Fill in `.env`:
- `DATABASE_URL` / `DIRECT_URL` — paste the pooler strings; **leave the
  `[YOUR-PASSWORD]` placeholder in them**.
- `DB_PASSWORD` — your raw database password. It's injected into the placeholder
  (URL-encoded) automatically, so passwords with `@ # / :` etc. need no escaping.
  (Alternatively, bake the password directly into the URLs and skip `DB_PASSWORD`.)
- `ADMIN_PASSWORD` — password for the **admin** login (full access).
- `USER_PASSWORD` — password for the **user** login (operations: routes, loads,
  payments, settlement — but not master/admin management).
- `SESSION_SECRET` — random string used to sign login session cookies
  (`openssl rand -hex 32`).

### 3. Create the schema + migrate data
```bash
npm run db:schema     # applies db/schema.sql (uses DIRECT_URL)
npm run db:migrate    # copies rows from the old dsr.db into Supabase
```
`db:migrate` defaults to the original Replit database path. Override with
`node scripts/migrate-data.mjs --db /path/to/dsr.db`. To drop the demo test
session created during migration testing: `... --prune 2`.

### 4. Run locally
```bash
npm run dev           # http://localhost:3000
```

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Vercel → **Add New → Project** → import the repo.
3. Add environment variables (Project Settings → Environment Variables):
   - `DATABASE_URL` — Supabase **transaction pooler** string (6543)
   - `ADMIN_PASSWORD` — your admin gate password
   - (`DIRECT_URL` only needed if you run migrations from Vercel; normally not.)
4. Deploy. `vercel.json` routes all traffic to the single Express function and
   bundles `public/`.

## Database backup

Admin → **Backup** → **Download full backup** saves the entire database as one
JSON file (`dsr-backup-YYYY-MM-DD-HHMM.json`) via `GET /api/backup`.

- **Admin only.** The route is gated on the session cookie's role; a `user`
  session gets a 403.
- **Everything is included:** `profiles`, `products`, `dsr_sessions`,
  `dsr_items`, `payments`, `purchases`, `stock_returns`, `stock_adjustments`.
- **Shape:** `{ format, version, generated_at, table_order, row_counts, tables }`.
  `table_order` lists tables parent-before-child, so replaying inserts in that
  order satisfies the foreign keys.
- **Point-in-time.** It is a manual download, not a scheduled job — the file
  reflects the moment the button was pressed.
- The file holds all business data in plain text; store it accordingly.

There is no in-app restore. To reload a backup, insert the tables in
`table_order` and then reset the identity sequences, e.g.
`SELECT setval(pg_get_serial_sequence('profiles','id'), MAX(id)) FROM profiles;`

## Notes

- **Money math** stays in JS (`roundMoney`), so money columns use `double precision`.
- **Transactions** (load-in, close, settle, return-stock, purchase, product-id
  change) run through `withTransaction`, which holds one pooled client for the
  whole `BEGIN…COMMIT` — required for correctness on a pooled/serverless Postgres.
- **Admin gate** is a password + an `x-user-role: ADMIN` header. The header is
  client-spoofable; acceptable for a small internal tool but not real auth. Set a
  strong `ADMIN_PASSWORD` and treat this as a follow-up if the app is exposed
  publicly.
