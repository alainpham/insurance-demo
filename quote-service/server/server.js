const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const axios = require("axios");
const liveReload = require("./livereload");

const log = require("./log");
const db = require("./db");
const states = require("./states");

const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");
const WORKFLOW_URL = process.env.WORKFLOW_URL || "http://localhost:3003";
const QUOTE_VALIDITY_DAYS = 60;

app.use(cors());
app.use(bodyParser.json());

liveReload.attach(app, PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));

let metrics; // required after db.init so the gauges can query

const ref = (prefix) =>
    `${prefix}-${new Date().getFullYear()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

app.get("/ping", (req, res) => res.status(200).json({ message: "pong" }));
app.get("/health", (req, res) => res.status(200).json({ status: "up", service: "quote-service" }));

// Runtime config for the browser, so the Faro collector URL isn't baked in.
app.get("/config.js", (req, res) => {
    res.type("application/javascript").send(
        `window.FARO_URL = ${JSON.stringify(process.env.FARO_URL || "http://localhost:12347/collect")};\n`
    );
});

/* --------------------------------------------------- reference data (proxy)
   The browser stays same-origin; quote-service fronts pricing-service so the
   public page never talks to an internal service directly.                  */

const PRICING_URL = process.env.PRICING_URL || "http://localhost:3002";

app.get("/api/industries", async (req, res) => {
    try {
        const r = await axios.get(`${PRICING_URL}/peer-groups`, { timeout: 5000 });
        res.json(r.data.map(({ industry, label }) => ({ industry, label })));
    } catch (err) {
        log.warn("industries lookup failed", { err: err.message });
        res.status(503).json({ error: "reference_unavailable" });
    }
});

app.get("/api/coverage-levels", async (req, res) => {
    try {
        const r = await axios.get(`${PRICING_URL}/coverage-levels`, { timeout: 5000 });
        res.json(r.data.map(({ code, label, factor }) => ({ code, label, factor })));
    } catch (err) {
        log.warn("coverage lookup failed", { err: err.message });
        res.status(503).json({ error: "reference_unavailable" });
    }
});

/* ------------------------------------------------------------------ public */

app.post("/api/quote-requests", async (req, res) => {
    const b = req.body || {};
    const missing = ["companyName", "industry", "headcount", "coverageLevel", "contactName", "contactEmail"]
        .filter((f) => !b[f]);
    if (missing.length) {
        return res.status(400).json({ error: "missing_fields", fields: missing });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.contactEmail)) {
        return res.status(400).json({ error: "invalid_email" });
    }
    const headcount = parseInt(b.headcount, 10);
    if (!Number.isFinite(headcount) || headcount < 1 || headcount > 100000) {
        return res.status(400).json({ error: "invalid_headcount" });
    }

    const client = await db.pool.connect();
    try {
        await client.query("BEGIN");
        const org = await client.query(
            `INSERT INTO ${db.SCHEMA}.organizations
                 (name, industry, headcount, year_founded, client_years, own_claims_per_member)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [b.companyName, b.industry, headcount, b.yearFounded || null,
             b.clientYears || 0, b.ownClaimsPerMember || null]
        );
        const reference = ref("REQ");
        const request = await client.query(
            `INSERT INTO ${db.SCHEMA}.quote_requests
                 (reference, organization_id, contact_name, contact_email, contact_phone,
                  age_mix, composition_mix, coverage_level, current_insurer, effective_date, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [reference, org.rows[0].id, b.contactName, b.contactEmail, b.contactPhone || null,
             JSON.stringify(b.ageMix || {}), JSON.stringify(b.compositionMix || {}),
             b.coverageLevel, b.currentInsurer || null, b.effectiveDate || null, b.notes || null]
        );
        await client.query("COMMIT");

        log.annotate({ "org.industry": b.industry, "org.size_band": bandOf(headcount) });
        log.info("quote request received", { reference, company: b.companyName, headcount });
        metrics?.requestsTotal.add(1, { industry: b.industry, size_band: bandOf(headcount) });

        // Hand off to the business process. Deliberately fire-and-forget with a
        // logged failure: a broker would make this durable (see ARCHITECTURE §10).
        axios
            .post(`${WORKFLOW_URL}/workflows`, { quoteRequestId: request.rows[0].id }, { timeout: 10000 })
            .catch((err) => log.error("workflow start failed", { reference, err: err.message }));

        res.status(202).json({
            reference,
            quoteRequestId: request.rows[0].id,
            message: "Request received. An advisor will call you within 24 hours.",
        });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        log.error("quote request failed", { err: err.message });
        res.status(500).json({ error: "request_failed", message: err.message });
    } finally {
        client.release();
    }
});

const bandOf = (n) => (n < 10 ? "micro" : n < 50 ? "small" : n < 250 ? "medium" : "large");

// Coarse status only — never leaks pricing or internal state.
app.get("/api/quote-requests/:reference", async (req, res) => {
    const { rows } = await db.query(
        `SELECT r.reference, r.created_at, q.state, q.reference AS quote_reference, q.id AS quote_id
           FROM ${db.SCHEMA}.quote_requests r
           LEFT JOIN ${db.SCHEMA}.quotes q ON q.quote_request_id = r.id
          WHERE r.reference = $1`,
        [req.params.reference]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const row = rows[0];
    res.json({
        reference: row.reference,
        submittedAt: row.created_at,
        status: row.state ? states.publicStatus(row.state) : "received",
    });
});

// The prospect's magic-link view.
app.get("/api/quotes/:id", async (req, res) => {
    const q = await loadQuote(req.params.id);
    if (!q) return res.status(404).json({ error: "not_found" });
    if (req.query.token !== q.access_token) return res.status(403).json({ error: "invalid_token" });
    if (!["SENT", "ACCEPTED", "REFUSED", "EXPIRED"].includes(q.state)) {
        return res.status(404).json({ error: "not_available_yet" });
    }
    res.json(publicQuote(q));
});

app.post("/api/quotes/:id/accept", (req, res) => prospectDecision(req, res, "ACCEPTED"));
app.post("/api/quotes/:id/decline", (req, res) => prospectDecision(req, res, "REFUSED"));

async function prospectDecision(req, res, to) {
    const q = await loadQuote(req.params.id);
    if (!q) return res.status(404).json({ error: "not_found" });
    if (req.query.token !== q.access_token) return res.status(403).json({ error: "invalid_token" });
    try {
        const updated = await transition(q, to, "prospect", null);
        res.json(publicQuote(updated));
    } catch (err) {
        if (err.code === "ILLEGAL_TRANSITION") {
            return res.status(409).json({ error: "illegal_transition", message: err.message });
        }
        throw err;
    }
}

/* ---------------------------------------------------------------- internal */

app.get("/internal/quote-requests/:id", async (req, res) => {
    const { rows } = await db.query(
        `SELECT r.*, o.name AS company_name, o.industry, o.headcount, o.year_founded,
                o.client_years, o.own_claims_per_member
           FROM ${db.SCHEMA}.quote_requests r
           JOIN ${db.SCHEMA}.organizations o ON o.id = r.organization_id
          WHERE r.id = $1`,
        [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
});

app.post("/internal/quotes", async (req, res) => {
    const { quoteRequestId, pricing, state = "PRICED" } = req.body || {};
    if (!quoteRequestId || !pricing) {
        return res.status(400).json({ error: "missing_fields", fields: ["quoteRequestId", "pricing"] });
    }
    const request = await db.query(
        `SELECT * FROM ${db.SCHEMA}.quote_requests WHERE id = $1`, [quoteRequestId]
    );
    if (!request.rows.length) return res.status(404).json({ error: "quote_request_not_found" });

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + QUOTE_VALIDITY_DAYS);

    const client = await db.pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(
            `INSERT INTO ${db.SCHEMA}.quotes
                 (reference, quote_request_id, organization_id, state, version, pricing, access_token, valid_until)
             VALUES ($1,$2,$3,$4,1,$5,$6,$7) RETURNING *`,
            [ref("Q"), quoteRequestId, request.rows[0].organization_id, state,
             JSON.stringify(pricing), crypto.randomBytes(16).toString("hex"), validUntil]
        );
        const quote = rows[0];
        await client.query(
            `INSERT INTO ${db.SCHEMA}.quote_versions (quote_id, version, pricing, created_by)
             VALUES ($1,1,$2,'system')`,
            [quote.id, JSON.stringify(pricing)]
        );
        await client.query(
            `INSERT INTO ${db.SCHEMA}.state_transitions (quote_id, from_state, to_state, actor, note)
             VALUES ($1,'NEW',$2,'system','initial pricing')`,
            [quote.id, state]
        );
        await client.query("COMMIT");

        metrics?.transitionsTotal.add(1, { to_state: state });
        metrics?.premiumEur.record(Number(pricing.premiumPerMemberMonth) || 0, {
            size_band: pricing.sizeBand, industry: pricing.peerGroup?.industry,
        });
        log.info("quote created", { reference: quote.reference, state });
        res.status(201).json(quote);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        log.error("quote creation failed", { err: err.message });
        res.status(500).json({ error: "create_failed", message: err.message });
    } finally {
        client.release();
    }
});

app.get("/internal/quotes", async (req, res) => {
    const clauses = [];
    const params = [];
    if (req.query.state) {
        params.push(req.query.state.split(","));
        clauses.push(`q.state = ANY($${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await db.query(
        `SELECT q.*, o.name AS company_name, o.industry, o.headcount,
                r.contact_name, r.contact_email, r.contact_phone, r.reference AS request_reference
           FROM ${db.SCHEMA}.quotes q
           JOIN ${db.SCHEMA}.organizations o ON o.id = q.organization_id
           JOIN ${db.SCHEMA}.quote_requests r ON r.id = q.quote_request_id
           ${where}
          ORDER BY q.created_at DESC LIMIT 200`,
        params
    );
    res.json(rows);
});

app.get("/internal/quotes/:id", async (req, res) => {
    const q = await loadQuote(req.params.id);
    if (!q) return res.status(404).json({ error: "not_found" });
    const transitions = await db.query(
        `SELECT from_state, to_state, actor, note, created_at
           FROM ${db.SCHEMA}.state_transitions WHERE quote_id = $1 ORDER BY id`,
        [q.id]
    );
    const versions = await db.query(
        `SELECT version, created_by, created_at FROM ${db.SCHEMA}.quote_versions
          WHERE quote_id = $1 ORDER BY version`,
        [q.id]
    );
    res.json({ ...q, transitions: transitions.rows, versions: versions.rows });
});

app.patch("/internal/quotes/:id/state", async (req, res) => {
    const { to, actor = "system", note = null } = req.body || {};
    const q = await loadQuote(req.params.id);
    if (!q) return res.status(404).json({ error: "not_found" });
    try {
        const updated = await transition(q, to, actor, note);
        res.json(updated);
    } catch (err) {
        if (err.code === "ILLEGAL_TRANSITION") {
            return res.status(409).json({ error: "illegal_transition", message: err.message });
        }
        log.error("transition failed", { err: err.message });
        res.status(500).json({ error: "transition_failed", message: err.message });
    }
});

// An employee adjustment creates v2 and leaves v1 immutable.
app.post("/internal/quotes/:id/versions", async (req, res) => {
    const { pricing, createdBy = "system" } = req.body || {};
    if (!pricing) return res.status(400).json({ error: "missing_fields", fields: ["pricing"] });
    const q = await loadQuote(req.params.id);
    if (!q) return res.status(404).json({ error: "not_found" });

    const client = await db.pool.connect();
    try {
        await client.query("BEGIN");
        const version = q.version + 1;
        await client.query(
            `INSERT INTO ${db.SCHEMA}.quote_versions (quote_id, version, pricing, created_by)
             VALUES ($1,$2,$3,$4)`,
            [q.id, version, JSON.stringify(pricing), createdBy]
        );
        const { rows } = await client.query(
            `UPDATE ${db.SCHEMA}.quotes SET version = $2, pricing = $3, updated_at = now()
              WHERE id = $1 RETURNING *`,
            [q.id, version, JSON.stringify(pricing)]
        );
        await client.query("COMMIT");
        log.info("quote version created", { reference: q.reference, version, by: createdBy });
        res.json(rows[0]);
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        res.status(500).json({ error: "version_failed", message: err.message });
    } finally {
        client.release();
    }
});

app.patch("/internal/quotes/:id/document", async (req, res) => {
    const { documentUrl } = req.body || {};
    const { rows } = await db.query(
        `UPDATE ${db.SCHEMA}.quotes SET document_url = $2, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [req.params.id, documentUrl]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
});

// Quotes whose validity has run out — the workflow tick calls this.
app.get("/internal/quotes/expired/pending", async (req, res) => {
    const { rows } = await db.query(
        `SELECT id, reference FROM ${db.SCHEMA}.quotes
          WHERE state = 'SENT' AND valid_until < current_date`
    );
    res.json(rows);
});

app.get("/internal/stats", async (req, res) => {
    const byState = await db.query(
        `SELECT state, count(*)::int AS count FROM ${db.SCHEMA}.quotes GROUP BY state ORDER BY state`
    );
    const portfolio = await db.query(
        `SELECT count(*)::int AS accepted,
                coalesce(sum(o.headcount),0)::int AS members,
                coalesce(sum((q.pricing->>'subscriptionPerMemberMonth')::numeric * o.headcount),0)::numeric AS subscription_revenue,
                coalesce(sum((q.pricing->>'premiumPerMemberMonth')::numeric * o.headcount),0)::numeric AS premium_volume
           FROM ${db.SCHEMA}.quotes q
           JOIN ${db.SCHEMA}.organizations o ON o.id = q.organization_id
          WHERE q.state = 'ACCEPTED'`
    );
    res.json({ byState: byState.rows, portfolio: portfolio.rows[0] });
});

/* ----------------------------------------------------------------- helpers */

async function loadQuote(idOrRef) {
    const byId = /^\d+$/.test(String(idOrRef));
    const { rows } = await db.query(
        `SELECT q.*, o.name AS company_name, o.industry, o.headcount, o.client_years,
                r.contact_name, r.contact_email, r.contact_phone, r.coverage_level,
                r.reference AS request_reference
           FROM ${db.SCHEMA}.quotes q
           JOIN ${db.SCHEMA}.organizations o ON o.id = q.organization_id
           JOIN ${db.SCHEMA}.quote_requests r ON r.id = q.quote_request_id
          WHERE ${byId ? "q.id = $1" : "q.reference = $1"}`,
        [idOrRef]
    );
    return rows[0] || null;
}

async function transition(quote, to, actor, note) {
    if (!states.canTransition(quote.state, to)) {
        const err = new Error(
            `Cannot move quote ${quote.reference} from ${quote.state} to ${to}. ` +
            `Allowed: ${(states.TRANSITIONS[quote.state] || []).join(", ") || "none (terminal)"}.`
        );
        err.code = "ILLEGAL_TRANSITION";
        log.warn("illegal transition refused", { reference: quote.reference, from: quote.state, to });
        log.annotate({ "quote.illegal_transition": true });
        throw err;
    }
    const client = await db.pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(
            `UPDATE ${db.SCHEMA}.quotes SET state = $2, updated_at = now() WHERE id = $1 RETURNING *`,
            [quote.id, to]
        );
        await client.query(
            `INSERT INTO ${db.SCHEMA}.state_transitions (quote_id, from_state, to_state, actor, note)
             VALUES ($1,$2,$3,$4,$5)`,
            [quote.id, quote.state, to, actor, note]
        );
        await client.query("COMMIT");
        metrics?.transitionsTotal.add(1, { to_state: to });
        log.annotate({ "quote.state": to });
        log.info("quote transitioned", { reference: quote.reference, from: quote.state, to, actor });
        return rows[0];
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

function publicQuote(q) {
    const p = q.pricing;
    return {
        id: q.id,
        reference: q.reference,
        state: q.state,
        companyName: q.company_name,
        headcount: q.headcount,
        validUntil: q.valid_until,
        documentUrl: q.document_url,
        coverage: p.coverage,
        premiumPerMemberMonth: p.premiumPerMemberMonth,
        subscriptionPerMemberMonth: p.subscriptionPerMemberMonth,
        totalPerMemberMonth: p.totalPerMemberMonth,
        monthlyTotal: p.monthlyTotal,
        annualTotal: p.annualTotal,
        rateTable: p.rateTable,
        rationale: p.rationale,
        z: p.z,
    };
}

let server;
db.init()
    .then(() => {
        metrics = require("./metrics");
        server = app.listen(PORT, () => log.info(`quote-service listening on ${PORT}`));
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
