// Quote PDF, rendered with pdfkit — pure JS, no headless browser, so the image
// stays small and the render stays fast enough to do live on stage.
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// pdfkit's built-in Helvetica silently DROPS the euro sign and en/em dashes.
// node:22 ships DejaVu, so embed it when it's there and degrade to ASCII when
// it isn't (running `npm start` on a machine without it).
const FONT_FILES = {
    regular: process.env.PDF_FONT_REGULAR || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    bold: process.env.PDF_FONT_BOLD || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
};
const UNICODE_FONT = fs.existsSync(FONT_FILES.regular) && fs.existsSync(FONT_FILES.bold);
const REG = UNICODE_FONT ? "body" : "Helvetica";
const BOLD = UNICODE_FONT ? "body-bold" : "Helvetica-Bold";

const safe = (v) =>
    UNICODE_FONT
        ? v
        : String(v)
            .replace(/\u20ac\s?/g, "EUR ")
            .replace(/[\u2013\u2014]/g, "-")
            .replace(/\u2026/g, "...")
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201c\u201d]/g, '"');

const INK = "#16241f";
const SOFT = "#5b6b64";
const ACCENT = "#0f766e";
const ACCENT_SOFT = "#ccfbf1";
const LINE = "#e2e8e5";

const eur = (n) =>
    new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(Number(n) || 0);

function render(quote, outputDir) {
    return new Promise((resolve, reject) => {
        const p = quote.pricing || {};
        const filename = `quote-${quote.reference}-v${quote.version || 1}.pdf`;
        const filepath = path.join(outputDir, filename);

        const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Quote ${quote.reference}` } });
        if (UNICODE_FONT) {
            doc.registerFont("body", FONT_FILES.regular);
            doc.registerFont("body-bold", FONT_FILES.bold);
        }
        // One place to sanitise, rather than wrapping every call site below.
        const rawText = doc.text.bind(doc);
        doc.text = (txt, ...rest) => rawText(safe(txt), ...rest);

        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);

        const W = doc.page.width - 100; // usable width
        let y = 50;

        // ---- header ----
        doc.rect(0, 0, doc.page.width, 90).fill(ACCENT);
        doc.fillColor("#ffffff").fontSize(22).font(BOLD).text("Assurance", 50, 32);
        doc.fontSize(10).font(REG).text("Health cover for your team, priced to break even.", 50, 60);
        doc.fillColor("#ffffff").fontSize(9)
            .text(`Quote ${quote.reference}`, 50, 32, { width: W, align: "right" })
            .text(`Valid until ${new Date(quote.valid_until).toLocaleDateString("en-GB")}`, 50, 46, { width: W, align: "right" });
        y = 120;

        // ---- client ----
        doc.fillColor(INK).fontSize(18).font(BOLD).text(quote.company_name || "", 50, y);
        y = doc.y + 4;
        doc.fillColor(SOFT).fontSize(10).font(REG)
            .text(`${quote.headcount} members · ${p.coverage?.label || ""} cover · prepared for ${quote.contact_name || ""}`, 50, y);
        y = doc.y + 20;

        // ---- the two lines: this is the whole point of the document ----
        y = priceRow(doc, y, W, "Insurance premium",
            "Covers your team's expected claims. Priced to break even — no margin.",
            eur(p.premiumPerMemberMonth), "#f8fafc", INK);
        y = priceRow(doc, y, W, "Assurance subscription",
            "Our fee, per member per month. This is how we make our money.",
            eur(p.subscriptionPerMemberMonth), ACCENT_SOFT, INK);
        y = priceRow(doc, y, W, "Total per member, per month",
            `${eur(p.monthlyTotal)} per month for ${quote.headcount} members · ${eur(p.annualTotal)} per year`,
            eur(p.totalPerMemberMonth), INK, "#ffffff");
        y += 10;

        // ---- pooling ----
        doc.fillColor(INK).fontSize(12).font(BOLD).text("How your premium was set", 50, y);
        y = doc.y + 8;
        const own = Math.round((p.z || 0) * 100);
        doc.rect(50, y, W, 10).fill(ACCENT_SOFT);
        if (own > 0) doc.rect(50, y, (W * own) / 100, 10).fill(ACCENT);
        y += 16;
        doc.fillColor(SOFT).fontSize(9).font(REG)
            .text(`${own}% your own claims experience · ${100 - own}% pooled with comparable organisations`, 50, y);
        y = doc.y + 8;
        for (const line of p.rationale || []) {
            doc.fillColor(SOFT).fontSize(9).text("· " + line, 55, y, { width: W - 10 });
            y = doc.y + 3;
        }
        y += 14;

        // ---- rate table ----
        y = tableHeader(doc, y, W, ["Household", "Share of your team", "Premium / month"]);
        for (const r of p.rateTable || []) {
            y = tableRow(doc, y, W, [r.label, `${r.share}%`, eur(r.premiumPerMonth)]);
        }
        y += 18;

        if (y > 640) { doc.addPage(); y = 60; }

        // ---- benefits ----
        doc.fillColor(INK).fontSize(12).font(BOLD)
            .text(`What's covered — ${p.coverage?.label || ""}`, 50, y);
        y = doc.y + 10;
        for (const b of p.coverage?.benefits || []) {
            if (y > 740) { doc.addPage(); y = 60; }
            doc.fillColor(INK).fontSize(9).font(BOLD).text(b.label, 50, y, { width: 150 });
            doc.fillColor(SOFT).font(REG).text(b.value, 205, y, { width: W - 155 });
            y = Math.max(doc.y, y + 12) + 4;
        }

        // ---- footer ----
        const bottom = doc.page.height - 70;
        doc.moveTo(50, bottom).lineTo(50 + W, bottom).strokeColor(LINE).lineWidth(1).stroke();
        doc.fillColor(SOFT).fontSize(8).font(REG).text(
            "Assurance is a demo application. This document is not a contract and no real insurance is offered. " +
            "Prices are indicative and valid for 60 days from the date of issue.",
            50, bottom + 10, { width: W, align: "center" }
        );

        doc.end();
        stream.on("finish", () => {
            const { size } = fs.statSync(filepath);
            resolve({ filename, filepath, bytes: size });
        });
        stream.on("error", reject);
    });
}

