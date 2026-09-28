// games/connect4/engine.js
// Connect 4 for two players. Pure game logic, no DOM — the same file runs in
// the browser (offline play, bot) and on the server (online rooms), where the
// server is the only one allowed to call applyMove().
//
// Board
// -----
// `grid` is a flat array of rows × cols cells, row 0 at the top:
//   grid[row * cols + col] = null (empty) | 0 | 1 (player)
// A disc dropped into a column falls to the lowest empty row.
// Player 0 plays red, player 1 yellow.
//
// Rules: four of your discs in a row (across, down or diagonally) win.
// A full board with no four is a draw. The only option is the board size
// (`state.rules.size`); the classic board is 7 columns × 6 rows.

export const DRAW = -1;
export const CONNECT = 4;

export const SIZES = {
    '7x6': { cols: 7, rows: 6 },
    '6x5': { cols: 6, rows: 5 },
    '8x7': { cols: 8, rows: 7 },
    '9x7': { cols: 9, rows: 7 },
};

export const DEFAULT_RULES = { size: '7x6' };

export const RULE_OPTIONS = { size: Object.keys(SIZES) };

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (rules && RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

export function createGame({ rules, firstPlayer = 0 } = {}) {
    const r = normalizeRules(rules);
    const { cols, rows } = SIZES[r.size];
    return {
        rules: r,
        cols,
        rows,
        grid: new Array(cols * rows).fill(null),
        turn: firstPlayer === 1 ? 1 : 0,
        moveCount: 0,
        winner: null,   // 0 | 1 | DRAW | null
        winLine: null,  // cell indices of the winning line(s)
        lastMove: null, // { player, col, row }
    };
}

export function cloneState(s) {
    return {
        rules: s.rules,
        cols: s.cols,
        rows: s.rows,
        grid: s.grid.slice(),
        turn: s.turn,
        moveCount: s.moveCount,
        winner: s.winner,
        winLine: s.winLine ? s.winLine.slice() : null,
        lastMove: s.lastMove,
    };
}

// Row a disc dropped into `col` lands on, or -1 if the column is full.
export function dropRow(state, col) {
    const { cols, rows, grid } = state;
    for (let r = rows - 1; r >= 0; r--) if (grid[r * cols + col] === null) return r;
    return -1;
}

export function legalMoves(state) {
    if (state.winner !== null) return [];
    const moves = [];
    for (let c = 0; c < state.cols; c++) if (state.grid[c] === null) moves.push(c);
    return moves;
}

export function isLegalMove(state, col, player = state.turn) {
    return (
        state.winner === null &&
        player === state.turn &&
        Number.isInteger(col) &&
        col >= 0 &&
        col < state.cols &&
        state.grid[col] === null
    );
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// Cells of every line of 4+ through (row, col) for its owner, or null.
export function linesThrough(state, row, col) {
    const { cols, rows, grid } = state;
    const p = grid[row * cols + col];
    if (p === null) return null;
    const cells = [];
    for (const [dr, dc] of DIRS) {
        const line = [row * cols + col];
        for (const s of [1, -1]) {
            let r = row + dr * s;
            let c = col + dc * s;
            while (r >= 0 && r < rows && c >= 0 && c < cols && grid[r * cols + c] === p) {
                line.push(r * cols + c);
                r += dr * s;
                c += dc * s;
            }
        }
        if (line.length >= CONNECT) for (const i of line) if (!cells.includes(i)) cells.push(i);
    }
    return cells.length ? cells.sort((a, b) => a - b) : null;
}

/**
 * Drop a disc into `col` for the player whose turn it is.
 * Returns { state, events } — a NEW state (input is not mutated) and the
 * events for the UI to animate:
 *   { type: 'drop', player, col, row }
 *   { type: 'win',  player, line }     player may be DRAW (line is then [])
 * Throws on an illegal move (the server relies on this).
 */
export function applyMove(prev, col) {
    if (!isLegalMove(prev, col)) throw new Error(`Illegal move: ${col}`);
    const s = cloneState(prev);
    const me = s.turn;
    const row = dropRow(s, col);
    s.grid[row * s.cols + col] = me;
    s.moveCount++;
    s.lastMove = { player: me, col, row };
    s.turn = 1 - me;
    const events = [{ type: 'drop', player: me, col, row }];
    const line = linesThrough(s, row, col);
    if (line) {
        s.winner = me;
        s.winLine = line;
    } else if (s.moveCount === s.cols * s.rows) {
        s.winner = DRAW;
    }
    if (s.winner !== null) events.push({ type: 'win', player: s.winner, line: s.winLine || [] });
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
//   easy    take a win, block a loss, otherwise a random column
//   medium  looks 4 moves ahead, with a little randomness
//   hard    looks 7 moves ahead (6 on the wider boards, to stay fast)
// The search works on a mutable copy of the board for speed.

export const BOT_LEVELS = {
    easy: { depth: 0, noise: 0 },
    medium: { depth: 4, noise: 6 },
    hard: { depth: 7, noise: 0 },
};

const WIN_SCORE = 1_000_000;

function makeSearch(state) {
    const { cols, rows } = state;
    const grid = state.grid.slice();
    const height = new Array(cols).fill(0); // discs in each column
    for (let c = 0; c < cols; c++) {
        for (let r = rows - 1; r >= 0 && grid[r * cols + c] !== null; r--) height[c]++;
    }
    // Centre columns first: better moves first makes alpha-beta much faster.
    const order = Array.from({ length: cols }, (_, c) => c)
        .sort((a, b) => Math.abs(a - (cols - 1) / 2) - Math.abs(b - (cols - 1) / 2));

    // All windows of 4 cells, precomputed for the evaluation.
    const windows = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            for (const [dr, dc] of DIRS) {
                const er = r + dr * (CONNECT - 1);
                const ec = c + dc * (CONNECT - 1);
                if (er < 0 || er >= rows || ec < 0 || ec >= cols) continue;
                const w = [];
                for (let k = 0; k < CONNECT; k++) w.push((r + dr * k) * cols + (c + dc * k));
                windows.push(w);
            }
        }
    }

    function wins(row, col, p) {
        for (const [dr, dc] of DIRS) {
            let n = 1;
            for (const s of [1, -1]) {
                let r = row + dr * s;
                let c = col + dc * s;
                while (r >= 0 && r < rows && c >= 0 && c < cols && grid[r * cols + c] === p) {
                    n++;
                    r += dr * s;
                    c += dc * s;
                }
            }
            if (n >= CONNECT) return true;
        }
        return false;
    }

    function play(col, p) {
        const row = rows - 1 - height[col]++;
        grid[row * cols + col] = p;
        return row;
    }
    function undo(col) {
        const row = rows - height[col]--;
        grid[row * cols + col] = null;
    }
    const canPlay = (col) => height[col] < rows;
    const winsAt = (col, p) => {
        if (!canPlay(col)) return false;
        const row = play(col, p);
        const w = wins(row, col, p);
        undo(col);
        return w;
    };

    // Static evaluation for player p.
    function evaluate(p) {
        const o = 1 - p;
        let score = 0;
        const mid = (cols - 1) / 2;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const v = grid[r * cols + c];
                if (v === null) continue;
                const bonus = Math.max(0, 3 - Math.abs(c - mid));
                score += v === p ? bonus : -bonus;
            }
        }
        for (const w of windows) {
            let mine = 0;
            let theirs = 0;
            for (const i of w) {
                if (grid[i] === p) mine++;
                else if (grid[i] === o) theirs++;
            }
            if (mine && theirs) continue;
            if (mine === 3) score += 50;
            else if (mine === 2) score += 8;
            else if (theirs === 3) score -= 60;
            else if (theirs === 2) score -= 8;
        }
        return score;
    }

    // Negamax with alpha-beta; the score is for the player to move (p).
    function negamax(depth, alpha, beta, p, filled) {
        if (filled === cols * rows) return 0;
        for (const c of order) if (winsAt(c, p)) return WIN_SCORE - filled;
        if (depth === 0) return evaluate(p);
        let best = -Infinity;
        for (const c of order) {
            if (!canPlay(c)) continue;
            play(c, p);
            const v = -negamax(depth - 1, -beta, -alpha, 1 - p, filled + 1);
            undo(c);
            if (v > best) best = v;
            if (best > alpha) alpha = best;
            if (alpha >= beta) break;
        }
        return best;
    }

    return { order, canPlay, winsAt, play, undo, negamax };
}

