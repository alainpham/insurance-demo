// The quote state machine. quote-service owns it; workflow-service drives it.
// An illegal transition is a domain error (409), not a crash — which makes it a
// span event in Tempo rather than a 500 in the error panel.

const TRANSITIONS = {
    NEW: ["PRICED", "OUT_OF_APPETITE"],
    PRICED: ["UNDER_REVIEW", "APPROVED", "OUT_OF_APPETITE"],
    UNDER_REVIEW: ["APPROVED", "DECLINED"],
    APPROVED: ["CONTACTED", "ABANDONED"],
    CONTACTED: ["SENT", "ABANDONED"],
    SENT: ["ACCEPTED", "REFUSED", "EXPIRED"],
    // terminal
    ACCEPTED: [],
    REFUSED: [],
    EXPIRED: [],
    DECLINED: [],
    ABANDONED: [],
    OUT_OF_APPETITE: [],
};

const ALL_STATES = Object.keys(TRANSITIONS);
const TERMINAL = ALL_STATES.filter((s) => TRANSITIONS[s].length === 0);

function canTransition(from, to) {
    return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// What the prospect is allowed to see — never the internal state.
function publicStatus(state) {
    if (["NEW", "PRICED", "UNDER_REVIEW", "APPROVED"].includes(state)) return "received";
    if (state === "CONTACTED") return "in progress";
    if (["SENT", "ACCEPTED", "REFUSED", "EXPIRED"].includes(state)) return "quote sent";
    return "closed";
}

module.exports = { TRANSITIONS, ALL_STATES, TERMINAL, canTransition, publicStatus };
