# Assurance

A working demo insurance company. Five Node.js/Express microservices, one Postgres, a
public quote form, and a back office where an employee turns a request into a quote and
sends it — with OpenTelemetry throughout and Grafana dashboards that show the business
model, not just the CPU.

---

## Quick start

### Docker Compose

```sh
make up        # build and start everything (~2 min cold)
make demo      # create the three scripted demo cases
make seed      # load a 100-organisation portfolio so the dashboards mean something
make smoke     # run one quote end to end and assert all 15 steps
make traffic   # steady trickle of new quotes — leave running during a demo
```

| | |
|---|---|
| **Public quote form** | <http://localhost:3001> |
| **Back office** | <http://localhost:3005> — `alice@assurance.demo` / `demo` |
| **Grafana** | <http://localhost:3000> — folder *Assurance* |
| **Mailpit** (watch the email arrive) | <http://localhost:8025> |
| **Alloy** | <http://localhost:12345> |

### Kubernetes

Assumes the cluster already runs Grafana Alloy and that `kubectl` points at it.

```sh
make push          # build and push alainpham/<service> to Docker Hub (once)
make k8s-deploy    # apply the manifests and wait for the rollouts
make k8s-demo      # the three scripted demo cases
make k8s-seed      # the 100-organisation portfolio
make k8s-smoke     # the same 15 assertions, against the cluster

make k8s-traffic   # steady trickle — leave this running in one terminal
make k8s-forward   # and this in another, to browse the apps
```

`make k8s-traffic` and `make k8s-forward` both hold the terminal open, so run them
separately. Everything else brings its own port-forward up and tears it down again.

Once `k8s-forward` is running, the apps are on the **same localhost ports as Compose**
(3001 public form, 3005 back office, 8025 Mailpit) — so the links above work unchanged.
Telemetry goes to the Alloy already in your cluster; import the dashboards from
`observability/grafana/dashboards/` into your own Grafana to see the business panels.

Heavier load, either runtime:

```sh
make load               make k8s-load             # k6, 3 min at 3 rps
make load RPS=60        make k8s-load RPS=60      # push it
make chaos-on           make k8s-chaos-on         # degrade pricing-service
```

Sign-ins, all with password `demo`:

| User | Role | Can discount the subscription by | Has waiting |
|---|---|---|---|
| `alice@assurance.demo` | advisor | 5% | contact and send tasks |
| `bruno@assurance.demo` | actuary | 15% | the referred quotes |
| `chloe@assurance.demo` | supervisor | 100% | escalated discounts |

---

## The business model, in one screen

Two lines on every quote, kept deliberately apart:

```
   PREMIUM        pays claims.       Target margin: zero. Priced to break even.
   SUBSCRIPTION   per member/month.  This is the revenue.
```

```js
// pricing-service/server/pricing.js
const Z = Math.min(1, Math.sqrt(memberYears / 3000));   // 0 for a first-year client
const expectedClaims = Z * ownClaimsPerMember + (1 - Z) * peerClaimsPerMember;
const premium = expectedClaims * coverageFactor / 12 * (1 + TAX);
const subscription = SUBSCRIPTION_GRID[sizeBand];
```

Two rules the code enforces, because they *are* the business model:

1. **Discounts apply to the subscription only.** Ask to discount the premium and you get
   `422 premium_not_discountable` — from the API *and* through the back-office UI.
2. **Every price carries its inputs, its `Z`, and its breakdown**, so any number can be
   explained to the organisation paying it.

A 12-person startup in year one gets `Z = 0` — fully pooled, so one hospital stay cannot
blow up its price. A 400-person manufacturer with four years of history gets `Z = 0.73`.
Seeded across a real portfolio the pattern is visible on the dashboard:

```
micro  (1–9)      Z 0.01        small  (10–49)    Z 0.04
medium (50–249)   Z 0.13        large  (250+)     Z 0.30
```

---

## The five services

Generated from the `njsexpress` template, so they all share the same shape:
`server/server.js`, a `public/` folder, port 8080 in the container, OpenTelemetry via
`NODE_OPTIONS`.

| Service | Host port | Responsibility |
|---|---|---|
| **quote-service** | 3001 | Public API + serves the public site. Owns organisations, requests, quotes, and the state machine. |
| **pricing-service** | 3002 | The business model. `Z`, expected claims, premium, subscription. Also the demo's chaos target. |
| **workflow-service** | 3003 | The business process: routing, employee tasks, 30s timer tick. |
| **notification-service** | 3004 | Quote PDF (pdfkit) and email (nodemailer → Mailpit). |
| **backoffice-service** | 3005 | Employee API + back-office UI. Login, tasks, pricing workbench, send. |

No API gateway: each Express app serves its own frontend, so everything is same-origin
and there is no CORS or proxy to explain.

### The process

```
request ──> price ──> [review by actuary] ──> contact ──> send ──> accepted
                │                                 │          │
        out of appetite                      abandoned    expired / refused
```

Routing is decided in `workflow-service/server/process.js`: under 250 members with
standard cover goes straight through; 250+ or `Z > 0.5` goes to an actuary first.

