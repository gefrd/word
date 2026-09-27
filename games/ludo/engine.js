// games/ludo/engine.js
// Ludo for 2–4 players. Pure game logic, no DOM — the same file runs in the
// browser (offline play, bots) and on the server (online rooms), where the
// server rolls the dice so nobody can fake a six.
//
// Board
// -----
// Seats 0..3 go clockwise: 0 bottom-left, 1 top-left, 2 top-right,
// 3 bottom-right. The shared track has 52 squares (global index 0..51).
// Seat p enters the track at START[p] = (40 + 13p) mod 52.
//
// A token's position is its `step` along its own path:
//   -1        in the yard
//   0..50     on the shared track (global square (START[p] + step) mod 52)
//   51..55    in its own home column
//   56        home (finished)
//
// Turn flow: phase 'roll' → roll the die → phase 'move' → pick a token.
// If no token can move, the turn passes automatically.
//
// Rules that differ between places are options in `state.rules`:
//   enter        '6'     a token leaves the yard on a 6
//                '1or6'  on a 1 or a 6
//   bonus        true    capturing or reaching home gives another roll
//   threeSixes   'forfeit'  a third 6 in a row ends the turn
//                'allowed'  keep rolling
//   blocks       false   tokens may share squares freely
//                true    two tokens of one colour on a square form a wall
//                        that other colours can't land on or pass
//   tokensToWin  4 | 2   how many tokens you must bring home to win

export const TRACK = 52;
export const HOME_STEP = 56;
export const LAST_TRACK_STEP = 50;
export const TOKENS = 4;
export const MAX_ACTIONS = 4000;

export const START = [40, 1, 14, 27];
export const SAFE = new Set([1, 9, 14, 22, 27, 35, 40, 48]); // starts + stars

export const DEFAULT_RULES = {
    enter: '6',
    bonus: true,
    threeSixes: 'forfeit',
    blocks: false,
    tokensToWin: 4,
};

export const RULE_OPTIONS = {
    enter: ['6', '1or6'],
    bonus: [true, false],
    threeSixes: ['forfeit', 'allowed'],
    blocks: [false, true],
    tokensToWin: [4, 2],
};

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

// Which seats play for a given number of players (2 players sit opposite).
export function seatsFor(count) {
    if (count === 2) return [0, 2];
    if (count === 3) return [0, 1, 2];
    return [0, 1, 2, 3];
}

export function createGame({ rules, players = [0, 1, 2, 3], firstPlayer } = {}) {
    const seats = players.filter((p, i) => Number.isInteger(p) && p >= 0 && p < 4 && players.indexOf(p) === i).sort();
    if (seats.length < 2) throw new Error('Ludo needs at least 2 players');
    return {
        rules: normalizeRules(rules),
        players: seats,
        tokens: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]),
        turn: seats.includes(firstPlayer) ? firstPlayer : seats[0],
        phase: 'roll',
        dice: null,
        sixes: 0,
        winner: null,
        actions: 0,
        lastMove: null,
    };
}

export function cloneState(s) {
    return {
        rules: s.rules,
        players: s.players,
        tokens: s.tokens.map((t) => t.slice()),
        turn: s.turn,
        phase: s.phase,
        dice: s.dice,
        sixes: s.sixes,
        winner: s.winner,
        actions: s.actions,
        lastMove: s.lastMove,
    };
}

export const onTrack = (step) => step >= 0 && step <= LAST_TRACK_STEP;
export const squareOf = (player, step) => (START[player] + step) % TRACK;

export function homeCount(state, player) {
    return state.tokens[player].filter((s) => s === HOME_STEP).length;
}

// Total progress, used for bots and tie-breaks.
export function progress(state, player) {
    return state.tokens[player].reduce((a, s) => a + (s < 0 ? 0 : s + 1), 0);
}

// Tokens of other players on global square `sq`: [{player, token}]
function othersOn(state, player, sq) {
    const out = [];
    for (const p of state.players) {
        if (p === player) continue;
        state.tokens[p].forEach((s, t) => {
            if (onTrack(s) && squareOf(p, s) === sq) out.push({ player: p, token: t });
        });
    }
    return out;
}