/**
 * Pick a column for the player whose turn it is.
 * `rng` is injectable so tests (and the server) can be deterministic.
 */
export function chooseBotMove(state, level = 'medium', rng = Math.random) {
    const moves = legalMoves(state);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    const me = state.turn;
    const opp = 1 - me;
    const S = makeSearch(state);

    // Win now, else stop the opponent winning now (every level does this).
    for (const c of S.order) if (S.winsAt(c, me)) return c;
    for (const c of S.order) if (S.winsAt(c, opp)) return c;

    const { depth: d, noise } = BOT_LEVELS[level] || BOT_LEVELS.medium;
    if (d === 0) return moves[Math.floor(rng() * moves.length)];
    const depth = state.cols > 7 ? Math.min(d, 6) : d;

    let bestMove = moves[0];
    let bestScore = -Infinity;
    for (const c of S.order) {
        if (!S.canPlay(c)) continue;
        S.play(c, me);
        // Without noise, only a strictly better move matters (root pruning).
        const alpha = noise ? -Infinity : bestScore;
        let v = -S.negamax(depth - 1, -Infinity, -alpha, opp, state.moveCount + 1);
        S.undo(c);
        if (noise && Math.abs(v) < WIN_SCORE / 2) v += (rng() - 0.5) * 2 * noise;
        if (v > bestScore) { bestScore = v; bestMove = c; }
    }
    return bestMove;
}
