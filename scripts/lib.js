// Shared helpers for the demo scripts. Node 22 has global fetch, so these
// scripts need no dependencies at all.

const QUOTE = process.env.QUOTE_URL || "http://localhost:3001";
const PRICING = process.env.PRICING_URL || "http://localhost:3002";
const WORKFLOW = process.env.WORKFLOW_URL || "http://localhost:3003";
const NOTIFICATION = process.env.NOTIFICATION_URL || "http://localhost:3004";
const BACKOFFICE = process.env.BACKOFFICE_URL || "http://localhost:3005";
const MAILPIT = process.env.MAILPIT_URL || "http://localhost:8025";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, options = {}) {
    const res = await fetch(url, {
        headers: { "content-type": "application/json", ...(options.headers || {}) },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!res.ok) {
        const err = new Error(body?.message || body?.error || `HTTP ${res.status} for ${url}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

// Poll until `check` returns something truthy, or give up.
async function until(label, fn, { attempts = 40, delayMs = 500 } = {}) {
    for (let i = 0; i < attempts; i++) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (_) { /* keep trying */ }
        await sleep(delayMs);
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function createRequest(payload) {
    return call(`${QUOTE}/api/quote-requests`, { method: "POST", body: payload });
}

async function workflowFor(quoteRequestId) {
    return until(`workflow for request ${quoteRequestId}`, async () => {
        const wf = await call(`${WORKFLOW}/workflows?quoteRequestId=${quoteRequestId}`);
        return wf?.quote_id ? wf : null;
    });
}

async function openTask(workflowId, type) {
    const wf = await call(`${WORKFLOW}/workflows/${workflowId}`);
    return (wf.tasks || []).find((t) => t.status === "open" && (!type || t.type === type)) || null;
}

async function completeTask(taskId, outcome, note, actor = "seed@assurance.demo") {
    return call(`${WORKFLOW}/tasks/${taskId}/complete`, {
        method: "POST", body: { outcome, note, actor },
    });
}

async function quote(quoteId) {
    return call(`${QUOTE}/internal/quotes/${quoteId}`);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = (p) => Math.random() < p;

module.exports = {
    QUOTE, PRICING, WORKFLOW, NOTIFICATION, BACKOFFICE, MAILPIT,
    call, sleep, until, createRequest, workflowFor, openTask, completeTask, quote,
    pick, between, chance,
};
