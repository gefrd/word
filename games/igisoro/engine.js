// games/igisoro/engine.js
// Igisoro — Rwandan mancala (4 × 8). Pure game logic, no DOM.
//
// The same file is meant to run in three places:
//   1. in the browser for offline play (vs bot / two players on one phone),
//   2. in a Web Worker for the bot,
//   3. later on the server (Cloudflare Durable Object) for online rooms,
//      where the server is the only one allowed to call applyMove().
// So: no globals, no randomness except through an injected rng, and the
// state is plain JSON that can be sent over the network as-is.
//
// Board layout
// ------------
// Each player owns 16 pits, stored as a loop `pits[p][0..15]`:
//   0..7   outer row, left → right as the player sees it
//   8..15  inner row, right → left as the player sees it
// Sowing always goes i → i+1 (mod 16), which is anticlockwise for both
// players. Columns in absolute terms (0..7, left → right from player 0):
//   player 0: outer i → column i,     inner 8+k → column 7-k
//   player 1: outer i → column 7-i,   inner 8+k → column k
//
// Rules. Igisoro is played differently from village to village, so the
// points where versions disagree are options stored in `state.rules`
// (the bot and, later, the server read them from the state):
//
//   setup         'outer4'  4 seeds in each outer pit, inner row empty
//                 'all2'    2 seeds in every pit
//                 'random'  32 seeds scattered at random, same for both sides
//   minSeeds      2         a move starts from a pit with at least 2 seeds
//                 1         single seeds may move too
//   captureNeeds  'both'    capture only if the opponent's inner AND outer
//                           pits in that column are non-empty
//                 'inner'   the opponent's inner pit is enough (the outer
//                           pit is taken along with it)
//   captureSow    'start'   captured seeds are sown from the pit where the
//                           turn began
//                 'next'    captured seeds are sown on from the pit where
//                           the capturing seed landed
//
// Common to all versions:
//   - Seeds are sown one per pit along your own 16-pit loop.
//   - Last seed in an empty pit: the turn ends.
//   - Last seed in an occupied pit of your inner row that can capture:
//     capture, then sow the captured seeds.
//   - Last seed in any other occupied pit: pick all of it up and keep sowing
//     (relay).
//   - A player who cannot move loses. After MAX_MOVES moves the player
//     with more seeds wins (equal = draw), so no game runs forever.

export const PITS = 16;
export const ROW = 8;
export const SEEDS_PER_PLAYER = 32;
export const MAX_MOVES = 400;
// Safety valve: a relay chain longer than this ends the turn.
// Real games never get close; it only guards against endless loops.
export const MAX_SOW_STEPS = 2000;
export const DRAW = -1;

export const DEFAULT_RULES = {
    setup: 'outer4',
    minSeeds: 2,
    captureNeeds: 'both',
    captureSow: 'start',
};

export const RULE_OPTIONS = {
    setup: ['outer4', 'all2', 'random'],
    minSeeds: [2, 1],
    captureNeeds: ['both', 'inner'],
    captureSow: ['start', 'next'],
};

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

function randomSetup(rng) {
    const row = new Array(PITS).fill(0);
    for (let i = 0; i < SEEDS_PER_PLAYER; i++) row[Math.floor(rng() * PITS)]++;
    // 32 seeds in 16 pits always leave some pit with ≥ 2, so the side can move.
    return row;
}

const SETUPS = {
    outer4: () => [4, 4, 4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0],
    all2: () => new Array(PITS).fill(2),
    random: randomSetup,
};

export function createGame({ rules, firstPlayer = 0, rng = Math.random } = {}) {
    const r = normalizeRules(rules);
    const row = SETUPS[r.setup](rng);
    return {
        rules: r,
        pits: [row.slice(), row.slice()],
        turn: firstPlayer === 1 ? 1 : 0,
        moveCount: 0,
        winner: null, // 0 | 1 | DRAW | null
        lastMove: null,
    };
}

export function cloneState(s) {
    return {
        rules: s.rules,
        pits: [s.pits[0].slice(), s.pits[1].slice()],
        turn: s.turn,
        moveCount: s.moveCount,
        winner: s.winner,
        lastMove: s.lastMove,
    };
}

export const isInner = (i) => i >= ROW;

export function columnOf(player, i) {
    if (player === 0) return i < ROW ? i : 15 - i;
    return i < ROW ? 7 - i : i - ROW;
}

// Pit indices of `player`'s outer and inner pits in absolute column `col`.
export function pitsInColumn(player, col) {
    if (player === 0) return { outer: col, inner: 15 - col };
    return { outer: 7 - col, inner: ROW + col };
}

export function seedCount(state, player) {
    return state.pits[player].reduce((a, b) => a + b, 0);
}

export function legalMoves(state, player = state.turn) {
    if (state.winner !== null) return [];
    const min = state.rules.minSeeds;
    const moves = [];
    const row = state.pits[player];
    for (let i = 0; i < PITS; i++) if (row[i] >= min) moves.push(i);
    return moves;
}

export function isLegalMove(state, pit, player = state.turn) {
    return (
        state.winner === null &&
        player === state.turn &&
        Number.isInteger(pit) &&
        pit >= 0 &&
        pit < PITS &&
        state.pits[player][pit] >= state.rules.minSeeds
    );
}