function isWall(state, player, sq) {
    if (!state.rules.blocks) return false;
    for (const p of state.players) {
        if (p === player) continue;
        let n = 0;
        for (const s of state.tokens[p]) if (onTrack(s) && squareOf(p, s) === sq) n++;
        if (n >= 2) return true;
    }
    return false;
}

function canEnter(state, dice) {
    return dice === 6 || (state.rules.enter === '1or6' && dice === 1);
}

// Where token `t` of `player` would go with `dice`, or null if it can't move.
export function targetStep(state, player, t, dice) {
    const s = state.tokens[player][t];
    if (s === HOME_STEP) return null;
    if (s < 0) {
        if (!canEnter(state, dice)) return null;
        if (isWall(state, player, START[player])) return null;
        return 0;
    }
    const to = s + dice;
    if (to > HOME_STEP) return null; // exact roll needed to finish
    if (state.rules.blocks) {
        for (let k = s + 1; k <= Math.min(to, LAST_TRACK_STEP); k++) {
            if (isWall(state, player, squareOf(player, k))) return null;
        }
    }
    return to;
}

export function legalTokens(state, player = state.turn) {
    if (state.winner !== null || state.phase !== 'move' || player !== state.turn) return [];
    const out = [];
    for (let t = 0; t < TOKENS; t++) if (targetStep(state, player, t, state.dice) !== null) out.push(t);
    return out;
}

export function isLegalAction(state, action, player = state.turn) {
    if (!action || state.winner !== null || player !== state.turn) return false;
    if (action.type === 'roll') return state.phase === 'roll';
    if (action.type === 'move') {
        return state.phase === 'move' && Number.isInteger(action.token) && action.token >= 0 &&
            action.token < TOKENS && targetStep(state, player, action.token, state.dice) !== null;
    }
    return false;
}

function nextPlayer(state, from) {
    const i = state.players.indexOf(from);
    return state.players[(i + 1) % state.players.length];
}

function passTurn(s, events) {
    s.turn = nextPlayer(s, s.turn);
    s.phase = 'roll';
    s.dice = null;
    s.sixes = 0;
    if (events) events.push({ type: 'turn', player: s.turn });
}

function rollAgain(s, events) {
    s.phase = 'roll';
    s.dice = null;
    if (events) events.push({ type: 'again', player: s.turn });
}

function finishByActions(s, events) {
    // Safety valve for endless games: most progress wins.
    let best = s.players[0];
    for (const p of s.players) {
        if (homeCount(s, p) * 100 + progress(s, p) > homeCount(s, best) * 100 + progress(s, best)) best = p;
    }
    s.winner = best;
    if (events) events.push({ type: 'win', player: best });
}

/**
 * Apply `action` for the player whose turn it is:
 *   { type: 'roll' }                 uses rng() (server-side online)
 *   { type: 'move', token }
 * Returns { state, events } with a new state. Throws on illegal actions.
 * Events: roll, move {token, from, to}, capture {victims}, home, forfeit,
 * pass, again, turn, win.
 */
