// games/uno/engine.js
// Uno for 2–4 players. Pure game logic, no DOM — the same file runs in the
// browser (offline play, bots) and on the server (online rooms), where the
// server shuffles the deck so nobody can stack it, and each phone only sees
// its own cards (see viewFor / viewMove below).
//
// Cards
// -----
// 108 cards: in each colour one 0, two of 1–9, two Skip, two Reverse, two +2;
// plus four Wild and four Wild +4. A card is { id, color, value }:
//   color  'red' | 'blue' | 'green' | 'yellow' | 'wild'
//   value  '0'..'9' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4'
// Ids are 0..107 and never change, so a move names a card by its id.
//
// Turn flow
// ---------
// phase 'play'   play a matching card, or draw.
// phase 'drawn'  you drew a card you can play: play it, or keep it (pass).
// After a +2 / +4 the next player draws and misses the turn. With stacking on,
// they may answer +2 with +2 (or +4 with +4) and the total goes to the next
// player; someone who can't answer takes all the cards automatically.
//
// Moves:
//   { type: 'play', card: id, color?: 'red'|…  (for wild cards), uno?: true }
//   { type: 'draw' }
//   { type: 'pass' }   (phase 'drawn' only)
//
// Rules that differ between places are options in `state.rules`:
//   draw      'one'       draw one card; play it if it fits, else the turn ends
//             'untilPlayable'  keep drawing until a card fits
//   stack     false | true   +2 on +2 and +4 on +4
//   handSize  7 | 5
//   sayUno    true   playing your second-to-last card without tapping UNO
//                    costs 2 cards
//             false  no UNO penalty

export const COLORS = ['red', 'blue', 'green', 'yellow'];
export const MAX_ACTIONS = 3000;

export const DEFAULT_RULES = {
    draw: 'one',
    stack: false,
    handSize: 7,
    sayUno: true,
};