// Opponent pits captured if `me` ends in inner pit `pos`, or null.
function capturable(s, me, pos) {
    if (!isInner(pos)) return null;
    const opp = 1 - me;
    const t = pitsInColumn(opp, columnOf(me, pos));
    const theirs = s.pits[opp];
    if (theirs[t.inner] === 0) return null;
    if (s.rules.captureNeeds === 'both' && theirs[t.outer] === 0) return null;
    return t;
}

/**
 * Play `pit` for the player whose turn it is.
 * Returns { state, events } — a NEW state (input is not mutated) and the
 * list of events for the UI to animate:
 *   { type: 'pickup',  player, pit, count }
 *   { type: 'sow',     player, pit }            one seed dropped
 *   { type: 'capture', player, from: [{player, pit, count}], count }
 *   { type: 'end',     player, pit, reason }    'empty' | 'limit'
 *   { type: 'win',     player }                 player may be DRAW
 * Throws on an illegal move (the server relies on this).
 */
export function applyMove(prev, pit, { withEvents = true } = {}) {
    if (!isLegalMove(prev, pit)) throw new Error(`Illegal move: ${pit}`);
    const s = cloneState(prev);
    const me = s.turn;
    const opp = 1 - me;
    const mine = s.pits[me];
    const theirs = s.pits[opp];
    const events = withEvents ? [] : null;

    let hand = mine[pit];
    mine[pit] = 0;
    if (events) events.push({ type: 'pickup', player: me, pit, count: hand });

    let pos = pit;
    let steps = 0;
    let endReason = 'empty';

    for (;;) {
        // Sow what is in hand, starting after `pos`.
        while (hand > 0) {
            pos = (pos + 1) % PITS;
            mine[pos]++;
            hand--;
            if (events) events.push({ type: 'sow', player: me, pit: pos });
        }
        if (++steps > MAX_SOW_STEPS) { endReason = 'limit'; break; }

        if (mine[pos] === 1) break; // landed in an empty pit

        const t = capturable(s, me, pos);
        if (t) {
            const count = theirs[t.inner] + theirs[t.outer];
            if (events) {
                const from = [{ player: opp, pit: t.inner, count: theirs[t.inner] }];
                if (theirs[t.outer]) from.push({ player: opp, pit: t.outer, count: theirs[t.outer] });
                events.push({ type: 'capture', player: me, from, count });
            }
            theirs[t.inner] = 0;
            theirs[t.outer] = 0;
            hand = count;
            // 'start': the first captured seed goes into the pit the turn
            // began from. 'next': sowing simply carries on after `pos`.
            if (s.rules.captureSow === 'start') pos = (pit - 1 + PITS) % PITS;
            continue;
        }

        // Relay: pick up the whole pit and keep going.
        hand = mine[pos];
        mine[pos] = 0;
        if (events) events.push({ type: 'pickup', player: me, pit: pos, count: hand });
    }

    if (events) events.push({ type: 'end', player: me, pit: pos, reason: endReason });

    s.moveCount++;
    s.lastMove = { player: me, pit };
    s.turn = opp;
    if (legalMoves(s, opp).length === 0) {
        s.winner = me;
    } else if (s.moveCount >= MAX_MOVES) {
        const a = seedCount(s, 0);
        const b = seedCount(s, 1);
        s.winner = a === b ? DRAW : a > b ? 0 : 1;
    }
    if (events && s.winner !== null) events.push({ type: 'win', player: s.winner });
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export const BOT_LEVELS = {
    easy: { depth: 1, noise: 6 },
    medium: { depth: 3, noise: 1 },
    hard: { depth: 5, noise: 0 },
};

const WIN_SCORE = 100000;

// Static evaluation from `player`'s point of view.
function evaluate(s, player) {
    if (s.winner === DRAW) return 0;
    if (s.winner !== null) return s.winner === player ? WIN_SCORE : -WIN_SCORE;
    const opp = 1 - player;
    const material = seedCount(s, player) - seedCount(s, opp);
    const mobility = legalMoves(s, player).length - legalMoves(s, opp).length;
    return material * 10 + mobility * 2;
}

function search(s, depth, alpha, beta, player) {
    if (depth === 0 || s.winner !== null) {
        // Prefer faster wins / slower losses.
        const v = evaluate(s, player);
        return v > WIN_SCORE / 2 ? v + depth : v < -WIN_SCORE / 2 ? v - depth : v;
    }
    const moves = legalMoves(s);
    const maximizing = s.turn === player;
    let best = maximizing ? -Infinity : Infinity;
    for (const m of moves) {
        const { state } = applyMove(s, m, { withEvents: false });
        const v = search(state, depth - 1, alpha, beta, player);
        if (maximizing) {
            if (v > best) best = v;
            if (best > alpha) alpha = best;
        } else {
            if (v < best) best = v;
            if (best < beta) beta = best;
        }
        if (alpha >= beta) break;
    }
    return best;
}

/**
 * Pick a move for the player whose turn it is.
 * `rng` is injectable so tests (and a server) can be deterministic.
 */
export function chooseBotMove(state, level = 'medium', rng = Math.random) {
    const moves = legalMoves(state);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    const { depth, noise } = BOT_LEVELS[level] || BOT_LEVELS.medium;
    const me = state.turn;

    let bestMove = moves[0];
    let bestScore = -Infinity;
    for (const m of moves) {
        const { state: next } = applyMove(state, m, { withEvents: false });
        let v = search(next, depth - 1, -Infinity, Infinity, me);
        if (noise) v += (rng() - 0.5) * 2 * noise * 10;
        if (v > bestScore) { bestScore = v; bestMove = m; }
    }
    return bestMove;
}