---

## Try it by hand

```sh
# price an organisation
curl -s localhost:3002/price -H 'content-type: application/json' -d '{
  "industry": "tech", "headcount": 12, "coverageLevel": "comfort",
  "ageMix": { "under30": 5, "from30to50": 6, "over50": 1 },
  "compositionMix": { "individual": 7, "couple": 3, "family": 2 }
}' | jq '{z, premiumPerMemberMonth, subscriptionPerMemberMonth, rationale}'

# the business model, refusing to be discounted
curl -s -o /dev/null -w '%{http_code}\n' localhost:3002/price/simulate \
  -H 'content-type: application/json' -d '{"industry":"tech","headcount":12,"premiumDiscountPct":10}'
# -> 422

# the state machine, refusing an illegal jump
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH localhost:3001/internal/quotes/1/state \
  -H 'content-type: application/json' -d '{"to":"ACCEPTED"}'
# -> 409

# the employee work queue
curl -s 'localhost:3003/tasks?role=actuary' | jq '.[] | {type, title, quote_reference}'
```

---

## Observability

Every service auto-instruments through `@opentelemetry/auto-instrumentations-node`, and
the public site loads **Grafana Faro** from a CDN. Faro propagates `traceparent` on
`fetch`, so **a click in the browser and its backend trace are one trace** — that is the
best thing in the demo.

```
services ──OTLP──┐
                 ├──> Grafana Alloy ──> Mimir / Loki / Tempo ──> Grafana
browser ──Faro───┘
```

Three provisioned dashboards in the **Assurance** folder:

1. **Business model** — subscription revenue vs premium volume, pooling weight `Z` by
   company size, average premium by industry, premium discounts refused.
2. **Sales funnel** — quotes by state, conversion, time to a priced quote, open tasks by
   role, how cases are routed.
3. **Service health** — RED metrics per service, `pricing-service` latency percentiles,
   and a log panel where every line carries its `trace_id`.

Business metrics are emitted as real OTel instruments (`assurance.*`), not scraped from
logs. Portfolio gauges query Postgres on each collection, so they reflect the actual
state of the system.

### Generating load

Four ways, smallest to largest.

| | What it does | When |
|---|---|---|
| `make seed` | 100 organisations through the real APIs, ~10s, then stops | Fill an empty dashboard before a demo |
| `make traffic` | Endless trickle, ~1 request every 4s, drives some cases through to a decision | Leave running during a demo so the charts keep moving |
| `make load-quick` | k6, 30s at 3 rps | Sanity-check that load works |
| `make load` | k6, 3 minutes at 3 rps | The real load demo |

```sh
make traffic                      # ctrl-c to stop
RATE_MS=1500 make traffic         # faster
DRIVE=0 make traffic              # submit only — let the employee queue pile up

make load                         # 3 min at 3 rps
make load RPS=60                  # push it
make load-quick RPS=40            # 30s version
```

`make traffic` needs nothing installed — it is plain Node against the public API, and it
advances a random share of cases through review, contact, send and acceptance, so the
funnel keeps a realistic shape instead of everything piling up in one state.

