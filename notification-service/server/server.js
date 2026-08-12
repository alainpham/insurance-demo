const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const nodemailer = require("nodemailer");
const liveReload = require("./livereload");

const log = require("./log");
const db = require("./db");
const pdf = require("./pdf");
const templates = require("./templates");

const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");
const DOC_DIR = process.env.DOCUMENT_DIR || path.join(__dirname, "../documents");
const DOC_BASE_URL = process.env.DOCUMENT_BASE_URL || "http://localhost:3004/documents";
const FROM = process.env.MAIL_FROM || "Assurance <advisor@assurance.demo>";

fs.mkdirSync(DOC_DIR, { recursive: true });

const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
    ignoreTLS: true,
});

app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

liveReload.attach(app, PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));
// redirect:false so a bare GET /documents falls through to the listing route
// below instead of being 301'd to /documents/ by the directory handler.
app.use("/documents", express.static(DOC_DIR, { redirect: false }));

app.get("/ping", (req, res) => res.status(200).json({ message: "pong" }));
app.get("/health", (req, res) => res.status(200).json({ status: "up", service: "notification-service" }));

/* ---------------------------------------------------------------- documents */

app.post("/documents/quote", async (req, res) => {
    const { quote } = req.body || {};
    if (!quote?.id || !quote?.pricing) {
        return res.status(400).json({ error: "missing_fields", fields: ["quote.id", "quote.pricing"] });
    }
    const span = log.tracer.startSpan("pdf.render");
    try {
        const version = quote.version || 1;

        // Idempotent on (quote, version): re-sending must not re-render.
        const existing = await db.query(
            `SELECT filename FROM ${db.SCHEMA}.documents WHERE quote_id = $1 AND version = $2`,
            [quote.id, version]
        );
        if (existing.rows.length && fs.existsSync(path.join(DOC_DIR, existing.rows[0].filename))) {
            const filename = existing.rows[0].filename;
            log.info("document already rendered", { reference: quote.reference, version });
            return res.json({ filename, url: `${DOC_BASE_URL}/${filename}`, cached: true });
        }

        const out = await pdf.render(quote, DOC_DIR);
        await db.query(
            `INSERT INTO ${db.SCHEMA}.documents (quote_id, quote_reference, version, filename, bytes)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (quote_id, version) DO UPDATE SET filename = EXCLUDED.filename, bytes = EXCLUDED.bytes`,
            [quote.id, quote.reference, version, out.filename, out.bytes]
        );
        span.setAttributes({ "pdf.bytes": out.bytes, "quote.version": version });
        log.info("document rendered", { reference: quote.reference, version, bytes: out.bytes });
        res.json({ filename: out.filename, url: `${DOC_BASE_URL}/${out.filename}`, bytes: out.bytes });
    } catch (err) {
        log.error("document render failed", { err: err.message });
        span.recordException(err);
        res.status(500).json({ error: "render_failed", message: err.message });
    } finally {
        span.end();
    }
});

app.get("/documents", async (req, res) => {
    const { rows } = await db.query(
        `SELECT quote_reference, version, filename, bytes, created_at
           FROM ${db.SCHEMA}.documents ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows.map((r) => ({ ...r, url: `${DOC_BASE_URL}/${r.filename}` })));
});

/* ------------------------------------------------------------------- email */

app.post("/emails", async (req, res) => {
    const d = req.body || {};
    if (!d.kind || !d.to) return res.status(400).json({ error: "missing_fields", fields: ["kind", "to"] });

    let built;
    try {
        built = templates.build(d.kind, d);
    } catch (err) {
        return res.status(400).json({ error: "unknown_template", message: err.message, known: templates.KINDS });
    }

    // Idempotency: the same message for the same quote is sent once.
    const key = d.idempotencyKey
        || crypto.createHash("sha256").update(`${d.kind}|${d.to}|${d.reference || ""}`).digest("hex");

    const claim = await db.query(
        `INSERT INTO ${db.SCHEMA}.messages (kind, recipient, subject, reference, idempotency_key, status)
         VALUES ($1,$2,$3,$4,$5,'pending')
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [d.kind, d.to, built.subject, d.reference || null, key]
    );
    if (!claim.rows.length) {
        log.info("email suppressed as duplicate", { kind: d.kind, to: d.to, reference: d.reference });
        return res.json({ status: "duplicate", subject: built.subject });
    }
    const id = claim.rows[0].id;

    try {
        await mailer.sendMail({ from: FROM, to: d.to, subject: built.subject, html: built.html });
        await db.query(`UPDATE ${db.SCHEMA}.messages SET status='sent' WHERE id=$1`, [id]);
        log.info("email sent", { kind: d.kind, to: d.to, reference: d.reference });
        res.json({ status: "sent", subject: built.subject });
    } catch (err) {
        await db.query(`UPDATE ${db.SCHEMA}.messages SET status='failed', error=$2 WHERE id=$1`, [id, err.message]);
        log.error("email failed", { kind: d.kind, to: d.to, err: err.message });
        res.status(502).json({ error: "send_failed", message: err.message });
    }
});

app.get("/emails", async (req, res) => {
    const { rows } = await db.query(
        `SELECT kind, recipient, subject, reference, status, error, created_at
           FROM ${db.SCHEMA}.messages ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
});

let server;
db.init()
    .then(() => {
        server = app.listen(PORT, () =>
            log.info(`notification-service listening on ${PORT}`, { docDir: DOC_DIR }));
    })
    .catch((err) => {
        log.error("startup failed", { err: err.message });
        process.exit(1);
    });

function shutdown(signal) {
    log.info(`${signal} received`);
    liveReload.closeStreams();
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
