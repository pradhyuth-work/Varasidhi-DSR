// Reads a supplier bill (PDF or photo) with Claude and returns proposed inward
// lines. Pure reading: nothing here touches the database. The admin reviews the
// result in the existing "Import a bill" preview and posts it through the normal
// /api/inventory/purchase route.

export const BILL_MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

const TOOL = {
  name: "record_bill",
  description: "Record the supplier bill that was read.",
  input_schema: {
    type: "object",
    properties: {
      supplier_name: { type: ["string", "null"], description: "Seller / supplier name printed on the bill." },
      invoice_number: { type: ["string", "null"], description: "The bill / invoice number, as printed." },
      invoice_date: { type: ["string", "null"], description: "The bill date, as printed." },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            bill_text: { type: "string", description: "The product description exactly as printed." },
            matched_product: {
              type: ["string", "null"],
              description: "The EXACT name from the catalogue list if this line is clearly that product, otherwise null.",
            },
            quantity: { type: "number", description: "Selling units received (pieces/packs) for this line." },
            note: { type: ["string", "null"], description: "Only if a person should double-check this line." },
          },
          required: ["bill_text", "matched_product", "quantity"],
        },
      },
      warnings: { type: "array", items: { type: "string" }, description: "Problems with the bill itself: unreadable parts, cut-off pages, etc." },
    },
    required: ["lines"],
  },
};

function buildPrompt(catalogue) {
  return [
    "You are reading a supplier purchase bill for a wholesale distributor so its stock can be inwarded.",
    "Extract every PRODUCT line: what was bought and how many units. Ignore totals, taxes, discounts, freight, round-off and payment lines.",
    "",
    "Rules:",
    "- quantity is the number of selling units (pieces/packs) received. If the bill gives cases/boxes AND states the units per case, multiply and add a note saying so. If it gives only cases and the units per case are not stated, use the number as printed and add a note.",
    "- Free / scheme units on a separate line are real stock: include them as their own line and note that they are free.",
    "- matched_product: choose from the catalogue below ONLY if the bill line is clearly the same product (same brand, variant and pack size). Copy the catalogue name exactly. If you are not sure, use null. Never guess.",
    "- Do not invent lines or quantities. If something is unreadable, leave it out and say so in warnings.",
    "",
    "Product catalogue (one per line):",
    catalogue.length ? catalogue.join("\n") : "(empty)",
  ].join("\n");
}

export class BillReadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {{base64: string, mediaType: string}} file @param {string[]} catalogue */
export async function readBill(file, catalogue) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new BillReadError(503, "Bill reading isn't set up yet — add ANTHROPIC_API_KEY to the server environment.");

  const fileBlock = file.mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: file.mediaType, data: file.base64 } }
    : { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 4096,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: [fileBlock, { type: "text", text: buildPrompt(catalogue) }] }],
    }),
  });
  if (!res.ok) {
    console.error("Bill reading failed", res.status, await res.text().catch(() => ""));
    throw new BillReadError(502, "Couldn't read this bill right now. Try again, or enter the lines by hand.");
  }
  const data = await res.json();
  const input = data?.content?.find((c) => c.type === "tool_use")?.input;
  if (!input || !Array.isArray(input.lines)) {
    throw new BillReadError(502, "The bill couldn't be understood. Try a clearer photo or the PDF.");
  }

  const byName = new Map(catalogue.map((n) => [n.trim().toLowerCase(), n]));
  const warnings = Array.isArray(input.warnings) ? [...input.warnings] : [];
  const lines = [];
  for (const l of input.lines) {
    const billText = String(l?.bill_text ?? "").trim();
    const qty = Number(l?.quantity);
    if (!billText) continue;
    if (!Number.isInteger(qty) || qty <= 0) {
      warnings.push(`"${billText}": quantity "${l?.quantity}" isn't a whole number above zero — skipped, add it by hand if needed.`);
      continue;
    }
    // Only names that really exist in the catalogue count as a match.
    const matched = l.matched_product ? (byName.get(String(l.matched_product).trim().toLowerCase()) ?? null) : null;
    lines.push({ billText, productName: matched, quantity: qty, note: l.note ? String(l.note).trim() : "" });
  }
  return {
    supplierName: input.supplier_name ? String(input.supplier_name).trim() : "",
    invoiceNumber: input.invoice_number ? String(input.invoice_number).trim() : "",
    invoiceDate: input.invoice_date ? String(input.invoice_date).trim() : "",
    lines,
    warnings,
  };
}