`make load` is [k6](https://k6.io), hitting `POST /api/quote-requests` with a ramping
arrival rate. Every submission runs the full process: pricing, quote creation, task
creation.

**The default is 3 rps on purpose.** That is enough to keep the dashboards moving and a
steady stream of traces flowing, without burying the three demo cases under thousands of
synthetic ones — at 20 rps a five-minute demo leaves you hunting for the interesting
quote. Raise `RPS` when the point is throughput rather than storytelling.

Measured here at the default: **2.5 submissions/s, 3.2 HTTP req/s, p95 7.5 ms, 0
failures**.

### Chaos

```sh
make chaos-on    # pricing-service: ~900ms added latency, 10% errors
make load RPS=60
make chaos-off
```

Watch the funnel dashboard degrade and the traces go red on exactly one span,
`pricing.compute`. Measured under chaos: ~983 ms average, ~8% of calls failing.

---

## Kubernetes

Assumes the cluster already runs Grafana Alloy (the `k8s-monitoring` chart) and pulls
images from Docker Hub. No registry, no LGTM, no NodePort, no Ingress — just Deployments,
ClusterIP Services, Postgres and Mailpit.

```sh
make push          # build, tag and push alainpham/<service>:{demo,latest}
make k8s-deploy    # apply everything and wait for the rollouts
make k8s-forward   # port-forward onto the compose ports — this is your local access
make k8s-smoke     # the same 15-step test, against the cluster
make k8s-delete
```

| Target | |
|---|---|
| `push` / `tag` | build+tag+push all five images / tag only |
| `k8s-status` | pods and services |
| `k8s-logs` | tail all five services at once |
| `k8s-restart` | roll the deployments to pick up a new image |
| `k8s-forward` | hold the port-forwards open for browsing |
| `k8s-smoke` / `k8s-seed` / `k8s-demo` | run the scripts against the cluster |
| `k8s-chaos-on` / `k8s-chaos-off` / `k8s-load` / `k8s-traffic` | the ops targets, against the cluster |

### Images

```sh
make push                                   # alainpham/<service>:demo and :latest
make push IMAGE_TAG=v2                      # alainpham/<service>:v2 and :latest
make push IMAGE_PREFIX=ghcr.io/you          # somewhere else
make push IMAGE_TAGS=demo                   # don't touch the :latest tag
```

`push` depends on `build` and `tag`, so it always ships what is in the working tree.
Needs `docker login` first.

### Telemetry

`OTEL_EXPORTER_OTLP_ENDPOINT` points at the receiver already in the cluster:

```
http://grafana-k8s-monitoring-alloy-receiver.default.svc.cluster.local:4318
```

Nothing observability-related is deployed by this repo on Kubernetes — the dashboards in
`observability/grafana/dashboards/` are still provisioned by docker-compose, and you would
import them into your own Grafana. The `assurance.*` business metrics, the traces and the
`trace_id`-tagged logs all flow to your Alloy unchanged.

### Access, and why there is no Ingress

`make k8s-forward` port-forwards the services onto the **same localhost ports
docker-compose uses**, so every URL, script and bookmark works against either runtime
without changing anything:

```
quote-service 3001 · pricing 3002 · workflow 3003 · notification 3004
backoffice 3005 · mailpit 8025
```

That is also why `scripts/lib.js` needs no cluster-specific configuration, and why
`k8s-smoke`, `k8s-seed`, `k8s-load` and friends are just the normal targets wrapped in
`scripts/k8s-forward.sh --run`. Nothing is exposed cluster-side, so nothing needs cleaning
up afterwards.

Three URLs go to a *browser* rather than being called server-side — the magic link in the
quote email, the PDF download, and the Faro collector. Those cannot use in-cluster DNS, so
they live in `k8s/01-endpoints.yaml`, defaulted to the port-forward addresses. If you
expose the apps through your own ingress, that ConfigMap is the only edit needed.

### Manifests

Each service keeps its own `deploy.yaml` next to its code, the way `njsexpress` generates
it — Deployment plus ClusterIP Service, with the env wiring and `/health` probes filled in.
Everything else is three files:

```
k8s/00-namespace.yaml   k8s/01-endpoints.yaml   k8s/10-postgres.yaml   k8s/20-mailpit.yaml
```

Postgres is a StatefulSet with a PVC; the PDF store has one too.

---

## Repository layout

```
.
├── quote-service/          # 1. public API + public site
├── pricing-service/        # 2. the business model
├── workflow-service/       # 3. the business process
├── notification-service/   # 4. PDF + email
├── backoffice-service/     # 5. employee API + UI
├── k8s/                    # namespace, endpoints, postgres, mailpit
├── scripts/                # smoke, seed, demo cases, traffic, k8s port-forward
├── observability/
│   ├── alloy/config.alloy
│   └── grafana/dashboards/ # provisioned JSON
├── load/                   # k6
├── docker-compose.yml
├── Makefile
└── ARCHITECTURE.md
```

Each service is standalone — its own `package.json`, `node_modules` and Dockerfile —
exactly as `njsexpress <name>` generates it. `server/log.js` and `server/db.js` are
duplicated across services on purpose: a shared library would couple them, and the
duplication is about forty lines.

### Adding a sixth service

```sh
njsexpress contract-service
```

Then add `pg` to its `package.json`, copy `server/log.js` and `server/db.js` from a
neighbour, change the schema name, and add it to `docker-compose.yml` with the same
`x-otel` and `x-db` anchors. It shows up in Grafana with no further work.

---

## Local development

```sh
cd pricing-service
npm install
npm run dev      # --watch + browser live-reload from the template
```

Point it at the compose Postgres with
`DATABASE_URL=postgres://assurance:assurance@localhost:5432/assurance`.

---

## Make targets

| | |
|---|---|
| `make up` | build and start everything, then wait for health |
| `make down` / `make clean` | stop / stop and delete the data volumes |
| `make demo` | the three scripted demo cases |
| `make seed` | 100-organisation portfolio (`SEED_COUNT=n` to change) |
| `make smoke` | 15-step end-to-end assertion run |
| `make tick` | run the workflow timer sweep now instead of waiting 30s |
| `make chaos-on` / `chaos-off` | degrade and restore `pricing-service` |
| `make logs` | tail the five services |

---

## What this is not

A demo, not a reference architecture. Deliberately absent, and why:

| Not here | What you'd add for real |
|---|---|
| Message broker | Kafka/NATS between quote and workflow; here it is a direct HTTP call |
| Workflow engine | Temporal or Camunda; here it is a state machine and a 30s tick |
| Real auth | Keycloak/OIDC; here it is three seeded users and a JWT cookie |
| API gateway | Traefik/Kong; here each app serves its own frontend |
| Database per service | One Postgres with a schema per service |
| Real actuarial model | Seeded lookup tables and a square-root credibility formula |
| Loss ratio | Needs a year of claims against active contracts — that is `contract-service`, out of scope |
| **Individual health data** | **The demo holds none.** Workforce data is aggregate counts per age band and household type; there are no claims records. Worth saying out loud to an insurance audience. |
