SHELL := /bin/bash
COMPOSE := docker compose

# --- kubernetes -------------------------------------------------------------
NS ?= assurance
IMAGE_TAG ?= demo
# Images live on Docker Hub. `make k8s-images` builds and pushes them; the
# manifests reference alainpham/<service>:demo.
IMAGE_PREFIX ?= alainpham
# Every image gets each of these tags. `demo` is what the manifests reference;
# `latest` is there so a plain `docker pull alainpham/quote-service` works.
IMAGE_TAGS ?= $(IMAGE_TAG) latest
SERVICES := quote-service pricing-service workflow-service notification-service backoffice-service

# Where the ops targets (chaos, tick, load) point. The k8s-* variants reuse
# these unchanged, because `make k8s-forward` puts the cluster on the same ports.
QUOTE_URL   ?= http://localhost:3001
PRICING_URL ?= http://localhost:3002
WORKFLOW_URL ?= http://localhost:3003

.DEFAULT_GOAL := help

.PHONY: help up down build logs ps seed demo smoke chaos-on chaos-off tick load load-quick \
        traffic clean urls tag push \
        k8s-deploy k8s-images k8s-forward k8s-status k8s-logs k8s-restart \
        k8s-smoke k8s-seed k8s-demo k8s-delete k8s-chaos-on k8s-chaos-off \
        k8s-load k8s-load-quick k8s-traffic k8s-traffic-logs k8s-traffic-stop k8s-traffic-local

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

up: ## Build and start everything
	$(COMPOSE) up -d --build
	@echo "waiting for services..."
	@./scripts/wait-for-health.sh
	@$(MAKE) --no-print-directory urls

down: ## Stop everything
	$(COMPOSE) down

clean: ## Stop everything and delete the data volumes
	$(COMPOSE) down -v

build: ## Rebuild the service images
	$(COMPOSE) build

tag: ## Tag the built images as $(IMAGE_PREFIX)/<service>:{$(IMAGE_TAGS)}
	@for s in $(SERVICES); do \
		docker image inspect assurance-$$s >/dev/null 2>&1 || { \
			echo "  image assurance-$$s not built — run 'make build' first"; exit 1; }; \
		for t in $(IMAGE_TAGS); do \
			docker tag assurance-$$s $(IMAGE_PREFIX)/$$s:$$t || exit 1; \
			echo "  tagged $(IMAGE_PREFIX)/$$s:$$t"; \
		done; \
	done

push: build tag ## Build, tag and push all five images to $(IMAGE_PREFIX)
	@echo "==> pushing to $(IMAGE_PREFIX) as $$(docker system info --format '{{.Username}}' 2>/dev/null || echo '<not logged in>')"
	@for s in $(SERVICES); do \
		for t in $(IMAGE_TAGS); do \
			docker push $(IMAGE_PREFIX)/$$s:$$t || { \
				echo ""; \
				echo "  push failed for $(IMAGE_PREFIX)/$$s:$$t"; \
				echo "  if this is an auth error, run:  docker login"; \
				echo "  to push somewhere else:         make push IMAGE_PREFIX=ghcr.io/you"; \
				exit 1; }; \
		done; \
	done
	@echo ""
	@echo "  pushed: $(foreach s,$(SERVICES),$(IMAGE_PREFIX)/$(s) )"
	@echo "  tags:   $(IMAGE_TAGS)"
	@echo "  next:   make k8s-deploy   (or make k8s-restart if already deployed)"

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Tail the logs of the five services
	$(COMPOSE) logs -f quote-service pricing-service workflow-service notification-service backoffice-service

seed: ## Load the demo portfolio (100 organisations across the funnel)
	node scripts/seed.js

demo: ## Create the three scripted demo cases
	node scripts/demo-cases.js

smoke: ## Run one quote end to end and check every step
	node scripts/smoke.js

chaos-on: ## Make pricing-service slow and flaky
	@curl -s -X POST $(PRICING_URL)/admin/chaos -H 'content-type: application/json' \
		-d '{"latencyMs":900,"errorRate":0.10}' > /dev/null
	@echo "chaos on: pricing-service p99 ~1.4s, 10% errors  ($(PRICING_URL))"

chaos-off: ## Restore pricing-service
	@curl -s -X POST $(PRICING_URL)/admin/chaos -H 'content-type: application/json' \
		-d '{"latencyMs":0,"errorRate":0}' > /dev/null
	@echo "chaos off"

tick: ## Run the workflow timer sweep now instead of waiting 30s
	@curl -s -X POST $(WORKFLOW_URL)/admin/tick > /dev/null && echo "tick done" 

load: ## Run the k6 load script — 3 min at 3 rps (RPS=60 to push it)
	k6 run -e BASE_URL=$(QUOTE_URL) $(if $(RPS),-e RPS=$(RPS)) load/quote-funnel.js

load-quick: ## Same load script, 30 seconds — for a sanity check
	k6 run -e QUICK=1 -e BASE_URL=$(QUOTE_URL) $(if $(RPS),-e RPS=$(RPS)) load/quote-funnel.js

traffic: ## Endless realistic trickle, no k6 needed — leave running during a demo
	node scripts/traffic.js

