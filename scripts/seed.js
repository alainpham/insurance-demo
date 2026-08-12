#!/usr/bin/env node
// Seeds a portfolio so the dashboards mean something on first boot.
//
// Everything goes through the real APIs — nothing is written straight to the
// database — so the seeded portfolio is exactly what the system would have
// produced on its own.
const L = require("./lib");

const COUNT = Number(process.env.SEED_COUNT || 100);
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY || 6);

const INDUSTRIES = ["tech", "professional_services", "retail", "manufacturing", "healthcare", "construction", "hospitality", "other"];
const COVERAGE = ["essential", "comfort", "premium"];

const FIRST = ["Camille", "Théo", "Salomé", "Hugo", "Léa", "Nabil", "Inès", "Mathis", "Awa", "Gaspard", "Zoé", "Rayan", "Maëlle", "Youssef", "Chloé"];
const LAST = ["Bernard", "Nguyen", "Diallo", "Rossi", "Lambert", "Sow", "Marchand", "Petit", "Traoré", "Roux", "Girard", "Benali", "Faure", "Costa", "Meunier"];
const NAME_A = ["North", "Atlas", "Verdant", "Solis", "Cobalt", "Aurora", "Pivot", "Lumen", "Kestrel", "Harbour", "Meridian", "Fable", "Orchard", "Beacon", "Quarry"];
const NAME_B = ["light", "works", "labs", "group", "systems", "collective", "partners", "foods", "logistics", "care", "build", "digital", "textiles", "energy", "studio"];
const SUFFIX = ["SAS", "SARL", "SA", "SCOP", ""];

function randomOrg(i) {
    const industry = L.pick(INDUSTRIES);
    // A realistic spread: mostly small companies, a few large ones.
    const roll = Math.random();
    const headcount = roll < 0.45 ? L.between(3, 40)
        : roll < 0.8 ? L.between(41, 200)
        : roll < 0.95 ? L.between(201, 600)
        : L.between(601, 2500);

    // A quarter are existing clients being re-quoted, so Z is non-zero for them.
    const returning = L.chance(0.25);
    const clientYears = returning ? L.between(1, 6) : 0;

    const over50 = L.between(5, 40);
    const under30 = L.between(10, 50);
    const name = `${L.pick(NAME_A)}${L.pick(NAME_B)} ${L.pick(SUFFIX)}`.trim();
    const contact = `${L.pick(FIRST)} ${L.pick(LAST)}`;

    return {
        companyName: `${name}`,
        industry,
        headcount,
        yearFounded: L.between(1975, 2025),
        coverageLevel: L.pick(COVERAGE),
        clientYears,
        ownClaimsPerMember: returning ? L.between(380, 780) : null,
        ageMix: { under30, from30to50: 100 - under30 - over50, over50 },
        compositionMix: { individual: L.between(30, 60), couple: L.between(15, 35), family: L.between(10, 35) },
        contactName: contact,
        contactEmail: `${contact.toLowerCase().replace(/[^a-z]/g, ".")}@${name.toLowerCase().replace(/[^a-z]/g, "")}.test`,
        contactPhone: `+33 ${L.between(1, 9)} ${L.between(10, 99)} ${L.between(10, 99)} ${L.between(10, 99)} ${L.between(10, 99)}`,
        _seedIndex: i,
    };
}

// Where each seeded case should end up. Leaving a slice mid-process on purpose:
// an empty task queue makes for a poor demo.
function targetOutcome() {
    const r = Math.random();
    if (r < 0.30) return "accepted";
    if (r < 0.40) return "refused";
    if (r < 0.52) return "sent";
    if (r < 0.62) return "abandoned";
    if (r < 0.72) return "contacted";
    return "open"; // stays in the work queue
}

async function seedOne(payload) {
    const outcome = targetOutcome();
    const created = await L.createRequest(payload);
    const wf = await L.workflowFor(created.quoteRequestId);
    let q = await L.quote(wf.quote_id);

    if (q.state === "OUT_OF_APPETITE") return { state: q.state, reference: q.reference };

    // An actuarial referral needs approving before anything else can happen.
    const review = await L.openTask(wf.id, "review_quote");
    if (review) {
        if (outcome === "open") return { state: "UNDER_REVIEW", reference: q.reference };
        await L.completeTask(review.id, "approve", "Seeded: approved.", "bruno@assurance.demo");
    }
    if (outcome === "open") return { state: q.state, reference: q.reference };

    // Contact
    const contact = await L.openTask(wf.id, "contact_prospect");
    if (contact) {
        if (outcome === "abandoned") {
            await L.completeTask(contact.id, "not_interested", "Seeded: staying with their current insurer.", "alice@assurance.demo");
            q = await L.quote(wf.quote_id);
            return { state: q.state, reference: q.reference };
        }
        await L.completeTask(contact.id, "reached", "Seeded: spoke to them.", "alice@assurance.demo");
    }
    if (outcome === "contacted") {
        q = await L.quote(wf.quote_id);
        return { state: q.state, reference: q.reference };
    }

    // Send
    const send = await L.openTask(wf.id, "send_quote");
    if (send) await L.completeTask(send.id, "sent", "Seeded: sent by email.", "alice@assurance.demo");
    q = await L.quote(wf.quote_id);

    if (outcome === "accepted" && q.state === "SENT") {
        await L.call(`${L.QUOTE}/api/quotes/${q.id}/accept?token=${q.access_token}`, { method: "POST" });
    } else if (outcome === "refused" && q.state === "SENT") {
        await L.call(`${L.QUOTE}/api/quotes/${q.id}/decline?token=${q.access_token}`, { method: "POST" });
    }

    q = await L.quote(wf.quote_id);
    return { state: q.state, reference: q.reference };
}

(async () => {
    console.log(`\nSeeding ${COUNT} organisations through the real APIs…\n`);
    const started = Date.now();
    const payloads = Array.from({ length: COUNT }, (_, i) => randomOrg(i));
    const tally = {};
    let done = 0, failed = 0;

    // A small worker pool: enough to be quick, not enough to look like an attack.
    async function worker() {
        while (payloads.length) {
            const p = payloads.shift();
            try {
                const r = await seedOne(p);
                tally[r.state] = (tally[r.state] || 0) + 1;
            } catch (err) {
                failed++;
                if (failed <= 3) console.error(`  ! ${p.companyName}: ${err.message}`);
            }
            done++;
            if (done % 10 === 0) process.stdout.write(`  ${done}/${COUNT}\r`);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`  ${done}/${COUNT} done in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (failed ? `  (${failed} failed)` : "") + "\n");
    console.log("  Portfolio by state:");
    for (const [state, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${state.toLowerCase().replace(/_/g, " ").padEnd(18)} ${n}`);
    }
    console.log("\n  Grafana: http://localhost:3000   Back office: http://localhost:3005\n");
})();
