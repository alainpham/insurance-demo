const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const api = require('@opentelemetry/api');
const axios = require('axios');
const liveReload = require('./livereload');
const piiLogger = require('./piiLogger');

// add the prometheus middleware to all routes
const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");

// Middleware
app.use(bodyParser.json());

liveReload.attach(app, PUBLIC_DIR); // dev only, no-op unless LIVERELOAD=1
app.use(express.static(PUBLIC_DIR)); // Serve static files


app.get("/ping", (req, res) => {
    traceIdString = getCurrentTraceIdString();
    console.log(traceIdString+"Received ping");
    res.status(200).json({ message: "pong" });
});

app.get("/api/logs", (req, res) => {
    res.status(200).json(piiLogger.listRecent());
});

app.get("/api/logs/:hash", (req, res) => {
    const entry = piiLogger.getByHash(req.params.hash);
    if (!entry) {
        return res.status(404).json({ message: "No log entry found for that sha256 hash" });
    }
    res.status(200).json(entry);
});

// Start the server
server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

const piiLoggerInterval = piiLogger.start(getCurrentTraceIdString);

//gracefull shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received.');
    clearInterval(piiLoggerInterval);
    liveReload.closeStreams();
    server.close(() => {
        console.log('Closed out remaining connections');
        // Additional cleanup tasks go here
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received.');
    clearInterval(piiLoggerInterval);
    liveReload.closeStreams();
    server.close(() => {
        console.log('Closed out remaining connections');
        // Additional cleanup tasks go here
    });
});

function getCurrentTraceIdString(){
    let current_span = api.trace.getSpan(api.context.active());
    let traceIdString = "";
    if (current_span) {
        traceIdString = "trace_id="+current_span.spanContext().traceId + " ";
    }
    return traceIdString;
}