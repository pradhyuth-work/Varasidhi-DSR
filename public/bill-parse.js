// Turns the text read off a supplier bill into proposed inward lines. No browser or network code
// here, so it is easy to test. Products are matched by NAME against the catalogue; anything it is
// not sure about is left unmatched or flagged, and a person always checks the result before posting.
import { BILL_ALIASES } from "./bill-aliases.js";
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(kgs?|kilograms?|grams?|gms?|gm|g|ml|ltrs?|litres?|liters?|l|pcs?|pieces?)(?![a-z])/g;
const SIZE_TOKEN = /^\d+(?:\.\d+)?(?:kg|g|ml|l|pc)$/;
const SKIP_LINE = /total|tax|gst|cess|round|discount|invoice|bill\s*no|\bdate\b|phone|mobile|\btel\b|fssai|\bpan\b|bank|ifsc|a\/c|account|\bupi\b|amount|payable|in words|\bonly\b|\bpage\b|signature|authori[sz]ed|terms|freight|transport|vehicle|lr\s*no|e-?way|balance|\bcash\b|\bcard\b/i;
function canonicalUnit(u) {
    if (u.startsWith("k"))
        return "kg";
    if (u.startsWith("m"))
        return "ml";
    if (u.startsWith("g"))
        return "g";
    if (u.startsWith("l"))
        return "l";
    return "pc";
}
/** Lowercase tokens, with sizes unified so "800 gm", "800GMS" and "800g" are all "800g". */
export function tokenize(s) {
    let t = s.toLowerCase().replace(/[^a-z0-9.\s]/g, " ");
    t = t.replace(UNIT_RE, (_m, n, u) => ` ${n}${canonicalUnit(u)} `);
    t = t.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
    return t.split(/\s+/).filter(Boolean);
}
function lev1(a, b) {
    if (Math.abs(a.length - b.length) > 1)
        return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i])
        i++;
    if (a.length === b.length)
        return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
