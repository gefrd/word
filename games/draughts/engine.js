// games/draughts/engine.js
// International draughts (10 × 10, FMJD rules). Pure game logic, no DOM.
//
// The same file runs in the browser (offline play and the bot) and on the
// online server, where it is the only code allowed to apply moves. So: no
// globals, no randomness except through an injected rng, and the state is
// plain JSON that can be sent over the network as-is.
//
// Board
// -----
// The 50 dark squares are numbered 0..49 (official notation is 1..50):
// row 0 is the top row and holds squares 0..4, row 9 the bottom row with
// squares 45..49. A dark square is one where (row + col) is odd, so the
// bottom-left corner (row 9, col 0) is dark, as on a real board.
// Player 0 starts at the bottom (squares 30..49) and moves up; player 1
// starts at the top (0..19) and moves down. Turning the board round maps
// square i to 49 - i, which is how the second phone in an online game sees it.
//
//   board[i]   0 empty, 1 / 2 player 0 man / king, -1 / -2 player 1 man / king
//   white      the player with the white pieces; White always moves first
//
// Rules (FMJD):
//   - Men move one square diagonally forward and capture forwards and
//     backwards by jumping an adjacent enemy piece.
//   - Kings ("flying kings") move any distance along a free diagonal and
//     capture a piece at any distance, landing on any free square behind it.
//   - Capturing is compulsory. With rules.capture 'max' (official) you must
//     take the largest number of pieces; with 'free' any full capture
//     sequence is allowed. A capture sequence always goes on as long as it can.
//   - Captured pieces are removed after the move, and no piece may be jumped
//     twice, so pieces already jumped block the way (the "Turkish strike").
//   - A man becomes a king only if it ENDS its move on the far row. Passing
//     over it during a capture does not count.
//   - A player who cannot move (no pieces, or all blocked) loses.
//   - Draws: the same position three times with the same player to move;
//     25 moves each with only kings moving and no captures; 3 pieces with a
//     king (3 kings, 2 kings + man, king + 2 men) against a lone king after
//     16 moves each; 2 pieces or fewer with a king against a lone king after
//     5 moves each. MAX_MOVES is a last safety net.
//
// A move is { path: [from, landing, ..., to], captures: [square, ...] }.
// Only `path` is needed to name a move: the landing squares decide which
// pieces are jumped, so the server accepts a phone's { path } and looks up
// the full move itself.

export const SIZE = 10;
export const SQUARES = 50;
export const DRAW = -1;
export const MAN = 1;
export const KING = 2;
export const MAX_MOVES = 600; // plies
export const KING_MOVES_DRAW = 50; // 25 moves each
export const MAX_PATH = 30;

export const DEFAULT_RULES = { capture: 'max' };
export const RULE_OPTIONS = { capture: ['max', 'free'] };

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (rules && RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export const rowOf = (sq) => Math.floor(sq / 5);
export const colOf = (sq) => 2 * (sq % 5) + (rowOf(sq) % 2 === 0 ? 1 : 0);

export function squareAt(row, col) {
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE || (row + col) % 2 === 0) return -1;
    return row * 5 + (col >> 1);
}

// Directions: 0 up-left, 1 up-right, 2 down-left, 3 down-right.
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const FORWARD = [[0, 1], [2, 3]]; // per player
// RAYS[sq][d]: the squares from sq towards d, nearest first.
const RAYS = [];
for (let sq = 0; sq < SQUARES; sq++) {
    RAYS.push(DIRS.map(([dr, dc]) => {
        const ray = [];
        for (let r = rowOf(sq) + dr, c = colOf(sq) + dc; squareAt(r, c) >= 0; r += dr, c += dc) ray.push(squareAt(r, c));
        return ray;
    }));
}

export const ownerOf = (v) => (v > 0 ? 0 : v < 0 ? 1 : null);
export const isKing = (v) => v === KING || v === -KING;
const signOf = (player) => (player === 0 ? 1 : -1);
const promotes = (player, sq) => (player === 0 ? sq < 5 : sq >= 45);

// ---------------------------------------------------------------------------
// Setup and state
// ---------------------------------------------------------------------------

export function initialBoard() {
    const b = new Array(SQUARES).fill(0);
    for (let i = 0; i < 20; i++) b[i] = -MAN;
    for (let i = 30; i < SQUARES; i++) b[i] = MAN;
    return b;
}

export function positionKey(board, turn) {
    let k = String(turn);
    for (let i = 0; i < SQUARES; i++) if (board[i]) k += ' ' + i + ':' + board[i];
    return k;
}

/**
 * New game. `firstPlayer` gets the white pieces and moves first.
 * `board` (50 numbers) and `turn` may be given to start from a position
 * (tests, puzzles).
 */
