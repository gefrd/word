// games/durak/engine.js
// Durak (the Russian card game) for 2–4 players. Pure game logic, no DOM —
// the same file runs in the browser (offline play, bots) and on the server
// (online rooms), where the server shuffles the deck so nobody can stack it.
//
// Cards are short strings: rank + suit, e.g. '6h', 'Ts' (ten), 'Ad'.
// Ranks 2..A ('23456789TJQKA'), suits h d c s. The 36-card deck is 6..A.
//
// One player acts at a time (the online server needs exactly one `turn`):
//   phase 'attack'  `turn` may lead (empty table, must play) or throw in
//                   more cards of ranks already on the table, or pass.
//                   Attackers get the chance in order: main attacker first,
//                   then clockwise. Players with nothing to throw are skipped.
//   phase 'defend'  the defender beats one card at a time, transfers
//                   (transfer rule) or takes.
//   phase 'throw'   the defender takes: attackers may add more cards
//                   (each attacker once), then the defender picks up.
// When every attacker passes with all cards beaten, the cards are discarded.
// Then everyone draws up to 6 (main attacker first, defender last).
// A player with no cards when the deck is empty is out. The last player
// holding cards is the durak (loser).
//
// Rules that differ between places are options in `state.rules`:
//   transfer   false   throw-in durak (podkidnoy)
//              true    transfer durak (perevodnoy): before beating any card
//                      the defender may add a card of the same rank and pass
//                      the attack on to the next player
//   deck       36 | 52
//   firstBout  6 | 5   most cards in the very first bout
//   throwIn    'all'        every other player may throw in
//              'neighbors'  only the players next to the defender

export const HAND = 6;
export const MAX_ACTIONS = 3000;
export const DRAW = -1;
export const RANKS = '23456789TJQKA';
export const SUITS = 'hdcs';

export const DEFAULT_RULES = {
    transfer: false,
    deck: 36,
    firstBout: 6,
    throwIn: 'all',
};

export const RULE_OPTIONS = {
    transfer: [false, true],
    deck: [36, 52],
    firstBout: [6, 5],
    throwIn: ['all', 'neighbors'],
};

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (rules && RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

// Seats around the table, clockwise.
export function seatsFor(count) {
    return [0, 1, 2, 3].slice(0, [2, 3, 4].includes(count) ? count : 2);
}

export const rankOf = (c) => RANKS.indexOf(c[0]);
export const suitOf = (c) => c[1];
export const isCard = (c) => typeof c === 'string' && c.length === 2 && RANKS.includes(c[0]) && SUITS.includes(c[1]);

export function makeDeck(size = 36) {
    const from = size === 52 ? 0 : RANKS.indexOf('6');
    const out = [];
    for (const s of SUITS) for (let r = from; r < RANKS.length; r++) out.push(RANKS[r] + s);
    return out;
}

// Does `def` beat `att` when `trump` is the trump suit?
export function beats(att, def, trump) {
    if (suitOf(def) === suitOf(att)) return rankOf(def) > rankOf(att);
    return suitOf(def) === trump;
}

// Trumps last, then by rank; handy for showing and for bots.
export function sortHand(hand, trump) {
    const key = (c) => (suitOf(c) === trump ? 100 : 0) + rankOf(c) * 4 + SUITS.indexOf(suitOf(c));
    return hand.slice().sort((a, b) => key(a) - key(b));
}

/**
 * New game. `rng` shuffles the deck (online: the server's secure random).
 * The player holding the lowest trump attacks first; if nobody has a trump,
 * `firstPlayer` does.
 */
export function createGame({ rules, players = [0, 1], firstPlayer, rng = Math.random } = {}) {
    const seats = players.filter((p, i) => Number.isInteger(p) && p >= 0 && p < 4 && players.indexOf(p) === i).sort();
    if (seats.length < 2) throw new Error('Durak needs at least 2 players');
    const r = normalizeRules(rules);
    const deck = makeDeck(r.deck);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(rng() * (i + 1)));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const hands = [[], [], [], []];
    for (let k = 0; k < HAND; k++) for (const p of seats) hands[p].push(deck.shift());
    const trumpCard = deck[deck.length - 1];
    const trump = suitOf(trumpCard);
    let first = null;
    let firstCard = null;
    for (const p of seats) {
        for (const c of hands[p]) {
            if (suitOf(c) === trump && (firstCard === null || rankOf(c) < rankOf(firstCard))) { first = p; firstCard = c; }
        }
    }
    if (first === null) first = seats.includes(firstPlayer) ? firstPlayer : seats[0];
    const s = {
        rules: r,
        players: seats,
        hands,
        deck,
        trumpCard,
        trump,
        discard: [],
        table: [],           // [{ a: attack card, d: defence card | null }]
        attacker: first,
        defender: null,
        turn: first,
        phase: 'attack',
        passed: [],
        limit: 0,
        bouts: 0,
        firstCard,           // the lowest trump that chose who starts (shown once)
        out: [],             // seats that got rid of their cards, in order
        loser: null,         // the durak
        winner: null,        // first player out, or DRAW when nobody is durak
        actions: 0,
    };
    s.defender = nextActive(s, first);
    s.limit = boutLimit(s);
    return s;
}

