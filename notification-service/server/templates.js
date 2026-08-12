const eur = (n) =>
    new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(Number(n) || 0);

const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function shell(body) {
    return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7faf9;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#16241f;line-height:1.55">
      <div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #e2e8e5;border-radius:12px;overflow:hidden">
        <div style="background:#0f766e;color:#fff;padding:20px 28px">
          <div style="font-size:20px;font-weight:700">Assurance</div>
          <div style="font-size:13px;opacity:.85">Health cover for your team, priced to break even.</div>
        </div>
        <div style="padding:28px">${body}</div>
        <div style="padding:16px 28px;border-top:1px solid #e2e8e5;color:#5b6b64;font-size:11px">
          Assurance is a demo application. No real insurance is sold and no personal health data is collected.
        </div>
      </div></body></html>`;
}

const button = (href, label) =>
    `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#0f766e;color:#fff;text-decoration:none;
      padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;

function priceBlock(p) {
    if (!p) return "";
    return `
    <table style="width:100%;border-collapse:collapse;margin:20px 0">
      <tr><td style="padding:12px;background:#f8fafc;border-radius:8px 8px 0 0">
        <strong>Insurance premium</strong><br>
        <span style="color:#5b6b64;font-size:12px">Covers expected claims. Priced to break even — no margin.</span>
      </td><td style="padding:12px;background:#f8fafc;text-align:right;font-size:18px;font-weight:700">
        ${eur(p.premiumPerMemberMonth)}</td></tr>
      <tr><td style="padding:12px;background:#ccfbf1">
        <strong>Assurance subscription</strong><br>
        <span style="color:#5b6b64;font-size:12px">Our fee, per member per month.</span>
      </td><td style="padding:12px;background:#ccfbf1;text-align:right;font-size:18px;font-weight:700">
        ${eur(p.subscriptionPerMemberMonth)}</td></tr>
      <tr><td style="padding:12px;background:#16241f;color:#fff;border-radius:0 0 0 8px">
        <strong>Total per member, per month</strong>
      </td><td style="padding:12px;background:#16241f;color:#fff;text-align:right;font-size:18px;font-weight:700;border-radius:0 0 8px 0">
        ${eur(p.totalPerMemberMonth)}</td></tr>
    </table>`;
}

const TEMPLATES = {
    quote: (d) => ({
        subject: `Your Assurance quote for ${d.company} — ${d.reference}`,
        html: shell(`
      <p>Hello ${esc(d.name)},</p>
      <p>Thank you for your time. Here is the quote for <strong>${esc(d.company)}</strong>.</p>
      ${priceBlock(d.pricing)}
      <p style="color:#5b6b64;font-size:13px">
        ${esc((d.pricing?.rationale || [])[0] || "")}
      </p>
      ${d.link ? button(d.link, "View and accept your quote") : ""}
      ${d.documentUrl ? `<p style="font-size:13px"><a href="${esc(d.documentUrl)}" style="color:#0f766e">Download the quote as a PDF</a></p>` : ""}
      <p style="color:#5b6b64;font-size:13px">This quote is valid for 60 days. Reply to this email if anything needs changing.</p>
      <p>— Your Assurance advisor</p>`),
    }),

    follow_up: (d) => ({
        subject: `Still thinking it over? Your quote ${d.reference}`,
        html: shell(`
      <p>Hello ${esc(d.name)},</p>
      <p>Just a quick note about the quote we sent for <strong>${esc(d.company)}</strong>. It is still open,
         and your advisor is happy to walk through anything that isn't clear — including exactly how the
         premium was calculated.</p>
      ${d.link ? button(d.link, "Open your quote") : ""}
      <p>— Your Assurance advisor</p>`),
    }),

    decline: (d) => ({
        subject: `About your request ${d.reference}`,
        html: shell(`
      <p>Hello ${esc(d.name)},</p>
      <p>Thank you for thinking of us for <strong>${esc(d.company)}</strong>. Having looked at the details,
         we are not able to offer cover on this occasion — the expected claims for this profile sit outside
         what we can price sustainably.</p>
      <p>We would rather tell you that plainly than quote a price we could not hold.</p>
      <p>— The Assurance team</p>`),
    }),

    expiring: (d) => ({
        subject: `Your quote ${d.reference} expires soon`,
        html: shell(`
      <p>Hello ${esc(d.name)},</p>
      <p>Your quote for <strong>${esc(d.company)}</strong> expires in a week. After that we would need to
         re-price, which takes a minute but may give a different number.</p>
      ${d.link ? button(d.link, "Open your quote") : ""}
      <p>— Your Assurance advisor</p>`),
    }),
};

function build(kind, data) {
    const t = TEMPLATES[kind];
    if (!t) throw new Error(`unknown template "${kind}"`);
    return t(data);
}

module.exports = { build, KINDS: Object.keys(TEMPLATES) };
