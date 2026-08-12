const { Pool } = require("pg");
const log = require("./log");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
        || "postgres://assurance:assurance@localhost:5432/assurance",
    max: 10,
});

const SCHEMA = "quote";

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

CREATE TABLE IF NOT EXISTS ${SCHEMA}.organizations (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    industry        TEXT NOT NULL,
    headcount       INTEGER NOT NULL,
    year_founded    INTEGER,
    client_years    INTEGER NOT NULL DEFAULT 0,
    own_claims_per_member NUMERIC,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.quote_requests (
    id                  BIGSERIAL PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,
    organization_id     BIGINT NOT NULL REFERENCES ${SCHEMA}.organizations(id),
    contact_name        TEXT NOT NULL,
    contact_email       TEXT NOT NULL,
    contact_phone       TEXT,
    age_mix             JSONB NOT NULL,
    composition_mix     JSONB NOT NULL,
    coverage_level      TEXT NOT NULL,
    current_insurer     TEXT,
    effective_date      DATE,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.quotes (
    id                  BIGSERIAL PRIMARY KEY,
    reference           TEXT UNIQUE NOT NULL,
    quote_request_id    BIGINT NOT NULL REFERENCES ${SCHEMA}.quote_requests(id),
    organization_id     BIGINT NOT NULL REFERENCES ${SCHEMA}.organizations(id),
    state               TEXT NOT NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    pricing             JSONB NOT NULL,
    access_token        TEXT NOT NULL,
    valid_until         DATE NOT NULL,
    document_url        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.quote_versions (
    id          BIGSERIAL PRIMARY KEY,
    quote_id    BIGINT NOT NULL REFERENCES ${SCHEMA}.quotes(id),
    version     INTEGER NOT NULL,
    pricing     JSONB NOT NULL,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (quote_id, version)
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.state_transitions (
    id          BIGSERIAL PRIMARY KEY,
    quote_id    BIGINT NOT NULL REFERENCES ${SCHEMA}.quotes(id),
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    actor       TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotes_state_idx ON ${SCHEMA}.quotes(state);
CREATE INDEX IF NOT EXISTS transitions_quote_idx ON ${SCHEMA}.state_transitions(quote_id);
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
    log.info("quote schema ready");
}

module.exports = { pool, query: (t, p) => pool.query(t, p), init, SCHEMA };
