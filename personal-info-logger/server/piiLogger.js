const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FIRST_NAMES = ["James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
const STREETS = ["Main St", "Oak Ave", "Maple Dr", "Cedar Ln", "Elm St", "Pine Rd", "Washington Blvd", "Lake View Dr"];
const CITIES = ["Springfield", "Riverside", "Franklin", "Greenville", "Fairview", "Salem", "Georgetown", "Madison"];
const STATES = ["CA", "TX", "NY", "FL", "IL", "PA", "OH", "GA"];
const DOMAINS = ["example.com", "mail.com", "test.org", "sample.net"];

const LOG_DIR = path.join(__dirname, "../logs");
const LOG_FILE = path.join(LOG_DIR, "pii.log");
const MAX_ENTRIES = 300;

// sha256 -> { record, timestamp }, insertion-ordered so the oldest key is evicted first
const store = new Map();

function randomItem(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function randomDigits(length) {
    let digits = "";
    for (let i = 0; i < length; i++) {
        digits += Math.floor(Math.random() * 10);
    }
    return digits;
}

function generateFakePerson() {
    const firstName = randomItem(FIRST_NAMES);
    const lastName = randomItem(LAST_NAMES);
    return {
        name: `${firstName} ${lastName}`,
        email: `${firstName}.${lastName}@${randomItem(DOMAINS)}`.toLowerCase(),
        phone: `(${randomDigits(3)}) ${randomDigits(3)}-${randomDigits(4)}`,
        ssn: `${randomDigits(3)}-${randomDigits(2)}-${randomDigits(4)}`,
        address: `${randomDigits(3)} ${randomItem(STREETS)}, ${randomItem(CITIES)}, ${randomItem(STATES)} ${randomDigits(5)}`,
        dob: `${1950 + Math.floor(Math.random() * 60)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`,
    };
}

function hashContent(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function maskName(name) {
    return name.split(" ").map((w) => w[0] + "*".repeat(w.length - 1)).join(" ");
}

function maskEmail(email) {
    const [local, domain] = email.split("@");
    const maskedLocal = local[0] + "*".repeat(local.length - 1);
    const dotIndex = domain.lastIndexOf(".");
    const domainName = domain.slice(0, dotIndex);
    const domainExt = domain.slice(dotIndex);
    const maskedDomain = domainName[0] + "*".repeat(domainName.length - 1) + domainExt;
    return `${maskedLocal}@${maskedDomain}`;
}

function maskPhone(phone) {
    const totalDigits = (phone.match(/\d/g) || []).length;
    let seen = 0;
    return phone.replace(/\d/g, (d) => {
        seen++;
        return seen > totalDigits - 2 ? d : "*";
    });
}

function maskSSN(ssn) {
    return `***-**-${ssn.split("-")[2]}`;
}

function maskAddress(address) {
    const [, city, stateZip] = address.split(", ");
    const [state, zip] = stateZip.split(" ");
    return `*** ***, ${city}, ${state} ${"*".repeat(zip.length)}`;
}

function maskDob(dob) {
    return `${dob.split("-")[0]}-**-**`;
}

function maskRecord(record) {
    return {
        name: maskName(record.name),
        email: maskEmail(record.email),
        phone: maskPhone(record.phone),
        ssn: maskSSN(record.ssn),
        address: maskAddress(record.address),
        dob: maskDob(record.dob),
    };
}

function remember(hash, record, timestamp) {
    store.set(hash, { record, timestamp });
    if (store.size > MAX_ENTRIES) {
        store.delete(store.keys().next().value);
    }
}

function appendToLogFile(line) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
}

function logOnce(getCurrentTraceIdString) {
    const record = generateFakePerson();
    const hash = hashContent(JSON.stringify(record));
    const timestamp = new Date().toISOString();
    const traceIdString = getCurrentTraceIdString ? getCurrentTraceIdString() : "";

    remember(hash, record, timestamp);
    const masked = JSON.stringify(maskRecord(record));
    appendToLogFile(`${timestamp} ${traceIdString}masked=${masked} sha256=${hash}`);
    console.log(`${traceIdString}Synthetic PII record logged, masked=${masked} sha256=${hash}`);
}

function start(getCurrentTraceIdString, intervalMs = 10000) {
    return setInterval(() => logOnce(getCurrentTraceIdString), intervalMs);
}

function getByHash(hash) {
    return store.get(hash);
}

function listRecent() {
    return Array.from(store.entries())
        .reverse()
        .map(([hash, entry]) => ({ hash, timestamp: entry.timestamp }));
}

module.exports = { generateFakePerson, start, getByHash, listRecent };
