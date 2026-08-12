// Grafana Faro — real user monitoring for the public funnel.
//
// The point of this file: Faro's fetch instrumentation propagates `traceparent`,
// so a click in this browser and the backend trace it causes are the SAME trace.
// Everything is best-effort — if the CDN or the collector is unreachable the
// form still works, it just stops reporting.
(function () {
    const COLLECTOR = window.FARO_URL || "http://localhost:12347/collect";
    const BASE = "https://unpkg.com/@grafana/";
    const SDK = BASE + "faro-web-sdk/dist/bundle/faro-web-sdk.iife.js";
    const TRACING = BASE + "faro-web-tracing/dist/bundle/faro-web-tracing.iife.js";

    // Buffer events raised before Faro finishes loading (or if it never does).
    const queue = [];
    window.track = function (name, attrs) {
        if (window.__faro?.api) window.__faro.api.pushEvent(name, attrs || {});
        else queue.push([name, attrs || {}]);
    };

    function load(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error("failed to load " + src));
            document.head.appendChild(s);
        });
    }

    load(SDK)
        .then(() => load(TRACING).catch(() => null)) // tracing is optional
        .then(() => {
            const faro = window.GrafanaFaroWebSdk.initializeFaro({
                url: COLLECTOR,
                app: { name: "quote-web", version: "1.0.0", environment: "demo" },
                instrumentations: [
                    ...window.GrafanaFaroWebSdk.getWebInstrumentations({ captureConsole: true }),
                    ...(window.GrafanaFaroWebTracing
                        ? [new window.GrafanaFaroWebTracing.TracingInstrumentation()]
                        : []),
                ],
            });
            window.__faro = faro;
            queue.splice(0).forEach(([n, a]) => faro.api.pushEvent(n, a));
            console.log("Faro initialised ->", COLLECTOR);
        })
        .catch((err) => console.warn("Faro unavailable, continuing without RUM:", err.message));
})();
