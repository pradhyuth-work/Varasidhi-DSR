// Supplier item codes (Godfrey Phillips "CIG…" brand codes) -> the product they are in this app, and how many
// sticks are in one pack. Source: PO_TALLY.xlsx "SKU MAPPING" + "M TO PACKS LOGIC". The bill quantity is in
// "M" (thousands of sticks), so packs = M × 1000 ÷ sticksPerPack.
//
// `product` is the product's name here; if it isn't in the catalogue under exactly that name the line is still
// shown (as "new product") so nothing is silently dropped. To map a new code, add one line.
export const BILL_ALIASES = {
    CIG0002051: { product: "Lights 20s", sticksPerPack: 20 },
    CIG0002001: { product: "Red 20s", sticksPerPack: 20 },
    CIG0002036: { product: "Advance 20s", sticksPerPack: 20 },
    CIG0002045: { product: "Advance 20s", sticksPerPack: 20 }, // Gold Advance 20s, ST UPG2.0 packaging
    CIG0002021: { product: "Fuse 20s", sticksPerPack: 20 },
    CIG0002077: { product: "Vista Forest 20s", sticksPerPack: 20 },
    CIG0002052: { product: "Lights 10s", sticksPerPack: 10 },
    CIG0002014: { product: "Red 10s", sticksPerPack: 10 },
    CIG0002037: { product: "Advance 10s", sticksPerPack: 10 },
    CIG0002044: { product: "Advance 10s", sticksPerPack: 10 }, // Gold Advance 10s, ST UPG2.0 packaging
    CIG0002031: { product: "Compact 10s", sticksPerPack: 10 },
    CIG0002020: { product: "Fuse 10s", sticksPerPack: 10 },
    CIG0002010: { product: "Clove 10s", sticksPerPack: 10 },
    CIG0002030: { product: "Fine touch 10s", sticksPerPack: 10 },
    CIG0002033: { product: "Filter Black 12s", sticksPerPack: 12 },
    CIG0002058: { product: "Blue Advance 20s", sticksPerPack: 20 },
    CIG0002057: { product: "Red Advance 20s", sticksPerPack: 20 },
    CIG0002027: { product: "Vista Double Fusion", sticksPerPack: 20 },
    CIG0002638: { product: "FS Crush Tropical 10s", sticksPerPack: 10 },
    CIG0005532: { product: "Stellar CB 64mm 10s", sticksPerPack: 10 },
    CIG0005513: { product: "Stellar CB 69mm 10s", sticksPerPack: 10 },
    CIG0005526: { product: "Stellar Paan Mix 20s", sticksPerPack: 20 },
    CIG0002047: { product: "FS King 10s", sticksPerPack: 10 },
    CIG0005510: { product: "Stellar Edge 10s", sticksPerPack: 10 },
    CIG0005525: { product: "Stellar Define 20s", sticksPerPack: 20 },
    CIG0005528: { product: "Stellar Shift 20s", sticksPerPack: 20 },
    CIG0005530: { product: "Stellar Shift Duos 20s", sticksPerPack: 20 },
    CIG0002101: { product: "Originals 10s", sticksPerPack: 10 },
    CIG0002096: { product: "FS Clove Crush 69mm 10s", sticksPerPack: 10, check: "Assumed to be the 69mm Clove Crush (the 64mm one is CIG0002105)." },
    CIG0002105: { product: "FS Clove Crush 64mm 10s", sticksPerPack: 10 },
    CIG0002069: { product: "FS Special 10s", sticksPerPack: 10 },
    CIG0002107: { product: "FS Special 10s", sticksPerPack: 10 },
    CIG0009371: { product: "Cavenders Gold (Red) 10s", sticksPerPack: 10 },
    CIG0003085: { product: "Cavenders Smooth (Blue) 10s", sticksPerPack: 10 },
    CIG0005501: { product: "Stellar Paan Pro 16s", sticksPerPack: 16 },
    CIG0005502: { product: "Stellar Define Pro 16s", sticksPerPack: 16 },
    CIG0005503: { product: "Stellar Shift Pro 16s", sticksPerPack: 16 },
    CIG0005534: { product: "Stellar Mode On", sticksPerPack: 10, check: "Pack size of 10 sticks is assumed for Mode On." },
    CIG0005536: { product: "Stellar Fruity Mix 10s", sticksPerPack: 10 },
};