function tokenMatch(a, b) {
    if (a === b)
        return true;
    const hasDigit = /\d/.test(a) || /\d/.test(b);
    if (hasDigit)
        return false;
    if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))
        return true;
    return Math.min(a.length, b.length) >= 5 && lev1(a, b);
}
/** Coverage of a product's tokens by a bill line's tokens; 0 when the product's size isn't on the line. */
function score(p, l) {
    for (const t of p)
        if (SIZE_TOKEN.test(t) && !l.includes(t))
            return { coverage: 0, matched: 0 };
    let matched = 0;
    for (const t of p)
        if (l.some((x) => tokenMatch(t, x)))
            matched++;
    return { coverage: p.length ? matched / p.length : 0, matched };
}
const NUM_RE = /(?<![A-Za-z0-9.,/-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![A-Za-z0-9%/-])/g;
function numbersIn(line, skipNameNumbers) {
    const skip = [...skipNameNumbers];
    const out = [];
    for (const m of line.matchAll(NUM_RE)) {
        const whole = m[1].replace(/,/g, "");
        const si = skip.indexOf(whole);
        if (si >= 0 && !m[2]) {
            skip.splice(si, 1);
            continue;
        }
        const frac = m[2];
        out.push({ value: Number(frac ? `${whole}.${frac}` : whole), isInt: !frac || /^0+$/.test(frac), whole });
    }
    return out;
}
/** Quantity = the whole number whose product with another figure on the line is a third figure (qty × rate = amount). */
function pickQuantity(nums) {
    for (let i = 0; i < nums.length; i++) {
        const q = nums[i];
        if (!q.isInt || q.value < 1 || q.value > 9999)
            continue;
        for (let j = 0; j < nums.length; j++) {
            if (j === i || nums[j].value <= 0)
                continue;
            for (let k = 0; k < nums.length; k++) {
                if (k === i || k === j)
                    continue;
                const a = nums[k].value;
                if (Math.abs(q.value * nums[j].value - a) <= Math.max(0.6, a * 0.012))
                    return { qty: q.value, guessed: false };
            }
        }
    }
    const first = nums.find((n) => n.isInt && n.value >= 1 && n.value <= 999);
    return first ? { qty: first.value, guessed: true } : null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseDate(text) {
    // 03-NOV-26 (how many supplier invoices print it)
    const t = text.match(/\b(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{2}|\d{4})\b/);
    if (t) {
        const mo = MONTHS.indexOf(t[2].toLowerCase()) + 1;
        let y = +t[3];
        if (mo > 0 && +t[1] >= 1 && +t[1] <= 31) {
            if (y < 100)
                y += 2000;
            return `${String(+t[1]).padStart(2, "0")}-${String(mo).padStart(2, "0")}-${y}`;
        }
    }
    const m = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})\b/);
    if (!m)
        return null;
    let y = +m[3];
    const mo = +m[2];
    const d = +m[1];
    if (y < 100)
        y += 2000;
    if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31)
        return null;
    return `${String(d).padStart(2, "0")}-${String(mo).padStart(2, "0")}-${y}`;
}
function parseInvoiceNumber(lines) {
    for (const line of lines) {
        const m = line.match(/\b(?:invoice|inv|bill)\s*(?:no|number|num|#)?\s*[.:\-#]*\s*([A-Za-z0-9][A-Za-z0-9/-]{2,24})/i);
        if (m && /\d/.test(m[1]))
            return m[1];
    }
    return null;
}
// Supplier item code, tolerant of the usual OCR slips (CIG0002001 read as GIG0002001, CIGOOO2001, …).
const CODE_RE = /(?<![A-Za-z0-9])[CGE][I1l|][GCQ69][0OD]{3}[0-9OD]{4}(?![A-Za-z0-9])/i;
function codeIn(line) {
    const m = line.match(CODE_RE);
    return m ? "CIG" + m[0].slice(3).replace(/[OD]/gi, "0") : null;
}
/** Quantity on a supplier bill is in M (thousands of sticks): the figure before the "M" unit, else the one after the HSN code. */
function millesIn(line) {
    const m = line.match(/(?<![\d.])(\d{1,4}(?:\.\d{1,3})?)\s+M(?![A-Za-z0-9])/);
    if (m)
        return Number(m[1]);
    const h = line.match(/\b\d{8}\b\s+(\d{1,4}(?:\.\d{1,3})?)(?![\d.])/);
    return h ? Number(h[1]) : null;
}
function resolveAlias(alias, cands) {
    const exact = cands.find((c) => c.name.trim().toLowerCase() === alias.product.trim().toLowerCase());
    if (exact)
        return exact.name;
    const pt = tokenize(alias.product);
    const near = cands.filter((c) => c.tokens.length === pt.length && pt.every((t) => c.tokens.some((x) => tokenMatch(t, x))));
    return near.length === 1 ? near[0].name : null;
}
export function parseBill(text, catalogue, aliases = BILL_ALIASES) {
    const out = { invoiceNumber: null, invoiceDate: null, lines: [], warnings: [] };
    const lines = String(text || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    out.invoiceNumber = parseInvoiceNumber(lines);
    out.invoiceDate = parseDate(lines.join("\n"));
    const cands = catalogue.map((name) => ({ name, tokens: tokenize(name) }));
    for (const raw of lines) {
        const line = raw.replace(/^\d{1,3}[.)]?\s+(?=[A-Za-z])/, "");
        const lt = tokenize(line);
        // Supplier item code on the line: that is the product, exactly — no guessing from the description.
        const code = codeIn(line);
        if (code) {
            const alias = aliases[code];
            const milles = millesIn(line);
            if (!alias) {
                out.warnings.push(`Item code ${code}${milles !== null ? ` (${milles} M)` : ""} isn't in the bill mapping, so it is NOT in the list — add the code to the mapping, or enter this line by hand.`);
                continue;
            }
            if (milles === null) {
                out.warnings.push(`${alias.product} (${code}): couldn't read the quantity — add it by hand.`);
                continue;
            }
            const exact = (milles * 1000) / alias.sticksPerPack;
            const packs = Math.round(exact);
            if (packs < 1) {
                out.warnings.push(`${alias.product} (${code}): ${milles} M comes to less than one pack — check the bill.`);
                continue;
            }
            const notes = [];
            if (Math.abs(exact - packs) > 0.01)
                notes.push(`${milles} M is ${exact.toFixed(2)} packs — rounded to ${packs}; check the quantity.`);
            if (alias.check)
                notes.push(alias.check);
            out.lines.push({
                billText: `${alias.product} · ${code} · ${milles} M`,
                productName: resolveAlias(alias, cands),
                quantity: packs,
                note: notes.length ? notes.join(" ") : undefined,
            });
            continue;
        }
        // Best catalogue product for this line: highest coverage, then the more specific (longer) name.
        let best = null;
        let tie = false;
        for (const c of cands) {
            const s = score(c.tokens, lt);
            const enough = s.coverage >= 0.75 && (c.tokens.length === 1 || s.matched >= 2);
            if (!enough)
                continue;
            if (!best || s.coverage > best.coverage || (s.coverage === best.coverage && c.tokens.length > best.c.tokens.length)) {
                best = { c, ...s };
                tie = false;
            }
            else if (s.coverage === best.coverage && c.tokens.length === best.c.tokens.length) {
                tie = true;
            }
        }
        const productNums = best ? best.c.tokens.filter((t) => /^\d+$/.test(t)) : [];
        const nums = numbersIn(line, productNums);
        if (best && !tie) {
            const q = pickQuantity(nums);
            if (!q) {
                out.warnings.push(`"${line}" looks like ${best.c.name} but no quantity could be read — add it by hand.`);
                continue;
            }
            out.lines.push({
                billText: line.slice(0, 80),
                productName: best.c.name,
                quantity: q.qty,
                note: q.guessed ? "Quantity is a best guess from the line — check it against the bill." : undefined,
            });
            continue;
        }
        // Not a catalogue product: only surface lines that look like a bill item (a name, a price, a quantity).
        const letters = (line.match(/[A-Za-z]{3,}/g) || []).length;
        const hasPrice = /\d[\d,]*\.\d{2}(?!\d)/.test(line);
        if (SKIP_LINE.test(line) || letters < 1 || !hasPrice)
            continue;
        const q = pickQuantity(nums);
        if (!q)
            continue;
        out.lines.push({
            billText: line.slice(0, 80),
            productName: null,
            quantity: q.qty,
            note: tie ? "Matches more than one product — pick the right one." : q.guessed ? "Quantity is a best guess from the line — check it against the bill." : undefined,
        });
    }
    if (out.lines.length === 0) {
        out.warnings.push("No product lines were found. Try a clearer, straight-on photo or the PDF, or use the CSV import.");
    }
    return out;
}
