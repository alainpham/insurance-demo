// Business metrics. The auto-instrumentation already gives us RED metrics for
// free; these are the ones the business dashboard is built from.
const api = require("@opentelemetry/api");
const db = require("./db");
const log = require("./log");

const meter = api.metrics.getMeter("quote-service");

const requestsTotal = meter.createCounter("assurance.quote_requests.total", {
    description: "Quote requests submitted through the public form",
});

const transitionsTotal = meter.createCounter("assurance.quote_transitions.total", {
    description: "Quote state transitions",
});

// Unit lives in the metric name, not the `unit` option: the OTLP->Prometheus
// translation appends the unit as a suffix, which would give us "..._eur_EUR".
const premiumEur = meter.createHistogram("assurance.quote.premium_per_member_month_eur", {
    description: "Premium per member per month at the time of pricing",
});

// Portfolio gauges, observed straight from the database on each collection.
meter
    .createObservableGauge("assurance.quotes.by_state", {
        description: "Quotes currently in each state",
    })
    .addCallback(async (result) => {
        try {
            const { rows } = await db.query(
                `SELECT state, count(*)::int AS n FROM ${db.SCHEMA}.quotes GROUP BY state`
            );
            for (const r of rows) result.observe(r.n, { state: r.state });
        } catch (err) {
            log.warn("quotes.by_state gauge failed", { err: err.message });
        }
    });

meter
    .createObservableGauge("assurance.portfolio.members_covered", {
        description: "Members covered by accepted quotes",
    })
    .addCallback(async (result) => {
        try {
            const { rows } = await db.query(
                `SELECT coalesce(sum(o.headcount),0)::int AS n
                   FROM ${db.SCHEMA}.quotes q
                   JOIN ${db.SCHEMA}.organizations o ON o.id = q.organization_id
                  WHERE q.state = 'ACCEPTED'`
            );
            result.observe(rows[0].n);
        } catch (err) {
            log.warn("members_covered gauge failed", { err: err.message });
        }
    });

meter
    .createObservableGauge("assurance.portfolio.subscription_revenue_month_eur", {
        description: "Monthly subscription revenue from accepted quotes",
    })
    .addCallback(async (result) => {
        try {
            const { rows } = await db.query(
                `SELECT coalesce(sum((q.pricing->>'subscriptionPerMemberMonth')::numeric * o.headcount),0) AS eur
                   FROM ${db.SCHEMA}.quotes q
                   JOIN ${db.SCHEMA}.organizations o ON o.id = q.organization_id
                  WHERE q.state = 'ACCEPTED'`
            );
            result.observe(Number(rows[0].eur));
        } catch (err) {
            log.warn("subscription_revenue gauge failed", { err: err.message });
        }
    });

meter
    .createObservableGauge("assurance.portfolio.premium_volume_month_eur", {
        description: "Monthly premium volume from accepted quotes — the break-even line",
    })
    .addCallback(async (result) => {
        try {
            const { rows } = await db.query(
                `SELECT coalesce(sum((q.pricing->>'premiumPerMemberMonth')::numeric * o.headcount),0) AS eur
                   FROM ${db.SCHEMA}.quotes q
                   JOIN ${db.SCHEMA}.organizations o ON o.id = q.organization_id
                  WHERE q.state = 'ACCEPTED'`
            );
            result.observe(Number(rows[0].eur));
        } catch (err) {
            log.warn("premium_volume gauge failed", { err: err.message });
        }
    });

module.exports = { requestsTotal, transitionsTotal, premiumEur };
