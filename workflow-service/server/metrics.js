const api = require("@opentelemetry/api");
const db = require("./db");
const log = require("./log");

const meter = api.metrics.getMeter("workflow-service");

const tasksCompleted = meter.createCounter("assurance.tasks.completed.total", {
    description: "Employee tasks completed, by type and outcome",
});

const workflowsStarted = meter.createCounter("assurance.workflows.started.total", {
    description: "Business processes started, by route",
});

const timeToQuote = meter.createHistogram("assurance.time_to_quote_seconds", {
    description: "Seconds from quote request to a priced quote",
});

meter
    .createObservableGauge("assurance.tasks.open", { description: "Open employee tasks" })
    .addCallback(async (result) => {
        try {
            const { rows } = await db.query(
                `SELECT type, role, count(*)::int AS n
                   FROM ${db.SCHEMA}.tasks WHERE status = 'open' GROUP BY type, role`
            );
            for (const r of rows) result.observe(r.n, { type: r.type, role: r.role });
        } catch (err) {
            log.warn("tasks.open gauge failed", { err: err.message });
        }
    });

meter
    .createObservableGauge("assurance.tasks.oldest_open_minutes", {
        description: "Age of the oldest open task, by role",
    })
    .addCallback(async (result) => {
        try {
            const { rows } = await db.query(
                `SELECT role, max(EXTRACT(EPOCH FROM (now() - created_at))/60)::float AS m
                   FROM ${db.SCHEMA}.tasks WHERE status = 'open' GROUP BY role`
            );
            for (const r of rows) result.observe(r.m, { role: r.role });
        } catch (err) {
            log.warn("oldest_open gauge failed", { err: err.message });
        }
    });

module.exports = { tasksCompleted, workflowsStarted, timeToQuote };
