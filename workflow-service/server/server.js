const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const cors = require("cors");
const liveReload = require("./livereload");

const log = require("./log");
const db = require("./db");
const proc = require("./process");

const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");
const TICK_MS = Number(process.env.TICK_MS || 30000);

app.use(cors());
app.use(bodyParser.json());

liveReload.attach(app, PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));

let metrics;

app.get("/ping", (req, res) => res.status(200).json({ message: "pong" }));
app.get("/health", (req, res) => res.status(200).json({ status: "up", service: "workflow-service" }));

app.post("/workflows", async (req, res) => {
    const { quoteRequestId } = req.body || {};
    if (!quoteRequestId) return res.status(400).json({ error: "missing_fields", fields: ["quoteRequestId"] });
    const started = Date.now();
    try {
        const wf = await proc.start(quoteRequestId);
        metrics?.workflowsStarted.add(1, { route: wf.route || "unknown" });
        if (wf.quote_id) metrics?.timeToQuote.record((Date.now() - started) / 1000, { route: wf.route || "unknown" });
        res.status(201).json(wf);
    } catch (err) {
        res.status(502).json({ error: "workflow_start_failed", message: err.message });
    }
});

app.get("/workflows/:id", async (req, res) => {
    const wf = await proc.current(req.params.id);
    if (!wf) return res.status(404).json({ error: "not_found" });
    const tasks = await db.query(
        `SELECT * FROM ${db.SCHEMA}.tasks WHERE workflow_id = $1 ORDER BY id`, [wf.id]
    );
    const attempts = await db.query(
        `SELECT * FROM ${db.SCHEMA}.contact_attempts WHERE workflow_id = $1 ORDER BY id`, [wf.id]
    );
    res.json({ ...wf, tasks: tasks.rows, contactAttempts: attempts.rows });
});

// Look a workflow up by the quote it produced (how the back-office finds it)
// or by the request that started it (how the seed scripts find it).
app.get("/workflows", async (req, res) => {
    const { quoteId, quoteRequestId } = req.query;
    if (!quoteId && !quoteRequestId) {
        return res.status(400).json({ error: "missing_query", fields: ["quoteId", "quoteRequestId"] });
    }
    const { rows } = quoteId
        ? await db.query(`SELECT * FROM ${db.SCHEMA}.workflows WHERE quote_id = $1`, [quoteId])
        : await db.query(`SELECT * FROM ${db.SCHEMA}.workflows WHERE quote_request_id = $1`, [quoteRequestId]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const tasks = await db.query(
        `SELECT * FROM ${db.SCHEMA}.tasks WHERE workflow_id = $1 ORDER BY id`, [rows[0].id]
    );
    const attempts = await db.query(
        `SELECT * FROM ${db.SCHEMA}.contact_attempts WHERE workflow_id = $1 ORDER BY id`, [rows[0].id]
    );
    res.json({ ...rows[0], tasks: tasks.rows, contactAttempts: attempts.rows });
});

app.get("/tasks", async (req, res) => {
    const tasks = await proc.listTasks({
        role: req.query.role,
        status: req.query.status || "open",
        limit: Math.min(Number(req.query.limit) || 100, 500),
    });
    res.json(tasks);
});

app.post("/tasks", async (req, res) => {
    const { workflowId, type, dueInMinutes } = req.body || {};
    if (!workflowId || !type) return res.status(400).json({ error: "missing_fields", fields: ["workflowId", "type"] });
    if (!proc.TASK_DEFS[type]) return res.status(400).json({ error: "unknown_task_type", type });
    const task = await proc.createTask(workflowId, type, { dueInMinutes });
    res.status(201).json(task);
});

app.post("/tasks/:id/claim", async (req, res) => {
    const { actor } = req.body || {};
    const { rows } = await db.query(
        `UPDATE ${db.SCHEMA}.tasks SET claimed_by = $2 WHERE id = $1 AND status = 'open' RETURNING *`,
        [req.params.id, actor || "unknown"]
    );
    if (!rows.length) return res.status(409).json({ error: "not_claimable" });
    log.info("task claimed", { taskId: req.params.id, actor });
    res.json(rows[0]);
});

app.post("/tasks/:id/complete", async (req, res) => {
    const { outcome, note, actor } = req.body || {};
    try {
        const wf = await proc.completeTask(req.params.id, { outcome, note, actor });
        metrics?.tasksCompleted.add(1, { type: wf.taskType, outcome: outcome || "none" });
        res.json(wf);
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) log.error("task completion failed", { err: err.message });
        res.status(status).json({ error: "task_completion_failed", message: err.message });
    }
});

// Re-price with employee overrides, then store the result as a new quote version.
app.post("/workflows/:id/reprice", async (req, res) => {
    const wf = await proc.current(req.params.id);
    if (!wf) return res.status(404).json({ error: "not_found" });
    try {
        const axios = require("axios");
        const QUOTE_URL = process.env.QUOTE_URL || "http://localhost:3001";
        const request = (await axios.get(
            `${QUOTE_URL}/internal/quote-requests/${wf.quote_request_id}`, { timeout: 8000 }
        )).data;
        const pricing = await proc.priceRequest(request, req.body || {});
        if (req.body?.persist) {
            await axios.post(`${QUOTE_URL}/internal/quotes/${wf.quote_id}/versions`,
                { pricing, createdBy: req.body.actor || "employee" }, { timeout: 8000 });
        }
        res.json(pricing);
    } catch (err) {
        const status = err.response?.status === 422 ? 422 : 502;
        res.status(status).json(err.response?.data || { error: "reprice_failed", message: err.message });
    }
});

app.post("/admin/tick", async (req, res) => {
    await proc.tick();
    res.json({ ok: true });
});

let server;
let ticker;
db.init()
    .then(() => {
        metrics = require("./metrics");
        server = app.listen(PORT, () => log.info(`workflow-service listening on ${PORT}`));
        ticker = setInterval(() => proc.tick(), TICK_MS);
        log.info(`process tick every ${TICK_MS}ms`);
    })
    .catch((err) => {
        log.error("startup failed", { err: err.message });
        process.exit(1);
    });

function shutdown(signal) {
    log.info(`${signal} received`);
    clearInterval(ticker);
    liveReload.closeStreams();
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
