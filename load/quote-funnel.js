// k6 load script for the public quote funnel.
//
//   k6 run load/quote-funnel.js                 # 3 rps for 3 minutes
//   k6 run -e RPS=60 load/quote-funnel.js       # push it
//   k6 run -e QUICK=1 load/quote-funnel.js      # same shape, 30 seconds
//
// The default is deliberately gentle: 3 requests a second is enough to keep the
// dashboards alive and the traces flowing during a demo, without burying the
// interesting cases under thousands of synthetic ones. Raise RPS when the point
// is throughput rather than storytelling.
//
// Pair with `make chaos-on` to watch the funnel degrade and the traces go red
// on pricing.compute.
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3001";
const RPS = Number(__ENV.RPS || 3);
// QUICK=1 runs a 30-second version instead of the full 3-minute ramp.
const QUICK = __ENV.QUICK === "1";

// Ramp to RPS, hold, ramp down. Every stage is expressed in terms of RPS so the
// shape holds whether you run the default 3 or override it to 60.
const STAGES = QUICK
    ? [
        { target: RPS, duration: "10s" },
        { target: RPS, duration: "15s" },
        { target: 1, duration: "5s" },
    ]
    : [
        { target: RPS, duration: "30s" },
        { target: RPS, duration: "2m" },
        { target: 1, duration: "30s" },
    ];

const submitDuration = new Trend("assurance_submit_duration");
const submitFailed = new Rate("assurance_submit_failed");

export const options = {
    scenarios: {
        funnel: {
            executor: "ramping-arrival-rate",
            startRate: 1,
            timeUnit: "1s",
            // Sized for the default 3 rps; the headroom is there so `RPS=60`
            // doesn't need a second set of numbers.
            preAllocatedVUs: 10,
            maxVUs: 120,
            stages: STAGES,
        },
    },
    thresholds: {
        // Deliberately generous: under `make chaos-on` these SHOULD go red.
        http_req_failed: ["rate<0.05"],
        "http_req_duration{expected_response:true}": ["p(95)<1500"],
    },
};

const INDUSTRIES = ["tech", "professional_services", "retail", "manufacturing", "healthcare", "construction", "hospitality", "other"];
const COVERAGE = ["essential", "comfort", "premium"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export default function () {
    const headcount = Math.random() < 0.8 ? between(4, 120) : between(121, 900);
    const under30 = between(10, 50);
    const over50 = between(5, 35);
    const i = between(1, 1e9);

    const payload = {
        companyName: `Loadtest ${i}`,
        industry: pick(INDUSTRIES),
        headcount,
        yearFounded: between(1990, 2025),
        coverageLevel: pick(COVERAGE),
        ageMix: { under30, from30to50: 100 - under30 - over50, over50 },
        compositionMix: { individual: between(30, 60), couple: between(15, 35), family: between(10, 35) },
        contactName: `Load Tester ${i}`,
        contactEmail: `load.${i}@example.test`,
        contactPhone: "+33 1 00 00 00 00",
    };

    const res = http.post(`${BASE}/api/quote-requests`, JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
        tags: { name: "POST /api/quote-requests" },
    });

    submitDuration.add(res.timings.duration);
    submitFailed.add(res.status !== 202);
    check(res, {
        "request accepted (202)": (r) => r.status === 202,
        "reference returned": (r) => {
            try { return Boolean(r.json("reference")); } catch (_) { return false; }
        },
    });

    // A few visitors read the coverage table without submitting — that's the
    // funnel leak the Faro dashboard measures.
    if (Math.random() < 0.3) {
        http.get(`${BASE}/api/coverage-levels`, { tags: { name: "GET /api/coverage-levels" } });
    }

    sleep(0.2);
}
