// Run: node --test games/draughts/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGame, legalMoves, applyMove, chooseBotMove, generateMoves, isLegalMove, parseMove,
    findMove, notation, pieceCount, kingCount, squareAt, rowOf, colOf, normalizeRules,
    DRAW, MAN, KING, SQUARES,
} from './engine.js';

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Positions in official numbering (1..50, player 0 = White at the bottom).
// { w: [men], W: [kings], b: [men], B: [kings] }
function pos(spec, { turn = 0, rules } = {}) {
    const board = new Array(SQUARES).fill(0);
    const put = (list, v) => (list || []).forEach((n) => { board[n - 1] = v; });
    put(spec.w, MAN); put(spec.W, KING); put(spec.b, -MAN); put(spec.B, -KING);
    return createGame({ board, turn, rules });
}
const N = (sq) => sq + 1; // index → official number
const paths = (moves) => moves.map((m) => m.path.map(N).join('-')).sort();

function perft(b, player, depth) {
    const moves = generateMoves(b, player, 'max');
    if (depth === 1) return moves.length;
    let n = 0;
    for (const m of moves) {
        const nb = b.slice();
        const from = m.path[0];
        const to = m.path[m.path.length - 1];
        const piece = nb[from];
        nb[from] = 0;
        for (const c of m.captures) nb[c] = 0;
        nb[to] = Math.abs(piece) === MAN && (player === 0 ? to < 5 : to >= 45) ? piece * 2 : piece;
        n += perft(nb, 1 - player, depth - 1);
    }
    return n;
}

test('board geometry: 50 dark squares, dark corner bottom-left', () => {
    const seen = new Set();
    for (let sq = 0; sq < SQUARES; sq++) {
        assert.equal((rowOf(sq) + colOf(sq)) % 2, 1);
        assert.equal(squareAt(rowOf(sq), colOf(sq)), sq);
        seen.add(sq);
    }
    assert.equal(seen.size, 50);
    assert.equal(squareAt(9, 0), 45); // square 46
    assert.equal(squareAt(0, 1), 0);  // square 1
    assert.equal(squareAt(0, 0), -1);
});

test('start position: 20 men each, White moves first with 9 moves', () => {
    const s = createGame();
    assert.equal(pieceCount(s, 0), 20);
    assert.equal(pieceCount(s, 1), 20);
    assert.equal(s.turn, 0);
    assert.equal(s.white, 0);
    assert.equal(legalMoves(s).length, 9);
    const b = createGame({ firstPlayer: 1 });
    assert.equal(b.turn, 1);
    assert.equal(b.white, 1);
    assert.equal(legalMoves(b).length, 9);
});

test('perft from the start matches the published numbers', () => {
    const s = createGame();
    assert.deepEqual([1, 2, 3, 4, 5].map((d) => perft(s.board.slice(), 0, d)), [9, 81, 658, 4265, 27117]);
});

test('men move forward only, one square', () => {
    const s = pos({ w: [33], b: [3] });
    assert.deepEqual(paths(legalMoves(s)), ['33-28', '33-29']);
    const t = pos({ w: [33], b: [18] }, { turn: 1 });
    assert.deepEqual(paths(legalMoves(t)), ['18-22', '18-23']);
});

test('capture is compulsory and men capture backwards', () => {
    // White man on 28, black man right behind it on 33, 39 free.
    const s = pos({ w: [28, 45], b: [33, 3] });
    const moves = legalMoves(s);
    assert.deepEqual(paths(moves), ['28-39']);
    assert.deepEqual(moves[0].captures.map(N), [33]);
    assert.throws(() => applyMove(s, { path: [44, 39] }), /Illegal/);
    const { state } = applyMove(s, { path: [27, 38] });
    assert.equal(state.board[32], 0, 'captured man removed');
    assert.equal(state.board[38], MAN);
});

test('majority rule: must take the most pieces (unless rules say free)', () => {
    // From 32 White can take 27 (one piece) or 28 then 18 (two pieces).
    const spec = { w: [32], b: [27, 28, 18, 5] };
    assert.deepEqual(paths(legalMoves(pos(spec))), ['32-23-12']);
    const free = pos(spec, { rules: { capture: 'free' } });
    assert.deepEqual(paths(legalMoves(free)), ['32-21', '32-23-12']);
    // A king counts the same as a man.
    const kings = pos({ w: [32], b: [27, 28], B: [18], W: [] });
    assert.equal(legalMoves(kings)[0].captures.length, 2);
});

