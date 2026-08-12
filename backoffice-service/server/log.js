// Minimal structured logging that carries the current OTel trace id, so log
// lines in Loki pivot straight to the trace in Tempo.
const api = require("@opentelemetry/api");

const SERVICE = process.env.OTEL_SERVICE_NAME || "service";

function traceIds() {
    const span = api.trace.getSpan(api.context.active());
    if (!span) return {};
    const ctx = span.spanContext();
    return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

function emit(level, msg, extra = {}) {
    console.log(JSON.stringify({
        level,
        time: new Date().toISOString(),
        service: SERVICE,
        msg,
        ...traceIds(),
        ...extra,
    }));
}

module.exports = {
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
    // Attach business meaning to the active span. Bucketed values only —
    // unbounded ids belong in logs, never in metric labels.
    annotate(attrs) {
        const span = api.trace.getSpan(api.context.active());
        if (span) span.setAttributes(attrs);
    },
    tracer: api.trace.getTracer(SERVICE),
};
