// Run: node --test games/battleship/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGame, applyMove, isLegalMove, legalShots, chooseBotMove, normalizeRules, randomFleet,
    fleetProblem, canPlace, shipCells, shipsLeft, viewFor, viewMove, cellOf, cellName,
    FLEETS, DEFAULT_RULES, RULE_OPTIONS, UNKNOWN, MISS, HIT, CLEAR,
} from './engine.js';

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A fixed classic fleet: rows 0, 2, 4, 6, 8 from the left edge.
const ROWS = [{ x: 0, y: 0, h: true }, { x: 0, y: 2, h: true }, { x: 0, y: 4, h: true }, { x: 0, y: 6, h: true }, { x: 0, y: 8, h: true }];
// Another one: columns 9, 7, 5, 3, 1 from the top.
const COLS = [{ x: 9, y: 0, h: false }, { x: 7, y: 0, h: false }, { x: 5, y: 0, h: false }, { x: 3, y: 0, h: false }, { x: 1, y: 0, h: false }];

function placed(rules, a = ROWS, b = COLS, firstPlayer = 0) {
    let s = createGame({ rules, firstPlayer });
    s = applyMove(s, { type: 'place', ships: firstPlayer === 0 ? a : b }).state;
    s = applyMove(s, { type: 'place', ships: firstPlayer === 0 ? b : a }).state;
    return s;
}
const fire = (s, x, y) => applyMove(s, { type: 'fire', cell: cellOf(x, y) });

test('rules: defaults and bad values', () => {
    assert.deepEqual(normalizeRules(), DEFAULT_RULES);
    assert.deepEqual(normalizeRules({ fleet: 'huge', again: 'yes' }), DEFAULT_RULES);
    assert.deepEqual(normalizeRules({ fleet: 'russian', again: true }), { fleet: 'russian', again: true });
    assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
    assert.equal(FLEETS.classic.reduce((a, b) => a + b), 17);
    assert.equal(FLEETS.russian.reduce((a, b) => a + b), 20);
    assert.deepEqual(Object.keys(RULE_OPTIONS), ['fleet', 'again']);
});

test('fleet validation: bounds, touching, count, shape', () => {
    const sizes = FLEETS.classic;
    assert.equal(fleetProblem(sizes, ROWS), null);
    assert.equal(fleetProblem(sizes, COLS), null);
    assert.equal(fleetProblem(sizes, ROWS.slice(0, 4)), 'count');
    assert.equal(fleetProblem(sizes, [{ x: 6, y: 0, h: true }, ...ROWS.slice(1)]), 'bounds');
    assert.equal(fleetProblem(sizes, [{ x: 1, y: 1, h: false }, ...ROWS.slice(1)]), 'touch');
    // Corners touching is not allowed either.
    assert.equal(fleetProblem(sizes, [ROWS[0], { x: 5, y: 1, h: true }, ...ROWS.slice(2)]), 'touch');
    assert.equal(fleetProblem(sizes, [{ x: 0, y: 0, h: 1 }, ...ROWS.slice(1)]), 'shape');
    assert.equal(fleetProblem(sizes, [{ x: 0.5, y: 0, h: true }, ...ROWS.slice(1)]), 'bounds');
    assert.equal(fleetProblem(sizes, 'nope'), 'count');
    assert.equal(canPlace([{ x: 0, y: 0, h: true, size: 5 }], { x: 6, y: 0, h: true, size: 4 }), true);
    assert.equal(canPlace([{ x: 0, y: 0, h: true, size: 5 }], { x: 5, y: 0, h: true, size: 4 }), false);
});

test('random fleets are always valid, for both fleets', () => {
    const rng = mulberry32(3);
    for (const key of Object.keys(FLEETS)) {
        for (let i = 0; i < 300; i++) assert.equal(fleetProblem(FLEETS[key], randomFleet(FLEETS[key], rng)), null);
    }
    // Partly placed fleets are completed around the ships already there.
    const fixed = [ROWS[0], null, null, null, ROWS[4]].map((s, i) => s && { ...s, size: FLEETS.classic[i] });
    const done = randomFleet(FLEETS.classic, rng, fixed);
    assert.deepEqual({ x: done[0].x, y: done[0].y, h: done[0].h }, ROWS[0]);
    assert.deepEqual({ x: done[4].x, y: done[4].y, h: done[4].h }, ROWS[4]);
});