function priceRow(doc, y, W, label, sub, amount, bg, fg) {
    const h = 52;
    doc.rect(50, y, W, h).fill(bg);
    doc.fillColor(fg).fontSize(11).font(BOLD).text(label, 62, y + 11, { width: W - 150 });
    doc.fillColor(fg === "#ffffff" ? "#b8c6c0" : SOFT).fontSize(8).font(REG)
        .text(sub, 62, y + 27, { width: W - 150 });
    doc.fillColor(fg).fontSize(16).font(BOLD)
        .text(amount, 50, y + 16, { width: W - 12, align: "right" });
    return y + h + 8;
}

function tableHeader(doc, y, W, cols) {
    doc.fillColor(SOFT).fontSize(8).font(BOLD);
    doc.text(cols[0], 50, y, { width: W / 2 });
    doc.text(cols[1], 50 + W / 2, y, { width: W / 4, align: "right" });
    doc.text(cols[2], 50 + (W * 3) / 4, y, { width: W / 4, align: "right" });
    y = doc.y + 4;
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(LINE).lineWidth(1).stroke();
    return y + 6;
}

function tableRow(doc, y, W, cols) {
    doc.fillColor(INK).fontSize(9.5).font(REG);
    doc.text(cols[0], 50, y, { width: W / 2 });
    doc.text(cols[1], 50 + W / 2, y, { width: W / 4, align: "right" });
    doc.text(cols[2], 50 + (W * 3) / 4, y, { width: W / 4, align: "right" });
    y = doc.y + 4;
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(LINE).lineWidth(0.5).stroke();
    return y + 6;
}

module.exports = { render };
