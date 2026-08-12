const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const liveReload = require("./livereload");

const log = require("./log");
const db = require("./db");
const auth = require("./auth");

const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");

const QUOTE_URL = process.env.QUOTE_URL || "http://localhost:3001";
const WORKFLOW_URL = process.env.WORKFLOW_URL || "http://localhost:3003";
const PRICING_URL = process.env.PRICING_URL || "http://localhost:3002";

app.use(cors({ credentials: true }));
app.use(bodyParser.json());

liveReload.attach(app, PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));

app.get("/ping", (req, res) => res.status(200).json({ message: "pong" }));
app.get("/health", (req, res) => res.status(200).json({ status: "up", service: "backoffice-service" }));

/* -------------------------------------------------------------------- auth */

app.post("/api/login", async (req, res) => {
    const { email, password } = req.body || {};
    const result = await auth.login(email, password);
    if (!result) return res.status(401).json({ error: "invalid_credentials" });
    res.cookie
        ? res.cookie(auth.COOKIE, result.token, { httpOnly: true, sameSite: "lax", maxAge: 12 * 3600 * 1000 })
        : res.setHeader("Set-Cookie", `${auth.COOKIE}=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
    res.json({ user: result.user, maxDiscountPct: auth.maxDiscount(result.user.role) });
});

app.post("/api/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${auth.COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
});

app.get("/api/me", auth.required, (req, res) => {
    res.json({
        user: { email: req.user.email, name: req.user.name, role: req.user.role },
        maxDiscountPct: auth.maxDiscount(req.user.role),
    });
});

app.get("/api/demo-users", async (req, res) => {
    res.json(db.SEED_USERS.map((u) => ({ email: u.email, name: u.name, role: u.role })));
});

/* ------------------------------------------------------------------- tasks */

// One call per screen: the browser never talks to an internal service directly.
app.get("/api/tasks", auth.required, async (req, res) => {
    try {
        const role = req.query.role || req.user.role;
        const tasks = (await axios.get(`${WORKFLOW_URL}/tasks`, {
            params: { role, status: req.query.status || "open" }, timeout: 8000,
        })).data;

        const quotes = (await axios.get(`${QUOTE_URL}/internal/quotes`, { timeout: 8000 })).data;
        const byId = Object.fromEntries(quotes.map((q) => [String(q.id), q]));

        res.json(tasks.map((t) => {
            const q = byId[String(t.quote_id)] || {};
            return {
                ...t,
                company: q.company_name,
                industry: q.industry,
                headcount: q.headcount,
                quoteState: q.state,
                premium: q.pricing?.premiumPerMemberMonth,
                subscription: q.pricing?.subscriptionPerMemberMonth,
                monthlyTotal: q.pricing?.monthlyTotal,
                z: q.pricing?.z,
            };
        }));
    } catch (err) {
        log.error("task list failed", { err: err.message });
        res.status(502).json({ error: "upstream_unavailable", message: err.message });
    }
});

app.post("/api/tasks/:id/complete", auth.required, async (req, res) => {
    try {
        const r = await axios.post(`${WORKFLOW_URL}/tasks/${req.params.id}/complete`, {
            outcome: req.body?.outcome, note: req.body?.note, actor: req.user.email,
        }, { timeout: 40000 });
        log.info("task completed by employee", {
            taskId: req.params.id, actor: req.user.email, outcome: req.body?.outcome,
        });
        res.json(r.data);
    } catch (err) {
        res.status(err.response?.status || 502).json(
            err.response?.data || { error: "task_failed", message: err.message }
        );
    }
});

/* ------------------------------------------------------------------- cases */

app.get("/api/cases/:quoteId", auth.required, async (req, res) => {
    try {
        const quote = (await axios.get(`${QUOTE_URL}/internal/quotes/${req.params.quoteId}`, { timeout: 8000 })).data;
        let workflow = null;
        try {
            workflow = (await axios.get(`${WORKFLOW_URL}/workflows`, {
                params: { quoteId: req.params.quoteId }, timeout: 8000,
            })).data;
        } catch (_) { /* a quote can exist without a live workflow */ }
        res.json({ quote, workflow, maxDiscountPct: auth.maxDiscount(req.user.role) });
    } catch (err) {
        res.status(err.response?.status || 502).json(
            err.response?.data || { error: "case_failed", message: err.message }
        );
    }
});

// Live re-pricing for the workbench. Also where authority limits bite.
app.post("/api/cases/:quoteId/simulate", auth.required, async (req, res) => {
    const { coverageLevel, subscriptionDiscountPct = 0, premiumDiscountPct = 0, persist = false } = req.body || {};

    const limit = auth.maxDiscount(req.user.role);
    if (Number(subscriptionDiscountPct) > limit) {
        log.warn("discount above authority", {
            actor: req.user.email, role: req.user.role, requested: subscriptionDiscountPct, limit,
        });
        return res.status(403).json({
            error: "above_authority",
            message: `A ${subscriptionDiscountPct}% discount is above your authority as ${req.user.role} (max ${limit}%). ` +
                     `Escalate to a supervisor.`,
            limit, escalateTo: "supervisor",
        });
    }

    try {
        const workflow = (await axios.get(`${WORKFLOW_URL}/workflows`, {
            params: { quoteId: req.params.quoteId }, timeout: 8000,
        })).data;

        const r = await axios.post(`${WORKFLOW_URL}/workflows/${workflow.id}/reprice`, {
            coverageLevel, subscriptionDiscountPct, premiumDiscountPct,
            persist, actor: req.user.email,
        }, { timeout: 20000 });
        res.json(r.data);
    } catch (err) {
        // A 422 here is the business model refusing a premium discount. Pass it
        // through untouched — it is the most interesting response in the demo.
        res.status(err.response?.status || 502).json(
            err.response?.data || { error: "simulate_failed", message: err.message }
        );
    }
});

app.post("/api/cases/:quoteId/escalate", auth.required, async (req, res) => {
    try {
        const workflow = (await axios.get(`${WORKFLOW_URL}/workflows`, {
            params: { quoteId: req.params.quoteId }, timeout: 8000,
        })).data;
        const task = (await axios.post(`${WORKFLOW_URL}/tasks`, {
            workflowId: workflow.id, type: "approve_discount",
        }, { timeout: 8000 })).data;
        log.info("discount escalated to supervisor", { quoteId: req.params.quoteId, by: req.user.email });
        res.status(201).json(task);
    } catch (err) {
        res.status(err.response?.status || 502).json(
            err.response?.data || { error: "escalate_failed", message: err.message }
        );
    }
});

/* --------------------------------------------------------------- portfolio */

app.get("/api/portfolio", auth.required, async (req, res) => {
    try {
        const [stats, quotes] = await Promise.all([
            axios.get(`${QUOTE_URL}/internal/stats`, { timeout: 8000 }),
            axios.get(`${QUOTE_URL}/internal/quotes`, { timeout: 8000 }),
        ]);
        res.json({
            ...stats.data,
            quotes: quotes.data.map((q) => ({
                id: q.id, reference: q.reference, state: q.state, company: q.company_name,
                industry: q.industry, headcount: q.headcount, createdAt: q.created_at,
                premium: q.pricing?.premiumPerMemberMonth,
                subscription: q.pricing?.subscriptionPerMemberMonth,
                monthlyTotal: q.pricing?.monthlyTotal, z: q.pricing?.z,
            })),
        });
    } catch (err) {
        res.status(502).json({ error: "portfolio_failed", message: err.message });
    }
});

app.get("/api/reference", auth.required, async (req, res) => {
    try {
        const r = await axios.get(`${PRICING_URL}/coverage-levels`, { timeout: 5000 });
        res.json({ coverageLevels: r.data });
    } catch (err) {
        res.status(502).json({ error: "reference_failed", message: err.message });
    }
});

let server;
db.init()
    .then(() => {
        server = app.listen(PORT, () => log.info(`backoffice-service listening on ${PORT}`));
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
