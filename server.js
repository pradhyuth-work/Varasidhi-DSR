import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { database, withTransaction } from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(publicDir, { extensions: ["html"] }));

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const positiveInteger = (value) =>
  Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const positiveAmount = (value) => {
  const amount = roundMoney(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};
const today = () => new Date().toISOString().slice(0, 10);
// Admin status is derived from the verified session cookie (set on the request
// by the auth middleware below), NOT from a client-supplied header.
const isAdmin = (req) => req.userRole === "admin";

function fail(res, status, error) {
  return res.status(status).json({ error });
}

// ---------------------------------------------------------------------------
// Authentication: a signed, HTTP-only session cookie. No external deps — the
// cookie is `role.expiry.hmac`, verified with SESSION_SECRET. Two roles exist:
// "admin" (ADMIN_PASSWORD) and "user" (USER_PASSWORD).
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "dsr_auth";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-insecure-secret-change-in-production";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const isProd = process.env.NODE_ENV === "production";

function signSession(role) {
  const payload = `${role}.${Date.now() + SESSION_TTL_MS}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${role}.${exp}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  if (role !== "admin" && role !== "user") return null;
  return role;
}

function parseCookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, role) {
  const attrs = [
    `${SESSION_COOKIE}=${signSession(role)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isProd) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isProd) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

async function getSessionPayload(sessionId) {
  const session = await database.get(
    `SELECT id, buyer_id, date, prev_balance, total_sales, total_payments,
            updated_balance, status
       FROM dsr_sessions WHERE id = ?`,
    [sessionId],
  );
  if (!session) return null;

  const items = await database.all(
    `SELECT i.id, i.dsr_id, i.product_id, p.name AS product_name,
            p.warehouse_stock, i.opening_stock, i.loaded_stock,
            i.closing_stock, i.qty_sold, i.unit_price, i.line_total
       FROM dsr_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.dsr_id = ?
      ORDER BY i.product_id`,
    [sessionId],
  );
  const payments = await database.all(
    `SELECT id, dsr_id, method, label_info, amount, created_at
       FROM payments WHERE dsr_id = ? ORDER BY created_at DESC, id DESC`,
    [sessionId],
  );
  return { session, items, payments };
}

async function getOrCreateActiveSession(buyerId) {
  let session = await database.get(
    `SELECT id FROM dsr_sessions
      WHERE buyer_id = ? AND status = 'IN_PROGRESS'
      ORDER BY id DESC LIMIT 1`,
    [buyerId],
  );
  if (!session) {
    const profile = await database.get(
      "SELECT id, current_balance FROM profiles WHERE id = ?",
      [buyerId],
    );
    if (!profile) return null;
    const created = await database.run(
      `INSERT INTO dsr_sessions
        (buyer_id, date, prev_balance, total_sales, total_payments, updated_balance, status)
       VALUES (?, ?, ?, 0, 0, ?, 'IN_PROGRESS')`,
      [buyerId, today(), profile.current_balance, profile.current_balance],
    );
    const products = await database.all(
      "SELECT id, unit_price FROM products ORDER BY id",
    );
    // Find the most recently SETTLED session for this buyer so we can carry
    // its closing stocks forward as the opening stocks for this new session.
    const lastSettled = await database.get(
      `SELECT id FROM dsr_sessions
        WHERE buyer_id = ? AND status = 'SETTLED'
        ORDER BY id DESC LIMIT 1`,
      [buyerId],
    );
    const prevClosingMap = new Map();
    if (lastSettled) {
      const prevItems = await database.all(
        "SELECT product_id, closing_stock FROM dsr_items WHERE dsr_id = ?",
        [lastSettled.id],
      );
      for (const item of prevItems) {
        prevClosingMap.set(item.product_id, item.closing_stock ?? 0);
      }
    }
    for (const product of products) {
      const openingStock = prevClosingMap.get(product.id) ?? 0;
      await database.run(
        `INSERT INTO dsr_items
          (dsr_id, product_id, opening_stock, loaded_stock, closing_stock,
           qty_sold, unit_price, line_total)
         VALUES (?, ?, ?, 0, ?, 0, ?, 0)`,
        [created.id, product.id, openingStock, openingStock, product.unit_price],
      );
    }
    session = { id: created.id };
  }
  return session.id;
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Gate every /api route behind a valid session, except health and login.
app.use("/api", (req, res, next) => {
  const p = req.path;
  if (p === "/login" || p === "/api/login" || p === "/health" || p === "/api/health") {
    return next();
  }
  const role = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!role) return fail(res, 401, "Please sign in.");
  req.userRole = role;
  next();
});

// Sign in: the submitted password decides the role (admin vs user).
app.post("/api/login", (req, res) => {
  const password = String(req.body?.password || "");
  const adminPw = process.env.ADMIN_PASSWORD || "5252";
  const userPw = process.env.USER_PASSWORD || "";
  let role = null;
  if (password && password === adminPw) role = "admin";
  else if (password && userPw && password === userPw) role = "user";
  if (!role) return fail(res, 401, "Incorrect password.");
  setSessionCookie(res, role);
  res.json({ role });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Current session role — the frontend calls this on load to decide what to show.
app.get("/api/me", (req, res) => res.json({ role: req.userRole }));

app.get("/api/profiles", async (_req, res) => {
  try {
    // `hidden` ships to every caller; the client decides where hidden buyers
    // should still appear (reports, history) and where they should not (the
    // day-to-day buyer picker).
    const profiles = await database.all(
      "SELECT id, name, current_balance, hidden FROM profiles ORDER BY id",
    );
    res.json({ profiles });
  } catch (error) {
    console.error("Failed to list profiles", error);
    fail(res, 500, "Unable to load buyer profiles.");
  }
});

app.post("/api/profiles", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can add buyer profiles.");
  const name = String(req.body?.name || "").trim();
  const currentBalance = roundMoney(req.body?.currentBalance ?? 1250);
  if (!name || name.length > 120) return fail(res, 400, "A buyer name is required.");
  if (!Number.isFinite(currentBalance) || currentBalance < 0) {
    return fail(res, 400, "Opening balance must be zero or greater.");
  }
  try {
    const created = await database.run(
      "INSERT INTO profiles (name, current_balance) VALUES (?, ?)",
      [name, currentBalance],
    );
    res.status(201).json(await database.get(
      "SELECT id, name, current_balance, hidden FROM profiles WHERE id = ?",
      [created.id],
    ));
  } catch (error) {
    console.error("Failed to create profile", error);
    fail(res, 500, "Unable to create buyer profile.");
  }
});

// Rename a buyer. The name is display-only — every join is on profiles.id — so
// renaming rewrites history's label without disturbing any figures.
app.patch("/api/profiles/:id/name", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can rename buyer profiles.");
  const profileId = positiveInteger(req.params.id);
  if (profileId === null || profileId < 1) return fail(res, 400, "Invalid profile id.");
  const name = String(req.body?.name || "").trim();
  if (!name || name.length > 120) return fail(res, 400, "A buyer name is required.");
  try {
    const result = await database.run(
      "UPDATE profiles SET name = ? WHERE id = ?",
      [name, profileId],
    );
    if (!result.changes) return fail(res, 404, "Buyer profile not found.");
    res.json(await database.get(
      "SELECT id, name, current_balance, hidden FROM profiles WHERE id = ?",
      [profileId],
    ));
  } catch (error) {
    console.error("Failed to rename profile", error);
    fail(res, 500, "Unable to rename the buyer profile.");
  }
});

// Hide / unhide a buyer. Nothing is deleted: the row, its sessions, and its
// ledger balance all stay put, so historical reports are unaffected. An
// in-progress route blocks hiding, otherwise the session would be stranded
// out of reach of the buyer picker.
app.patch("/api/profiles/:id/hidden", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can hide buyer profiles.");
  const profileId = positiveInteger(req.params.id);
  if (profileId === null || profileId < 1) return fail(res, 400, "Invalid profile id.");
  if (typeof req.body?.hidden !== "boolean") {
    return fail(res, 400, "hidden must be true or false.");
  }
  const hidden = req.body.hidden;
  try {
    const profile = await database.get("SELECT id FROM profiles WHERE id = ?", [profileId]);
    if (!profile) return fail(res, 404, "Buyer profile not found.");
    if (hidden) {
      const open = await database.get(
        "SELECT id FROM dsr_sessions WHERE buyer_id = ? AND status = 'IN_PROGRESS'",
        [profileId],
      );
      if (open) {
        return fail(res, 409, "Settle this buyer's open route before hiding them.");
      }
    }
    await database.run("UPDATE profiles SET hidden = ? WHERE id = ?", [hidden, profileId]);
    res.json(await database.get(
      "SELECT id, name, current_balance, hidden FROM profiles WHERE id = ?",
      [profileId],
    ));
  } catch (error) {
    console.error("Failed to change profile visibility", error);
    fail(res, 500, "Unable to update the buyer profile.");
  }
});