test('placement: first player places first, then the other; battle starts with the first player', () => {
    let s = createGame({ firstPlayer: 1 });
    assert.equal(s.phase, 'place');
    assert.equal(s.turn, 1);
    assert.equal(isLegalMove(s, { type: 'fire', cell: 0 }), false);
    assert.equal(isLegalMove(s, { type: 'place', ships: ROWS }, 0), false, 'not your turn');
    let r = applyMove(s, { type: 'place', ships: ROWS });
    assert.equal(r.state.turn, 0);
    assert.equal(r.state.phase, 'place');
    assert.deepEqual(r.events, [{ type: 'placed', player: 1 }]);
    r = applyMove(r.state, { type: 'place', ships: COLS });
    assert.equal(r.state.phase, 'battle');
    assert.equal(r.state.turn, 1);
    assert.equal(r.state.moveCount, 2);
    assert.equal(r.state.boards[0].ships[0].size, 5);
    assert.throws(() => applyMove(r.state, { type: 'place', ships: ROWS }));
});

test('miss passes the turn; hit, sink and the water around a sunk ship', () => {
    let s = placed();
    let r = fire(s, 0, 0); // player 0 shoots at COLS: (0,0) is water
    assert.equal(r.events[0].result, 'miss');
    assert.equal(r.state.boards[1].shots[0], MISS);
    assert.equal(r.state.turn, 1);
    assert.equal(isLegalMove(r.state, { type: 'fire', cell: 0 }, 0), false);

    // Player 1 hits the destroyer at (0,8)-(1,8) of ROWS.
    r = fire(r.state, 0, 8);
    assert.equal(r.events[0].result, 'hit');
    assert.equal(r.state.turn, 0, 'classic: turn passes after a hit');
    r = fire(r.state, 2, 2); // player 0 misses
    r = fire(r.state, 1, 8);
    assert.equal(r.events[0].result, 'sunk');
    assert.deepEqual(r.events[0].ship, { x: 0, y: 8, h: true, size: 2 });
    assert.deepEqual(r.events[0].cleared.sort((a, b) => a - b), [cellOf(0, 7), cellOf(1, 7), cellOf(2, 7), cellOf(2, 8), cellOf(0, 9), cellOf(1, 9), cellOf(2, 9)].sort((a, b) => a - b));
    assert.equal(r.state.boards[0].shots[cellOf(0, 9)], CLEAR);
    assert.deepEqual(r.state.sunk[0], [4]);
    assert.deepEqual(shipsLeft(r.state, 0), [5, 4, 3, 3]);
    // Cells already known can't be shot again.
    assert.equal(isLegalMove({ ...r.state, turn: 1 }, { type: 'fire', cell: cellOf(0, 9) }), false);
    assert.equal(r.state.fired[1], 2);
    assert.equal(r.state.hits[1], 2);
});

test('"shoot again" rule keeps the turn after a hit', () => {
    const s = placed({ again: true });
    let r = fire(s, 9, 0); // hit on the carrier
    assert.equal(r.state.turn, 0);
    assert.ok(r.events.some((e) => e.type === 'again'));
    r = fire(r.state, 8, 0); // miss
    assert.equal(r.state.turn, 1);
});

test('sinking the whole fleet wins; no moves after that', () => {
    let s = placed({ again: true });
    for (const ship of COLS.map((c, i) => ({ ...c, size: FLEETS.classic[i] }))) {
        for (const c of shipCells(ship)) {
            assert.equal(s.turn, 0);
            s = applyMove(s, { type: 'fire', cell: c }).state;
        }
    }
    assert.equal(s.winner, 0);
    assert.equal(s.phase, 'over');
    assert.equal(s.hits[0], 17);
    assert.deepEqual(legalShots(s), []);
    assert.equal(isLegalMove(s, { type: 'fire', cell: 50 }), false);
    assert.equal(chooseBotMove(s), null);
});

