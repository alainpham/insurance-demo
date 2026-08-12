// Business metrics from the pricing engine. These are what the "Business model"
// dashboard is built from — the model itself, as time series.
const api = require("@opentelemetry/api");

const meter = api.metrics.getMeter("pricing-service");

// Unit is in the metric name rather than the `unit` option: the OTLP->Prometheus
// translation appends the unit as a suffix, which would give us "..._eur_EUR".
const credibilityZ = meter.createHistogram("assurance.pricing.credibility_z", {
    description: "Credibility factor Z — how much of a price comes from the organisation's own claims",
});

const expectedClaims = meter.createHistogram("assurance.pricing.expected_claims_per_member_year_eur", {
    description: "Blended expected claims per member per year",
});

const premiumEur = meter.createHistogram("assurance.pricing.premium_per_member_month_eur", {
    description: "Premium per member per month",
});

const subscriptionEur = meter.createHistogram("assurance.pricing.subscription_per_member_month_eur", {
    description: "Subscription per member per month — the revenue line",
});

const pricingsTotal = meter.createCounter("assurance.pricing.total", {
    description: "Pricings performed",
});

const premiumDiscountRefused = meter.createCounter("assurance.pricing.premium_discount_refused.total", {
    description: "Attempts to discount the premium, refused — the business model enforced in code",
});

function record(result) {
    const labels = {
        size_band: result.sizeBand,
        industry: result.peerGroup?.industry,
        coverage_level: result.coverage?.code,
    };
    credibilityZ.record(result.z, { size_band: result.sizeBand });
    expectedClaims.record(result.expectedClaimsPerMemberYear, labels);
    premiumEur.record(result.premiumPerMemberMonth, labels);
    subscriptionEur.record(result.subscriptionPerMemberMonth, { size_band: result.sizeBand });
    pricingsTotal.add(1, { ...labels, out_of_appetite: String(result.outOfAppetite) });
}

module.exports = { record, premiumDiscountRefused };
