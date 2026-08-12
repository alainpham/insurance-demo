// Assurance back office. Plain JS, no framework, no build step.
(function () {
    const $ = (id) => document.getElementById(id);
    const eur = (n) =>
        new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
    const esc = (s) =>
        String(s ?? "").replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
    const ago = (mins) => {
        const m = Math.max(0, Math.round(Number(mins) || 0));
        if (m < 60) return `${m} min`;
        if (m < 1440) return `${Math.round(m / 60)} h`;
        return `${Math.round(m / 1440)} d`;
    };

    let me = null;
    let currentCase = null;
    let simulated = null;

    async function api(path, options = {}) {
        const res = await fetch(path, {
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const text = await res.text();
        const body = text ? JSON.parse(text) : null;
        if (!res.ok) {
            const err = new Error(body?.message || body?.error || `HTTP ${res.status}`);
            err.status = res.status;
            err.body = body;
            throw err;
        }
        return body;
    }

    /* ------------------------------------------------------------- login */

    async function showLogin() {
        $("app").classList.add("hidden");
        $("login").classList.remove("hidden");
        try {
            const users = await api("/api/demo-users");
            $("demo-users").innerHTML = users
                .map((u) => `<button data-email="${esc(u.email)}">${esc(u.name)} — <span class="r">${esc(u.role)}</span></button>`)
                .join("");
            $("demo-users").querySelectorAll("button").forEach((b) =>
                b.addEventListener("click", () => {
                    $("email").value = b.dataset.email;
                    $("password").value = "demo";
                    doLogin();
                })
            );
        } catch (_) { /* the list is a convenience, not a requirement */ }
    }

    async function doLogin() {
        const err = $("login-error");
        err.classList.add("hidden");
        try {
            const r = await api("/api/login", {
                method: "POST",
                body: { email: $("email").value.trim(), password: $("password").value },
            });
            me = r;
            start();
        } catch (e) {
            err.textContent = e.status === 401 ? "That email and password don't match." : e.message;
            err.classList.remove("hidden");
        }
    }

    $("login-btn").addEventListener("click", doLogin);
    $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

    $("logout").addEventListener("click", async () => {
        await api("/api/logout", { method: "POST" }).catch(() => {});
        me = null;
        location.reload();
    });

    /* -------------------------------------------------------------- views */

    function show(view) {
        for (const v of ["tasks", "case", "portfolio"]) {
            $("view-" + v).classList.toggle("hidden", v !== view);
        }
        document.querySelectorAll("nav button").forEach((b) =>
            b.classList.toggle("active", b.dataset.view === view)
        );
    }

    document.querySelectorAll("nav button").forEach((b) =>
        b.addEventListener("click", () => {
            const v = b.dataset.view;
            show(v);
            if (v === "tasks") loadTasks();
            if (v === "portfolio") loadPortfolio();
        })
    );

    $("back-to-tasks").addEventListener("click", () => { show("tasks"); loadTasks(); });
    $("refresh-tasks").addEventListener("click", loadTasks);
    $("role-filter").addEventListener("change", loadTasks);

    function start() {
        $("login").classList.add("hidden");
        $("app").classList.remove("hidden");
        $("who-name").textContent = me.user.name;
        $("who-role").textContent = me.user.role;
        $("tasks-lede").textContent =
            `Signed in as ${me.user.role}. You may discount the subscription by up to ${me.maxDiscountPct}%. ` +
            `The premium is never discountable.`;
        show("tasks");
        loadTasks();
    }

    /* --------------------------------------------------------------- tasks */

    async function loadTasks() {
        const role = $("role-filter").value;
        const rows = $("task-rows");
        rows.innerHTML = `<tr><td colspan="7" class="spinner">Loading…</td></tr>`;
        try {
            const tasks = await api(`/api/tasks${role ? `?role=${role}` : ""}`);
            $("tasks-empty").classList.toggle("hidden", tasks.length > 0);
            rows.innerHTML = tasks.map((t) => `
        <tr class="clickable" data-quote="${t.quote_id}">
          <td><strong>${esc(t.title)}</strong><br><span class="badge ${t.type === "review_quote" ? "review" : ""}">${esc(t.role)}</span></td>
          <td>${esc(t.company || "—")}<br><span class="badge">${esc(t.industry || "")}</span></td>
          <td class="num">${t.headcount ?? "—"}</td>
          <td class="num">${t.z == null ? "—" : Math.round((1 - t.z) * 100) + "% pooled"}</td>
          <td class="num">${t.monthlyTotal == null ? "—" : eur(t.monthlyTotal)}</td>
          <td>${esc(t.quote_reference || "")}<br><span class="badge">${esc((t.quoteState || "").toLowerCase().replace(/_/g, " "))}</span></td>
          <td class="num">${ago(t.age_minutes)}${t.overdue ? ' <span class="badge overdue">overdue</span>' : ""}</td>
        </tr>`).join("");
            rows.querySelectorAll("tr.clickable").forEach((tr) =>
                tr.addEventListener("click", () => openCase(tr.dataset.quote))
            );
        } catch (e) {
            if (e.status === 401) return showLogin();
            rows.innerHTML = `<tr><td colspan="7" class="notice error">${esc(e.message)}</td></tr>`;
        }
    }

    /* ---------------------------------------------------------------- case */

    async function openCase(quoteId) {
        show("case");
        $("case-body").innerHTML = `<div class="card spinner">Loading case…</div>`;
        try {
            currentCase = await api(`/api/cases/${quoteId}`);
            simulated = null;
            renderCase();
        } catch (e) {
            if (e.status === 401) return showLogin();
            $("case-body").innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
        }
    }

    function renderCase() {
        const q = currentCase.quote;
        const wf = currentCase.workflow;
        const p = simulated || q.pricing;
        const base = q.pricing;
        const own = Math.round((p.z || 0) * 100);
        const openTasks = (wf?.tasks || []).filter((t) => t.status === "open");

        $("case-body").innerHTML = `
      <h1>${esc(q.company_name)}</h1>
      <p class="lede">
        Quote ${esc(q.reference)} · ${q.headcount} members · ${esc(q.industry)} ·
        <span class="badge ${stateClass(q.state)}">${esc(q.state.toLowerCase().replace(/_/g, " "))}</span>
        ${wf?.route ? `<span class="badge">${esc(wf.route.replace(/_/g, " "))}</span>` : ""}
      </p>

      <div class="grid">
        <div>
          <div class="card">
            <h2>Price</h2>
            <div class="price-lines">
              <div class="price-line premium">
                <span class="label">Insurance premium
                  <span class="sub">Break-even against expected claims. Not discountable.</span></span>
                <span class="amount">${eur(p.premiumPerMemberMonth)}</span>
              </div>
              <div class="price-line subscription">
                <span class="label">Assurance subscription
                  <span class="sub">Per member, per month. This is the revenue line.</span></span>
                <span class="amount">
                  ${simulated && base.subscriptionPerMemberMonth !== p.subscriptionPerMemberMonth
                    ? `<span class="was">${eur(base.subscriptionPerMemberMonth)}</span>` : ""}
                  ${eur(p.subscriptionPerMemberMonth)}</span>
              </div>
              <div class="price-line total">
                <span class="label">Total per member, per month
                  <span class="sub">${eur(p.monthlyTotal)} / month · ${eur(p.annualTotal)} / year</span></span>
                <span class="amount">${eur(p.totalPerMemberMonth)}</span>
              </div>
            </div>

            <div class="pooling">
              <div style="display:flex;align-items:baseline;gap:.75rem">
                <span class="z-big">Z = ${p.z}</span>
                <strong style="font-size:.9rem">How this premium was set</strong>
              </div>
              <div class="bar">
                <div class="own" style="width:${own}%"></div>
                <div class="pooled" style="width:${100 - own}%"></div>
              </div>
              <div class="legend">
                <span><i style="background:var(--accent)"></i>${own}% own claims experience</span>
                <span><i style="background:var(--accent-soft)"></i>${100 - own}% pooled with similar organisations</span>
              </div>
              <ul>${(p.rationale || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
            </div>
          </div>

          <div class="card">
            <h2>Adjust</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
              <div>
                <label for="cov">Coverage level</label>
                <select id="cov">
                  ${["essential", "comfort", "premium"].map((c) =>
                    `<option value="${c}" ${(p.coverage?.code || "comfort") === c ? "selected" : ""}>${c[0].toUpperCase() + c.slice(1)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label for="sub-disc">Subscription discount — <span id="sub-disc-val">${p.inputs?.subscriptionDiscountPct || 0}</span>%
                  <span style="font-weight:400">(your limit: ${currentCase.maxDiscountPct}%)</span></label>
                <input id="sub-disc" type="range" min="0" max="30" step="1" value="${p.inputs?.subscriptionDiscountPct || 0}">
              </div>
            </div>

            <label for="prem-disc">Premium discount %
              <span style="font-weight:400">— try it and see what happens</span></label>
            <input id="prem-disc" type="number" min="0" max="50" value="0" style="max-width:8rem">

            <div class="actions">
              <button class="ghost" id="simulate">Simulate</button>
              <button class="primary" id="save-version" ${simulated ? "" : "disabled"}>Save as new version</button>
              <button class="ghost" id="reset-sim" ${simulated ? "" : "disabled"}>Reset</button>
            </div>
            <div id="sim-notice"></div>
          </div>

          <div class="card">
            <h2>Price breakdown</h2>
            <table><tbody>
              ${(p.breakdown || []).filter((b) => b.value !== null).map((b) =>
                `<tr><td>${esc(b.label)}</td><td class="num">${typeof b.value === "number" ? b.value.toLocaleString("en-IE") : esc(b.value)}</td></tr>`).join("")}
            </tbody></table>
            <h3 style="margin-top:1.25rem">Rates by household</h3>
            <table>
              <thead><tr><th>Household</th><th class="num">Share</th><th class="num">Premium / month</th></tr></thead>
              <tbody>${(p.rateTable || []).map((r) =>
                `<tr><td>${esc(r.label)}</td><td class="num">${r.share}%</td><td class="num">${eur(r.premiumPerMonth)}</td></tr>`).join("")}</tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="card">
            <h2>Next action</h2>
            ${openTasks.length
                ? openTasks.map(taskPanel).join("")
                : `<p class="lede" style="margin:0">Nothing to do on this case right now.</p>`}
            <div id="task-notice"></div>
          </div>

          <div class="card">
            <h2>Prospect</h2>
            <dl class="kv">
              <dt>Contact</dt><dd>${esc(q.contact_name || "—")}</dd>
              <dt>Email</dt><dd>${esc(q.contact_email || "—")}</dd>
              <dt>Phone</dt><dd>${esc(q.contact_phone || "—")}</dd>
              <dt>Members</dt><dd>${q.headcount}</dd>
              <dt>Client since</dt><dd>${q.client_years ? q.client_years + " yr" : "new"}</dd>
              <dt>Valid until</dt><dd>${new Date(q.valid_until).toLocaleDateString("en-GB")}</dd>
              <dt>Contact attempts</dt><dd>${wf?.contact_attempts ?? 0}</dd>
            </dl>
            ${q.document_url ? `<div class="actions"><a href="${esc(q.document_url)}" target="_blank"><button class="ghost">Open the PDF</button></a></div>` : ""}
          </div>

          <div class="card">
            <h2>History</h2>
            <ul class="timeline">
              ${(q.transitions || []).map((t) => `
                <li><strong>${esc(t.to_state.toLowerCase().replace(/_/g, " "))}</strong>
                    ${t.note ? ` — ${esc(t.note)}` : ""}
                    <div class="when">${when(t.created_at)} · ${esc(t.actor || "system")}</div></li>`).join("")}
              ${(wf?.contactAttempts || []).map((c) => `
                <li><strong>call: ${esc(c.outcome)}</strong>${c.note ? ` — ${esc(c.note)}` : ""}
                    <div class="when">${when(c.created_at)} · ${esc(c.actor || "")}</div></li>`).join("")}
            </ul>
          </div>
        </div>
      </div>`;

        wireCase();
    }

    function stateClass(s) {
        if (["ACCEPTED", "APPROVED", "SENT", "CONTACTED"].includes(s)) return "good";
        if (["UNDER_REVIEW", "PRICED"].includes(s)) return "review";
        if (["DECLINED", "REFUSED", "EXPIRED", "ABANDONED", "OUT_OF_APPETITE"].includes(s)) return "bad";
        return "";
    }

    const TASK_ACTIONS = {
        review_quote: [
            { outcome: "approve", label: "Approve the quote", cls: "primary" },
            { outcome: "decline", label: "Decline", cls: "danger" },
        ],
        contact_prospect: [
            { outcome: "reached", label: "Reached them", cls: "primary" },
            { outcome: "no_answer", label: "No answer", cls: "ghost" },
            { outcome: "not_interested", label: "Not interested", cls: "danger" },
        ],
        send_quote: [{ outcome: "sent", label: "Render PDF and send", cls: "primary" }],
        approve_discount: [
            { outcome: "approve", label: "Approve the discount", cls: "primary" },
            { outcome: "decline", label: "Refuse", cls: "danger" },
        ],
    };

    function taskPanel(t) {
        const actions = TASK_ACTIONS[t.type] || [];
        return `
      <div style="margin-bottom:1rem">
        <h3>${esc(t.title)}</h3>
        <p class="lede" style="margin-bottom:.5rem">Assigned to the <strong>${esc(t.role)}</strong> queue.</p>
        <label for="note-${t.id}">Note (optional)</label>
        <textarea id="note-${t.id}" rows="2" placeholder="What happened?"></textarea>
        <div class="actions">
          ${actions.map((a) =>
            `<button class="${a.cls}" data-task="${t.id}" data-outcome="${a.outcome}">${esc(a.label)}</button>`).join("")}
        </div>
      </div>`;
    }

    function wireCase() {
        const covEl = $("cov"), subEl = $("sub-disc"), premEl = $("prem-disc");

        subEl.addEventListener("input", () => { $("sub-disc-val").textContent = subEl.value; });

        $("simulate").addEventListener("click", async () => {
            const notice = $("sim-notice");
            notice.innerHTML = "";
            try {
                simulated = await api(`/api/cases/${currentCase.quote.id}/simulate`, {
                    method: "POST",
                    body: {
                        coverageLevel: covEl.value,
                        subscriptionDiscountPct: Number(subEl.value),
                        premiumDiscountPct: Number(premEl.value),
                    },
                });
                renderCase();
                $("sim-notice").innerHTML =
                    `<div class="notice ok"><strong>Simulated</strong>Not saved yet — use "Save as new version" to keep it.</div>`;
            } catch (e) {
                // The two refusals worth demonstrating.
                if (e.status === 422) {
                    notice.innerHTML = `<div class="notice error"><strong>The premium cannot be discounted</strong>${esc(e.message)}</div>`;
                } else if (e.status === 403) {
                    notice.innerHTML =
                        `<div class="notice warn"><strong>Above your authority</strong>${esc(e.message)}
                         <div class="actions"><button class="ghost" id="escalate">Escalate to a supervisor</button></div></div>`;
                    $("escalate").addEventListener("click", escalate);
                } else {
                    notice.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
                }
            }
        });

        $("reset-sim").addEventListener("click", () => { simulated = null; renderCase(); });

        $("save-version").addEventListener("click", async () => {
            try {
                await api(`/api/cases/${currentCase.quote.id}/simulate`, {
                    method: "POST",
                    body: {
                        coverageLevel: covEl.value,
                        subscriptionDiscountPct: Number(subEl.value),
                        premiumDiscountPct: 0,
                        persist: true,
                    },
                });
                await openCase(currentCase.quote.id);
                $("sim-notice").innerHTML = `<div class="notice ok"><strong>Saved</strong>A new quote version was recorded.</div>`;
            } catch (e) {
                $("sim-notice").innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
            }
        });

        document.querySelectorAll("[data-task]").forEach((btn) =>
            btn.addEventListener("click", async () => {
                const id = btn.dataset.task;
                const outcome = btn.dataset.outcome;
                const note = $("note-" + id)?.value || null;
                document.querySelectorAll("[data-task]").forEach((b) => (b.disabled = true));
                $("task-notice").innerHTML = `<div class="notice ok">Working…</div>`;
                try {
                    await api(`/api/tasks/${id}/complete`, { method: "POST", body: { outcome, note } });
                    await openCase(currentCase.quote.id);
                    $("task-notice").innerHTML = `<div class="notice ok"><strong>Done</strong>The process moved on.</div>`;
                } catch (e) {
                    document.querySelectorAll("[data-task]").forEach((b) => (b.disabled = false));
                    $("task-notice").innerHTML = `<div class="notice error"><strong>That didn't work</strong>${esc(e.message)}</div>`;
                }
            })
        );
    }

    async function escalate() {
        try {
            await api(`/api/cases/${currentCase.quote.id}/escalate`, { method: "POST" });
            await openCase(currentCase.quote.id);
            $("task-notice").innerHTML =
                `<div class="notice ok"><strong>Escalated</strong>A supervisor now has a task to approve this discount.</div>`;
        } catch (e) {
            $("sim-notice").innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
        }
    }

    /* ----------------------------------------------------------- portfolio */

    async function loadPortfolio() {
        try {
            const p = await api("/api/portfolio");
            const total = p.byState.reduce((a, s) => a + s.count, 0);
            const accepted = p.byState.find((s) => s.state === "ACCEPTED")?.count || 0;
            $("portfolio-stats").innerHTML = `
        <div class="stat"><div class="n">${total}</div><div class="l">quotes</div></div>
        <div class="stat"><div class="n">${accepted}</div><div class="l">accepted</div></div>
        <div class="stat"><div class="n">${total ? Math.round((accepted / total) * 100) : 0}%</div><div class="l">conversion</div></div>
        <div class="stat"><div class="n">${p.portfolio.members}</div><div class="l">members covered</div></div>
        <div class="stat"><div class="n">${eur(p.portfolio.subscription_revenue)}</div><div class="l">subscription / month</div></div>
        <div class="stat"><div class="n">${eur(p.portfolio.premium_volume)}</div><div class="l">premium / month</div></div>`;

            $("portfolio-rows").innerHTML = p.quotes.map((q) => `
        <tr class="clickable" data-quote="${q.id}">
          <td>${esc(q.reference)}</td>
          <td>${esc(q.company)}</td>
          <td><span class="badge">${esc(q.industry)}</span></td>
          <td class="num">${q.headcount}</td>
          <td class="num">${q.z == null ? "—" : Math.round((1 - q.z) * 100) + "%"}</td>
          <td class="num">${eur(q.monthlyTotal)}</td>
          <td><span class="badge ${stateClass(q.state)}">${esc(q.state.toLowerCase().replace(/_/g, " "))}</span></td>
        </tr>`).join("");
            $("portfolio-rows").querySelectorAll("tr.clickable").forEach((tr) =>
                tr.addEventListener("click", () => openCase(tr.dataset.quote))
            );
        } catch (e) {
            if (e.status === 401) return showLogin();
            $("portfolio-rows").innerHTML = `<tr><td colspan="7" class="notice error">${esc(e.message)}</td></tr>`;
        }
    }

    /* --------------------------------------------------------------- boot */

    api("/api/me")
        .then((r) => { me = r; start(); })
        .catch(() => showLogin());
})();