test('flying king: moves any distance, captures from afar, lands anywhere behind', () => {
    const quiet = pos({ W: [46], b: [1] });
    assert.deepEqual(paths(legalMoves(quiet)), ['46-10', '46-14', '46-19', '46-23', '46-28', '46-32', '46-37', '46-41', '46-5']);
    const cap = pos({ W: [46], b: [28, 1] });
    assert.deepEqual(paths(legalMoves(cap)), ['46-10', '46-14', '46-19', '46-23', '46-5']);
    // Only landing on 19 lets the king go on and take 13: majority rule.
    const more = pos({ W: [46], b: [28, 13, 1] });
    assert.deepEqual(paths(legalMoves(more)), ['46-19-2', '46-19-8']);
    for (const m of legalMoves(more)) assert.deepEqual(m.captures.map(N).sort(), [13, 28]);
    // A king can't jump two pieces standing next to each other.
    const blocked = pos({ W: [46], b: [28, 23, 1] });
    assert.ok(legalMoves(blocked).every((m) => m.captures.length === 0));
});

test('Turkish strike: a jumped piece stays until the move ends and blocks the way', () => {
    // King 46 takes 37 and must come back across 37's square to reach 31:
    // not allowed, so the longest capture is 3 pieces and 31 survives.
    const s = pos({ W: [46], b: [37, 33, 43, 31, 1] });
    const moves = legalMoves(s);
    assert.ok(moves.length > 0);
    for (const m of moves) {
        assert.equal(m.captures.length, 3, m.path.map(N).join('x'));
        assert.equal(new Set(m.captures).size, m.captures.length);
        assert.ok(!m.captures.includes(30), '31 is behind the jumped piece');
    }
});

test('a man passing the far row in a capture does not become a king', () => {
    // 13 takes 8 (lands on 2, the far row) and must go on taking 7 to 11.
    const s = pos({ w: [13, 50], b: [8, 7, 30] });
    const moves = legalMoves(s);
    assert.deepEqual(paths(moves), ['13-2-11']);
    const { state, events } = applyMove(s, moves[0]);
    assert.equal(state.board[10], MAN);
    assert.equal(events[0].promote, false);
    // Ending on the far row does make a king.
    const p = pos({ w: [7, 50], b: [30] });
    const r = applyMove(p, { path: [6, 0] });
    assert.equal(r.state.board[0], KING);
    assert.equal(r.events[0].promote, true);
    assert.equal(kingCount(r.state, 0), 1);
});

test('a player who cannot move loses', () => {
    const s = pos({ w: [28, 50], b: [22] });
    const { state, events } = applyMove(s, { path: [27, 16] });
    assert.equal(pieceCount(state, 1), 0);
    assert.equal(state.winner, 0);
    assert.equal(state.reason, 'no_moves');
    assert.deepEqual(events.at(-1), { type: 'win', player: 0, reason: 'no_moves' });
    // Blocked: after 49-44 the black man on 35 can neither step to 40 nor jump it.
    const blocked = pos({ w: [40, 45, 49], b: [35] }, { turn: 0 });
    const r = applyMove(blocked, { path: [48, 43] });
    assert.equal(r.state.winner, 0);
    assert.throws(() => applyMove(r.state, { path: [34, 39] }), /Illegal/);
});

test('draw by threefold repetition', () => {
    let s = pos({ W: [50, 46], B: [1, 5] });
    const cycle = [[49, 44], [0, 5], [44, 49], [5, 0]];
    let plies = 0;
    while (s.winner === null && plies < 20) {
        s = applyMove(s, { path: cycle[plies % 4] }).state;
        plies++;
    }
    assert.equal(s.winner, DRAW);
    assert.equal(s.reason, 'repetition');
    assert.equal(plies, 8);
});

test('draw after 25 moves each with only kings and no captures', () => {
    const s = pos({ W: [50, 46], w: [], B: [1, 5], b: [] });
    s.kingMoves = 49;
    const r = applyMove(s, { path: [49, 44] }).state;
    assert.equal(r.winner, DRAW);
    assert.equal(r.reason, 'kings_only');
    // A man move resets the count.
    const t = pos({ W: [46], w: [40], B: [1, 5] });
    t.kingMoves = 49;
    assert.equal(applyMove(t, { path: [39, 34] }).state.kingMoves, 0);
});

test('drawn endgames: 3 pieces vs lone king 16 moves, 2 pieces vs lone king 5 moves', () => {
    const three = pos({ W: [46, 50], w: [36], B: [5] });
    assert.equal(three.egClass, 16);
    const two = pos({ W: [46, 50], B: [5] });
    assert.equal(two.egClass, 5);
    assert.equal(pos({ W: [46], w: [36, 37, 38], B: [5] }).egClass, 0, '4 pieces: play on');
    // 1 king vs 1 king: the count runs from the moment the ending appears...
    const k = pos({ W: [46], B: [1] });
    assert.equal(k.egClass, 5);
    const k1 = applyMove(k, { path: [45, 40] }).state;
    assert.equal(k1.egPlies, 1);
    assert.equal(k1.winner, null);
    // ...and after 5 moves each it is a draw.
    k.egPlies = 9;
    const end = applyMove(k, { path: [45, 40] }).state;
    assert.equal(end.winner, DRAW);
    assert.equal(end.reason, 'endgame');
    // A man move inside the same ending keeps the count going.
    const c = pos({ W: [46, 50], w: [36], B: [5], b: [] });
    c.egPlies = 20;
    assert.equal(applyMove(c, { path: [35, 30] }).state.egPlies, 21);
});

