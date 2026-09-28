// Run: node --test games/connect4/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DRAW, SIZES, DEFAULT_RULES, RULE_OPTIONS, normalizeRules, createGame, dropRow,
    legalMoves, isLegalMove, applyMove, chooseBotMove,
} from './engine.js';

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Play a list of columns, alternating players.
function play(cols, s = createGame()) {
    for (const c of cols) s = applyMove(s, c).state;
    return s;
}

// Build a position from a picture (top row first): '.' empty, 'R' player 0, 'Y' player 1.
function fromRows(rows, turn = 0) {
    const s = createGame();
    s.grid = rows.join('').split('').map((ch) => (ch === 'R' ? 0 : ch === 'Y' ? 1 : null));
    s.moveCount = s.grid.filter((v) => v !== null).length;
    s.turn = turn;
    return s;
}

test('rules: defaults, sizes and junk input', () => {
    assert.deepEqual(normalizeRules(), DEFAULT_RULES);
    assert.deepEqual(normalizeRules({ size: '9x7', evil: 1 }), { size: '9x7' });
    assert.deepEqual(normalizeRules({ size: '100x100' }), DEFAULT_RULES);
    assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
    for (const size of RULE_OPTIONS.size) {
        const s = createGame({ rules: { size } });
        assert.equal(s.cols, SIZES[size].cols);
        assert.equal(s.rows, SIZES[size].rows);
        assert.equal(s.grid.length, s.cols * s.rows);
        assert.equal(legalMoves(s).length, s.cols);
    }
    assert.equal(createGame({ firstPlayer: 1 }).turn, 1);
    assert.equal(createGame({ firstPlayer: 7 }).turn, 0);
});

test('discs fall to the bottom and stack', () => {
    const s = play([3, 3, 3]);
    assert.equal(s.grid[5 * 7 + 3], 0);
    assert.equal(s.grid[4 * 7 + 3], 1);
    assert.equal(s.grid[3 * 7 + 3], 0);
    assert.equal(dropRow(s, 3), 2);
    assert.deepEqual(s.lastMove, { player: 0, col: 3, row: 3 });
    assert.equal(s.turn, 1);
    assert.equal(s.moveCount, 3);
});

test('events describe the drop and the win', () => {
    const r = applyMove(createGame(), 2);
    assert.deepEqual(r.events, [{ type: 'drop', player: 0, col: 2, row: 5 }]);
    const s = play([0, 6, 1, 6, 2, 6]);
    const w = applyMove(s, 3);
    assert.equal(w.state.winner, 0);
    assert.deepEqual(w.events[1], { type: 'win', player: 0, line: [35, 36, 37, 38] });
});