export const RULE_OPTIONS = {
    draw: ['one', 'untilPlayable'],
    stack: [false, true],
    handSize: [7, 5],
    sayUno: [true, false],
};

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (rules && RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

export function seatsFor(count) {
    return [0, 1, 2, 3].slice(0, [2, 3, 4].includes(count) ? count : 4);
}

export function buildDeck() {
    const deck = [];
    const add = (color, value) => deck.push({ id: deck.length, color, value });
    for (const color of COLORS) {
        add(color, '0');
        for (let n = 1; n <= 9; n++) { add(color, String(n)); add(color, String(n)); }
        for (const v of ['skip', 'reverse', 'draw2']) { add(color, v); add(color, v); }
    }
    for (let i = 0; i < 4; i++) add('wild', 'wild');
    for (let i = 0; i < 4; i++) add('wild', 'wild4');
    return deck;
}

export const isWild = (card) => card.color === 'wild';
export const isNumber = (card) => /^[0-9]$/.test(card.value);
export const drawAmount = (card) => (card.value === 'draw2' ? 2 : card.value === 'wild4' ? 4 : 0);

function shuffle(a, rng) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** New game. `rng` shuffles the deck (the server passes a secure one). */
export function createGame({ rules, players = [0, 1, 2, 3], firstPlayer, rng = Math.random } = {}) {
    const seats = players.filter((p, i) => Number.isInteger(p) && p >= 0 && p < 4 && players.indexOf(p) === i).sort();
    if (seats.length < 2) throw new Error('Uno needs at least 2 players');
    const r = normalizeRules(rules);
    const deck = shuffle(buildDeck(), rng);
    const hands = [[], [], [], []];
    for (let k = 0; k < r.handSize; k++) for (const p of seats) hands[p].push(deck.pop());
    // The first card turned up is always a number card.
    let top = deck.pop();
    while (!isNumber(top)) {
        deck.splice(Math.floor(rng() * (deck.length + 1)), 0, top);
        top = deck.pop();
    }
    return {
        rules: r,
        players: seats,
        hands,
        deck,
        discard: [top],
        color: top.color,
        direction: 1,
        turn: seats.includes(firstPlayer) ? firstPlayer : seats[0],
        phase: 'play',
        pending: 0,     // cards the player to move must take (stacking)
        drawn: null,    // id of the card just drawn that may be played
        said: [false, false, false, false], // said UNO and holds one card
        lacks: [null, null, null, null],    // colour each player last had to draw on (public)
        winner: null,
        actions: 0,
        lastMove: null,
    };
}

export function cloneState(s) {
    return {
        ...s,
        hands: s.hands.map((h) => (Array.isArray(h) ? h.slice() : h)),
        deck: Array.isArray(s.deck) ? s.deck.slice() : s.deck,
        discard: s.discard.slice(),
        said: s.said.slice(),
        lacks: s.lacks.slice(),
    };
}

// Works on the full state and on a player's view (where other hands and the
// deck are just counts).
export const handCount = (state, p) => (Array.isArray(state.hands[p]) ? state.hands[p].length : state.hands[p] || 0);
export const deckCount = (state) => (Array.isArray(state.deck) ? state.deck.length : state.deck);
export const topCard = (state) => state.discard[state.discard.length - 1];

// Seat `k` places after `from` in the current direction.
export function seatAfter(state, from, k = 1) {
    const n = state.players.length;
    const i = state.players.indexOf(from);
    return state.players[(((i + k * state.direction) % n) + n) % n];
}

export function canPlayCard(state, card) {
    const top = topCard(state);
    if (state.pending > 0) return state.rules.stack && card.value === top.value && drawAmount(card) > 0;
    return isWild(card) || card.color === state.color || card.value === top.value;
}

/** Ids of the cards `player` may play now. */
export function playableCards(state, player = state.turn) {
    if (state.winner !== null || player !== state.turn) return [];
    const hand = state.hands[player];
    if (!Array.isArray(hand)) return [];
    if (state.phase === 'drawn') return hand.filter((c) => c.id === state.drawn).map((c) => c.id);
    if (state.phase !== 'play') return [];
    return hand.filter((c) => canPlayCard(state, c)).map((c) => c.id);
}

export function findCard(state, player, id) {
    const hand = state.hands[player];
    return Array.isArray(hand) ? hand.find((c) => c.id === id) || null : null;
}

export function isLegalMove(state, move, player = state.turn) {
    if (!move || typeof move !== 'object' || state.winner !== null || player !== state.turn) return false;
    if (move.type === 'draw') return state.phase === 'play';
    if (move.type === 'pass') return state.phase === 'drawn';
    if (move.type === 'play') {
        if (!Number.isInteger(move.card) || !playableCards(state, player).includes(move.card)) return false;
        const card = findCard(state, player, move.card);
        return !isWild(card) || COLORS.includes(move.color);
    }
    return false;
}

// Take one card from the deck, reshuffling the discard pile when it runs out.
function takeCard(s, rng, events) {
    if (s.deck.length === 0 && s.discard.length > 1) {
        const top = s.discard.pop();
        s.deck = shuffle(s.discard, rng);
        s.discard = [top];
        if (events) events.push({ type: 'reshuffle' });
    }
    return s.deck.length ? s.deck.pop() : null;
}

function giveCards(s, p, count, rng, events, type = 'draw') {
    const cards = [];
    for (let k = 0; k < count; k++) {
        const c = takeCard(s, rng, events);
        if (!c) break;
        cards.push(c);
    }
    s.hands[p].push(...cards);
    if (s.hands[p].length > 1) s.said[p] = false;
    if (events) events.push({ type, player: p, count: cards.length, cards });
    return cards;
}

// Hand the turn to `p`. A player facing a stacked +2/+4 who can't answer it
// takes the cards at once and misses the turn.
function beginTurn(s, p, rng, events) {
    s.turn = p;
    s.phase = 'play';
    s.drawn = null;
    if (s.pending > 0 && !s.hands[p].some((c) => canPlayCard(s, c))) {
        giveCards(s, p, s.pending, rng, events);
        s.pending = 0;
        if (events) events.push({ type: 'skip', player: p });
        s.turn = seatAfter(s, p);
    }
    if (events) events.push({ type: 'turn', player: s.turn });
}

function finishByActions(s, events) {
    // Safety valve for endless games: fewest cards wins.
    let best = s.players[0];
    for (const p of s.players) if (s.hands[p].length < s.hands[best].length) best = p;
    s.winner = best;
    s.phase = 'over';
    if (events) events.push({ type: 'win', player: best });
}

/**
 * Apply `move` for the player whose turn it is. `rng` is used when the deck
 * has to be reshuffled. Returns { state, events } with a new state; throws on
 * illegal moves.
 * Events: play {card, color}, uno, penalty {count, cards}, draw {count, cards},
 * reshuffle, skip, reverse, stack {total}, pass, turn, win.
 */
export function applyMove(prev, move, rng = Math.random, { withEvents = true } = {}) {
    if (!isLegalMove(prev, move)) throw new Error('Illegal move: ' + JSON.stringify(move));
    const s = cloneState(prev);
    const me = s.turn;
    const events = withEvents ? [] : null;
    s.actions++;

    if (move.type === 'play') {
        const hand = s.hands[me];
        const card = hand.splice(hand.findIndex((c) => c.id === move.card), 1)[0];
        s.discard.push(card);
        s.color = isWild(card) ? move.color : card.color;
        s.drawn = null;
        if (s.lacks[me] === card.color) s.lacks[me] = null;
        if (events) events.push({ type: 'play', player: me, card, color: s.color });
        s.lastMove = { player: me, type: 'play', card, color: s.color };

        if (hand.length === 1) {
            if (move.uno || !s.rules.sayUno) {
                s.said[me] = true;
                if (events && move.uno) events.push({ type: 'uno', player: me });
            } else {
                giveCards(s, me, 2, rng, events, 'penalty');
            }
        }
        if (hand.length === 0) {
            s.winner = me;
            s.phase = 'over';
            if (events) events.push({ type: 'win', player: me });
            return { state: s, events };
        }

        let next = seatAfter(s, me);
        const amount = drawAmount(card);
        if (card.value === 'skip') {
            if (events) events.push({ type: 'skip', player: next });
            next = seatAfter(s, me, 2);
        } else if (card.value === 'reverse') {
            s.direction = -s.direction;
            if (events) events.push({ type: 'reverse', player: me, direction: s.direction });
            if (s.players.length === 2) {
                // With two players Reverse works like Skip.
                if (events) events.push({ type: 'skip', player: next });
                next = me;
            } else {
                next = seatAfter(s, me);
            }
        } else if (amount && s.rules.stack) {
            s.pending += amount;
            if (events) events.push({ type: 'stack', player: next, total: s.pending });
        } else if (amount) {
            giveCards(s, next, amount, rng, events);
            if (events) events.push({ type: 'skip', player: next });
            next = seatAfter(s, me, 2);
        }
        beginTurn(s, next, rng, events);
    } else if (move.type === 'draw') {
        if (s.pending > 0) {
            // Take the whole stack and miss the turn.
            giveCards(s, me, s.pending, rng, events);
            s.pending = 0;
            s.lastMove = { player: me, type: 'draw' };
            beginTurn(s, seatAfter(s, me), rng, events);
        } else {
            s.lacks[me] = s.color;
            let fits = null;
            let count = 0;
            do {
                const got = giveCards(s, me, 1, rng, events);
                if (!got.length) break;
                count++;
                if (canPlayCard(s, got[0])) fits = got[0];
            } while (!fits && s.rules.draw === 'untilPlayable');
            s.lastMove = { player: me, type: 'draw', count };
            if (fits) {
                s.phase = 'drawn';
                s.drawn = fits.id;
            } else {
                if (events) events.push({ type: 'pass', player: me });
                beginTurn(s, seatAfter(s, me), rng, events);
            }
        }
    } else {
        // pass: keep the drawn card
        if (events) events.push({ type: 'pass', player: me });
        s.lastMove = { player: me, type: 'pass' };
        beginTurn(s, seatAfter(s, me), rng, events);
    }

    if (s.winner === null && s.actions >= MAX_ACTIONS) finishByActions(s, events);
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Hidden information (online)
// ---------------------------------------------------------------------------

/** The state as `seat` may see it: other hands and the deck become counts. */
export function viewFor(state, seat) {
    return {
        ...state,
        hands: state.hands.map((h, p) => (p === seat ? h.slice() : h.length)),
        deck: state.deck.length,
        discard: state.discard.slice(-6),
        discardCount: state.discard.length,
        // Ids are fixed per card, so the drawn card's id would give it away.
        drawn: seat === state.turn ? state.drawn : null,
    };
}

/** Events of the last move as `seat` may see them: nobody sees others' drawn cards. */
export function viewEvents(events, seat) {
    return events.map((e) => ((e.type === 'draw' || e.type === 'penalty') && e.player !== seat
        ? { type: e.type, player: e.player, count: e.count }
        : e));
}

// ---------------------------------------------------------------------------
// Bot (uses only its own hand and what everyone can see)
// ---------------------------------------------------------------------------

export const BOT_LEVELS = ['easy', 'medium', 'hard'];

function bestColor(hand, rng, avoid = null) {
    const counts = { red: 0, blue: 0, green: 0, yellow: 0 };
    for (const c of hand) if (!isWild(c)) counts[c.color] += isNumber(c) ? 1 : 1.3;
    // A colour the next player just couldn't play is worth a little extra.
    if (avoid) counts[avoid] += 1.5;
    let best = COLORS[Math.floor(rng() * 4)];
    for (const c of COLORS) if (counts[c] > counts[best]) best = c;
    return best;
}

function scorePlay(state, me, card, level) {
    const hand = state.hands[me];
    const rest = hand.filter((c) => c !== card);
    const next = seatAfter(state, me);
    const nextCards = handCount(state, next);
    const minOther = Math.min(...state.players.filter((p) => p !== me).map((p) => handCount(state, p)));
    let score = 0;
    const amount = drawAmount(card);
    const attack = card.value === 'skip' || card.value === 'reverse' || amount > 0;

    if (isWild(card)) {
        // Keep wild cards for when nothing else fits.
        score -= card.value === 'wild4' ? 30 : 20;
        if (rest.length <= 1) score += 25;
    } else {
        // Stay in the colour we hold most of.
        const sameColor = rest.filter((c) => c.color === card.color).length;
        score += sameColor * (level === 'hard' ? 3 : 2);
        if (isNumber(card)) score += Number(card.value) * 0.3; // get rid of big numbers
        if (level === 'hard' && state.lacks && state.lacks[next] === card.color) score += 6;
    }
    if (attack) {
        if (nextCards <= 2) score += 40 + amount * 5;
        else if (level === 'hard' && minOther <= 2) score += 15;
        else score += 3;
        // With two players Skip, Reverse and +2 give you another turn.
        if (level === 'hard' && state.players.length === 2 && rest.some((c) => c.color === card.color || c.value === card.value)) score += 8;
    }
    if (level === 'hard' && card.value === 'reverse' && state.players.length > 2) {
        // Reverse is good when the player behind us has more cards.
        const prev = seatAfter(state, me, -1);
        score += handCount(state, prev) > nextCards ? 6 : -6;
    }
    return score;
}

/** Returns the bot's move for the player whose turn it is. */
export function chooseBotMove(state, level = 'medium', rng = Math.random) {
    if (state.winner !== null) return null;
    const me = state.turn;
    const hand = state.hands[me];
    const ids = playableCards(state, me);
    const next = seatAfter(state, me);
    const avoid = level === 'hard' && state.lacks ? state.lacks[next] : null;
    const withColor = (card) => (isWild(card) ? bestColor(hand.filter((c) => c !== card), rng, avoid) : undefined);
    const make = (card) => {
        const m = { type: 'play', card: card.id };
        const color = withColor(card);
        if (color) m.color = color;
        // Easy bots sometimes forget to say UNO.
        if (hand.length === 2 && !(level === 'easy' && rng() < 0.25)) m.uno = true;
        return m;
    };

    if (state.phase === 'drawn') {
        const card = findCard(state, me, state.drawn);
        return make(card);
    }
    if (ids.length === 0) return { type: 'draw' };
    const cards = ids.map((id) => findCard(state, me, id));
    if (level === 'easy' && rng() < 0.6) return make(cards[Math.floor(rng() * cards.length)]);
    let best = cards[0];
    let bestScore = -Infinity;
    for (const c of cards) {
        const v = scorePlay(state, me, c, level) + rng() * 0.5;
        if (v > bestScore) { bestScore = v; best = c; }
    }
    return make(best);
}