// Correct a buyer's ledger balance. Mirrors the warehouse-stock correction:
// "set" writes an exact figure, "adjust" applies a delta, and every change is
// written to balance_adjustments. A reason is REQUIRED — this moves money, so
// an unexplained correction is not accepted.
//
// Refused while the buyer has an IN_PROGRESS route. That session snapshotted
// prev_balance when it was created, and settling recomputes current_balance
// from that snapshot — so a correction made mid-route would be silently
// overwritten at settle time. Settling first keeps the ledger auditable.
app.patch("/api/profiles/:id/balance", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can correct ledger balances.");
  const profileId = positiveInteger(req.params.id);
  if (profileId === null || profileId < 1) return fail(res, 400, "Invalid profile id.");
  const mode = req.body?.mode === "adjust" ? "adjust" : "set";
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  if (!reason) return fail(res, 400, "A reason is required for a ledger correction.");
  const rawValue = roundMoney(req.body?.value);
  if (!Number.isFinite(rawValue)) {
    return fail(res, 400, "A valid amount is required.");
  }
  if (mode === "adjust" && rawValue === 0) {
    return fail(res, 400, "Enter a non-zero amount to adjust by.");
  }
  try {
    const open = await database.get(
      "SELECT id FROM dsr_sessions WHERE buyer_id = ? AND status = 'IN_PROGRESS'",
      [profileId],
    );
    if (open) {
      return fail(res, 409, "Settle this buyer's open route before correcting their balance.");
    }
    const result = await withTransaction(async (tx) => {
      const profile = await tx.get(
        "SELECT id, current_balance FROM profiles WHERE id = ?",
        [profileId],
      );
      if (!profile) return { notFound: true };
      const oldBalance = roundMoney(profile.current_balance);
      // Ledger balances are legitimately negative (buyer in credit), so unlike
      // warehouse stock there is no floor to clamp against.
      const newBalance = mode === "set" ? rawValue : roundMoney(oldBalance + rawValue);
      await tx.run("UPDATE profiles SET current_balance = ? WHERE id = ?", [newBalance, profileId]);
      await tx.run(
        `INSERT INTO balance_adjustments
           (profile_id, old_balance, new_balance, delta, mode, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [profileId, oldBalance, newBalance, roundMoney(newBalance - oldBalance), mode, reason],
      );
      return { oldBalance, newBalance };
    });
    if (result.notFound) return fail(res, 404, "Buyer profile not found.");
    res.json(await database.get(
      "SELECT id, name, current_balance, hidden FROM profiles WHERE id = ?",
      [profileId],
    ));
  } catch (error) {
    console.error("Failed to correct ledger balance", error);
    fail(res, 500, "Unable to correct the ledger balance.");
  }
});

app.get("/api/balance-adjustments", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can view ledger correction history.");
  try {
    res.json({ adjustments: await database.all(
      `SELECT b.id, b.profile_id, p.name AS profile_name, b.old_balance,
              b.new_balance, b.delta, b.mode, b.reason, b.created_at
         FROM balance_adjustments b
         LEFT JOIN profiles p ON p.id = b.profile_id
        ORDER BY b.created_at DESC, b.id DESC LIMIT 200`,
    ) });
  } catch (error) {
    console.error("Failed to list balance adjustments", error);
    fail(res, 500, "Unable to load ledger correction history.");
  }
});

app.delete("/api/profiles/:id", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can delete buyer profiles.");
  const profileId = positiveInteger(req.params.id);
  if (profileId === null || profileId < 1) return fail(res, 400, "Invalid profile id.");
  const force = req.query.force === "true";
  try {
    const profile = await database.get("SELECT id FROM profiles WHERE id = ?", [profileId]);
    if (!profile) return fail(res, 404, "Buyer profile not found.");
    const history = await database.get(
      "SELECT COUNT(*) AS count FROM dsr_sessions WHERE buyer_id = ?",
      [profileId],
    );
    if (Number(history?.count) > 0 && !force) {
      return fail(res, 409, "Profiles with route history cannot be deleted.");
    }
    // Force delete cascades the buyer's entire history. dsr_items and payments
    // cascade off dsr_sessions automatically; stock_returns do not, so clear
    // those first. All inside one transaction.
    await withTransaction(async (tx) => {
      await tx.run(
        "DELETE FROM stock_returns WHERE dsr_id IN (SELECT id FROM dsr_sessions WHERE buyer_id = ?)",
        [profileId],
      );
      await tx.run("DELETE FROM dsr_sessions WHERE buyer_id = ?", [profileId]);
      await tx.run("DELETE FROM profiles WHERE id = ?", [profileId]);
    });
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete profile", error);
    fail(res, 500, "Unable to delete buyer profile.");
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    res.json({ products: await database.all(
      "SELECT id, name, warehouse_stock, unit_price FROM products ORDER BY id",
    ) });
  } catch (error) {
    console.error("Failed to list products", error);
    fail(res, 500, "Unable to load the product master.");
  }
});

// Every table holding a products.id foreign key. All four are DEFERRABLE
// INITIALLY DEFERRED (see db/schema.sql), so children can be repointed before
// the parent PK moves; the constraints are validated at COMMIT.
const PRODUCT_CHILD_TABLES = ["dsr_items", "purchases", "stock_returns", "stock_adjustments"];

// Make room at startId by shifting that product and everything after it up by
// one, carrying all child rows along.
//
// This cannot be done as a single `id = id + 1`: products_pkey and
// dsr_items' UNIQUE (dsr_id, product_id) are NOT deferrable, so a row moving
// 29 -> 30 collides with the existing 30 the moment it is written. Instead park
// the whole affected range above the current maximum, then land it one higher —
// the destination range is empty by then, so no row ever collides.
async function shiftProductIdsFrom(tx, startId) {
  const { max } = await tx.get("SELECT COALESCE(MAX(id), 0) AS max FROM products");
  const park = Number(max) + 1000;
  for (const table of PRODUCT_CHILD_TABLES) {
    await tx.run(`UPDATE ${table} SET product_id = product_id + ? WHERE product_id >= ?`, [park, startId]);
  }
  await tx.run("UPDATE products SET id = id + ? WHERE id >= ?", [park, startId]);
  for (const table of PRODUCT_CHILD_TABLES) {
    await tx.run(`UPDATE ${table} SET product_id = product_id - ? + 1 WHERE product_id > ?`, [park, park]);
  }
  await tx.run("UPDATE products SET id = id - ? + 1 WHERE id > ?", [park, park]);
}

// Explicit ids (custom inserts, shifts, renumbering) never advance the identity
// sequence, so it drifts behind MAX(id) and the next auto-assigned id collides
// with a live row. Re-point it after any operation that writes ids by hand.
async function resyncProductSequence(tx) {
  await tx.run(
    `SELECT setval(pg_get_serial_sequence('products', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 1) FROM products), 1))`,
  );
}

app.post("/api/products", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can add products.");
  const name = String(req.body?.name || "").trim();
  const initialStock = positiveInteger(req.body?.initialStock);
  const unitPrice = positiveAmount(req.body?.unitPrice);
  const customId = req.body?.customId != null ? positiveInteger(req.body.customId) : null;
  if (!name || name.length > 120 || initialStock === null || unitPrice === null) {
    return fail(res, 400, "Product name, whole-number stock, and positive unit price are required.");
  }
  if (req.body?.customId != null && customId === null) {
    return fail(res, 400, "Product ID must be a positive whole number.");
  }
  try {
    const outcome = await withTransaction(async (tx) => {
      let newId = customId;
      let shifted = 0;
      if (customId !== null) {
        const occupied = await tx.get("SELECT id FROM products WHERE id = ?", [customId]);
        if (occupied) {
          // Insert-at-position: the requested id is taken, so that product and
          // every one after it slide up by one to open the slot.
          const { count } = await tx.get(
            "SELECT COUNT(*)::int AS count FROM products WHERE id >= ?",
            [customId],
          );
          shifted = Number(count);
          await shiftProductIdsFrom(tx, customId);
        }
        await tx.run(
          "INSERT INTO products (id, name, warehouse_stock, unit_price) VALUES (?, ?, ?, ?)",
          [customId, name, initialStock, unitPrice],
        );
      } else {
        // Guard against a sequence that has drifted behind MAX(id), which would
        // otherwise hand out an id that is already taken.
        await resyncProductSequence(tx);
        const created = await tx.run(
          "INSERT INTO products (name, warehouse_stock, unit_price) VALUES (?, ?, ?)",
          [name, initialStock, unitPrice],
        );
        newId = created.id;
      }
      await resyncProductSequence(tx);
      // Backfill a dsr_items row into every currently open session so the new
      // product appears in load-in and closing tables without restarting a route.
      const openSessions = await tx.all(
        "SELECT id FROM dsr_sessions WHERE status = 'IN_PROGRESS'",
      );
      for (const session of openSessions) {
        await tx.run(
          `INSERT INTO dsr_items
            (dsr_id, product_id, opening_stock, loaded_stock, closing_stock,
             qty_sold, unit_price, line_total)
           VALUES (?, ?, 0, 0, 0, 0, ?, 0)
           ON CONFLICT (dsr_id, product_id) DO NOTHING`,
          [session.id, newId, unitPrice],
        );
      }
      return { newId, shifted };
    });
    const product = await database.get(
      "SELECT id, name, warehouse_stock, unit_price FROM products WHERE id = ?",
      [outcome.newId],
    );
    res.status(201).json({ ...product, shifted: outcome.shifted });
  } catch (error) {
    if (error?.code === "23505") return fail(res, 409, "A product with that name already exists.");
    console.error("Failed to create product", error);
    fail(res, 500, "Unable to create product.");
  }
});

app.patch("/api/products/:id/product-id", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can change product IDs.");
  const oldId = positiveInteger(req.params.id);
  const newId = positiveInteger(req.body?.newId);
  if (oldId === null || newId === null || newId < 1) {
    return fail(res, 400, "Valid old and new product IDs are required.");
  }
  if (oldId === newId) return fail(res, 400, "New ID is the same as the current ID.");
  try {
    const product = await database.get("SELECT id, name, warehouse_stock, unit_price FROM products WHERE id = ?", [oldId]);
    if (!product) return fail(res, 404, "Product not found.");
    const conflict = await database.get("SELECT id FROM products WHERE id = ?", [newId]);
    if (conflict) return fail(res, 409, `Product ID ${newId} is already in use.`);
    // Cascade update all FK references inside a transaction. The product_id
    // foreign keys are DEFERRABLE INITIALLY DEFERRED (see db/schema.sql) so the
    // children can be repointed to newId before the parent PK row exists; the
    // constraints are validated at COMMIT.
    await withTransaction(async (tx) => {
      // Every child table must be repointed. Missing one leaves an orphan whose
      // deferred FK fails at COMMIT and aborts the whole change.
      for (const table of PRODUCT_CHILD_TABLES) {
        await tx.run(`UPDATE ${table} SET product_id = ? WHERE product_id = ?`, [newId, oldId]);
      }
      await tx.run("UPDATE products SET id = ? WHERE id = ?", [newId, oldId]);
      await resyncProductSequence(tx);
    });
    res.json({ id: newId, name: product.name, warehouse_stock: product.warehouse_stock, unit_price: product.unit_price });
  } catch (error) {
    if (error?.code === "23505") return fail(res, 409, `Product ID ${newId} is already in use.`);
    console.error("Failed to change product ID", error);
    fail(res, 500, "Unable to change product ID.");
  }
});

app.patch("/api/products/:id/rate", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can update product rates.");
  const productId = positiveInteger(req.params.id);
  const unitPrice = positiveAmount(req.body?.unitPrice);
  if (productId === null || productId < 1 || unitPrice === null) {
    return fail(res, 400, "A valid product and positive unit price are required.");
  }
  try {
    const result = await database.run(
      "UPDATE products SET unit_price = ? WHERE id = ?",
      [unitPrice, productId],
    );
    if (!result.changes) return fail(res, 404, "Product not found.");
    res.json(await database.get(
      "SELECT id, name, warehouse_stock, unit_price FROM products WHERE id = ?",
      [productId],
    ));
  } catch (error) {
    console.error("Failed to update product rate", error);
    fail(res, 500, "Unable to update product rate.");
  }
});

// Manual warehouse-stock correction for a discrepancy. mode "set" writes an
// absolute count; mode "adjust" applies a signed delta. Every change is logged
// to stock_adjustments with a reason.
app.patch("/api/products/:id/stock", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can adjust warehouse stock.");
  const productId = positiveInteger(req.params.id);
  const mode = req.body?.mode === "adjust" ? "adjust" : "set";
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  const rawValue = Number(req.body?.value);
  if (productId === null || productId < 1 || !Number.isInteger(rawValue)) {
    return fail(res, 400, "A valid product and whole-number value are required.");
  }
  try {
    const result = await withTransaction(async (tx) => {
      const product = await tx.get(
        "SELECT id, warehouse_stock FROM products WHERE id = ?",
        [productId],
      );
      if (!product) return { notFound: true };
      const oldStock = product.warehouse_stock;
      const newStock = mode === "set" ? rawValue : oldStock + rawValue;
      if (newStock < 0) {
        return { invalid: "Resulting stock cannot be negative." };
      }
      await tx.run("UPDATE products SET warehouse_stock = ? WHERE id = ?", [newStock, productId]);
      await tx.run(
        `INSERT INTO stock_adjustments (product_id, old_stock, new_stock, delta, mode, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [productId, oldStock, newStock, newStock - oldStock, mode, reason],
      );
      return { oldStock, newStock };
    });
    if (result.notFound) return fail(res, 404, "Product not found.");
    if (result.invalid) return fail(res, 400, result.invalid);
    res.json(await database.get(
      "SELECT id, name, warehouse_stock, unit_price FROM products WHERE id = ?",
      [productId],
    ));
  } catch (error) {
    console.error("Failed to adjust stock", error);
    fail(res, 500, "Unable to adjust warehouse stock.");
  }
});