export function createGame({ rules, firstPlayer = 0, board, turn } = {}) {
    const first = firstPlayer === 1 ? 1 : 0;
    const b = board ? board.slice() : initialBoard();
    const t = turn === 0 || turn === 1 ? turn : first;
    const s = {
        rules: normalizeRules(rules),
        board: b,
        turn: t,
        white: first,
        moveCount: 0,
        winner: null, // 0 | 1 | DRAW | null
        reason: null, // 'no_moves' | 'repetition' | 'kings_only' | 'endgame' | 'limit'
        lastMove: null,
        kingMoves: 0,  // plies in a row with only kings moving, no captures
        egClass: endgameClass(b), // 16 or 5 while a drawn-out endgame is on the board
        egPlies: 0,
        seen: [positionKey(b, t)], // positions since the last man move or capture
    };
    if (legalMoves(s).length === 0) { s.winner = 1 - t; s.reason = 'no_moves'; }
    return s;
}

export function cloneState(s) {
    return { ...s, board: s.board.slice(), seen: s.seen.slice() };
}

export function pieceCount(state, player) {
    let n = 0;
    for (const v of state.board) if (ownerOf(v) === player) n++;
    return n;
}

export function kingCount(state, player) {
    let n = 0;
    const k = KING * signOf(player);
    for (const v of state.board) if (v === k) n++;
    return n;
}

// ---------------------------------------------------------------------------
// Move generation (works on a plain array or Int8Array, used by the bot too)
// ---------------------------------------------------------------------------

// All complete capture sequences for the piece on `from`.
function capturesFrom(b, from, out) {
    const piece = b[from];
    const king = isKing(piece);
    const enemy = piece > 0 ? (v) => v < 0 : (v) => v > 0;
    const taken = new Array(SQUARES).fill(false);
    const path = [from];
    const caps = [];
    b[from] = 0; // the piece has left its square: it may pass or land there

    const dfs = (pos) => {
        let more = false;
        for (let d = 0; d < 4; d++) {
            const ray = RAYS[pos][d];
            let k = 0;
            if (king) while (k < ray.length && b[ray[k]] === 0) k++;
            if (k >= ray.length - 1) continue;
            const victim = ray[k];
            if (!enemy(b[victim]) || taken[victim]) continue;
            // Landing squares: just behind a man's victim; any free square behind a king's.
            for (let j = k + 1; j < ray.length && b[ray[j]] === 0; j++) {
                more = true;
                taken[victim] = true;
                caps.push(victim);
                path.push(ray[j]);
                dfs(ray[j]);
                path.pop();
                caps.pop();
                taken[victim] = false;
                if (!king) break;
            }
        }
        if (!more && caps.length) out.push({ path: path.slice(), captures: caps.slice() });
    };
    dfs(from);
    b[from] = piece;
}

function quietFrom(b, from, player, out) {
    const king = isKing(b[from]);
    const dirs = king ? [0, 1, 2, 3] : FORWARD[player];
    for (const d of dirs) {
        const ray = RAYS[from][d];
        for (let k = 0; k < ray.length && b[ray[k]] === 0; k++) {
            out.push({ path: [from, ray[k]], captures: [] });
            if (!king) break;
        }
    }
}

// Legal moves of `player` on board `b`. `capture` is rules.capture.
export function generateMoves(b, player, capture = 'max') {
    const sign = signOf(player);
    let caps = [];
    for (let sq = 0; sq < SQUARES; sq++) if (b[sq] * sign > 0) capturesFrom(b, sq, caps);
    if (caps.length) {
        if (capture === 'max') {
            let most = 0;
            for (const m of caps) if (m.captures.length > most) most = m.captures.length;
            caps = caps.filter((m) => m.captures.length === most);
        }
        return caps;
    }
    const quiet = [];
    for (let sq = 0; sq < SQUARES; sq++) if (b[sq] * sign > 0) quietFrom(b, sq, player, quiet);
    return quiet;
}

export function legalMoves(state, player = state.turn) {
    if (state.winner !== null) return [];
    return generateMoves(state.board.slice(), player, state.rules.capture);
}

export const mustCapture = (moves) => moves.length > 0 && moves[0].captures.length > 0;

