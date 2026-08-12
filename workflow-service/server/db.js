const { Pool } = require("pg");
const log = require("./log");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
        || "postgres://assurance:assurance@localhost:5432/assurance",
    max: 10,
});

const SCHEMA = "workflow";

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

CREATE TABLE IF NOT EXISTS ${SCHEMA}.workflows (
    id                  BIGSERIAL PRIMARY KEY,
    quote_request_id    BIGINT NOT NULL,
    quote_id            BIGINT,
    quote_reference     TEXT,
    state               TEXT NOT NULL,
    route               TEXT,
    contact_attempts    INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.tasks (
    id              BIGSERIAL PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES ${SCHEMA}.workflows(id),
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    role            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    claimed_by      TEXT,
    outcome         TEXT,
    note            TEXT,
    due_at          TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.contact_attempts (
    id              BIGSERIAL PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES ${SCHEMA}.workflows(id),
    outcome         TEXT NOT NULL,
    note            TEXT,
    actor           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.timers (
    id              BIGSERIAL PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES ${SCHEMA}.workflows(id),
    kind            TEXT NOT NULL,
    fire_at         TIMESTAMPTZ NOT NULL,
    fired           BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON ${SCHEMA}.tasks(status, role);
CREATE INDEX IF NOT EXISTS timers_pending_idx ON ${SCHEMA}.timers(fired, fire_at);
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
    log.info("workflow schema ready");
}

module.exports = { pool, query: (t, p) => pool.query(t, p), init, SCHEMA };
