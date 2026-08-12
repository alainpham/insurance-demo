// The business process, as an explicit state machine plus a task table.
//
// No workflow engine: this is a demo, and the whole point is that you can read
// the process in one file. A real deployment would put Temporal or Camunda here
// (see ARCHITECTURE.md §10) — the service boundaries would not change.

const axios = require("axios");
const db = require("./db");
const log = require("./log");

const QUOTE_URL = process.env.QUOTE_URL || "http://localhost:3001";
const PRICING_URL = process.env.PRICING_URL || "http://localhost:3002";
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || "http://localhost:3004";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3001";

// Routing rules. Small and standard goes straight through; anything large or
// experience-rated gets a human actuary on it.
const REFERRAL_HEADCOUNT = Number(process.env.REFERRAL_HEADCOUNT || 250);
const REFERRAL_Z = Number(process.env.REFERRAL_Z || 0.5);
const MAX_CONTACT_ATTEMPTS = Number(process.env.MAX_CONTACT_ATTEMPTS || 3);
const CONTACT_RETRY_MINUTES = Number(process.env.CONTACT_RETRY_MINUTES || 2880); // 48h
const FOLLOW_UP_DAYS = Number(process.env.FOLLOW_UP_DAYS || 3);

const TASK_DEFS = {
    review_quote: { title: "Review and approve the quote", role: "actuary", slaMinutes: 240 },
    contact_prospect: { title: "Contact the prospect", role: "advisor", slaMinutes: 1440 },
    send_quote: { title: "Send the quote", role: "advisor", slaMinutes: 1440 },
    approve_discount: { title: "Approve a discount above authority", role: "supervisor", slaMinutes: 240 },
};

/* ----------------------------------------------------------------- helpers */

async function createTask(workflowId, type, { dueInMinutes } = {}) {
    const def = TASK_DEFS[type];
    if (!def) throw new Error(`unknown task type ${type}`);
    const due = new Date(Date.now() + (dueInMinutes ?? def.slaMinutes) * 60000);
    const { rows } = await db.query(
        `INSERT INTO ${db.SCHEMA}.tasks (workflow_id, type, title, role, due_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [workflowId, type, def.title, def.role, due]
    );
    log.info("task created", { workflowId, type, role: def.role });
    return rows[0];
}

async function setState(workflowId, state, extra = {}) {
    const sets = ["state = $2", "updated_at = now()"];
    const params = [workflowId, state];
    for (const [k, v] of Object.entries(extra)) {
        params.push(v);
        sets.push(`${k} = $${params.length}`);
    }
    const { rows } = await db.query(
        `UPDATE ${db.SCHEMA}.workflows SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
        params
    );
    return rows[0];
}

async function moveQuote(quoteId, to, actor, note) {
    try {
        await axios.patch(`${QUOTE_URL}/internal/quotes/${quoteId}/state`, { to, actor, note }, { timeout: 8000 });
        return true;
    } catch (err) {
        const detail = err.response?.data?.message || err.message;
        log.error("quote transition failed", { quoteId, to, err: detail });
        return false;
    }
}

/* ------------------------------------------------------------------- start */

async function start(quoteRequestId) {
    const existing = await db.query(
        `SELECT * FROM ${db.SCHEMA}.workflows WHERE quote_request_id = $1`, [quoteRequestId]
    );
    if (existing.rows.length) {
        log.warn("workflow already exists", { quoteRequestId });
        return existing.rows[0];
    }

    const { rows } = await db.query(
        `INSERT INTO ${db.SCHEMA}.workflows (quote_request_id, state) VALUES ($1,'STARTED') RETURNING *`,
        [quoteRequestId]
    );
    let wf = rows[0];

    try {
        // 1. the request
        const request = (await axios.get(`${QUOTE_URL}/internal/quote-requests/${quoteRequestId}`, { timeout: 8000 })).data;

        // 2. price it
        const pricing = await priceRequest(request);

        // 3. record the quote
        const quote = (await axios.post(`${QUOTE_URL}/internal/quotes`, {
            quoteRequestId, pricing, state: "PRICED",
        }, { timeout: 8000 })).data;

        wf = await setState(wf.id, "PRICED", { quote_id: quote.id, quote_reference: quote.reference });
        log.annotate({ "quote.state": "PRICED", "org.size_band": pricing.sizeBand });

        // 4. appetite
        if (pricing.outOfAppetite) {
            await moveQuote(quote.id, "OUT_OF_APPETITE", "system", "outside underwriting appetite");
            await setState(wf.id, "CLOSED", { route: "out_of_appetite" });
            await sendEmail("decline", request, quote, pricing);
            log.info("out of appetite", { quoteRequestId, reference: quote.reference });
            return await current(wf.id);
        }

        // 5. route: straight through, or a human actuary
        const referral = request.headcount >= REFERRAL_HEADCOUNT || pricing.z > REFERRAL_Z;
        if (referral) {
            await moveQuote(quote.id, "UNDER_REVIEW", "system", "referred for actuarial review");
            await setState(wf.id, "AWAITING_REVIEW", { route: "referral" });
            await createTask(wf.id, "review_quote");
        } else {
            await moveQuote(quote.id, "APPROVED", "system", "straight-through: small and standard");
            await setState(wf.id, "AWAITING_CONTACT", { route: "straight_through" });
            await createTask(wf.id, "contact_prospect");
        }
        log.info("workflow started", {
            quoteRequestId, reference: quote.reference,
            route: referral ? "referral" : "straight_through", z: pricing.z,
        });
        return await current(wf.id);
    } catch (err) {
        const detail = err.response?.data?.message || err.message;
        log.error("workflow start failed", { quoteRequestId, err: detail });
        await setState(wf.id, "FAILED", { last_error: detail });
        throw err;
    }
}

