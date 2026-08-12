#!/usr/bin/env node
// End-to-end smoke test: one quote from the public form to a signed acceptance,
// asserting every step. Exits non-zero on the first failure.
const L = require("./lib");

let step = 0;
const pass = (msg, extra) => console.log(`  \x1b[32m✓\x1b[0m ${++step}. ${msg}${extra ? `  \x1b[2m${extra}\x1b[0m` : ""}`);
const fail = (msg, err) => {
    console.error(`  \x1b[31m✗\x1b[0m ${++step}. ${msg}\n     ${err?.message || err}`);
    process.exit(1);
};

(async () => {
    console.log("\nAssurance smoke test\n");

    // 0. every service up
    try {
        const names = { quote: L.QUOTE, pricing: L.PRICING, workflow: L.WORKFLOW, notification: L.NOTIFICATION, backoffice: L.BACKOFFICE };
        for (const [name, url] of Object.entries(names)) {
            const h = await L.call(`${url}/health`);
            if (h.status !== "up") throw new Error(`${name} not up`);
        }
        pass("all five services report healthy");
    } catch (err) { fail("services healthy", err); }

    // 1. public form submission
    let created;
    try {
        created = await L.createRequest({
            companyName: "Smoke Test SARL",
            industry: "tech",
            headcount: 14,
            yearFounded: 2021,
            coverageLevel: "comfort",
            ageMix: { under30: 6, from30to50: 7, over50: 1 },
            compositionMix: { individual: 8, couple: 4, family: 2 },
            contactName: "Smoke Tester",
            contactEmail: "smoke@example.test",
            contactPhone: "+33 1 23 45 67 89",
        });
        if (!created.reference) throw new Error("no reference returned");
        pass("public form accepted the request", created.reference);
    } catch (err) { fail("public form submission", err); }

    // 2. the process started and produced a priced quote
    let wf, q;
    try {
        wf = await L.workflowFor(created.quoteRequestId);
        q = await L.quote(wf.quote_id);
        if (!q.pricing?.premiumPerMemberMonth) throw new Error("quote has no premium");
        pass("workflow priced the quote",
            `${q.reference} · premium ${q.pricing.premiumPerMemberMonth}€ · subscription ${q.pricing.subscriptionPerMemberMonth}€ · Z=${q.pricing.z}`);
    } catch (err) { fail("workflow produced a priced quote", err); }

    // 3. small and standard, so it should have gone straight through
    try {
        if (wf.route !== "straight_through") throw new Error(`expected straight_through, got ${wf.route}`);
        if (q.state !== "APPROVED") throw new Error(`expected APPROVED, got ${q.state}`);
        pass("14 members with standard cover went straight through", "no actuary needed");
    } catch (err) { fail("straight-through routing", err); }

    // 4. the business model refuses a premium discount
    try {
        const res = await fetch(`${L.PRICING}/price/simulate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ industry: "tech", headcount: 14, premiumDiscountPct: 10 }),
        });
        if (res.status !== 422) throw new Error(`expected 422, got ${res.status}`);
        pass("premium discount refused with 422", "the business model, enforced in code");
    } catch (err) { fail("premium discount refusal", err); }

    // 5. the state machine refuses an illegal jump
    try {
        const res = await fetch(`${L.QUOTE}/internal/quotes/${q.id}/state`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ to: "ACCEPTED", actor: "smoke" }),
        });
        if (res.status !== 409) throw new Error(`expected 409, got ${res.status}`);
        pass("illegal state transition refused with 409", "APPROVED -> ACCEPTED is not allowed");
    } catch (err) { fail("state machine enforcement", err); }

    // 6. employee contacts the prospect
    try {
        const task = await L.openTask(wf.id, "contact_prospect");
        if (!task) throw new Error("no contact task waiting");
        await L.completeTask(task.id, "reached", "Spoke to them, happy to receive the quote.");
        q = await L.quote(wf.quote_id);
        if (q.state !== "CONTACTED") throw new Error(`expected CONTACTED, got ${q.state}`);
        pass("advisor logged the call", "quote is now CONTACTED");
    } catch (err) { fail("contact task", err); }

    // 7. send: PDF rendered and email delivered
    try {
        const task = await L.openTask(wf.id, "send_quote");
        if (!task) throw new Error("no send task waiting");
        await L.completeTask(task.id, "sent", "Sent by email.");
        q = await L.quote(wf.quote_id);
        if (q.state !== "SENT") throw new Error(`expected SENT, got ${q.state}`);
        if (!q.document_url) throw new Error("no document url on the quote");
        pass("quote PDF rendered and sent", q.document_url);
    } catch (err) { fail("send task", err); }

    // 8. the PDF is actually fetchable
    try {
        const res = await fetch(q.document_url);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error("not a PDF");
        pass("PDF downloads and is a valid PDF", `${(buf.length / 1024).toFixed(1)} kB`);
    } catch (err) { fail("PDF download", err); }

    // 9. the email reached Mailpit
    try {
        const box = await L.call(`${L.MAILPIT}/api/v1/messages?limit=50`);
        const msg = (box.messages || []).find((m) => m.Subject?.includes(q.reference));
        if (!msg) throw new Error(`no email mentioning ${q.reference}`);
        pass("email arrived in Mailpit", msg.Subject);
    } catch (err) { fail("email delivery", err); }

    // 10. the prospect opens the magic link and accepts
    try {
        const view = await L.call(`${L.QUOTE}/api/quotes/${q.id}?token=${q.access_token}`);
        if (view.reference !== q.reference) throw new Error("magic link returned the wrong quote");
        const accepted = await L.call(`${L.QUOTE}/api/quotes/${q.id}/accept?token=${q.access_token}`, { method: "POST" });
        if (accepted.state !== "ACCEPTED") throw new Error(`expected ACCEPTED, got ${accepted.state}`);
        pass("prospect opened the magic link and accepted", `${q.reference} is ACCEPTED`);
    } catch (err) { fail("prospect acceptance", err); }

    // 11. a bad token is refused
    try {
        const res = await fetch(`${L.QUOTE}/api/quotes/${q.id}?token=wrong`);
        if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
        pass("a wrong magic-link token is refused with 403");
    } catch (err) { fail("magic link security", err); }

    // 12. back-office login and authority limits
    let cookie;
    try {
        const res = await fetch(`${L.BACKOFFICE}/api/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "bruno@assurance.demo", password: "demo" }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(`login failed: ${body.error}`);
        if (body.maxDiscountPct !== 15) throw new Error(`actuary limit should be 15, got ${body.maxDiscountPct}`);
        cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
        pass("back-office login works", `actuary may discount the subscription up to ${body.maxDiscountPct}%`);
    } catch (err) { fail("back-office login", err); }

    // 13. the same refusals must hold through the back office, not just against
    //     pricing-service directly — this is the path the demo actually uses.
    const workbench = (body) =>
        fetch(`${L.BACKOFFICE}/api/cases/${q.id}/simulate`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(body),
        });
    try {
        const res = await workbench({ coverageLevel: "comfort", premiumDiscountPct: 10 });
        if (res.status !== 422) throw new Error(`expected 422 through the back office, got ${res.status}`);
        pass("premium discount refused through the back office too", "422 all the way from the UI");
    } catch (err) { fail("premium discount refusal via back office", err); }

    try {
        const res = await workbench({ coverageLevel: "comfort", subscriptionDiscountPct: 25 });
        if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
        const ok = await workbench({ coverageLevel: "comfort", subscriptionDiscountPct: 12 });
        if (!ok.ok) throw new Error(`12% should be allowed for an actuary, got ${ok.status}`);
        const priced = await ok.json();
        if (!(priced.subscriptionPerMemberMonth < priced.subscriptionListPerMemberMonth)) {
            throw new Error("the subscription discount was not applied");
        }
        pass("discount authority enforced",
            `25% refused, 12% applied (${priced.subscriptionListPerMemberMonth}€ -> ${priced.subscriptionPerMemberMonth}€)`);
    } catch (err) { fail("discount authority", err); }

    console.log(`\n\x1b[32mAll ${step} checks passed.\x1b[0m`);
    console.log(`\nQuote ${q.reference} is ACCEPTED. Open the back office at ${L.BACKOFFICE} to see it.\n`);
})();