app.delete("/api/products/:id", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can delete products.");
  const productId = positiveInteger(req.params.id);
  if (productId === null || productId < 1) return fail(res, 400, "Invalid product id.");
  const force = req.query.force === "true";
  try {
    const product = await database.get("SELECT id FROM products WHERE id = ?", [productId]);
    if (!product) return fail(res, 404, "Product not found.");
    const history = await database.get(
      "SELECT COUNT(*) AS count FROM dsr_items WHERE product_id = ? AND (loaded_stock > 0 OR qty_sold > 0)",
      [productId],
    );
    if (Number(history?.count) > 0 && !force) {
      return fail(res, 409, "Products with route dispatch history cannot be deleted.");
    }
    // Force delete clears every child row that references the product before
    // removing it. Driven off PRODUCT_CHILD_TABLES so a table added later
    // cannot be forgotten here — omitting one makes the delete fail on its
    // foreign key.
    await withTransaction(async (tx) => {
      for (const table of PRODUCT_CHILD_TABLES) {
        await tx.run(`DELETE FROM ${table} WHERE product_id = ?`, [productId]);
      }
      await tx.run("DELETE FROM products WHERE id = ?", [productId]);
    });
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete product", error);
    fail(res, 500, "Unable to delete product.");
  }
});

app.get("/api/purchases", async (_req, res) => {
  try {
    res.json({ purchases: await database.all(
      `SELECT pu.id, pu.product_id, p.name AS product_name, pu.qty_added,
              pu.supplier_ref, pu.created_at
         FROM purchases pu JOIN products p ON p.id = pu.product_id
        ORDER BY pu.created_at DESC, pu.id DESC LIMIT 100`,
    ) });
  } catch (error) {
    console.error("Failed to list purchases", error);
    fail(res, 500, "Unable to load purchase logs.");
  }
});

