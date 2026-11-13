// Reads the text off a supplier bill (photo or PDF), on this device. Loaded only when someone taps
// "Upload bill", so it adds nothing to normal start-up. The bill is never uploaded: only the Tesseract
// and pdf.js libraries (and English language data) are downloaded from a public CDN, then cached by the browser.
// Browser-only — import it dynamically from client components.
const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const loading = new Map();
function loadScript(src, ready, failMsg) {
    if (ready())
        return Promise.resolve();
    let p = loading.get(src);
    if (!p) {
        p = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.async = true;
            s.onload = () => (ready() ? resolve() : (loading.delete(src), reject(new Error(failMsg))));
            s.onerror = () => {
                loading.delete(src);
                s.remove();
                reject(new Error(failMsg));
            };
            document.head.appendChild(s);
        });
        loading.set(src, p);
    }
    return p;
}
const loadTesseract = async () => {
    await loadScript(TESSERACT_SRC, () => !!window.Tesseract, "Couldn't download the scanner. Check your connection and try again.");
    return window.Tesseract;
};
const loadPdfJs = async () => {
    await loadScript(PDFJS_SRC, () => !!window.pdfjsLib, "Couldn't download the PDF reader. Check your connection and try again.");
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return lib;
};
async function toBitmap(file) {
    try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
    }
    catch {
        throw new Error("That file isn't a picture we can read. Try a clearer photo or the PDF.");
    }
}
/** Scale a photo to a size the reader handles well, turn it grey and stretch the contrast so faint print stands out. */
function enhance(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx)
        return canvas;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
        const g = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
        d[i] = g;
        hist[g]++;
    }
    const total = d.length / 4;
    let lo = 0;
    let hi = 255;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= total * 0.02) {
            lo = v;
            break;
        }
    }
    acc = 0;
    for (let v = 255; v >= 0; v--) {
        acc += hist[v];
        if (acc >= total * 0.02) {
            hi = v;
            break;
        }
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, (((d[i] - lo) * 255) / span) | 0));
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}
async function photoToCanvas(file) {
    const src = await toBitmap(file);
    const scale = Math.min(2, 2000 / Math.max(src.width, src.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx)
        throw new Error("This browser can't read images.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    src.close();
    return enhance(c);
}
function rotated(c, deg) {
    if (deg === 0)
        return c;
    const swap = deg === 90 || deg === 270;
    const o = document.createElement("canvas");
    o.width = swap ? c.height : c.width;
    o.height = swap ? c.width : c.height;
    const x = o.getContext("2d", { willReadFrequently: true });
    if (!x)
        return c;
    x.translate(o.width / 2, o.height / 2);
    x.rotate((deg * Math.PI) / 180);
    x.drawImage(c, -c.width / 2, -c.height / 2);
    return o;
}
function shrunk(c, max) {
    const k = Math.min(1, max / Math.max(c.width, c.height));
    if (k === 1)
        return c;
    const o = document.createElement("canvas");
    o.width = Math.round(c.width * k);
    o.height = Math.round(c.height * k);
    o.getContext("2d")?.drawImage(c, 0, 0, o.width, o.height);
    return o;
}
/**
 * Photos of bills are often taken sideways or upside down (and a phone doesn't always say so). Read a
 * small copy in each direction and keep the one the reader is most confident about; stop early when
 * the photo is already the right way up.
 */
async function uprightCanvas(worker, c, onProgress) {
    const small = shrunk(c, 900);
    const conf = async (deg) => (await worker.recognize(rotated(small, deg))).data.confidence ?? 0;
    onProgress?.("orienting", 0);
    const first = await conf(0);
    if (first >= 70)
        return c;
    let best = { deg: 0, conf: first };
    for (const deg of [90, 270, 180]) {
        const cf = await conf(deg);
        if (cf > best.conf)
            best = { deg, conf: cf };
    }
    return best.deg === 0 || best.conf < first + 8 ? c : rotated(c, best.deg);
}
async function ocr(canvases, onProgress) {
    const T = await loadTesseract();
    const worker = await T.createWorker("eng", 1, {
        logger: (m) => onProgress?.(m.status, m.progress || 0),
    });
    try {
        // Mode 6 reads a block of rows, which is what a bill's item table is; keeping the gaps between
        // words stops "Parle-G 800g   24   10.50" from running together.
        await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
        const parts = [];
        const confs = [];
        for (const c of canvases) {
            const upright = await uprightCanvas(worker, c, onProgress);
            const { data } = await worker.recognize(upright);
            parts.push(data.text || "");
            confs.push(data.confidence ?? 0);
        }
        return { text: parts.join("\n"), confidence: confs.reduce((a, b) => a + b, 0) / Math.max(1, confs.length) };
    }
    finally {
        try {
            await worker.terminate();
        }
        catch { /* ignore */ }
    }
}
/** Text straight out of a digital PDF (exact), grouped back into rows by position. */
async function pdfText(page) {
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
        if (!it.str.trim())
            continue;
        const x = it.transform[4];
        const y = it.transform[5];
        const row = rows.find((r) => Math.abs(r.y - y) < 3);
        if (row)
            row.parts.push({ x, s: it.str });
        else
            rows.push({ y, parts: [{ x, s: it.str }] });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join("   ")).join("\n");
}
const MAX_PDF_PAGES = 4;
/** Resolves to the text found on the bill. onProgress(status, 0..1) is called while the readers load and read. */
export async function readBillText(file, onProgress) {
    if (file.type !== "application/pdf")
        return ocr([await photoToCanvas(file)], onProgress);
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const texts = [];
    for (let n = 1; n <= pages; n++)
        texts.push(await pdfText(await doc.getPage(n)));
    const digital = texts.join("\n");
    if (digital.replace(/\s/g, "").length >= 40)
        return { text: digital, confidence: null };
    // A scanned PDF has no text inside it: draw each page and read it like a photo.
    const canvases = [];
    for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(3, 2000 / Math.max(base.width, base.height)) });
        const c = document.createElement("canvas");
        c.width = Math.round(viewport.width);
        c.height = Math.round(viewport.height);
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx)
            throw new Error("This browser can't read PDFs.");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        canvases.push(enhance(c));
    }
    return ocr(canvases, onProgress);
}
