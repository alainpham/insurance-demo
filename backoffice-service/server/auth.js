const jwt = require("jsonwebtoken");
const db = require("./db");
const log = require("./log");

const SECRET = process.env.JWT_SECRET || "assurance-demo-secret-not-for-production";
const COOKIE = "assurance_session";
const TTL = "12h";

// What each role may discount — on the subscription, and only on the subscription.
// The premium is priced to break even, so there is no margin in it to give away.
const DISCOUNT_AUTHORITY = { advisor: 5, actuary: 15, supervisor: 100 };

async function login(email, password) {
    const { rows } = await db.query(
        `SELECT * FROM ${db.SCHEMA}.users WHERE email = $1`, [String(email || "").toLowerCase()]
    );
    const user = rows[0];
    if (!user || !db.verify(password, user.password_hash)) return null;
    const token = jwt.sign(
        { sub: user.id, email: user.email, name: user.name, role: user.role },
        SECRET, { expiresIn: TTL }
    );
    log.info("login", { email: user.email, role: user.role });
    return { token, user: { email: user.email, name: user.name, role: user.role } };
}

function parseCookies(header) {
    return Object.fromEntries(
        String(header || "")
            .split(";")
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => {
                const i = p.indexOf("=");
                return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
            })
    );
}

function required(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
        || (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "not_authenticated" });
    try {
        req.user = jwt.verify(token, SECRET);
        log.annotate({ "employee.role": req.user.role });
        next();
    } catch (_) {
        res.status(401).json({ error: "session_expired" });
    }
}

const maxDiscount = (role) => DISCOUNT_AUTHORITY[role] ?? 0;

module.exports = { login, required, COOKIE, DISCOUNT_AUTHORITY, maxDiscount };
