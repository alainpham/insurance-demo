const { Pool } = require("pg");
const crypto = require("crypto");
const log = require("./log");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
        || "postgres://assurance:assurance@localhost:5432/assurance",
    max: 10,
});

const SCHEMA = "backoffice";

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Demo users. Real deployments put Keycloak here (ARCHITECTURE.md §10).
const SEED_USERS = [
    { email: "alice@assurance.demo", name: "Alice Moreau", role: "advisor" },
    { email: "bruno@assurance.demo", name: "Bruno Keller", role: "actuary" },
    { email: "chloe@assurance.demo", name: "Chloé Dupont", role: "supervisor" },
];
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "demo";

function hash(password, salt = crypto.randomBytes(16).toString("hex")) {
    const derived = crypto.scryptSync(password, salt, 32).toString("hex");
    return `${salt}:${derived}`;
}

function verify(password, stored) {
    const [salt, derived] = String(stored).split(":");
    if (!salt || !derived) return false;
    const candidate = crypto.scryptSync(password, salt, 32);
    const expected = Buffer.from(derived, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

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
    for (const u of SEED_USERS) {
        await pool.query(
            `INSERT INTO ${SCHEMA}.users (email, name, role, password_hash)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`,
            [u.email, u.name, u.role, hash(DEMO_PASSWORD)]
        );
    }
    log.info("backoffice schema ready", { users: SEED_USERS.length });
}

module.exports = { pool, query: (t, p) => pool.query(t, p), init, SCHEMA, verify, SEED_USERS };