function samePath(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// The legal move with this path, or null.
export function findMove(state, path) {
    if (!Array.isArray(path)) return null;
    for (const m of legalMoves(state)) if (samePath(m.path, path)) return m;
    return null;
}

// What a phone sent → { path } or null (the server never trusts it).
export function parseMove(raw) {
    const path = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? raw.path : null;
    if (!Array.isArray(path) || path.length < 2 || path.length > MAX_PATH) return null;
    for (const sq of path) if (!Number.isInteger(sq) || sq < 0 || sq >= SQUARES) return null;
    return { path: path.slice() };
}

export function isLegalMove(state, move) {
    return state.winner === null && !!move && findMove(state, move.path) !== null;
}

// Official notation (1..50, White at the bottom): "32-28", "19x28", "37x26x17".
export function notation(state, move) {
    const n = (sq) => (state.white === 0 ? sq + 1 : SQUARES - sq);
    const cap = move.captures.length > 0;
    return (cap ? move.path : [move.path[0], move.path[move.path.length - 1]]).map(n).join(cap ? 'x' : '-');
}

// ---------------------------------------------------------------------------
// Playing a move
// ---------------------------------------------------------------------------

// 16 or 5 if the board is one of the drawn-out endgames of FMJD art. 6.3/6.4.
function endgameClass(b) {
    const c = [[0, 0], [0, 0]]; // [player][men, kings]
    for (const v of b) if (v) c[v > 0 ? 0 : 1][isKing(v) ? 1 : 0]++;
    for (const p of [0, 1]) {
        const lone = c[p][0] === 0 && c[p][1] === 1;
        const o = c[1 - p];
        const total = o[0] + o[1];
        if (lone && o[1] >= 1) {
            if (total === 3) return 16;
            if (total <= 2) return 5;
        }
    }
    return 0;
}

/**
 * Play `move` ({ path } is enough) for the player whose turn it is.
 * Returns { state, events } — a NEW state (input is not mutated) and events
 * for the UI:
 *   { type: 'move', player, path, captures, promote }
 *   { type: 'win',  player, reason }     player may be DRAW
 * Throws on an illegal move (the server relies on this).
 */
export function applyMove(prev, move, { withEvents = true } = {}) {
    const m = prev.winner === null && move ? findMove(prev, move.path) : null;
    if (!m) throw new Error('Illegal move: ' + JSON.stringify(move && move.path));
    const s = cloneState(prev);
    const me = s.turn;
    const b = s.board;
    const from = m.path[0];
    const to = m.path[m.path.length - 1];
    const piece = b[from];
    const wasMan = !isKing(piece);
    b[from] = 0;
    for (const c of m.captures) b[c] = 0;
    const promote = wasMan && promotes(me, to);
    b[to] = promote ? KING * signOf(me) : piece;

    s.moveCount++;
    s.turn = 1 - me;
    s.lastMove = { player: me, path: m.path.slice(), captures: m.captures.slice() };

    const irreversible = wasMan || m.captures.length > 0;
    s.kingMoves = irreversible ? 0 : s.kingMoves + 1;
    const key = positionKey(b, s.turn);
    s.seen = irreversible ? [key] : [...s.seen, key];
    const cls = endgameClass(b);
    if (cls !== s.egClass) { s.egClass = cls; s.egPlies = 0; } else if (cls) s.egPlies++;

    if (legalMoves(s).length === 0) {
        s.winner = me;
        s.reason = 'no_moves';
    } else if (s.seen.filter((k) => k === key).length >= 3) {
        s.winner = DRAW; s.reason = 'repetition';
    } else if (s.kingMoves >= KING_MOVES_DRAW) {
        s.winner = DRAW; s.reason = 'kings_only';
    } else if (s.egClass && s.egPlies >= s.egClass * 2) {
        s.winner = DRAW; s.reason = 'endgame';
    } else if (s.moveCount >= MAX_MOVES) {
        s.winner = DRAW; s.reason = 'limit';
    }

    let events = null;
    if (withEvents) {
        events = [{ type: 'move', player: me, path: m.path.slice(), captures: m.captures.slice(), promote }];
        if (s.winner !== null) events.push({ type: 'win', player: s.winner, reason: s.reason });
    }
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Bot: alpha-beta search on a mutable board, captures searched to the end
// ---------------------------------------------------------------------------

export const BOT_LEVELS = {
    easy: { depth: 1, noise: 70, nodes: 5000 },
    medium: { depth: 4, noise: 10, nodes: 30000 },
    hard: { depth: 20, noise: 0, nodes: 250000, ms: 1500 },
};

const WIN = 100000;
const MAN_VALUE = 100;
const KING_VALUE = 320;
// Bonus for a man by how far it has come (0 = own back row).
const ADVANCE = [0, 2, 4, 6, 9, 12, 16, 22, 30, 0];

// Static evaluation for `player`.
function evaluate(b, player) {
    let score = 0;
    let pieces = 0;
    for (let sq = 0; sq < SQUARES; sq++) {
        const v = b[sq];
        if (!v) continue;
        pieces++;
        const p = v > 0 ? 0 : 1;
        let x;
        if (isKing(v)) {
            x = KING_VALUE;
        } else {
            const r = p === 0 ? 9 - rowOf(sq) : rowOf(sq);
            const c = colOf(sq);
            x = MAN_VALUE + ADVANCE[r];
            if (c >= 3 && c <= 6) x += 4; // centre
            if (c === 0 || c === 9) x -= 3; // edge men are less useful
            if (r === 0) x += 6; // back-row guard stops enemy kings
        }
        score += p === player ? x : -x;
    }
    // Ahead in material: trading down helps, so reward fewer pieces left.
    if (score > 150) score += (40 - pieces) * 2;
    else if (score < -150) score -= (40 - pieces) * 2;
    return score;
}

function makeMove(b, m) {
    const from = m.path[0];
    const to = m.path[m.path.length - 1];
    const piece = b[from];
    const vals = m.captures.map((c) => b[c]);
    b[from] = 0;
    for (const c of m.captures) b[c] = 0;
    const player = piece > 0 ? 0 : 1;
    b[to] = !isKing(piece) && promotes(player, to) ? KING * signOf(player) : piece;
    return { from, to, piece, vals };
}

function unmakeMove(b, m, u) {
    b[u.to] = 0;
    b[u.from] = u.piece;
    for (let i = 0; i < m.captures.length; i++) b[m.captures[i]] = u.vals[i];
}

class OutOfTime extends Error {}

function makeSearch(capture, limits) {
    const history = new Int32Array(SQUARES * SQUARES);
    const start = Date.now();
    let nodes = 0;
    const key = (m) => m.path[0] * SQUARES + m.path[m.path.length - 1];

    function order(moves) {
        if (moves.length < 2) return moves;
        return moves.sort((x, y) => history[key(y)] - history[key(x)]);
    }

    function search(b, player, depth, alpha, beta, ply) {
        if (++nodes > limits.nodes || (limits.ms && (nodes & 1023) === 0 && Date.now() - start > limits.ms)) {
            throw new OutOfTime();
        }
        const moves = generateMoves(b, player, capture);
        if (moves.length === 0) return -WIN + ply;
        const forced = moves[0].captures.length > 0;
        // Out of depth: stand still unless a capture must be played (captures
        // are compulsory, so the exchange has to be seen to its end).
        if (depth <= 0 && !forced) return evaluate(b, player);
        if (depth <= -12 || ply >= 64) return evaluate(b, player);
        let best = -Infinity;
        for (const m of order(moves)) {
            const u = makeMove(b, m);
            // A single forced reply doesn't use up depth.
            const next = moves.length === 1 ? depth : depth - 1;
            const v = -search(b, 1 - player, next, -beta, -alpha, ply + 1);
            unmakeMove(b, m, u);
            if (v > best) best = v;
            if (v > alpha) alpha = v;
            if (alpha >= beta) {
                if (!forced) history[key(m)] += depth * depth + 1;
                break;
            }
        }
        return best;
    }

    return { search, nodes: () => nodes };
}

/**
 * Pick a move for the player whose turn it is. Returns one of legalMoves().
 * `rng` is injectable so tests (and the server) can be deterministic.
 */
export function chooseBotMove(state, level = 'medium', rng = Math.random) {
    const moves = legalMoves(state);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    const cfg = BOT_LEVELS[level] || BOT_LEVELS.medium;
    const me = state.turn;
    const b = Int8Array.from(state.board);
    const { search } = makeSearch(state.rules.capture, cfg);

    // Noise is fixed per move for the whole search, so deeper iterations
    // don't wash it out.
    const noise = moves.map(() => (cfg.noise ? (rng() - 0.5) * 2 * cfg.noise : 0));
    let order = moves.map((_, i) => i);
    let bestIdx = 0;
    for (let depth = 1; depth <= cfg.depth; depth++) {
        const scores = new Array(moves.length).fill(-Infinity);
        let alpha = -Infinity;
        let idx = -1;
        try {
            for (const i of order) {
                const u = makeMove(b, moves[i]);
                let v;
                try {
                    v = -search(b, 1 - me, depth - 1, -Infinity, -alpha + cfg.noise * 2 + 1, 1);
                } finally {
                    unmakeMove(b, moves[i], u);
                }
                v += noise[i];
                scores[i] = v;
                if (idx < 0 || v > scores[idx]) idx = i;
                if (v > alpha) alpha = v;
            }
        } catch (e) {
            if (!(e instanceof OutOfTime)) throw e;
            // Keep the unfinished iteration's choice only if its first
            // (previous best) move was fully searched and something beat it.
            if (idx >= 0 && idx !== order[0] && scores[order[0]] > -Infinity) bestIdx = idx;
            break;
        }
        bestIdx = idx;
        order = order.slice().sort((x, y) => scores[y] - scores[x]);
        if (Math.abs(scores[bestIdx]) > WIN / 2) break; // forced win or loss found
    }
    return moves[bestIdx];
}
