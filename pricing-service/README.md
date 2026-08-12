# pricing-service

This README provides instructions to build and run the pricing-service using Docker.

## env vars for otel

```bash 
# exporter options are otlp, console, none
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="pricing-service"
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

To build the Docker image for the pricing-service, run the following command:

```sh
docker rmi alainpham/pricing-service
docker build -t alainpham/pricing-service .
```

## Pushing to repository

```sh
docker push alainpham/pricing-service
```

## Running the Docker Container

To run the Docker container, use the following command:

```sh
docker run --rm -p 8080:8080 --name pricing-service alainpham/pricing-service
```

## Stopping the Docker Container

To stop the running container, use the following command:

```sh
docker stop pricing-service
```

## Removing the Docker Container

To remove the stopped container, use the following command:

```sh
docker rm pricing-service
```

## Deploy on kube

```sh
kubectl create ns apps
kubectl -n apps apply -f deploy.yaml
```