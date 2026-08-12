#!/usr/bin/env node
// The three scripted cases the demo script walks through. Run after `make up`.
const L = require("./lib");

const CASES = [
    {
        title: "Startup, 12 members, first year",
        shows: "Z = 0 — fully pooled, straight through, no human needed to price it",
        payload: {
            companyName: "Northlight Studio",
            industry: "tech",
            headcount: 12,
            yearFounded: 2024,
            coverageLevel: "comfort",
            ageMix: { under30: 5, from30to50: 6, over50: 1 },
            compositionMix: { individual: 7, couple: 3, family: 2 },
            contactName: "Salomé Bernard",
            contactEmail: "salome@northlight.test",
            contactPhone: "+33 6 12 34 56 78",
            currentInsurer: "None — first group policy",
        },
        // leave the contact task open: it is what the demo picks up on stage
        drive: [],
    },
    {
        title: "Manufacturer, 400 members, 4 years of history",
        shows: "Z ≈ 0.73 — priced on its own experience, so it goes to an actuary",
        payload: {
            companyName: "Vallier Industries",
            industry: "manufacturing",
            headcount: 400,
            yearFounded: 1994,
            coverageLevel: "comfort",
            clientYears: 4,
            ownClaimsPerMember: 640,
            ageMix: { under30: 80, from30to50: 220, over50: 100 },
            compositionMix: { individual: 120, couple: 140, family: 140 },
            contactName: "Marc Vallier",
            contactEmail: "m.vallier@vallier.test",
            contactPhone: "+33 4 78 22 11 00",
            currentInsurer: "Groupe Prévoyance",
        },
        drive: [],
    },
    {
        title: "Restaurant chain, older workforce, high-claims industry",
        shows: "Outside appetite — declined politely, with an email to prove it",
        payload: {
            companyName: "Maison Feuillat",
            industry: "hospitality",
            headcount: 60,
            yearFounded: 2003,
            coverageLevel: "premium",
            ageMix: { under30: 4, from30to50: 16, over50: 40 },
            compositionMix: { individual: 20, couple: 20, family: 20 },
            contactName: "Hélène Feuillat",
            contactEmail: "helene@feuillat.test",
            contactPhone: "+33 5 61 00 22 33",
        },
        drive: [],
    },
];

(async () => {
    console.log("\nCreating the three demo cases\n");

    for (const c of CASES) {
        try {
            const created = await L.createRequest(c.payload);
            const wf = await L.workflowFor(created.quoteRequestId);
            const q = await L.quote(wf.quote_id);
            const p = q.pricing || {};

            console.log(`  \x1b[1m${c.title}\x1b[0m`);
            console.log(`    ${c.shows}`);
            console.log(`    ${q.reference} · ${q.state} · route: ${wf.route || "—"}`);
            if (p.premiumPerMemberMonth != null) {
                console.log(
                    `    Z = ${p.z} · premium ${p.premiumPerMemberMonth} €/member/month · ` +
                    `subscription ${p.subscriptionPerMemberMonth} € · total ${p.monthlyTotal} €/month`
                );
            }
            console.log("");
        } catch (err) {
            console.error(`  \x1b[31m✗\x1b[0m ${c.title}: ${err.message}\n`);
        }
    }

    console.log("Open the back office at http://localhost:3005 — sign in as:");
    console.log("  bruno@assurance.demo / demo   (actuary — has the Vallier review waiting)");
    console.log("  alice@assurance.demo / demo   (advisor — has the Northlight contact waiting)\n");
})();