async function priceRequest(request, overrides = {}) {
    const body = {
        quoteRef: request.reference,
        industry: request.industry,
        headcount: request.headcount,
        ageMix: request.age_mix,
        compositionMix: request.composition_mix,
        coverageLevel: overrides.coverageLevel || request.coverage_level,
        clientYears: request.client_years || 0,
        ownClaimsPerMember: request.own_claims_per_member,
        subscriptionDiscountPct: overrides.subscriptionDiscountPct || 0,
        // Forwarded so pricing-service can refuse it with a 422. Dropping this
        // silently would let a premium discount through the back office.
        premiumDiscountPct: overrides.premiumDiscountPct || 0,
    };
    const path = Object.keys(overrides).length ? "/price/simulate" : "/price";
    const res = await axios.post(`${PRICING_URL}${path}`, body, { timeout: 15000 });
    return res.data;
}

/* ------------------------------------------------------------ task actions */

async function completeTask(taskId, { outcome, note, actor }) {
    const { rows } = await db.query(`SELECT * FROM ${db.SCHEMA}.tasks WHERE id = $1`, [taskId]);
    const task = rows[0];
    if (!task) { const e = new Error("task not found"); e.status = 404; throw e; }
    if (task.status === "done") { const e = new Error("task already completed"); e.status = 409; throw e; }

    const wf = await current(task.workflow_id);
    log.annotate({ "task.type": task.type, "employee.role": task.role });

    const handlers = { review_quote, contact_prospect, send_quote, approve_discount };
    const handler = handlers[task.type];
    if (!handler) { const e = new Error(`no handler for ${task.type}`); e.status = 400; throw e; }

    await db.query(
        `UPDATE ${db.SCHEMA}.tasks SET status='done', outcome=$2, note=$3, claimed_by=coalesce(claimed_by,$4),
                completed_at=now() WHERE id=$1`,
        [taskId, outcome || null, note || null, actor || null]
    );

    await handler(wf, { outcome, note, actor });
    log.info("task completed", { taskId, type: task.type, outcome, actor });
    return { ...(await current(wf.id)), taskType: task.type };
}

async function review_quote(wf, { outcome, note, actor }) {
    if (outcome === "decline") {
        await moveQuote(wf.quote_id, "DECLINED", actor, note || "declined by underwriter");
        await setState(wf.id, "CLOSED");
        return;
    }
    await moveQuote(wf.quote_id, "APPROVED", actor, note || "approved by underwriter");
    await setState(wf.id, "AWAITING_CONTACT");
    await createTask(wf.id, "contact_prospect");
}

async function contact_prospect(wf, { outcome, note, actor }) {
    await db.query(
        `INSERT INTO ${db.SCHEMA}.contact_attempts (workflow_id, outcome, note, actor) VALUES ($1,$2,$3,$4)`,
        [wf.id, outcome || "unknown", note || null, actor || null]
    );
    const attempts = wf.contact_attempts + 1;
    await setState(wf.id, wf.state, { contact_attempts: attempts });

    if (outcome === "not_interested") {
        await moveQuote(wf.quote_id, "ABANDONED", actor, "prospect not interested");
        await setState(wf.id, "CLOSED");
        return;
    }
    if (outcome === "reached") {
        await moveQuote(wf.quote_id, "CONTACTED", actor, note || "prospect reached");
        await setState(wf.id, "AWAITING_SEND");
        await createTask(wf.id, "send_quote");
        return;
    }
    // no answer: try again, up to the limit
    if (attempts >= MAX_CONTACT_ATTEMPTS) {
        await moveQuote(wf.quote_id, "ABANDONED", actor, `unreachable after ${attempts} attempts`);
        await setState(wf.id, "CLOSED");
        log.info("prospect abandoned as unreachable", { workflowId: wf.id, attempts });
        return;
    }
    await createTask(wf.id, "contact_prospect", { dueInMinutes: CONTACT_RETRY_MINUTES });
}

