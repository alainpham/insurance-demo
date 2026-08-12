# personal-info-logger

This README provides instructions to build and run the personal-info-logger using Docker.

## env vars for otel

```bash 
# exporter options are otlp, console, none
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="personal-info-logger"
export NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
```

## Prerequisites

- Docker installed on your machine
- Docker Compose installed on your machine

## Running locally for dev

```sh
npm install 
npm start
```

To auto-restart the server whenever a file under `server/` or `public/` changes,
and auto-reload the browser tab with it:

```sh
npm run dev
```

The browser reload uses a `/__livereload` SSE endpoint plus a small script
injected into served HTML. Both are gated behind `LIVERELOAD=1`, which only
`npm run dev` sets — `npm start` and the container image are untouched.


## Building the Docker Image

To build the Docker image for the personal-info-logger, run the following command:

```sh
docker rmi alainpham/personal-info-logger
docker build -t alainpham/personal-info-logger .
```

## Pushing to repository

```sh
docker push alainpham/personal-info-logger
```

## Running the Docker Container

The image bundles a Grafana Alloy instance that tails the app's `logs/pii.log`
and ships it to Loki, configured via env vars:

```sh
docker run -d -p 8080:8080 --name personal-info-logger \
  -e LOKI_ENDPOINT="https://logs-prod-XXX.grafana.net/loki/api/v1/push" \
  -e LOKI_USER="<instance id>" \
  -e LOKI_PASSWORD="<grafana cloud api key>" \
  alainpham/personal-info-logger:latest
```

## Stopping the Docker Container

To stop the running container, use the following command:

```sh
docker stop personal-info-logger
```

## Removing the Docker Container

To remove the stopped container, use the following command:

```sh
docker rm personal-info-logger
```

## Deploy on kube

```sh
kubectl create ns apps
kubectl -n apps apply -f deploy.yaml
```