export function applyAction(prev, action, rng = Math.random, { withEvents = true } = {}) {
    if (!isLegalAction(prev, action)) throw new Error('Illegal action: ' + JSON.stringify(action));
    const s = cloneState(prev);
    const me = s.turn;
    const events = withEvents ? [] : null;
    s.actions++;

    if (action.type === 'roll') {
        const value = Math.min(6, 1 + Math.floor(rng() * 6));
        s.dice = value;
        if (events) events.push({ type: 'roll', player: me, value });
        if (value === 6) s.sixes++;
        s.lastMove = { player: me, type: 'roll', value };
        if (value === 6 && s.sixes >= 3 && s.rules.threeSixes === 'forfeit') {
            if (events) events.push({ type: 'forfeit', player: me });
            passTurn(s, events);
        } else {
            s.phase = 'move';
            if (legalTokens(s, me).length === 0) {
                if (events) events.push({ type: 'pass', player: me });
                if (value === 6) rollAgain(s, events);
                else passTurn(s, events);
            }
        }
    } else {
        const t = action.token;
        const from = s.tokens[me][t];
        const to = targetStep(s, me, t, s.dice);
        s.tokens[me][t] = to;
        if (events) events.push({ type: 'move', player: me, token: t, from, to });
        s.lastMove = { player: me, type: 'move', token: t, from, to };

        let bonus = false;
        if (onTrack(to)) {
            const sq = squareOf(me, to);
            if (!SAFE.has(sq)) {
                const victims = othersOn(s, me, sq);
                if (victims.length) {
                    for (const v of victims) s.tokens[v.player][v.token] = -1;
                    if (events) events.push({ type: 'capture', player: me, victims });
                    bonus = s.rules.bonus;
                }
            }
        }
        if (to === HOME_STEP) {
            if (events) events.push({ type: 'home', player: me, token: t });
            bonus = bonus || s.rules.bonus;
        }

        if (homeCount(s, me) >= s.rules.tokensToWin) {
            s.winner = me;
            s.phase = 'over';
            if (events) events.push({ type: 'win', player: me });
            return { state: s, events };
        }
        if (s.dice === 6 || bonus) rollAgain(s, events);
        else passTurn(s, events);
    }

    if (s.winner === null && s.actions >= MAX_ACTIONS) {
        s.phase = 'over';
        finishByActions(s, events);
    }
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export const BOT_LEVELS = ['easy', 'medium', 'hard'];

// How likely an opponent token can land on global square `sq` next turn.
function threatOn(state, player, sq, precise) {
    let threat = 0;
    for (const p of state.players) {
        if (p === player) continue;
        for (const s of state.tokens[p]) {
            if (!onTrack(s)) continue; // yard tokens enter on a safe square
            // Distance along p's path from its token to sq.
            const d = (sq - squareOf(p, s) + TRACK) % TRACK;
            if (d >= 1 && d <= 6 && s + d <= LAST_TRACK_STEP) threat += precise ? 1 / 6 : 1;
            else if (precise && d >= 7 && d <= 12 && s + d <= LAST_TRACK_STEP) threat += 1 / 36;
        }
    }
    return threat;
}

function scoreMove(state, player, t, precise) {
    const from = state.tokens[player][t];
    const to = targetStep(state, player, t, state.dice);
    let score = to / 4; // progress
    if (from < 0) score += 25; // leave the yard
    if (to === HOME_STEP) score += 40;
    else if (to > LAST_TRACK_STEP && from <= LAST_TRACK_STEP) score += 22; // safe in home column
    if (onTrack(to)) {
        const sq = squareOf(player, to);
        const safe = SAFE.has(sq);
        if (!safe) {
            for (const v of othersOn(state, player, sq)) {
                score += 45 + Math.max(0, state.tokens[v.player][v.token]) / 2;
            }
            score -= threatOn(state, player, sq, precise) * (precise ? 60 : 12) * (1 + to / 50);
        } else {
            score += 10;
        }
        if (state.rules.blocks && state.tokens[player].some((s, i) => i !== t && s === to)) score += 8;
    }
    if (onTrack(from)) {
        const sq = squareOf(player, from);
        if (!SAFE.has(sq)) score += threatOn(state, player, sq, precise) * (precise ? 50 : 10) * (1 + from / 50);
    }
    return score;
}

/** Returns the action the bot takes: { type: 'roll' } or { type: 'move', token }. */
export function chooseBotAction(state, level = 'medium', rng = Math.random) {
    if (state.winner !== null) return null;
    if (state.phase === 'roll') return { type: 'roll' };
    const moves = legalTokens(state);
    if (moves.length === 0) return null;
    if (moves.length === 1) return { type: 'move', token: moves[0] };
    if (level === 'easy' && rng() < 0.5) {
        return { type: 'move', token: moves[Math.floor(rng() * moves.length)] };
    }
    const precise = level === 'hard';
    let best = moves[0];
    let bestScore = -Infinity;
    for (const t of moves) {
        const v = scoreMove(state, state.turn, t, precise) + rng() * 0.01;
        if (v > bestScore) { bestScore = v; best = t; }
    }
    return { type: 'move', token: best };
}