test('parseMove / isLegalMove never trust the phone', () => {
    const s = createGame();
    for (const bad of [null, 5, 'x', {}, { path: [] }, { path: [31] }, { path: [31, 'a'] }, { path: [31, 50] },
        { path: [-1, 3] }, { path: [31.5, 26] }, { path: new Array(40).fill(1) }]) {
        assert.equal(parseMove(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseMove({ path: [31, 26], extra: 1 }), { path: [31, 26] });
    assert.deepEqual(parseMove([31, 26]), { path: [31, 26] });
    assert.ok(isLegalMove(s, { path: [31, 26] }));
    assert.ok(!isLegalMove(s, { path: [31, 21] }));
    assert.ok(!isLegalMove(s, { path: [15, 20] }), "not the opponent's piece");
    assert.ok(!isLegalMove(s, null));
    assert.equal(findMove(s, [30, 25]).path.length, 2);
    assert.equal(notation(s, findMove(s, [30, 25])), '31-26');
    assert.deepEqual(normalizeRules({ capture: 'nope', x: 1 }), { capture: 'max' });
});

test('applyMove does not mutate its input and counts moves', () => {
    const s = createGame();
    const copy = JSON.stringify(s);
    const { state } = applyMove(s, { path: [31, 26] });
    assert.equal(JSON.stringify(s), copy);
    assert.equal(state.moveCount, 1);
    assert.equal(state.turn, 1);
    assert.deepEqual(state.lastMove, { player: 0, path: [31, 26], captures: [] });
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(state)));
});

test('bot: always legal, takes a free piece, every level', () => {
    const rng = mulberry32(5);
    for (const level of ['easy', 'medium', 'hard']) {
        const s = createGame();
        const m = chooseBotMove(s, level, rng);
        assert.ok(findMove(s, m.path), level);
    }
    // Black to move: 18x27 wins a man; 18-22 or others just lose time.
    const s = pos({ w: [22, 46, 47], b: [17, 1] }, { turn: 1 });
    const m = chooseBotMove(s, 'medium', rng);
    assert.ok(m.captures.length === 1);
    // Medium doesn't hand over a man: 33-29 walks into 24x33.
    const safe = pos({ w: [33, 47], b: [24, 1] });
    for (let i = 0; i < 5; i++) assert.notEqual(chooseBotMove(safe, 'medium', rng).path.map(N).join('-'), '33-29');
    assert.equal(chooseBotMove({ ...createGame(), winner: 0 }, 'easy', rng), null);
});

test('medium beats easy, and games between bots always finish', () => {
    const rng = mulberry32(11);
    let mediumWins = 0;
    for (let g = 0; g < 4; g++) {
        let s = createGame({ firstPlayer: g % 2 });
        const medium = g % 2; // alternate colours
        while (s.winner === null) {
            const m = chooseBotMove(s, s.turn === medium ? 'medium' : 'easy', rng);
            assert.ok(isLegalMove(s, m));
            s = applyMove(s, m, { withEvents: false }).state;
            assert.ok(pieceCount(s, 0) <= 20 && pieceCount(s, 1) <= 20);
        }
        if (s.winner === medium) mediumWins++;
    }
    assert.ok(mediumWins >= 3, 'medium won ' + mediumWins + ' of 4');
});

test('random games: captures are real enemy pieces, no piece taken twice, games end', () => {
    const rng = mulberry32(21);
    for (let g = 0; g < 30; g++) {
        let s = createGame({ rules: { capture: g % 3 === 0 ? 'free' : 'max' }, firstPlayer: g % 2 });
        while (s.winner === null) {
            const moves = legalMoves(s);
            const m = moves[Math.floor(rng() * moves.length)];
            const me = s.turn;
            assert.equal(new Set(m.captures).size, m.captures.length);
            for (const c of m.captures) assert.ok(s.board[c] * (me === 0 ? -1 : 1) > 0);
            const before = pieceCount(s, 1 - me);
            s = applyMove(s, m, { withEvents: false }).state;
            assert.equal(pieceCount(s, 1 - me), before - m.captures.length);
        }
        assert.ok([0, 1, DRAW].includes(s.winner));
        assert.ok(s.reason);
    }
});

test('draughts.html carries the current engine (run games/build.mjs if this fails)', async () => {
    const { readFileSync } = await import('node:fs');
    const { inlineEngine, pagePaths } = await import('../build.mjs');
    const p = pagePaths('draughts');
    const html = readFileSync(p.html, 'utf8');
    assert.equal(inlineEngine(html, readFileSync(p.engine, 'utf8')), html);
});
