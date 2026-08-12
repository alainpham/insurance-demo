// Public quote funnel. Plain JS on purpose — no framework, no build step.
(function () {
    const STORE = "assurance.quote.draft";
    const form = document.getElementById("quote-form");
    const confirmation = document.getElementById("confirmation");
    const errorEl = document.getElementById("form-error");

    const FALLBACK_INDUSTRIES = [
        { industry: "tech", label: "Software & tech" },
        { industry: "professional_services", label: "Professional services" },
        { industry: "retail", label: "Retail & e-commerce" },
        { industry: "manufacturing", label: "Manufacturing" },
        { industry: "healthcare", label: "Healthcare & social" },
        { industry: "construction", label: "Construction" },
        { industry: "hospitality", label: "Hospitality & food service" },
        { industry: "other", label: "Other" },
    ];
    const FALLBACK_COVERAGE = [
        { code: "essential", label: "Essential", factor: 0.8 },
        { code: "comfort", label: "Comfort", factor: 1.0 },
        { code: "premium", label: "Premium", factor: 1.35 },
    ];
    const COVERAGE_BLURB = {
        essential: "Statutory cover plus the essentials. The lowest premium.",
        comfort: "Our most popular level: 150% routine care, 250 € optical, 200% dental.",
        premium: "Best cover: 250% routine care, 450 € optical, 350% dental, alternative medicine.",
    };

    let step = 1;

    /* ------------------------------------------------------------ reference */

    async function loadReference() {
        const [industries, coverage] = await Promise.all([
            fetch("/api/industries").then((r) => r.json()).catch(() => FALLBACK_INDUSTRIES),
            fetch("/api/coverage-levels").then((r) => r.json()).catch(() => FALLBACK_COVERAGE),
        ]);

        const sel = document.getElementById("industry");
        sel.innerHTML = (industries.length ? industries : FALLBACK_INDUSTRIES)
            .map((i) => `<option value="${i.industry}">${i.label}</option>`)
            .join("");

        const box = document.getElementById("coverage-options");
        box.innerHTML = (coverage.length ? coverage : FALLBACK_COVERAGE)
            .map(
                (c, i) => `
        <label>
          <input type="radio" name="coverageLevel" value="${c.code}" ${c.code === "comfort" || (i === 0 && coverage.length === 1) ? "checked" : ""}>
          <span class="name">${c.label}</span>
          <span class="desc">${COVERAGE_BLURB[c.code] || ""}</span>
        </label>`
            )
            .join("");

        restore();
    }

    /* ----------------------------------------------------------- navigation */

    function show(n) {
        for (const i of [1, 2, 3]) {
            document.getElementById("step" + i).classList.toggle("hidden", i !== n);
            document.getElementById("bar" + i).classList.toggle("done", i <= n);
        }
        step = n;
        window.track("funnel_step_view", { step: String(n) });
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function validateStep(n) {
        errorEl.classList.add("hidden");
        if (n === 1) {
            const name = document.getElementById("companyName").value.trim();
            const headcount = parseInt(document.getElementById("headcount").value, 10);
            if (!name) return fail("Please tell us your company name.");
            if (!Number.isFinite(headcount) || headcount < 1) return fail("Please enter a valid number of employees.");
        }
        if (n === 3) {
            const contact = document.getElementById("contactName").value.trim();
            const email = document.getElementById("contactEmail").value.trim();
            if (!contact) return fail("Please tell us your name.");
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Please enter a valid email address.");
        }
        return true;
    }

    function fail(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove("hidden");
        window.track("funnel_validation_error", { step: String(step), message: msg });
        return false;
    }

    form.addEventListener("click", (e) => {
        const next = e.target.dataset?.next;
        const back = e.target.dataset?.back;
        if (next) {
            if (!validateStep(step)) return;
            save();
            show(parseInt(next, 10));
        }
        if (back) show(parseInt(back, 10));
    });

    /* ---------------------------------------------------------------- mixes */

    document.querySelectorAll('input[type=range]').forEach((r) => {
        r.addEventListener("input", () => {
            document.querySelector(`output[for="${r.id}"]`).textContent = r.value;
            save();
        });
    });

    const mix = (ids) => Object.fromEntries(ids.map((id) => [id, Number(document.getElementById(id).value)]));

    /* --------------------------------------------------------------- draft */

    function payload() {
        return {
            companyName: document.getElementById("companyName").value.trim(),
            industry: document.getElementById("industry").value,
            headcount: parseInt(document.getElementById("headcount").value, 10),
            yearFounded: document.getElementById("yearFounded").value
                ? parseInt(document.getElementById("yearFounded").value, 10) : null,
            currentInsurer: document.getElementById("currentInsurer").value.trim() || null,
            ageMix: mix(["under30", "from30to50", "over50"]),
            compositionMix: mix(["individual", "couple", "family"]),
            coverageLevel: document.querySelector('input[name=coverageLevel]:checked')?.value || "comfort",
            contactName: document.getElementById("contactName").value.trim(),
            contactEmail: document.getElementById("contactEmail").value.trim(),
            contactPhone: document.getElementById("contactPhone").value.trim() || null,
            effectiveDate: document.getElementById("effectiveDate").value || null,
        };
    }

    function save() {
        try { sessionStorage.setItem(STORE, JSON.stringify({ step, data: payload() })); } catch (_) {}
    }

    function restore() {
        let saved;
        try { saved = JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch (_) { return; }
        if (!saved) return;
        const d = saved.data || {};
        const set = (id, v) => { if (v != null && document.getElementById(id)) document.getElementById(id).value = v; };
        set("companyName", d.companyName); set("industry", d.industry); set("headcount", d.headcount);
        set("yearFounded", d.yearFounded); set("currentInsurer", d.currentInsurer);
        set("contactName", d.contactName); set("contactEmail", d.contactEmail);
        set("contactPhone", d.contactPhone); set("effectiveDate", d.effectiveDate);
        for (const [k, v] of Object.entries({ ...(d.ageMix || {}), ...(d.compositionMix || {}) })) {
            const el = document.getElementById(k);
            if (el) { el.value = v; document.querySelector(`output[for="${k}"]`).textContent = v; }
        }
        const cov = document.querySelector(`input[name=coverageLevel][value="${d.coverageLevel}"]`);
        if (cov) cov.checked = true;
    }

    /* -------------------------------------------------------------- submit */

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!validateStep(3)) return;

        const btn = document.getElementById("submit-btn");
        btn.disabled = true;
        btn.textContent = "Sending…";
        window.track("quote_request_submit", {});

        try {
            const res = await fetch("/api/quote-requests", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload()),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.message || body.error || "Something went wrong.");

            sessionStorage.removeItem(STORE);
            sessionStorage.setItem("assurance.quote.reference", body.reference);
            document.getElementById("reference").textContent = body.reference;
            form.classList.add("hidden");
            document.querySelector(".steps").classList.add("hidden");
            confirmation.classList.remove("hidden");
            window.track("quote_request_success", { reference: body.reference });
        } catch (err) {
            fail(err.message);
            window.track("quote_request_error", { message: err.message });
        } finally {
            btn.disabled = false;
            btn.textContent = "Request my quote";
        }
    });

    /* -------------------------------------------------------------- status */

    document.getElementById("check-status").addEventListener("click", async () => {
        const reference = document.getElementById("reference").textContent;
        const line = document.getElementById("status-line");
        line.classList.remove("hidden");
        line.textContent = "Checking…";
        try {
            const r = await fetch(`/api/quote-requests/${encodeURIComponent(reference)}`);
            const b = await r.json();
            line.textContent = r.ok ? `Status: ${b.status}` : "We could not find that reference.";
        } catch (_) {
            line.textContent = "Status check failed.";
        }
    });

    document.getElementById("start-over").addEventListener("click", () => location.reload());

    // Demo hook: /?slow=1 adds artificial client latency so the RUM dashboard
    // and the trace waterfall have something to show.
    if (new URLSearchParams(location.search).get("slow") === "1") {
        const realFetch = window.fetch;
        window.fetch = (...args) =>
            new Promise((r) => setTimeout(r, 1200)).then(() => realFetch(...args));
        console.warn("slow mode on: 1.2s added to every request");
    }

    loadReference();
    show(1);
})();
