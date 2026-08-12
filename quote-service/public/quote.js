// The prospect's magic-link view of their quote.
(function () {
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    const token = params.get("token");

    const eur = (n) =>
        new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
    const show = (elId) => document.getElementById(elId).classList.remove("hidden");
    const hide = (elId) => document.getElementById(elId).classList.add("hidden");

    function bail(message) {
        hide("loading");
        document.getElementById("error-message").textContent = message;
        show("error");
    }

    async function load() {
        if (!id || !token) return bail("This link is incomplete. Please use the link from your email.");
        let res, quote;
        try {
            res = await fetch(`/api/quotes/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
            quote = await res.json();
        } catch (err) {
            return bail("We could not reach the server. Please try again in a moment.");
        }
        if (!res.ok) {
            if (res.status === 403) return bail("This link is not valid.");
            if (quote.error === "not_available_yet") return bail("Your quote is not ready yet. Your advisor will email you as soon as it is.");
            return bail("We could not find that quote.");
        }
        render(quote);
    }

    function render(q) {
        document.getElementById("company").textContent = q.companyName;
        document.getElementById("reference").textContent = q.reference;
        document.getElementById("headcount").textContent = q.headcount;
        document.getElementById("valid-until").textContent =
            new Date(q.validUntil).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
        document.getElementById("state").textContent = q.state.toLowerCase().replace(/_/g, " ");

        document.getElementById("premium").textContent = eur(q.premiumPerMemberMonth);
        document.getElementById("subscription").textContent = eur(q.subscriptionPerMemberMonth);
        document.getElementById("total").textContent = eur(q.totalPerMemberMonth);
        document.getElementById("monthly-total").textContent =
            `${eur(q.monthlyTotal)} per month for ${q.headcount} members · ${eur(q.annualTotal)} per year`;

        // The pooling bar: this is the thing we want people to actually see.
        const own = Math.round((q.z || 0) * 100);
        document.getElementById("bar-own").style.width = own + "%";
        document.getElementById("bar-pooled").style.width = (100 - own) + "%";
        document.getElementById("pct-own").textContent = own + "%";
        document.getElementById("pct-pooled").textContent = (100 - own) + "%";
        document.getElementById("rationale").innerHTML =
            (q.rationale || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");

        document.getElementById("rate-table").innerHTML = (q.rateTable || [])
            .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="num">${r.share}%</td><td class="num">${eur(r.premiumPerMonth)}</td></tr>`)
            .join("");

        document.getElementById("coverage-title").textContent = `What's covered — ${q.coverage?.label || ""}`;
        document.getElementById("benefits").innerHTML = (q.coverage?.benefits || [])
            .map((b) => `<tr><td><strong>${escapeHtml(b.label)}</strong></td><td>${escapeHtml(b.value)}</td></tr>`)
            .join("");

        if (q.documentUrl) {
            const a = document.getElementById("pdf");
            a.href = q.documentUrl;
            a.classList.remove("hidden");
        }

        if (q.state !== "SENT") closed(q.state);

        hide("loading");
        show("quote");
        window.track("quote_view", { reference: q.reference, state: q.state });
    }

    function closed(state) {
        hide("decision");
        const titles = {
            ACCEPTED: ["Thank you — quote accepted", "Your advisor will be in touch to confirm the start date and finalise cover."],
            REFUSED: ["Quote declined", "Thanks for letting us know. If anything changes, your advisor is happy to revisit it."],
            EXPIRED: ["This quote has expired", "Prices are valid for 60 days. Ask your advisor for a fresh one — it takes a minute."],
        };
        const [title, message] = titles[state] || ["This quote is closed", "Please contact your advisor."];
        document.getElementById("closed-title").textContent = title;
        document.getElementById("closed-message").textContent = message;
        show("closed");
    }

    async function decide(action) {
        const errEl = document.getElementById("decision-error");
        errEl.classList.add("hidden");
        document.getElementById("accept").disabled = true;
        document.getElementById("decline").disabled = true;
        try {
            const res = await fetch(
                `/api/quotes/${encodeURIComponent(id)}/${action}?token=${encodeURIComponent(token)}`,
                { method: "POST" }
            );
            const body = await res.json();
            if (!res.ok) throw new Error(body.message || "That didn't work.");
            window.track("quote_decision", { action, reference: body.reference });
            render(body);
        } catch (err) {
            errEl.textContent = err.message;
            errEl.classList.remove("hidden");
            document.getElementById("accept").disabled = false;
            document.getElementById("decline").disabled = false;
        }
    }

    document.getElementById("accept").addEventListener("click", () => decide("accept"));
    document.getElementById("decline").addEventListener("click", () => decide("decline"));

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    load();
})();
