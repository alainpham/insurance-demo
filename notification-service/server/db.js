const { Pool } = require("pg");
const log = require("./log");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
        || "postgres://assurance:assurance@localhost:5432/assurance",
    max: 10,
});

const SCHEMA = "notification";

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

CREATE TABLE IF NOT EXISTS ${SCHEMA}.messages (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    subject         TEXT NOT NULL,
    reference       TEXT,
    idempotency_key TEXT UNIQUE,
    status          TEXT NOT NULL,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.documents (
    id              BIGSERIAL PRIMARY KEY,
    quote_id        BIGINT NOT NULL,
    quote_reference TEXT NOT NULL,
    version         INTEGER NOT NULL,
    filename        TEXT NOT NULL,
    bytes           INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (quote_id, version)
);
`;

async function connectWithRetry(attempts = 40, delayMs = 1500) {
    for (let i = 1; i <= attempts; i++) {
        try {
            const c = await pool.connect();
            c.release();
            return;
        } catch (err) {
            if (i === attempts) throw err;
            log.warn(`database not ready, retry ${i}/${attempts}`, { err: err.message });
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

async function init() {
    await connectWithRetry();
    await pool.query(DDL);
    log.info("notification schema ready");
}

module.exports = { pool, query: (t, p) => pool.query(t, p), init, SCHEMA };