test('four in a row wins: across, down and both diagonals', () => {
    // Across
    let s = play([0, 0, 1, 1, 2, 2, 3]);
    assert.equal(s.winner, 0);
    assert.deepEqual(s.winLine, [35, 36, 37, 38]);
    // Down (yellow)
    s = play([0, 1, 0, 1, 0, 1, 6, 1]);
    assert.equal(s.winner, 1);
    assert.deepEqual(s.winLine, [8, 15, 22, 29].map((i) => i + 7));
    // Diagonal /
    s = play([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
    assert.equal(s.winner, 0);
    assert.deepEqual(s.winLine, [2 * 7 + 3, 3 * 7 + 2, 4 * 7 + 1, 5 * 7 + 0]);
    // Diagonal \
    s = play([6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3]);
    assert.equal(s.winner, 0);
    // Three is not enough
    s = play([0, 0, 1, 1, 2, 2]);
    assert.equal(s.winner, null);
});

test('five in a row: the whole line is highlighted', () => {
    const s = play([0, 0, 1, 1, 3, 3, 4, 4, 2]);
    assert.equal(s.winner, 0);
    assert.deepEqual(s.winLine, [35, 36, 37, 38, 39]);
});

test('full board without four is a draw', () => {
    const s = fromRows([
        'RRYYRR.',
        'YYRRYYR',
        'RRYYRRY',
        'YYRRYYR',
        'RRYYRRY',
        'YYRRYYR',
    ], 1);
    assert.deepEqual(legalMoves(s), [6]);
    const r = applyMove(s, 6);
    assert.equal(r.state.moveCount, 42);
    assert.equal(r.state.winner, DRAW);
    assert.equal(r.state.winLine, null);
    assert.deepEqual(r.events[1], { type: 'win', player: DRAW, line: [] });
    assert.deepEqual(legalMoves(r.state), []);
});

test('illegal moves throw and do not mutate', () => {
    let s = play([0, 0, 0, 0, 0, 0]);
    const before = JSON.stringify(s);
    assert.equal(isLegalMove(s, 0), false);
    assert.throws(() => applyMove(s, 0));
    assert.throws(() => applyMove(s, 7));
    assert.throws(() => applyMove(s, -1));
    assert.throws(() => applyMove(s, 1.5));
    assert.throws(() => applyMove(s, '3'));
    assert.throws(() => applyMove(s, null));
    assert.equal(isLegalMove(s, 3, 1), false, 'not your turn');
    applyMove(s, 3);
    assert.equal(JSON.stringify(s), before);
    s = play([0, 1, 0, 1, 0, 1, 0]);
    assert.throws(() => applyMove(s, 2), 'no moves after the game is won');
});

test('state is plain JSON (can go over the network)', () => {
    const s = play([3, 3, 4]);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('every bot level wins now and blocks now', () => {
    const win = fromRows([
        '.......',
        '.......',
        '.......',
        '.......',
        'Y.YY...',
        'RRR.YY.',
    ], 0);
    const block = fromRows([
        '.......',
        '.......',
        '.......',
        '.......',
        '....R..',
        'YYY.RR.',
    ], 0);
    for (const level of ['easy', 'medium', 'hard']) {
        assert.equal(chooseBotMove(win, level, mulberry32(1)), 3, level + ' wins');
        assert.equal(chooseBotMove(block, level, mulberry32(1)), 3, level + ' blocks');
    }
});

test('hard bot sets up a two-way threat', () => {
    // Red to move: only column 1 makes ".RRR." with both ends open.
    const s = fromRows([
        '.......',
        '.......',
        '.......',
        '.......',
        '...Y...',
        '..RR.Y.',
    ], 0);
    assert.equal(chooseBotMove(s, 'hard'), 1);
});

test('random games with bots finish on every board size', () => {
    const rng = mulberry32(7);
    for (const size of RULE_OPTIONS.size) {
        for (let g = 0; g < 4; g++) {
            let s = createGame({ rules: { size }, firstPlayer: g % 2 });
            while (s.winner === null) {
                const level = ['easy', 'medium'][s.turn];
                const m = chooseBotMove(s, level, rng);
                assert.ok(isLegalMove(s, m));
                s = applyMove(s, m).state;
            }
            assert.ok(s.moveCount <= s.cols * s.rows);
        }
    }
});

test('stronger bots beat weaker ones', () => {
    const rng = mulberry32(3);
    function match(a, b, games) {
        let wins = 0;
        for (let g = 0; g < games; g++) {
            // a plays player 0 in even games, player 1 in odd games.
            const aSeat = g % 2;
            let s = createGame({ firstPlayer: g % 4 < 2 ? 0 : 1 });
            while (s.winner === null) {
                s = applyMove(s, chooseBotMove(s, s.turn === aSeat ? a : b, rng)).state;
            }
            if (s.winner === aSeat) wins++;
        }
        return wins;
    }
    const g1 = 30;
    const w1 = match('medium', 'easy', g1);
    assert.ok(w1 >= g1 * 0.7, `medium beat easy ${w1}/${g1}`);
    const g2 = 12;
    const w2 = match('hard', 'medium', g2);
    assert.ok(w2 >= g2 * 0.6, `hard beat medium ${w2}/${g2}`);
});

test('bot is quick enough for a phone (hard, biggest board)', () => {
    let s = createGame({ rules: { size: '9x7' } });
    const rng = mulberry32(9);
    let worst = 0;
    while (s.winner === null) {
        const t = performance.now();
        const m = chooseBotMove(s, s.turn === 0 ? 'hard' : 'medium', rng);
        worst = Math.max(worst, performance.now() - t);
        s = applyMove(s, m).state;
    }
    assert.ok(worst < 1500, `slowest move ${Math.round(worst)} ms`);
});

test('connect-four.html carries the current engine (run games/build.mjs if this fails)', async () => {
    const { readFileSync } = await import('node:fs');
    const { inlineEngine, pagePaths } = await import('../build.mjs');
    const p = pagePaths('connect4');
    const html = readFileSync(p.html, 'utf8');
    assert.equal(inlineEngine(html, readFileSync(p.engine, 'utf8')), html);
});
