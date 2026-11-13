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
        for (const c of canvases)
            parts.push((await worker.recognize(c)).data.text || "");
        return parts.join("\n");
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
        return digital;
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