export function cloneState(s) {
    return {
        ...s,
        hands: s.hands.map((h) => h.slice()),
        deck: s.deck.slice(),
        discard: s.discard.slice(),
        table: s.table.map((p) => ({ a: p.a, d: p.d })),
        passed: s.passed.slice(),
        out: s.out.slice(),
    };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const isActive = (s, p) => s.players.includes(p) && !s.out.includes(p);

export function nextActive(s, from) {
    const n = s.players.length;
    const i = s.players.indexOf(from);
    for (let k = 1; k < n; k++) {
        const p = s.players[(i + k) % n];
        if (!s.out.includes(p)) return p;
    }
    return from;
}

function boutLimit(s) {
    const max = s.bouts === 0 ? s.rules.firstBout : HAND;
    return Math.min(max, s.hands[s.defender].length);
}

export function tableRanks(s) {
    const r = new Set();
    for (const p of s.table) {
        r.add(p.a[0]);
        if (p.d) r.add(p.d[0]);
    }
    return r;
}

export const uncovered = (s) => s.table.map((p, i) => (p.d ? -1 : i)).filter((i) => i >= 0);

// Who may throw in this bout, in the order they get the chance.
export function attackOrder(s) {
    const out = [];
    let p = s.attacker;
    for (let k = 0; k < s.players.length; k++) {
        if (p !== s.defender && isActive(s, p) && !out.includes(p)) out.push(p);
        p = nextActive(s, p);
    }
    if (s.rules.throwIn === 'neighbors') {
        const right = nextActive(s, s.defender);
        return out.filter((q) => q === s.attacker || q === right);
    }
    return out;
}

// Cards `p` could add to the table right now (ignores whose turn it is).
export function throwable(s, p) {
    if (s.table.length === 0 || s.table.length >= s.limit) return [];
    const ranks = tableRanks(s);
    return s.hands[p].filter((c) => ranks.has(c[0]));
}

// Can `p` still transfer the attack now (transfer rule)?
export function transferTarget(s) {
    if (!s.rules.transfer || s.phase !== 'defend' || s.table.length === 0) return null;
    if (s.table.some((x) => x.d)) return null;
    const to = nextActive(s, s.defender);
    if (to === s.defender) return null;
    const max = s.bouts === 0 ? s.rules.firstBout : HAND;
    if (s.table.length + 1 > Math.min(max, s.hands[to].length)) return null;
    return to;
}

export function canTransferWith(s, card) {
    return transferTarget(s) !== null && s.hands[s.defender].includes(card) && card[0] === s.table[0].a[0];
}

// Legal { card, target } pairs for the defender.
export function defenceOptions(s) {
    if (s.phase !== 'defend') return [];
    const out = [];
    for (const i of uncovered(s)) {
        for (const c of s.hands[s.defender]) if (beats(s.table[i].a, c, s.trump)) out.push({ card: c, target: i });
    }
    return out;
}

function sameCards(cards) {
    return Array.isArray(cards) && cards.length > 0 && cards.length <= HAND &&
        cards.every((c, i) => isCard(c) && cards.indexOf(c) === i);
}

export function isLegalAction(s, a, player = s.turn) {
    if (!a || typeof a !== 'object' || s.winner !== null || s.phase === 'over' || player !== s.turn) return false;
    const hand = s.hands[player];
    switch (a.type) {
        case 'attack': {
            if (s.phase !== 'attack' && s.phase !== 'throw') return false;
            if (!sameCards(a.cards) || !a.cards.every((c) => hand.includes(c))) return false;
            if (s.table.length === 0) {
                return s.phase === 'attack' && player === s.attacker && a.cards.length <= s.limit &&
                    a.cards.every((c) => c[0] === a.cards[0][0]);
            }
            const ranks = tableRanks(s);
            return s.table.length + a.cards.length <= s.limit && a.cards.every((c) => ranks.has(c[0]));
        }
        case 'pass':
            return (s.phase === 'attack' && s.table.length > 0) || s.phase === 'throw';
        case 'defend': {
            if (s.phase !== 'defend' || !isCard(a.card) || !hand.includes(a.card)) return false;
            const p = s.table[a.target];
            return Number.isInteger(a.target) && !!p && !p.d && beats(p.a, a.card, s.trump);
        }
        case 'transfer':
            return isCard(a.card) && canTransferWith(s, a.card);
        case 'take':
            return s.phase === 'defend';
        default:
            return false;
    }
}

// Every legal action for the player to move (used by tests and the timeout bot).
export function legalActions(s) {
    if (s.winner !== null || s.phase === 'over') return [];
    const p = s.turn;
    const out = [];
    if (s.phase === 'defend') {
        for (const o of defenceOptions(s)) out.push({ type: 'defend', card: o.card, target: o.target });
        if (transferTarget(s) !== null) {
            for (const c of s.hands[p]) if (c[0] === s.table[0].a[0]) out.push({ type: 'transfer', card: c });
        }
        out.push({ type: 'take' });
        return out;
    }
    if (s.table.length === 0) {
        for (const c of s.hands[p]) out.push({ type: 'attack', cards: [c] });
        return out;
    }
    for (const c of throwable(s, p)) out.push({ type: 'attack', cards: [c] });
    out.push({ type: 'pass' });
    return out;
}

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

function removeCards(hand, cards) {
    for (const c of cards) hand.splice(hand.indexOf(c), 1);
}

// Next attacker (in order, not yet passed) who has something to throw.
function nextThrower(s) {
    for (const p of attackOrder(s)) {
        if (!s.passed.includes(p) && throwable(s, p).length > 0) return p;
    }
    return null;
}

// Give the turn to the next attacker, or end the bout if nobody can add.
function toAttackers(s, events) {
    const p = nextThrower(s);
    if (p !== null) { s.turn = p; return; }
    if (s.phase === 'throw') pickUp(s, events);
    else beaten(s, events);
}

// Defender's turn. With no way to beat or transfer, taking is forced.
function toDefender(s, events) {
    s.phase = 'defend';
    s.turn = s.defender;
    s.passed = [];
    if (defenceOptions(s).length === 0 && !s.hands[s.defender].some((c) => canTransferWith(s, c))) {
        if (events) events.push({ type: 'take', player: s.defender, forced: true });
        startThrow(s, events);
    }
}

function startThrow(s, events) {
    s.phase = 'throw';
    s.passed = [];
    toAttackers(s, events);
}

function beaten(s, events) {
    for (const p of s.table) s.discard.push(p.a, p.d);
    s.table = [];
    if (events) events.push({ type: 'beaten', player: s.defender });
    endBout(s, events, false);
}

function pickUp(s, events) {
    const cards = [];
    for (const p of s.table) { cards.push(p.a); if (p.d) cards.push(p.d); }
    s.hands[s.defender].push(...cards);
    s.table = [];
    if (events) events.push({ type: 'pickup', player: s.defender, cards });
    endBout(s, events, true);
}

function endBout(s, events, took) {
    // Draw up to 6: attackers in order, the defender last.
    const order = [...attackOrderAll(s), s.defender];
    for (const p of order) {
        const cards = [];
        while (s.hands[p].length + cards.length < HAND && s.deck.length > 0) cards.push(s.deck.shift());
        if (cards.length) {
            s.hands[p].push(...cards);
            if (events) events.push({ type: 'draw', player: p, count: cards.length, cards });
        }
    }
    if (s.deck.length === 0) {
        for (const p of order) {
            if (s.hands[p].length === 0 && !s.out.includes(p)) {
                s.out.push(p);
                if (events) events.push({ type: 'out', player: p });
            }
        }
    }
    s.bouts++;
    s.passed = [];
    const active = s.players.filter((p) => !s.out.includes(p));
    if (active.length <= 1) return finish(s, events, active.length ? active[0] : null);

    const oldDef = s.defender;
    if (took) s.attacker = nextActive(s, oldDef);
    else s.attacker = s.out.includes(oldDef) ? nextActive(s, oldDef) : oldDef;
    s.defender = nextActive(s, s.attacker);
    s.phase = 'attack';
    s.turn = s.attacker;
    s.limit = boutLimit(s);
    if (events) events.push({ type: 'bout', attacker: s.attacker, defender: s.defender });
}

// Everyone except the defender, main attacker first (ignores the neighbours rule).
function attackOrderAll(s) {
    const out = [];
    let p = s.attacker;
    for (let k = 0; k < s.players.length; k++) {
        if (p !== s.defender && isActive(s, p) && !out.includes(p)) out.push(p);
        p = nextActive(s, p);
    }
    return out;
}

function finish(s, events, loser) {
    s.phase = 'over';
    s.turn = null;
    s.loser = loser;
    s.winner = loser === null ? DRAW : s.out[0];
    if (events) events.push({ type: 'over', loser, winner: s.winner });
}

/**
 * Apply `action` for the player whose turn it is:
 *   { type: 'attack', cards: ['7h', '7s'] }   lead or throw in
 *   { type: 'pass' }                            nothing (more) to add
 *   { type: 'defend', card: 'Kh', target: 0 }   beat table[target]
 *   { type: 'transfer', card: '7d' }            transfer rule only
 *   { type: 'take' }
 * Returns { state, events } with a new state. Throws on illegal actions.
 * Events: attack, pass, defend, transfer, take {forced}, beaten, pickup,
 * draw {count, cards}, out, bout, over.
 */
export function applyAction(prev, action, rng = Math.random, { withEvents = true } = {}) {
    if (!isLegalAction(prev, action)) throw new Error('Illegal action: ' + JSON.stringify(action));
    const s = cloneState(prev);
    const me = s.turn;
    const events = withEvents ? [] : null;
    s.actions++;
    s.firstCard = null;

    switch (action.type) {
        case 'attack': {
            const cards = action.cards.slice();
            removeCards(s.hands[me], cards);
            for (const c of cards) s.table.push({ a: c, d: null });
            if (events) events.push({ type: 'attack', player: me, cards });
            if (s.phase === 'throw') {
                s.passed.push(me);
                toAttackers(s, events);
            } else {
                toDefender(s, events);
            }
            break;
        }
        case 'pass':
            s.passed.push(me);
            if (events) events.push({ type: 'pass', player: me });
            toAttackers(s, events);
            break;
        case 'defend': {
            removeCards(s.hands[me], [action.card]);
            s.table[action.target].d = action.card;
            if (events) events.push({ type: 'defend', player: me, card: action.card, target: action.target });
            if (uncovered(s).length === 0) {
                s.phase = 'attack';
                s.passed = [];
                toAttackers(s, events);
            } else {
                toDefender(s, events);
            }
            break;
        }
        case 'transfer': {
            const to = transferTarget(s);
            removeCards(s.hands[me], [action.card]);
            s.table.push({ a: action.card, d: null });
            if (events) events.push({ type: 'transfer', player: me, card: action.card, to });
            s.attacker = me;
            s.defender = to;
            s.limit = Math.min(s.bouts === 0 ? s.rules.firstBout : HAND, s.hands[to].length);
            toDefender(s, events);
            break;
        }
        case 'take':
            if (events) events.push({ type: 'take', player: me, forced: false });
            startThrow(s, events);
            break;
    }

    if (s.winner === null && s.actions >= MAX_ACTIONS) {
        // Safety valve for endless games: most cards loses.
        let worst = s.players.find((p) => !s.out.includes(p));
        for (const p of s.players) if (!s.out.includes(p) && s.hands[p].length > s.hands[worst].length) worst = p;
        for (const p of s.players) if (!s.out.includes(p) && p !== worst) s.out.push(p);
        finish(s, events, worst);
    }
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Hidden information (online)
// ---------------------------------------------------------------------------

// What `seat` may see: own hand, table, the face-up trump at the bottom of the
// deck, the discard (every card in it was face up on the table), and only how
// many cards the others and the deck hold.
export function viewFor(s, seat) {
    const hidden = (n) => new Array(n).fill('??');
    const deck = hidden(s.deck.length);
    if (deck.length) deck[deck.length - 1] = s.deck[s.deck.length - 1];
    return {
        ...s,
        hands: s.hands.map((h, p) => (p === seat ? h.slice() : hidden(h.length))),
        deck,
        discard: s.discard.slice(),
        table: s.table.map((p) => ({ a: p.a, d: p.d })),
        passed: s.passed.slice(),
        out: s.out.slice(),
    };
}

// The cards someone draws are seen only by them.
export function viewEvents(events, seat) {
    return (events || []).map((e) => (e.type === 'draw' && e.player !== seat ? { type: 'draw', player: e.player, count: e.count } : e));
}

// ---------------------------------------------------------------------------
// Bot (uses only what its seat may see: own hand, table, counts)
// ---------------------------------------------------------------------------

export const BOT_LEVELS = ['easy', 'medium', 'hard'];

// Cost of giving a card away: trumps are worth the most.
const value = (c, trump) => rankOf(c) + (suitOf(c) === trump ? 13 : 0);

function pick(list, rng) {
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

function botLead(s, hand, level, rng) {
    if (level === 'easy' && rng() < 0.4) {
        const c = pick(hand, rng);
        return { type: 'attack', cards: [c] };
    }
    const endgame = s.deck.length === 0;
    // Group by rank; lead the cheapest group, several cards if we have them.
    const groups = new Map();
    for (const c of hand) {
        if (!groups.has(c[0])) groups.set(c[0], []);
        groups.get(c[0]).push(c);
    }
    let best = null;
    let bestScore = Infinity;
    for (const cards of groups.values()) {
        const plain = cards.filter((c) => suitOf(c) !== s.trump);
        const use = (plain.length ? plain : cards).sort((a, b) => value(a, s.trump) - value(b, s.trump)).slice(0, s.limit);
        const cheapest = value(use[0], s.trump);
        let score = cheapest * 2 - use.length * (endgame || level === 'hard' ? 3 : 1.5);
        if (!plain.length) score += 20;
        if (score < bestScore) { bestScore = score; best = use; }
    }
    // Early on, keep pairs of high cards: lead only one of them.
    if (!endgame && best.length > 1 && rankOf(best[0]) >= RANKS.indexOf('Q')) best = best.slice(0, 1);
    return { type: 'attack', cards: best };
}

// Which of `cards` are cheap enough to give away now.
function giveAway(s, cards, level) {
    const endgame = s.deck.length === 0;
    const maxRank = s.deck.length > 10 ? RANKS.indexOf('T') : RANKS.indexOf('Q');
    return cards
        .filter((c) => endgame || (suitOf(c) !== s.trump && rankOf(c) <= maxRank) || (level === 'hard' && s.deck.length <= 2 && suitOf(c) !== s.trump))
        .sort((a, b) => value(a, s.trump) - value(b, s.trump));
}

function botThrow(s, hand, level, rng) {
    const room = s.limit - s.table.length;
    const cand = throwable(s, s.turn);
    if (!cand.length) return { type: 'pass' };
    if (level === 'easy') {
        if (rng() < 0.4) return { type: 'pass' };
        return { type: 'attack', cards: [pick(cand, rng)] };
    }
    const give = giveAway(s, cand, level).slice(0, room);
    if (!give.length) return { type: 'pass' };
    return { type: 'attack', cards: give };
}

function botDefend(s, hand, level, rng) {
    const open = uncovered(s);
    const trump = s.trump;
    // Plan: hardest attack card first, each with the cheapest card that beats it.
    const used = new Set();
    const plan = [];
    const order = open.slice().sort((x, y) => value(s.table[y].a, trump) - value(s.table[x].a, trump));
    for (const i of order) {
        const opts = hand.filter((c) => !used.has(c) && beats(s.table[i].a, c, trump))
            .sort((a, b) => value(a, trump) - value(b, trump));
        if (!opts.length) { plan.length = 0; break; }
        used.add(opts[0]);
        plan.push({ card: opts[0], target: i });
    }
    // Transfer when it is cheaper than beating.
    if (transferTarget(s) !== null && level !== 'easy') {
        const rank = s.table[0].a[0];
        const tr = hand.filter((c) => c[0] === rank).sort((a, b) => value(a, trump) - value(b, trump));
        if (tr.length) {
            const cost = plan.length ? plan.reduce((t, p) => t + value(p.card, trump), 0) : Infinity;
            if (!plan.length || suitOf(tr[0]) !== trump || value(tr[0], trump) < cost / 2) {
                return { type: 'transfer', card: tr[0] };
            }
        }
    }
    if (!plan.length) {
        // Can't beat everything: beat nothing, take.
        return { type: 'take' };
    }
    if (level !== 'easy' && s.deck.length > 8) {
        // Early in the game, don't spend high trumps on cheap cards.
        const trumps = plan.filter((p) => suitOf(p.card) === trump);
        const highTrump = trumps.some((p) => rankOf(p.card) >= RANKS.indexOf('K'));
        const cheapTable = s.table.every((p) => suitOf(p.a) !== trump && rankOf(p.a) <= RANKS.indexOf('T'));
        if ((highTrump || trumps.length >= 2) && cheapTable && s.table.length <= 2) return { type: 'take' };
    }
    if (level === 'easy' && rng() < 0.3) {
        const opts = defenceOptions(s);
        const o = pick(opts, rng);
        return { type: 'defend', card: o.card, target: o.target };
    }
    return { type: 'defend', card: plan[0].card, target: plan[0].target };
}

// Hard bot: try each sensible action in a few random deals of the cards it
// can't see (consistent with the counts it can see), play them out with
// medium bots, and keep the action that avoids being the durak most often.
const ROLLOUTS = 24;

function candidates(s, rng) {
    const out = [chooseSimple(s, 'medium', rng)];
    const hand = s.hands[s.turn];
    if (s.phase === 'defend') {
        const best = new Map();
        for (const o of defenceOptions(s)) {
            const k = o.target + ':' + (suitOf(o.card) === s.trump ? 't' : 'p');
            if (!best.has(k) || value(o.card, s.trump) < value(best.get(k).card, s.trump)) best.set(k, o);
        }
        for (const o of best.values()) out.push({ type: 'defend', card: o.card, target: o.target });
        if (transferTarget(s) !== null) {
            for (const c of hand) if (c[0] === s.table[0].a[0]) out.push({ type: 'transfer', card: c });
        }
        out.push({ type: 'take' });
    } else if (s.table.length === 0) {
        const groups = new Map();
        for (const c of sortHand(hand, s.trump)) {
            if (!groups.has(c[0])) groups.set(c[0], []);
            groups.get(c[0]).push(c);
        }
        for (const cards of groups.values()) {
            out.push({ type: 'attack', cards: [cards[0]] });
            if (cards.length > 1) out.push({ type: 'attack', cards: cards.slice(0, s.limit) });
        }
    } else {
        out.push({ type: 'pass' });
        const cand = sortHand(throwable(s, s.turn), s.trump);
        for (const c of cand) out.push({ type: 'attack', cards: [c] });
        if (cand.length > 1) out.push({ type: 'attack', cards: cand.slice(0, s.limit - s.table.length) });
    }
    const seen = new Set();
    return out.filter((a) => {
        const k = JSON.stringify(a);
        if (seen.has(k) || !isLegalAction(s, a)) return false;
        seen.add(k);
        return true;
    });
}

// A full state where the cards `me` can't see are dealt at random.
function sampleWorld(s, me, rng) {
    const known = new Set([...s.hands[me], ...s.discard, ...s.table.flatMap((p) => (p.d ? [p.a, p.d] : [p.a]))]);
    const bottom = s.deck.length ? s.trumpCard : null;
    if (bottom) known.add(bottom);
    const pool = makeDeck(s.rules.deck).filter((c) => !known.has(c));
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(rng() * (i + 1)));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const w = cloneState(s);
    w.hands = s.hands.map((h, p) => (p === me ? h.slice() : pool.splice(0, h.length)));
    w.deck = s.deck.length ? [...pool.splice(0, s.deck.length - 1), bottom] : [];
    return w;
}

function rollout(w, me, rng) {
    let s = w;
    for (let k = 0; k < 400 && s.winner === null; k++) {
        s = applyAction(s, chooseSimple(s, 'medium', rng), rng, { withEvents: false }).state;
    }
    if (s.loser === me) return 0;
    if (s.loser === null) return 0.6;
    return 1 - (s.out.indexOf(me) < 0 ? 0.5 : s.out.indexOf(me) * 0.05);
}

function botHard(s, rng) {
    const list = candidates(s, rng);
    if (list.length <= 1) return list[0];
    const me = s.turn;
    const score = new Array(list.length).fill(0);
    score[0] += 0.5; // ties go to the simple choice
    for (let r = 0; r < ROLLOUTS; r++) {
        const w = sampleWorld(s, me, rng);
        list.forEach((a, i) => {
            score[i] += rollout(applyAction(w, a, rng, { withEvents: false }).state, me, rng);
        });
    }
    let best = 0;
    for (let i = 1; i < list.length; i++) if (score[i] > score[best]) best = i;
    return list[best];
}

/** The action the bot takes for `state.turn`, or null if the game is over. */
export function chooseBotAction(s, level = 'medium', rng = Math.random) {
    if (s.winner !== null || s.phase === 'over') return null;
    if (level === 'hard') return botHard(s, rng);
    return chooseSimple(s, level, rng);
}

function chooseSimple(s, level, rng) {
    const hand = s.hands[s.turn];
    let a;
    if (s.phase === 'defend') a = botDefend(s, hand, level, rng);
    else if (s.table.length === 0) a = botLead(s, hand, level, rng);
    else a = botThrow(s, hand, level, rng);
    if (!isLegalAction(s, a)) a = legalActions(s).find((x) => x.type === 'pass' || x.type === 'take') || legalActions(s)[0];
    return a;
}