test('viewFor hides the other fleet but shows sunk ships; everything once the game is over', () => {
    let s = placed();
    s = fire(s, 0, 0).state;          // 0 misses
    s = fire(s, 0, 8).state;          // 1 hits the destroyer
    s = fire(s, 1, 1).state;          // 0 misses
    s = fire(s, 1, 8).state;          // 1 sinks it
    const v0 = viewFor(s, 0);
    assert.equal(v0.boards[0].ships.length, 5, 'own fleet visible');
    assert.equal(v0.boards[1].ships.length, 0, 'enemy fleet hidden');
    assert.equal(v0.boards[1].hidden, true);
    assert.deepEqual(v0.boards[1].shots, s.boards[1].shots, 'shots are public');
    const v1 = viewFor(s, 1);
    assert.deepEqual(v1.boards[0].ships, [{ x: 0, y: 8, h: true, size: 2 }], 'sunk ships are public');
    assert.deepEqual(v1.sunk[0], [0]);
    assert.deepEqual(shipsLeft(v1, 0), [5, 4, 3, 3]);
    assert.ok(!JSON.stringify(v0).includes('"x":9'), 'no trace of COLS carrier in player 0 view');
    // The original state is untouched.
    assert.equal(s.boards[1].ships.length, 5);
    // Over: both fleets are shown.
    const over = { ...s, winner: 1, phase: 'over' };
    assert.equal(viewFor(over, 0).boards[1].ships.length, 5);
    // Before placement is finished the other side sees nothing either.
    let p = createGame();
    p = applyMove(p, { type: 'place', ships: ROWS }).state;
    assert.equal(viewFor(p, 1).boards[0].ships.length, 0);
});

test('viewMove hides a placement from the opponent only', () => {
    const mv = { player: 0, move: { type: 'place', ships: ROWS }, events: [{ type: 'placed', player: 0 }], auto: false, n: 1 };
    assert.deepEqual(viewMove(mv, 1).move, { type: 'place' });
    assert.equal(viewMove(mv, 0), mv);
    const shot = { player: 0, move: { type: 'fire', cell: 5 }, events: [], n: 3 };
    assert.equal(viewMove(shot, 1), shot);
    assert.equal(viewMove(null, 1), null);
});

test('bot never peeks: same move from the full state and from its own view', () => {
    const rng = mulberry32(7);
    for (const level of ['easy', 'medium', 'hard']) {
        for (let g = 0; g < 8; g++) {
            let s = createGame({ rules: { fleet: g % 2 ? 'russian' : 'classic', again: g % 3 === 0 } });
            while (s.winner === null) {
                const seed = Math.floor(rng() * 1e9);
                const a = chooseBotMove(s, level, mulberry32(seed));
                if (s.phase === 'battle') {
                    const b = chooseBotMove(viewFor(s, s.turn), level, mulberry32(seed));
                    assert.deepEqual(a, b);
                }
                assert.ok(isLegalMove(s, a), JSON.stringify(a));
                s = applyMove(s, a).state;
            }
        }
    }
});

function playGame(levels, rng, rules) {
    let s = createGame({ rules, firstPlayer: rng() < 0.5 ? 0 : 1 });
    let guard = 0;
    while (s.winner === null && guard++ < 400) s = applyMove(s, chooseBotMove(s, levels[s.turn], rng)).state;
    assert.notEqual(s.winner, null);
    return s;
}

test('bots finish every game; stronger bots win more and need fewer shots', () => {
    const rng = mulberry32(21);
    const avgShots = {};
    for (const level of ['easy', 'medium', 'hard']) {
        let total = 0;
        for (let g = 0; g < 30; g++) {
            const s = playGame([level, level], rng);
            total += s.fired[s.winner];
        }
        avgShots[level] = total / 30;
    }
    console.log('average shots to win', avgShots);
    assert.ok(avgShots.hard < avgShots.medium && avgShots.medium < avgShots.easy, JSON.stringify(avgShots));
    assert.ok(avgShots.hard < 60, JSON.stringify(avgShots));

    let wins = 0;
    for (let g = 0; g < 40; g++) if (playGame(['hard', 'easy'], rng, { fleet: g % 2 ? 'russian' : 'classic' }).winner === 0) wins++;
    assert.ok(wins >= 32, `hard beat easy ${wins}/40`);
});

test('cell names', () => {
    assert.equal(cellName(0), 'A1');
    assert.equal(cellName(99), 'J10');
    assert.equal(cellName(cellOf(2, 6)), 'C7');
    assert.equal(UNKNOWN, 0);
    assert.equal(HIT, 2);
});

test('battleship.html carries the current engine (run games/build.mjs if this fails)', async () => {
    const { readFileSync } = await import('node:fs');
    const { inlineEngine, pagePaths } = await import('../build.mjs');
    const p = pagePaths('battleship');
    const html = readFileSync(p.html, 'utf8');
    assert.equal(inlineEngine(html, readFileSync(p.engine, 'utf8')), html);
});
