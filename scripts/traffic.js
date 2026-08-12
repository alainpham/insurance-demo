#!/usr/bin/env node
// A steady trickle of realistic traffic. Leave this running during a demo so the
// dashboards keep moving without anyone touching the form.
//
//   node scripts/traffic.js                 # ~1 request every 4s
//   RATE_MS=1500 node scripts/traffic.js    # faster
//   DRIVE=0 node scripts/traffic.js         # submit only, leave tasks piling up
//
// Unlike seed.js this never stops, and it advances only *some* cases through the
// process — so the employee queue grows and shrinks the way a real one does.
const L = require("./lib");

const RATE_MS = Number(process.env.RATE_MS || 4000);
const DRIVE = process.env.DRIVE !== "0";

const INDUSTRIES = ["tech", "professional_services", "retail", "manufacturing", "healthcare", "construction", "hospitality", "other"];
const COVERAGE = ["essential", "comfort", "premium"];
const NAME_A = ["North", "Atlas", "Verdant", "Solis", "Cobalt", "Aurora", "Pivot", "Lumen", "Kestrel", "Harbour", "Meridian", "Orchard", "Beacon", "Quarry"];
const NAME_B = ["light", "works", "labs", "group", "systems", "collective", "partners", "foods", "logistics", "care", "build", "digital", "energy", "studio"];
const FIRST = ["Camille", "Théo", "Salomé", "Hugo", "Léa", "Nabil", "Inès", "Mathis", "Awa", "Gaspard", "Zoé", "Rayan"];
const LAST = ["Bernard", "Nguyen", "Diallo", "Rossi", "Lambert", "Sow", "Marchand", "Petit", "Traoré", "Roux"];

let submitted = 0, priced = 0, advanced = 0, failed = 0;

function randomOrg() {
    const roll = Math.random();
    const headcount = roll < 0.5 ? L.between(3, 40)
        : roll < 0.82 ? L.between(41, 200)
        : roll < 0.96 ? L.between(201, 600)
        : L.between(601, 2000);
    const returning = L.chance(0.25);
    const under30 = L.between(10, 50);
    const over50 = L.between(5, 40);
    const name = `${L.pick(NAME_A)}${L.pick(NAME_B)}`;
    const contact = `${L.pick(FIRST)} ${L.pick(LAST)}`;
    return {
        companyName: name,
        industry: L.pick(INDUSTRIES),
        headcount,
        yearFounded: L.between(1975, 2025),
        coverageLevel: L.pick(COVERAGE),
        clientYears: returning ? L.between(1, 6) : 0,
        ownClaimsPerMember: returning ? L.between(380, 780) : null,
        ageMix: { under30, from30to50: 100 - under30 - over50, over50 },
        compositionMix: { individual: L.between(30, 60), couple: L.between(15, 35), family: L.between(10, 35) },
        contactName: contact,
        contactEmail: `${contact.toLowerCase().replace(/[^a-z]/g, ".")}@${name.toLowerCase()}.test`,
        contactPhone: `+33 ${L.between(1, 9)} ${L.between(10, 99)} ${L.between(10, 99)} ${L.between(10, 99)} ${L.between(10, 99)}`,
    };
}

// Advance a case a random distance through the process, so the funnel keeps a
// realistic shape instead of everything ending up in one state.
async function drive(wf) {
    const depth = Math.random();
    if (depth < 0.25) return; // leave it in the queue

    const review = await L.openTask(wf.id, "review_quote");
    if (review) await L.completeTask(review.id, "approve", "Traffic: approved.", "bruno@assurance.demo");
    if (depth < 0.4) return;

    const contact = await L.openTask(wf.id, "contact_prospect");
    if (contact) {
        if (depth < 0.5) {
            await L.completeTask(contact.id, "not_interested", "Traffic: staying put.", "alice@assurance.demo");
            return;
        }
        await L.completeTask(contact.id, "reached", "Traffic: spoke to them.", "alice@assurance.demo");
    }
    if (depth < 0.6) return;

    const send = await L.openTask(wf.id, "send_quote");
    if (send) await L.completeTask(send.id, "sent", "Traffic: sent.", "alice@assurance.demo");
    if (depth < 0.75) return;

    const q = await L.quote(wf.quote_id);
    if (q.state !== "SENT") return;
    const action = depth < 0.92 ? "accept" : "decline";
    await L.call(`${L.QUOTE}/api/quotes/${q.id}/${action}?token=${q.access_token}`, { method: "POST" });
    advanced++;
}

async function once() {
    try {
        const created = await L.createRequest(randomOrg());
        submitted++;
        if (!DRIVE) return;
        const wf = await L.workflowFor(created.quoteRequestId);
        priced++;
        await drive(wf);
    } catch (err) {
        failed++;
        if (failed % 10 === 1) console.error(`  ! ${err.message}`);
    }
}

// In a terminal, redraw a status line every second. In a pod, that would be one
// log line per second forever — so log a summary every REPORT_MS instead.
const INTERACTIVE = process.stdout.isTTY && process.env.REPORT_MS === undefined;
const REPORT_MS = Number(process.env.REPORT_MS || 60000);

console.log(`Traffic generator — one request every ${RATE_MS}ms${DRIVE ? "" : " (submit only)"}, target ${L.QUOTE}`);
if (INTERACTIVE) console.log("Ctrl-C to stop.\n");

const timer = setInterval(() => { once(); }, RATE_MS);
const reporter = setInterval(
    () => {
        const line = `submitted ${submitted} · priced ${priced} · closed ${advanced}` +
            (failed ? ` · failed ${failed}` : "");
        if (INTERACTIVE) process.stdout.write("  " + line + "        \r");
        else console.log(line);
    },
    INTERACTIVE ? 1000 : REPORT_MS
);

function stop() {
    clearInterval(timer);
    clearInterval(reporter);
    console.log(`\n\nStopped. submitted ${submitted} · priced ${priced} · closed ${advanced}` +
        (failed ? ` · failed ${failed}` : "") + "\n");
    process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