async function send_quote(wf, { actor }) {
    const quote = (await axios.get(`${QUOTE_URL}/internal/quotes/${wf.quote_id}`, { timeout: 8000 })).data;

    // Render the PDF, then email it. A failure here leaves the task done but the
    // quote un-sent, which the tick would retry in a fuller implementation.
    const doc = (await axios.post(`${NOTIFICATION_URL}/documents/quote`, { quote }, { timeout: 30000 })).data;
    await axios.patch(`${QUOTE_URL}/internal/quotes/${wf.quote_id}/document`,
        { documentUrl: doc.url }, { timeout: 8000 });

    await sendEmail("quote", quote, quote, quote.pricing, doc.url);
    await moveQuote(wf.quote_id, "SENT", actor, "quote sent to prospect");
    await setState(wf.id, "AWAITING_DECISION");

    // Nudge the prospect if they go quiet.
    const fireAt = new Date(Date.now() + FOLLOW_UP_DAYS * 86400000);
    await db.query(
        `INSERT INTO ${db.SCHEMA}.timers (workflow_id, kind, fire_at) VALUES ($1,'follow_up',$2)`,
        [wf.id, fireAt]
    );
}

async function approve_discount(wf, { outcome, note, actor }) {
    if (outcome === "decline") {
        log.info("discount refused by supervisor", { workflowId: wf.id, actor });
        return;
    }
    await setState(wf.id, wf.state);
}

/* ------------------------------------------------------------------ emails */

async function sendEmail(kind, request, quote, pricing, documentUrl) {
    try {
        const to = request.contact_email || quote.contact_email;
        const name = request.contact_name || quote.contact_name;
        const link = quote.access_token
            ? `${PUBLIC_BASE_URL}/quote.html?id=${quote.id}&token=${quote.access_token}`
            : null;
        await axios.post(`${NOTIFICATION_URL}/emails`, {
            kind, to, name,
            company: request.company_name || quote.company_name,
            reference: quote.reference,
            link, documentUrl,
            pricing: pricing || quote.pricing,
        }, { timeout: 15000 });
    } catch (err) {
        log.error("email failed", { kind, err: err.response?.data?.message || err.message });
    }
}

/* -------------------------------------------------------------------- tick */

// Durable timers, the cheap way. Everything here is idempotent so a missed or
// repeated tick is harmless.
async function tick() {
    const span = log.tracer.startSpan("workflow.tick");
    try {
        // 1. expire quotes past their validity
        const expired = (await axios.get(`${QUOTE_URL}/internal/quotes/expired/pending`, { timeout: 8000 })).data;
        for (const q of expired) {
            const ok = await moveQuote(q.id, "EXPIRED", "system", "validity elapsed");
            if (ok) log.info("quote expired", { reference: q.reference });
        }

        // 2. fire due timers
        const { rows: timers } = await db.query(
            `SELECT t.*, w.quote_id FROM ${db.SCHEMA}.timers t
               JOIN ${db.SCHEMA}.workflows w ON w.id = t.workflow_id
              WHERE t.fired = false AND t.fire_at <= now() LIMIT 50`
        );
        for (const timer of timers) {
            await db.query(`UPDATE ${db.SCHEMA}.timers SET fired = true WHERE id = $1`, [timer.id]);
            if (timer.kind === "follow_up") await followUp(timer);
        }
        span.setAttribute("workflow.tick.expired", expired.length);
        span.setAttribute("workflow.tick.timers", timers.length);
    } catch (err) {
        log.warn("tick failed", { err: err.message });
        span.recordException(err);
    } finally {
        span.end();
    }
}

async function followUp(timer) {
    try {
        const quote = (await axios.get(`${QUOTE_URL}/internal/quotes/${timer.quote_id}`, { timeout: 8000 })).data;
        if (quote.state !== "SENT") return; // already decided; nothing to nudge
        await sendEmail("follow_up", quote, quote, quote.pricing, quote.document_url);
        log.info("follow-up sent", { reference: quote.reference });
    } catch (err) {
        log.warn("follow-up failed", { err: err.message });
    }
}

/* ---------------------------------------------------------------- queries */

async function current(id) {
    const { rows } = await db.query(`SELECT * FROM ${db.SCHEMA}.workflows WHERE id = $1`, [id]);
    return rows[0];
}

async function listTasks({ role, status = "open", limit = 100 }) {
    const params = [status];
    let where = "t.status = $1";
    if (role && role !== "all") { params.push(role); where += ` AND t.role = $${params.length}`; }
    params.push(limit);
    const { rows } = await db.query(
        `SELECT t.*, w.quote_id, w.quote_reference, w.route, w.contact_attempts, w.state AS workflow_state,
                EXTRACT(EPOCH FROM (now() - t.created_at))/60 AS age_minutes,
                (t.due_at < now()) AS overdue
           FROM ${db.SCHEMA}.tasks t
           JOIN ${db.SCHEMA}.workflows w ON w.id = t.workflow_id
          WHERE ${where}
          ORDER BY t.created_at ASC LIMIT $${params.length}`,
        params
    );
    return rows;
}

module.exports = {
    start, completeTask, createTask, listTasks, current, tick, priceRequest, setState,
    TASK_DEFS, REFERRAL_HEADCOUNT, REFERRAL_Z,
};
