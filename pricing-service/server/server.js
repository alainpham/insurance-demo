const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const cors = require("cors");
const liveReload = require("./livereload");

const log = require("./log");
const db = require("./db");
const { price, reference } = require("./pricing");
const metrics = require("./metrics");

const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");

app.use(cors());
app.use(bodyParser.json());

liveReload.attach(app, PUBLIC_DIR); // dev only, no-op unless LIVERELOAD=1
app.use(express.static(PUBLIC_DIR));

app.get("/ping", (req, res) => res.status(200).json({ message: "pong" }));
app.get("/health", (req, res) => res.status(200).json({ status: "up", service: "pricing-service" }));

/* ------------------------------------------------------------------ chaos
   pricing-service is the demo's slow, occasionally-flaky dependency. Runtime
   tunable so `make chaos-on` can degrade it live without a restart.        */

const chaos = {
    latencyMs: Number(process.env.CHAOS_LATENCY_MS || 0),
    errorRate: Number(process.env.CHAOS_ERROR_RATE || 0),
};

app.get("/admin/chaos", (req, res) => res.json(chaos));
app.post("/admin/chaos", (req, res) => {
    if (req.body?.latencyMs != null) chaos.latencyMs = Math.max(0, Number(req.body.latencyMs));
    if (req.body?.errorRate != null) chaos.errorRate = Math.min(1, Math.max(0, Number(req.body.errorRate)));
    log.warn("chaos settings changed", chaos);
    res.json(chaos);
});

app.use("/price", async (req, res, next) => {
    if (chaos.latencyMs > 0) {
        // Spread it around the target so the latency histogram has a shape.
        const jitter = chaos.latencyMs * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, jitter));
    }
    if (chaos.errorRate > 0 && Math.random() < chaos.errorRate) {
        log.error("chaos: injected failure");
        log.annotate({ "chaos.injected": true });
        return res.status(503).json({ error: "pricing_unavailable", message: "injected failure (chaos mode)" });
    }
    next();
});

// Bucketed so it can be a metric/span attribute without unbounded cardinality.
const zBucket = (z) => (z === 0 ? "0" : z < 0.25 ? "0-0.25" : z < 0.5 ? "0.25-0.5" : z < 0.75 ? "0.5-0.75" : "0.75-1");

async function doPrice(req, res, { allowOverrides }) {
    const span = log.tracer.startSpan("pricing.compute");
    try {
        const body = req.body || {};

        // Rule 1 of the business model, enforced in code: the premium is priced
        // to break even, so there is no margin in it to give away.
        if (allowOverrides && Number(body.premiumDiscountPct) > 0) {
            log.warn("premium discount refused", { requested: body.premiumDiscountPct });
            span.setAttribute("pricing.premium_discount_refused", true);
            metrics.premiumDiscountRefused.add(1);
            return res.status(422).json({
                error: "premium_not_discountable",
                message:
                    "The premium is priced to break even against expected claims — there is no margin in it. " +
                    "Commercial discounts apply to the subscription only.",
            });
        }

        const result = price({ ...body, premiumDiscountPct: 0 });

        span.setAttributes({
            "pricing.z_bucket": zBucket(result.z),
            "org.size_band": result.sizeBand,
            "org.industry": result.inputs.industry,
            "coverage.level": result.coverage.code,
            "pricing.out_of_appetite": result.outOfAppetite,
        });
        log.annotate({ "org.size_band": result.sizeBand, "pricing.z_bucket": zBucket(result.z) });
        metrics.record(result);

        await db.query(
            `INSERT INTO ${db.SCHEMA}.pricing_audit (quote_ref, request, result) VALUES ($1,$2,$3)`,
            [body.quoteRef || null, JSON.stringify(body), JSON.stringify(result)]
        );

        log.info("priced", {
            industry: result.inputs.industry,
            headcount: result.inputs.headcount,
            z: result.z,
            premium: result.premiumPerMemberMonth,
            subscription: result.subscriptionPerMemberMonth,
        });
        res.json(result);
    } catch (err) {
        log.error("pricing failed", { err: err.message });
        span.recordException(err);
        res.status(500).json({ error: "pricing_failed", message: err.message });
    } finally {
        span.end();
    }
}

app.post("/price", (req, res) => doPrice(req, res, { allowOverrides: false }));
app.post("/price/simulate", (req, res) => doPrice(req, res, { allowOverrides: true }));

app.get("/peer-groups", async (req, res) => {
    const { rows } = await db.query(
        `SELECT industry, label, annual_claims_eur FROM ${db.SCHEMA}.peer_groups ORDER BY label`
    );
    res.json(rows);
});

app.get("/coverage-levels", async (req, res) => {
    const { rows } = await db.query(
        `SELECT code, label, factor, benefits FROM ${db.SCHEMA}.coverage_levels ORDER BY factor`
    );
    res.json(rows);
});

app.get("/subscription-grid", async (req, res) => {
    const { rows } = await db.query(
        `SELECT size_band, label, eur_per_member FROM ${db.SCHEMA}.subscription_grid`
    );
    res.json(rows);
});

let server;
db.init(reference)
    .then(() => {
        server = app.listen(PORT, () => log.info(`pricing-service listening on ${PORT}`));
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