app.get("/api/stock-adjustments", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can view stock adjustment history.");
  try {
    res.json({ adjustments: await database.all(
      `SELECT a.id, a.product_id, p.name AS product_name, a.old_stock,
              a.new_stock, a.delta, a.mode, a.reason, a.created_at
         FROM stock_adjustments a
         LEFT JOIN products p ON p.id = a.product_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    ) });
  } catch (error) {
    console.error("Failed to list stock adjustments", error);
    fail(res, 500, "Unable to load stock adjustment history.");
  }
});

app.post("/api/inventory/purchase", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can record purchases.");
  const productId = positiveInteger(req.body?.productId);
  const qtyAdded = positiveInteger(req.body?.qtyAdded);
  const supplierRef = String(req.body?.supplierRef || "").trim();
  if (productId === null || productId < 1 || qtyAdded === null || qtyAdded < 1) {
    return fail(res, 400, "A product and a positive whole-number quantity are required.");
  }
  if (supplierRef.length > 120) return fail(res, 400, "Supplier or bill reference is too long.");
  try {
    const created = await withTransaction(async (tx) => {
      const product = await tx.get("SELECT id FROM products WHERE id = ?", [productId]);
      if (!product) throw new Error("Product not found.");
      await tx.run(
        "UPDATE products SET warehouse_stock = warehouse_stock + ? WHERE id = ?",
        [qtyAdded, productId],
      );
      return tx.run(
        "INSERT INTO purchases (product_id, qty_added, supplier_ref) VALUES (?, ?, ?)",
        [productId, qtyAdded, supplierRef],
      );
    });
    res.status(201).json(await database.get(
      `SELECT pu.id, pu.product_id, p.name AS product_name, pu.qty_added,
              pu.supplier_ref, pu.created_at, p.warehouse_stock
         FROM purchases pu JOIN products p ON p.id = pu.product_id WHERE pu.id = ?`,
      [created.id],
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record purchase.";
    fail(res, message === "Product not found." ? 404 : 400, message);
  }
});

app.delete("/api/purchases/:id", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can delete purchase records.");
  const purchaseId = positiveInteger(req.params.id);
  if (purchaseId === null || purchaseId < 1) return fail(res, 400, "Invalid purchase id.");
  try {
    const purchase = await database.get("SELECT id, product_id, qty_added FROM purchases WHERE id = ?", [purchaseId]);
    if (!purchase) return fail(res, 404, "Purchase record not found.");
    await withTransaction(async (tx) => {
      await tx.run(
        "UPDATE products SET warehouse_stock = GREATEST(0, warehouse_stock - ?) WHERE id = ?",
        [purchase.qty_added, purchase.product_id],
      );
      await tx.run("DELETE FROM purchases WHERE id = ?", [purchaseId]);
    });
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete purchase", error);
    fail(res, 500, "Unable to delete purchase record.");
  }
});

app.get("/api/dsr/active/:buyerId", async (req, res) => {
  const buyerId = positiveInteger(req.params.buyerId);
  if (buyerId === null || buyerId < 1) return fail(res, 400, "Invalid buyer id.");
  try {
    const sessionId = await getOrCreateActiveSession(buyerId);
    if (!sessionId) return fail(res, 404, "Buyer profile not found.");
    res.json(await getSessionPayload(sessionId));
  } catch (error) {
    console.error("Failed to load active DSR", error);
    fail(res, 500, "Unable to load the active DSR.");
  }
});

app.post("/api/dsr/load-in", async (req, res) => {
  const buyerId = positiveInteger(req.body?.buyerId);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (buyerId === null || buyerId < 1 || items.length === 0) {
    return fail(res, 400, "Buyer and at least one load-in row are required.");
  }
  try {
    const sessionId = await getOrCreateActiveSession(buyerId);
    if (!sessionId) return fail(res, 404, "Buyer profile not found.");
    await withTransaction(async (tx) => {
      for (const requestedItem of items) {
        const productId = positiveInteger(requestedItem.productId);
        const additionalLoad = positiveInteger(requestedItem.additionalLoad);
        if (productId === null || additionalLoad === null) {
          throw new Error("Load quantities must be whole numbers.");
        }
        if (additionalLoad === 0) continue;
        const product = await tx.get(
          "SELECT id, warehouse_stock FROM products WHERE id = ?",
          [productId],
        );
        if (!product) throw new Error("One or more products could not be found.");
        if (product.warehouse_stock < additionalLoad) {
          throw new Error(`Not enough warehouse stock for product ${productId}.`);
        }
        const item = await tx.get(
          `SELECT i.id FROM dsr_items i
            JOIN dsr_sessions s ON s.id = i.dsr_id
           WHERE i.dsr_id = ? AND i.product_id = ? AND s.status = 'IN_PROGRESS'`,
          [sessionId, productId],
        );
        if (!item) throw new Error("This DSR item is not available.");
        await tx.run(
          "UPDATE products SET warehouse_stock = warehouse_stock - ? WHERE id = ?",
          [additionalLoad, productId],
        );
        await tx.run(
          "UPDATE dsr_items SET loaded_stock = loaded_stock + ? WHERE id = ?",
          [additionalLoad, item.id],
        );
      }
    });
    res.json(await getSessionPayload(sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record load-in.";
    fail(res, message.startsWith("Not enough") ? 409 : 400, message);
  }
});

app.post("/api/payments", async (req, res) => {
  const dsrId = positiveInteger(req.body?.dsrId);
  const method = String(req.body?.method || "").trim();
  const labelInfo = String(req.body?.labelInfo || "").trim();
  const amount = positiveAmount(req.body?.amount);
  if (
    dsrId === null ||
    dsrId < 1 ||
    !method ||
     amount === null
  ) {
    return fail(res, 400, "A payment method and a positive amount are required.");
  }
  try {
    const session = await database.get(
      "SELECT id, status FROM dsr_sessions WHERE id = ?",
      [dsrId],
    );
    if (!session) return fail(res, 404, "DSR session not found.");
    if (session.status !== "IN_PROGRESS") return fail(res, 409, "Settled DSRs are locked.");
    const created = await database.run(
      `INSERT INTO payments (dsr_id, method, label_info, amount)
       VALUES (?, ?, ?, ?)`,
      [dsrId, method, labelInfo, amount],
    );
    const payment = await database.get(
      `SELECT id, dsr_id, method, label_info, amount, created_at
         FROM payments WHERE id = ?`,
      [created.id],
    );
    res.status(201).json(payment);
  } catch (error) {
    console.error("Failed to add payment", error);
    fail(res, 500, "Unable to record payment.");
  }
});

app.delete("/api/payments/:id", async (req, res) => {
  if (String(req.header("x-user-role") || "").toUpperCase() !== "ADMIN") {
    return fail(res, 403, "Only Admin can delete payments.");
  }
  const paymentId = positiveInteger(req.params.id);
  if (paymentId === null || paymentId < 1) return fail(res, 400, "Invalid payment id.");
  try {
    const payment = await database.get(
      `SELECT p.id, s.status FROM payments p
       JOIN dsr_sessions s ON s.id = p.dsr_id WHERE p.id = ?`,
      [paymentId],
    );
    if (!payment) return fail(res, 404, "Payment not found.");
    if (payment.status !== "IN_PROGRESS") return fail(res, 409, "Settled DSRs are locked.");
    await database.run("DELETE FROM payments WHERE id = ?", [paymentId]);
    res.status(204).end();
  } catch (error) {
    console.error("Failed to delete payment", error);
    fail(res, 500, "Unable to delete payment.");
  }
});

// Stage 1 of settlement: save closing stock + compute line totals; stays IN_PROGRESS.
app.post("/api/dsr/close", async (req, res) => {
  const dsrId = positiveInteger(req.body?.dsrId);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (dsrId === null || dsrId < 1 || items.length === 0) {
    return fail(res, 400, "A DSR and closing stock rows are required.");
  }
  try {
    const session = await database.get(
      "SELECT id, prev_balance, status FROM dsr_sessions WHERE id = ?",
      [dsrId],
    );
    if (!session) return fail(res, 404, "DSR session not found.");
    if (session.status !== "IN_PROGRESS") return fail(res, 409, "This DSR is already settled.");
    const storedItems = await database.all(
      "SELECT id, product_id, opening_stock, loaded_stock, unit_price FROM dsr_items WHERE dsr_id = ?",
      [dsrId],
    );
    const closingByProduct = new Map();
    for (const row of items) {
      const productId = positiveInteger(row.productId);
      const closingStock = positiveInteger(row.closingStock);
      if (productId === null || closingStock === null) {
        throw new Error("Closing stock must be a whole number.");
      }
      closingByProduct.set(productId, closingStock);
    }
    if (closingByProduct.size !== storedItems.length) {
      throw new Error("Closing stock is required for every product.");
    }
    await withTransaction(async (tx) => {
      let totalSales = 0;
      for (const item of storedItems) {
        const closingStock = closingByProduct.get(item.product_id);
        const dispatched = item.opening_stock + item.loaded_stock;
        if (closingStock > dispatched) {
          throw new Error("Closing stock cannot exceed total dispatched stock.");
        }
        const qtySold = dispatched - closingStock;
        const lineTotal = roundMoney(qtySold * item.unit_price);
        totalSales += lineTotal;
        await tx.run(
          "UPDATE dsr_items SET closing_stock = ?, qty_sold = ?, line_total = ? WHERE id = ?",
          [closingStock, qtySold, lineTotal, item.id],
        );
      }
      totalSales = roundMoney(totalSales);
      await tx.run(
        "UPDATE dsr_sessions SET total_sales = ? WHERE id = ?",
        [totalSales, dsrId],
      );
    });
    res.json(await getSessionPayload(dsrId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save closing stock.";
    fail(res, message.includes("exceed") ? 409 : 400, message);
  }
});

// Stage 2 of settlement: finalise — uses already-saved closing data, locks status, updates ledger.
app.post("/api/dsr/settle", async (req, res) => {
  const dsrId = positiveInteger(req.body?.dsrId);
  if (dsrId === null || dsrId < 1) {
    return fail(res, 400, "A DSR session id is required.");
  }
  try {
    const session = await database.get(
      "SELECT id, prev_balance, total_sales, status FROM dsr_sessions WHERE id = ?",
      [dsrId],
    );
    if (!session) return fail(res, 404, "DSR session not found.");
    if (session.status !== "IN_PROGRESS") return fail(res, 409, "This DSR is already settled.");
    const paymentTotals = await database.get(
      "SELECT COALESCE(SUM(amount), 0) AS total_payments FROM payments WHERE dsr_id = ?",
      [dsrId],
    );
    const totalPayments = roundMoney(paymentTotals.total_payments);
    const updatedBalance = roundMoney(session.prev_balance + session.total_sales - totalPayments);
    await withTransaction(async (tx) => {
      await tx.run(
        `UPDATE dsr_sessions
            SET total_payments = ?, updated_balance = ?, status = 'SETTLED'
          WHERE id = ?`,
        [totalPayments, updatedBalance, dsrId],
      );
      await tx.run(
        "UPDATE profiles SET current_balance = ? WHERE id = (SELECT buyer_id FROM dsr_sessions WHERE id = ?)",
        [updatedBalance, dsrId],
      );
    });
    res.json(await getSessionPayload(dsrId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to settle DSR.";
    fail(res, 400, message);
  }
});

// Return all closing stock from a session back to warehouse inventory.
app.post("/api/dsr/return-stock", async (req, res) => {
  const dsrId = positiveInteger(req.body?.dsrId);
  if (!dsrId) return fail(res, 400, "A DSR session id is required.");
  try {
    const session = await database.get(
      "SELECT id, status FROM dsr_sessions WHERE id = ?",
      [dsrId],
    );
    if (!session) return fail(res, 404, "DSR session not found.");
    if (session.status !== "SETTLED") return fail(res, 409, "Only settled sessions can have stock returned.");

    const items = await database.all(
      "SELECT id, product_id, closing_stock FROM dsr_items WHERE dsr_id = ? AND closing_stock > 0",
      [dsrId],
    );
    if (!items.length) return res.json({ returned: [], message: "No stock to return." });

    await withTransaction(async (tx) => {
      for (const item of items) {
        await tx.run(
          "UPDATE products SET warehouse_stock = warehouse_stock + ? WHERE id = ?",
          [item.closing_stock, item.product_id],
        );
        await tx.run(
          "UPDATE dsr_items SET closing_stock = 0 WHERE id = ?",
          [item.id],
        );
        await tx.run(
          "INSERT INTO stock_returns (dsr_id, product_id, qty_returned) VALUES (?, ?, ?)",
          [dsrId, item.product_id, item.closing_stock],
        );
      }
    });

    res.json({
      returned: items.map((i) => ({ product_id: i.product_id, qty: i.closing_stock })),
      message: `${items.length} product(s) returned to warehouse.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to return stock.";
    fail(res, 500, message);
  }
});

// ---------------------------------------------------------------------------
// Full database backup. Admin-only. Dumps every application table into a single
// JSON file the browser downloads. Table order is parent-before-child so the
// file can be replayed with inserts in this same sequence without tripping a
// foreign key. Names are hard-coded constants (never user input) because they
// are interpolated straight into the SELECT.
// ---------------------------------------------------------------------------
const BACKUP_TABLES = [
  "profiles",
  "products",
  "dsr_sessions",
  "dsr_items",
  "payments",
  "purchases",
  "stock_returns",
  "stock_adjustments",
  "balance_adjustments",
];

app.get("/api/backup", async (req, res) => {
  if (!isAdmin(req)) return fail(res, 403, "Only Admin can download a database backup.");
  try {
    const tables = {};
    const rowCounts = {};
    for (const table of BACKUP_TABLES) {
      const rows = await database.all(`SELECT * FROM ${table} ORDER BY id`);
      tables[table] = rows;
      rowCounts[table] = rows.length;
    }
    const backup = {
      format: "dsr-backup",
      version: 1,
      generated_at: new Date().toISOString(),
      table_order: BACKUP_TABLES,
      row_counts: rowCounts,
      tables,
    };
    // Local calendar-time stamp so the filename matches the operator's day.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="dsr-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error("Failed to create database backup", error);
    fail(res, 500, "Unable to create the database backup.");
  }
});

app.get("/api/reports/csv", async (_req, res) => {
  try {
    const startOfMonth = `${today().slice(0, 7)}-01`;
    const rows = await database.all(
      `SELECT s.id, s.date, p.name AS buyer_name, s.prev_balance,
              s.total_sales, s.total_payments, s.updated_balance, s.status
         FROM dsr_sessions s JOIN profiles p ON p.id = s.buyer_id
        WHERE s.date >= ? ORDER BY s.date DESC, s.id DESC`,
      [startOfMonth],
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="dsr-mtd-report.csv"');
     res.write("DSR ID,Date,Buyer,Previous Balance,Total Sales,Payments Received,Updated Ledger Balance,Status\n");
     const money = (value) => `₹${roundMoney(value).toFixed(2)}`;
    for (const row of rows) {
      const values = [
        row.id,
        row.date,
        row.buyer_name,
         money(row.prev_balance),
         money(row.total_sales),
         money(row.total_payments),
         money(row.updated_balance),
        row.status,
      ].map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`);
      res.write(`${values.join(",")}\n`);
    }
    res.end();
  } catch (error) {
    console.error("Failed to create CSV report", error);
    fail(res, 500, "Unable to create the CSV report.");
  }
});

app.get("/api/reports/inventory", async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.from) ? req.query.from : `${today().slice(0, 7)}-01`;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.to)   ? req.query.to   : today();

    const bills = await database.all(
      `SELECT 'purchase'       AS entry_type,
              pu.id,
              pu.supplier_ref  AS ref,
              pu.created_at,
              p.name           AS product_name,
              pu.qty_added     AS qty,
              NULL             AS buyer_name
         FROM purchases pu
         JOIN products p ON p.id = pu.product_id
        WHERE pu.created_at::date >= ?::date AND pu.created_at::date <= ?::date

        UNION ALL

        SELECT 'return'        AS entry_type,
               sr.id,
               NULL            AS ref,
               sr.created_at,
               p.name          AS product_name,
               sr.qty_returned AS qty,
               pr.name         AS buyer_name
          FROM stock_returns sr
          JOIN products p        ON p.id  = sr.product_id
          JOIN dsr_sessions s    ON s.id  = sr.dsr_id
          JOIN profiles pr       ON pr.id = s.buyer_id
         WHERE sr.created_at::date >= ?::date AND sr.created_at::date <= ?::date

        ORDER BY 4 DESC, 2 DESC`,
      [from, to, from, to],
    );

    const inventory = await database.all(
      "SELECT id, name, warehouse_stock, unit_price FROM products ORDER BY id",
    );

    res.json({ filters: { from, to }, bills, inventory });
  } catch (error) {
    console.error("Failed to generate inventory report", error);
    fail(res, 500, "Unable to generate the inventory report.");
  }
});

app.get("/api/reports/performance", async (req, res) => {
  try {
    const profileId = positiveInteger(req.query?.profileId) ?? null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.from) ? req.query.from : `${today().slice(0, 7)}-01`;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.to)   ? req.query.to   : today();

    // Overall summary
    const summary = await database.get(
      // total_revenue sums item-level line_total (not s.total_sales): joining
      // sessions to items would otherwise count each session's sales once per
      // line item, inflating the figure.
      `SELECT COUNT(DISTINCT s.id)              AS session_count,
              COALESCE(SUM(i.qty_sold), 0)      AS total_qty,
              COALESCE(SUM(i.line_total), 0)    AS total_revenue
         FROM dsr_sessions s
         JOIN dsr_items i ON i.dsr_id = s.id
        WHERE s.status = 'SETTLED'
          AND s.date >= ? AND s.date <= ?
          AND (?::int IS NULL OR s.buyer_id = ?)`,
      [from, to, profileId, profileId],
    );

    let rows = [];
    if (profileId !== null) {
      // Product-level breakdown for selected profile
      rows = await database.all(
        `SELECT p.id AS product_id, p.name AS product_name,
                COALESCE(SUM(i.qty_sold), 0)   AS total_qty,
                COALESCE(SUM(i.line_total), 0) AS total_revenue,
                COUNT(DISTINCT CASE WHEN i.qty_sold > 0 THEN s.id END) AS session_count
           FROM products p
           LEFT JOIN dsr_items i ON i.product_id = p.id
           LEFT JOIN dsr_sessions s ON s.id = i.dsr_id
             AND s.status = 'SETTLED'
             AND s.date >= ? AND s.date <= ?
             AND s.buyer_id = ?
          GROUP BY p.id, p.name
          ORDER BY total_qty DESC, p.id`,
        [from, to, profileId],
      );
    } else {
      // Per-profile totals with individual product breakdown
      const profileRows = await database.all(
        `SELECT pr.id AS profile_id, pr.name AS buyer_name,
                COUNT(DISTINCT s.id)              AS session_count,
                COALESCE(SUM(i.qty_sold), 0)      AS total_qty,
                COALESCE(SUM(i.line_total), 0)    AS total_revenue
           FROM profiles pr
           LEFT JOIN dsr_sessions s ON s.buyer_id = pr.id
             AND s.status = 'SETTLED' AND s.date >= ? AND s.date <= ?
           LEFT JOIN dsr_items i ON i.dsr_id = s.id
          GROUP BY pr.id, pr.name
          ORDER BY total_qty DESC, pr.id`,
        [from, to],
      );
      // Product breakdown per profile
      const productRows = await database.all(
        `SELECT s.buyer_id AS profile_id, p.name AS product_name,
                COALESCE(SUM(i.qty_sold), 0)   AS total_qty,
                COALESCE(SUM(i.line_total), 0) AS total_revenue
           FROM dsr_items i
           JOIN dsr_sessions s ON s.id = i.dsr_id
             AND s.status = 'SETTLED' AND s.date >= ? AND s.date <= ?
           JOIN products p ON p.id = i.product_id
          WHERE i.qty_sold > 0
          GROUP BY s.buyer_id, p.id
          ORDER BY s.buyer_id, total_qty DESC`,
        [from, to],
      );
      const productsByProfile = new Map();
      for (const r of productRows) {
        if (!productsByProfile.has(r.profile_id)) productsByProfile.set(r.profile_id, []);
        productsByProfile.get(r.profile_id).push({ product_name: r.product_name, total_qty: r.total_qty, total_revenue: roundMoney(r.total_revenue) });
      }
      rows = profileRows.map((p) => ({
        ...p,
        total_revenue: roundMoney(p.total_revenue),
        products: productsByProfile.get(p.profile_id) ?? [],
      }));
    }

    res.json({
      filters: { profileId, from, to },
      summary: {
        session_count: summary.session_count,
        total_qty:     summary.total_qty,
        total_revenue: roundMoney(summary.total_revenue),
      },
      rows: profileId !== null ? rows.map((r) => ({ ...r, total_revenue: roundMoney(r.total_revenue) })) : rows,
    });
  } catch (error) {
    console.error("Failed to generate performance report", error);
    fail(res, 500, "Unable to generate the performance report.");
  }
});

app.get("/api/reports/profile-stock", async (req, res) => {
  try {
    // For every buyer profile, get their latest session's item-level closing stock.
    // "Stock on hand" = what the buyer still has after their most recent route day.
    const rows = await database.all(
      `SELECT
         pr.id           AS profile_id,
         pr.name         AS buyer_name,
         s.id            AS session_id,
         s.date          AS session_date,
         s.status,
         p.name          AS product_name,
         i.opening_stock,
         i.loaded_stock,
         i.closing_stock,
         i.qty_sold
       FROM profiles pr
       LEFT JOIN dsr_sessions s ON s.id = (
         SELECT id FROM dsr_sessions
          WHERE buyer_id = pr.id
          ORDER BY id DESC LIMIT 1
       )
       LEFT JOIN dsr_items i ON i.dsr_id = s.id
       LEFT JOIN products p  ON p.id = i.product_id
       ORDER BY pr.name, p.name`,
    );

    // Group by profile
    const profileMap = new Map();
    for (const row of rows) {
      if (!profileMap.has(row.profile_id)) {
        profileMap.set(row.profile_id, {
          profile_id:   row.profile_id,
          buyer_name:   row.buyer_name,
          session_id:   row.session_id,
          session_date: row.session_date,
          status:       row.status,
          products:     [],
        });
      }
      if (row.product_name) {
        profileMap.get(row.profile_id).products.push({
          product_name:  row.product_name,
          opening_stock: row.opening_stock ?? 0,
          loaded_stock:  row.loaded_stock  ?? 0,
          closing_stock: row.closing_stock ?? 0,
          qty_sold:      row.qty_sold      ?? 0,
        });
      }
    }

    res.json({ profiles: [...profileMap.values()] });
  } catch (error) {
    console.error("Failed to generate profile stock report", error);
    fail(res, 500, "Unable to generate the profile stock report.");
  }
});

app.get("/api/reports/product-sales", async (req, res) => {
  try {
    const profileId = positiveInteger(req.query?.profileId) ?? null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.from) ? req.query.from : `${today().slice(0, 7)}-01`;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.to)   ? req.query.to   : today();

    // Summary across all settled sessions in range
    const summary = await database.get(
      `SELECT COUNT(DISTINCT s.id)              AS session_count,
              COALESCE(SUM(s.total_sales), 0)    AS total_sales,
              COALESCE(SUM(s.total_payments), 0) AS total_payments
         FROM dsr_sessions s
        WHERE s.status = 'SETTLED'
          AND s.date >= ? AND s.date <= ?
          AND (?::int IS NULL OR s.buyer_id = ?)`,
      [from, to, profileId, profileId],
    );

    // Product-wise aggregation — LEFT JOIN so every product appears even with zero sales
    const products = await database.all(
      `SELECT p.id AS product_id, p.name AS product_name, p.unit_price AS current_price,
              COALESCE(SUM(i.qty_sold), 0)   AS total_qty_sold,
              COALESCE(SUM(i.line_total), 0) AS total_revenue,
              COUNT(DISTINCT CASE WHEN i.qty_sold > 0 THEN i.dsr_id END) AS session_count
         FROM products p
         LEFT JOIN (
           SELECT di.product_id, di.dsr_id, di.qty_sold, di.line_total
             FROM dsr_items di
             JOIN dsr_sessions ds ON ds.id = di.dsr_id
               AND ds.status = 'SETTLED'
               AND ds.date >= ? AND ds.date <= ?
               AND (?::int IS NULL OR ds.buyer_id = ?)
         ) i ON i.product_id = p.id
        GROUP BY p.id, p.name, p.unit_price
        ORDER BY p.id`,
      [from, to, profileId, profileId],
    );

    // Per-buyer breakdown — only when no profile filter is applied
    let byBuyer = [];
    if (profileId === null) {
      byBuyer = await database.all(
        `SELECT pr.id AS buyer_id, pr.name AS buyer_name,
                COUNT(DISTINCT s.id)              AS session_count,
                COALESCE(SUM(s.total_sales), 0)    AS total_sales,
                COALESCE(SUM(s.total_payments), 0) AS total_payments
           FROM profiles pr
           LEFT JOIN dsr_sessions s ON s.buyer_id = pr.id
             AND s.status = 'SETTLED'
             AND s.date >= ? AND s.date <= ?
          GROUP BY pr.id, pr.name
          ORDER BY total_sales DESC, pr.id`,
        [from, to],
      );
    }

    res.json({
      filters: { profileId, from, to },
      summary: {
        session_count: summary.session_count,
        total_sales:    roundMoney(summary.total_sales),
        total_payments: roundMoney(summary.total_payments),
      },
      products: products.map((p) => ({ ...p, total_revenue: roundMoney(p.total_revenue) })),
      byBuyer:  byBuyer.map((b)  => ({
        ...b,
        total_sales:    roundMoney(b.total_sales),
        total_payments: roundMoney(b.total_payments),
      })),
    });
  } catch (error) {
    console.error("Failed to generate product sales report", error);
    fail(res, 500, "Unable to generate the product sales report.");
  }
});

app.get("/api/reports/payments", async (req, res) => {
  try {
    const profileId = positiveInteger(req.query?.profileId) ?? null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.from) ? req.query.from : `${today().slice(0, 7)}-01`;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.to)   ? req.query.to   : today();

    const rows = await database.all(
      `SELECT p.id, p.dsr_id, p.method, p.label_info, p.amount,
              s.date, pr.name AS buyer_name, pr.id AS buyer_id
         FROM payments p
         JOIN dsr_sessions s  ON s.id  = p.dsr_id
         JOIN profiles     pr ON pr.id = s.buyer_id
        WHERE s.date >= ? AND s.date <= ?
          AND (?::int IS NULL OR s.buyer_id = ?)
        ORDER BY s.date DESC, s.id DESC, p.id ASC`,
      [from, to, profileId, profileId],
    );

    // Group into days
    const dayMap = new Map();
    let totalAmount = 0;
    const buyerSet = new Set();
    for (const row of rows) {
      const amount = roundMoney(row.amount);
      totalAmount = roundMoney(totalAmount + amount);
      buyerSet.add(row.buyer_id);
      if (!dayMap.has(row.date)) dayMap.set(row.date, { date: row.date, day_total: 0, payments: [] });
      const day = dayMap.get(row.date);
      day.day_total = roundMoney(day.day_total + amount);
      day.payments.push({ id: row.id, dsr_id: row.dsr_id, buyer_name: row.buyer_name, buyer_id: row.buyer_id, method: row.method, label_info: row.label_info, amount });
    }

    // Current balances + last settled date for all profiles
    const balances = await database.all(
      `SELECT pr.id, pr.name, pr.current_balance,
              (SELECT s2.date FROM dsr_sessions s2
                WHERE s2.buyer_id = pr.id AND s2.status = 'SETTLED'
                ORDER BY s2.date DESC, s2.id DESC LIMIT 1) AS last_settled
         FROM profiles pr
        ORDER BY pr.name`,
    );

    res.json({
      filters: { from, to, profileId },
      summary: { total_payments: totalAmount, payment_count: rows.length, buyer_count: buyerSet.size },
      days: [...dayMap.values()],
      balances: balances.map((b) => ({ ...b, current_balance: roundMoney(b.current_balance) })),
    });
  } catch (error) {
    console.error("Failed to generate payments report", error);
    fail(res, 500, "Unable to generate payments report.");
  }
});

app.get("/api/reports/settlement", async (req, res) => {
  try {
    const profileId = positiveInteger(req.query?.profileId) ?? null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.from) ? req.query.from : `${today().slice(0, 7)}-01`;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.to)   ? req.query.to   : today();

    const sessions = await database.all(
      `SELECT s.id, s.date, pr.name AS buyer_name,
              s.prev_balance, s.total_sales, s.total_payments, s.updated_balance
         FROM dsr_sessions s
         JOIN profiles pr ON pr.id = s.buyer_id
        WHERE s.status = 'SETTLED'
          AND s.date >= ? AND s.date <= ?
          AND (?::int IS NULL OR s.buyer_id = ?)
        ORDER BY s.date DESC, s.id DESC`,
      [from, to, profileId, profileId],
    );

    if (sessions.length === 0) {
      return res.json({ filters: { profileId, from, to }, sessions: [] });
    }

    const sessionIds = sessions.map((s) => s.id);
    const ph = sessionIds.map(() => "?").join(",");

    const items = await database.all(
      `SELECT di.dsr_id, di.product_id, p.name AS product_name,
              (di.opening_stock + di.loaded_stock) AS dispatch,
              di.closing_stock, di.qty_sold, di.unit_price, di.line_total
         FROM dsr_items di
         JOIN products p ON p.id = di.product_id
        WHERE di.dsr_id IN (${ph})
        ORDER BY p.name`,
      sessionIds,
    );

    const payments = await database.all(
      `SELECT dsr_id, method, label_info, amount
         FROM payments
        WHERE dsr_id IN (${ph})
        ORDER BY created_at`,
      sessionIds,
    );

    const itemsBySession = {};
    for (const item of items) {
      (itemsBySession[item.dsr_id] ||= []).push({ ...item, line_total: roundMoney(item.line_total) });
    }
    const paymentsBySession = {};
    for (const payment of payments) {
      (paymentsBySession[payment.dsr_id] ||= []).push({ ...payment, amount: roundMoney(payment.amount) });
    }

    res.json({
      filters: { profileId, from, to },
      sessions: sessions.map((s) => ({
        ...s,
        total_sales:     roundMoney(s.total_sales),
        total_payments:  roundMoney(s.total_payments),
        updated_balance: roundMoney(s.updated_balance),
        items:    itemsBySession[s.id]    || [],
        payments: paymentsBySession[s.id] || [],
      })),
    });
  } catch (error) {
    console.error("Failed to generate settlement report", error);
    fail(res, 500, "Unable to generate the settlement report.");
  }
});

app.get("/{*splat}", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// Export the Express app so it can be used both as a Vercel serverless handler
// (api/index.js) and by the local dev server (local.js). Schema init and
// `app.listen` are handled in local.js, not here.
export default app;

// Exported for tests: the id-shift is the one operation that rewrites primary
// keys across history, so it needs to be exercisable inside a rollback.
export { shiftProductIdsFrom, resyncProductSequence, PRODUCT_CHILD_TABLES };