urls:
	@echo ""
	@echo "  Public quote form   http://localhost:3001"
	@echo "  Back office         http://localhost:3005   (alice@assurance.demo / demo)"
	@echo "  Grafana             http://localhost:3000"
	@echo "  Mailpit             http://localhost:8025"
	@echo "  Alloy               http://localhost:12345"
	@echo ""

# ---------------------------------------------------------------- kubernetes
#
# Assumes the cluster already runs Grafana Alloy (the k8s-monitoring chart) and
# that the images are on Docker Hub. No registry, no LGTM, no NodePort, no
# Ingress — just Deployments, ClusterIP Services, Postgres and Mailpit.
# Local access is `make k8s-forward`, which port-forwards onto the compose ports.

k8s-deploy: ## Deploy to the current kubectl context
	@echo "==> context: $$(kubectl config current-context)   namespace: $(NS)"
	@kubectl apply -f k8s/00-namespace.yaml -f k8s/01-endpoints.yaml
	@kubectl apply -f k8s/10-postgres.yaml -f k8s/20-mailpit.yaml
	@kubectl apply $(foreach s,$(SERVICES),-f $(s)/deploy.yaml)
	@echo "==> waiting for rollouts"
	@kubectl -n $(NS) rollout status statefulset/postgres --timeout=300s
	@for d in mailpit $(SERVICES); do \
		kubectl -n $(NS) rollout status deploy/$$d --timeout=300s || exit 1; \
	done
	@echo ""
	@echo "  deployed. 'make k8s-forward' for local access, 'make k8s-smoke' to verify."
	@echo ""

k8s-images: push ## Alias for `make push`

k8s-forward: ## Port-forward the cluster onto the compose ports (ctrl-c to stop)
	@NS=$(NS) ./scripts/k8s-forward.sh

k8s-restart: ## Roll all five services (picks up a new image)
	@kubectl -n $(NS) rollout restart $(foreach s,$(SERVICES),deploy/$(s))
	@for d in $(SERVICES); do kubectl -n $(NS) rollout status deploy/$$d --timeout=300s; done

k8s-status: ## Show what is running in the cluster
	@kubectl -n $(NS) get pods -o wide
	@echo ""
	@kubectl -n $(NS) get svc

k8s-logs: ## Tail the five services in the cluster
	@kubectl -n $(NS) logs -f --max-log-requests 10 --prefix \
		-l app.kubernetes.io/component=api --tail=20

k8s-smoke: ## Run the end-to-end smoke test against the cluster
	@NS=$(NS) ./scripts/k8s-forward.sh --run "node scripts/smoke.js"

k8s-seed: ## Seed the demo portfolio into the cluster
	@NS=$(NS) ./scripts/k8s-forward.sh --run "node scripts/seed.js"

k8s-demo: ## Create the three scripted demo cases in the cluster
	@NS=$(NS) ./scripts/k8s-forward.sh --run "node scripts/demo-cases.js"

k8s-chaos-on: ## Make pricing-service slow and flaky, in the cluster
	@NS=$(NS) ./scripts/k8s-forward.sh --run "make chaos-on"

k8s-chaos-off: ## Restore pricing-service in the cluster
	@NS=$(NS) ./scripts/k8s-forward.sh --run "make chaos-off"

k8s-load: ## Run the k6 load script against the cluster
	@NS=$(NS) ./scripts/k8s-forward.sh --run "make load $(if $(RPS),RPS=$(RPS))"

k8s-load-quick: ## Same, 30 seconds
	@NS=$(NS) ./scripts/k8s-forward.sh --run "make load-quick $(if $(RPS),RPS=$(RPS))"

k8s-traffic: ## Deploy the steady trickle INTO the cluster (RATE_MS=1500 to speed up)
	@kubectl -n $(NS) create configmap assurance-traffic-scripts \
		--from-file=lib.js=scripts/lib.js \
		--from-file=traffic.js=scripts/traffic.js \
		--dry-run=client -o yaml | kubectl apply -f - >/dev/null
	@kubectl apply -f k8s/30-traffic.yaml
	@kubectl -n $(NS) set env deploy/traffic \
		$(if $(RATE_MS),RATE_MS=$(RATE_MS)) $(if $(DRIVE),DRIVE=$(DRIVE)) \
		RESTARTED_AT=$$(date +%s) >/dev/null
	@kubectl -n $(NS) rollout status deploy/traffic --timeout=180s
	@echo ""
	@echo "  generating traffic inside the cluster. 'make k8s-traffic-logs' to watch,"
	@echo "  'make k8s-traffic-stop' to stop it."
	@echo ""

k8s-traffic-logs: ## Follow the in-cluster traffic generator
	@kubectl -n $(NS) logs -f deploy/traffic --tail=20

k8s-traffic-stop: ## Remove the in-cluster traffic generator
	@kubectl -n $(NS) delete deploy/traffic cm/assurance-traffic-scripts --ignore-not-found
	@echo "  traffic generator removed"

k8s-traffic-local: ## Run the trickle from here instead, through a port-forward
	@NS=$(NS) ./scripts/k8s-forward.sh --run "node scripts/traffic.js"

k8s-delete: ## Delete everything from the cluster
	@kubectl delete namespace $(NS) --ignore-not-found
	@echo "  namespace $(NS) deleted"
