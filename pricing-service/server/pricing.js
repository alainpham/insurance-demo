// The business model, in one file.
//
//   PREMIUM      -> pays claims. Target margin: zero. Priced to break even.
//   SUBSCRIPTION -> per member per month. This is the revenue.
//
// Two rules the code enforces, because they *are* the business model:
//   1. Discounts apply to the subscription only (see server.js -> 422).
//   2. Every price carries its inputs, its Z and its breakdown, so it can be
//      explained to the organisation that pays it.

const reference = require("./data/reference.json");

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n) => Math.round(n * 100);

function sizeBandOf(headcount) {
    if (headcount < 10) return "micro";
    if (headcount < 50) return "small";
    if (headcount < 250) return "medium";
    return "large";
}

// Normalise a {under30, from30to50, over50} mix to fractions summing to 1.
function normaliseMix(mix, keys) {
    const clean = {};
    let total = 0;
    for (const k of keys) {
        const v = Math.max(0, Number(mix?.[k] ?? 0));
        clean[k] = v;
        total += v;
    }
    if (total === 0) {
        // No mix supplied: assume an even spread rather than failing.
        for (const k of keys) clean[k] = 1 / keys.length;
        return clean;
    }
    for (const k of keys) clean[k] = clean[k] / total;
    return clean;
}

/**
 * Credibility factor Z — how much of the organisation's own claims history we
 * trust. Limited-fluctuation credibility, capped at 1.
 *
 * A first-year client has zero exposure, so Z = 0: fully pooled, and one
 * hospital stay cannot blow up its price.
 */
function credibility(headcount, clientYears) {
    const memberYears = Math.max(0, headcount) * Math.max(0, clientYears || 0);
    const z = Math.min(1, Math.sqrt(memberYears / reference.fullCredibilityMemberYears));
    return { z: Math.round(z * 1000) / 1000, memberYears };
}

function price(input) {
    const {
        industry = "other",
        headcount = 1,
        ageMix,
        compositionMix,
        coverageLevel = "comfort",
        clientYears = 0,
        ownClaimsPerMember = null,
        subscriptionDiscountPct = 0,
        premiumDiscountPct = 0,
    } = input;

    const peer = reference.industries[industry] || reference.industries.other;
    const level = reference.coverageLevels.find((l) => l.code === coverageLevel)
        || reference.coverageLevels.find((l) => l.code === "comfort");
    const band = sizeBandOf(headcount);

    const ages = normaliseMix(ageMix, ["under30", "from30to50", "over50"]);
    const comps = normaliseMix(compositionMix, ["individual", "couple", "family"]);

    // --- expected claims, per individual member, per year -------------------
    const ageFactor =
        ages.under30 * reference.ageFactors.under30 +
        ages.from30to50 * reference.ageFactors.from30to50 +
        ages.over50 * reference.ageFactors.over50;

    const peerClaims = peer.annualClaimsEur * ageFactor;

    const { z, memberYears } = credibility(headcount, clientYears);
    const own = ownClaimsPerMember == null ? null : Number(ownClaimsPerMember);
    // With no history there is nothing to blend, so the peer group carries it all.
    const expectedClaims = own == null ? peerClaims : z * own + (1 - z) * peerClaims;

    // --- premium ------------------------------------------------------------
    const tax = reference.insurancePremiumTax;
    const handling = reference.claimsHandlingRatio;
    const coveredClaims = expectedClaims * level.factor;
    const premiumIndividual = (coveredClaims * (1 + handling)) / 12 * (1 + tax);

    const rateTable = Object.entries(reference.compositionFactors).map(([code, c]) => ({
        composition: code,
        label: c.label,
        share: pct(comps[code]),
        premiumPerMonth: round2(premiumIndividual * c.factor),
    }));

    const compositionFactor =
        comps.individual * reference.compositionFactors.individual.factor +
        comps.couple * reference.compositionFactors.couple.factor +
        comps.family * reference.compositionFactors.family.factor;

    const avgPremium = premiumIndividual * compositionFactor;

    // --- subscription: the revenue line, and the only discountable one ------
    const grid = reference.subscriptionGrid[band];
    const subDiscount = Math.min(100, Math.max(0, Number(subscriptionDiscountPct) || 0));
    const subscriptionList = grid.eurPerMember;
    const subscription = subscriptionList * (1 - subDiscount / 100);

    const perMember = avgPremium + subscription;
    const monthlyTotal = perMember * headcount;

    // --- explainability -----------------------------------------------------
    const rationale = [];
    if (z === 0) {
        rationale.push(
            `New client with no claims history: the price is 100% pooled with comparable organisations.`
        );
    } else {
        rationale.push(
            `${headcount} members over ${clientYears} year(s) = ${Math.round(memberYears)} member-years of exposure, ` +
            `so ${pct(z)}% of the price comes from this organisation's own claims and ${pct(1 - z)}% is pooled.`
        );
    }
    rationale.push(`Peer group: ${peer.label}, ${grid.label}.`);
    rationale.push(
        `Age mix ${pct(ages.under30)}% under 30 / ${pct(ages.from30to50)}% 30–50 / ${pct(ages.over50)}% over 50 ` +
        `gives an age factor of ${round2(ageFactor)}.`
    );
    rationale.push(`Coverage "${level.label}" applies a factor of ${level.factor}.`);
    rationale.push(`The premium targets a 100% loss ratio — there is no margin in it.`);
    if (subDiscount > 0) {
        rationale.push(`A ${subDiscount}% commercial discount is applied to the subscription only.`);
    }

    const breakdown = [
        { label: "Peer group expected claims (per member/year)", value: round2(peerClaims) },
        { label: "Own experience (per member/year)", value: own == null ? null : round2(own) },
        { label: "Credibility factor Z", value: z },
        { label: "Blended expected claims (per member/year)", value: round2(expectedClaims) },
        { label: `Coverage factor (${level.label})`, value: level.factor },
        { label: "Claims handling", value: `${pct(handling)}%` },
        { label: "Insurance premium tax", value: `${round2(tax * 100)}%` },
        { label: "Premium — individual (per month)", value: round2(premiumIndividual) },
        { label: "Premium — average across the workforce (per month)", value: round2(avgPremium) },
        { label: `Subscription list price (${grid.label})`, value: round2(subscriptionList) },
        { label: "Subscription after discount", value: round2(subscription) },
    ];

    const outOfAppetite = expectedClaims > reference.appetite.maxAnnualClaimsPerMember
        || reference.appetite.excludedIndustries.includes(industry);

    return {
        inputs: {
            industry, headcount, coverageLevel: level.code, clientYears,
            ownClaimsPerMember: own, ageMix: ages, compositionMix: comps,
            subscriptionDiscountPct: subDiscount, premiumDiscountPct: Number(premiumDiscountPct) || 0,
        },
        sizeBand: band,
        peerGroup: { industry, label: peer.label },
        z,
        memberYears: Math.round(memberYears),
        expectedClaimsPerMemberYear: round2(expectedClaims),
        peerClaimsPerMemberYear: round2(peerClaims),
        coverage: { code: level.code, label: level.label, factor: level.factor, benefits: level.benefits },
        premiumPerMemberMonth: round2(avgPremium),
        subscriptionPerMemberMonth: round2(subscription),
        subscriptionListPerMemberMonth: round2(subscriptionList),
        totalPerMemberMonth: round2(perMember),
        monthlyTotal: round2(monthlyTotal),
        annualTotal: round2(monthlyTotal * 12),
        rateTable,
        breakdown,
        rationale,
        outOfAppetite,
    };
}

module.exports = { price, credibility, sizeBandOf, reference };
