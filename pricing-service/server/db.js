const { Pool } = require("pg");
const log = require("./log");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
        || "postgres://assurance:assurance@localhost:5432/assurance",
    max: 10,
});

const SCHEMA = "pricing";

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

CREATE TABLE IF NOT EXISTS ${SCHEMA}.peer_groups (
    industry            TEXT PRIMARY KEY,
    label               TEXT NOT NULL,
    annual_claims_eur   NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.coverage_levels (
    code        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    factor      NUMERIC NOT NULL,
    benefits    JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.subscription_grid (
    size_band       TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    eur_per_member  NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.pricing_audit (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    quote_ref       TEXT,
    request         JSONB NOT NULL,
    result          JSONB NOT NULL
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

async function init(reference) {
    await connectWithRetry();
    await pool.query(DDL);

    // Reference data is seeded, not migrated: re-running is safe and idempotent.
    for (const [industry, row] of Object.entries(reference.industries)) {
        await pool.query(
            `INSERT INTO ${SCHEMA}.peer_groups (industry, label, annual_claims_eur)
             VALUES ($1,$2,$3)
             ON CONFLICT (industry) DO UPDATE
               SET label = EXCLUDED.label, annual_claims_eur = EXCLUDED.annual_claims_eur`,
            [industry, row.label, row.annualClaimsEur]
        );
    }
    for (const lvl of reference.coverageLevels) {
        await pool.query(
            `INSERT INTO ${SCHEMA}.coverage_levels (code, label, factor, benefits)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (code) DO UPDATE
               SET label = EXCLUDED.label, factor = EXCLUDED.factor, benefits = EXCLUDED.benefits`,
            [lvl.code, lvl.label, lvl.factor, JSON.stringify(lvl.benefits)]
        );
    }
    for (const [band, row] of Object.entries(reference.subscriptionGrid)) {
        await pool.query(
            `INSERT INTO ${SCHEMA}.subscription_grid (size_band, label, eur_per_member)
             VALUES ($1,$2,$3)
             ON CONFLICT (size_band) DO UPDATE
               SET label = EXCLUDED.label, eur_per_member = EXCLUDED.eur_per_member`,
            [band, row.label, row.eurPerMember]
        );
    }
    log.info("pricing schema ready, reference data seeded");
}

module.exports = { pool, query: (t, p) => pool.query(t, p), init, SCHEMA };
