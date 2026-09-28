// Run: node --test games/igisoro/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGame, applyMove, legalMoves, chooseBotMove, seedCount,
    columnOf, pitsInColumn, normalizeRules, RULE_OPTIONS, DEFAULT_RULES, PITS, DRAW,
} from './engine.js';

// Small deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function emptyGame(rules) {
    const s = createGame({ rules });
    s.pits = [new Array(PITS).fill(0), new Array(PITS).fill(0)];
    return s;
}

test('starting position: 32 seeds each, player 0 to move', () => {
    const s = createGame();
    assert.equal(seedCount(s, 0), 32);
    assert.equal(seedCount(s, 1), 32);
    assert.equal(s.turn, 0);
    assert.deepEqual(legalMoves(s), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('column mapping is consistent both ways', () => {
    for (const p of [0, 1]) {
        for (let col = 0; col < 8; col++) {
            const { outer, inner } = pitsInColumn(p, col);
            assert.equal(columnOf(p, outer), col);
            assert.equal(columnOf(p, inner), col);
        }
    }
});

test('illegal moves throw and do not mutate', () => {
    const s = createGame();
    const before = JSON.stringify(s);
    assert.throws(() => applyMove(s, 8)); // empty inner pit
    assert.throws(() => applyMove(s, 99));
    assert.throws(() => applyMove(s, -1));
    applyMove(s, 0);
    assert.equal(JSON.stringify(s), before);
});

test('turn ends when the last seed lands in an empty pit', () => {
    const s = emptyGame();
    s.pits[0][0] = 2;
    s.pits[0][5] = 2; // keeps player 0 alive
    s.pits[1][0] = 2;
    const { state, events } = applyMove(s, 0);
    assert.deepEqual(state.pits[0].slice(0, 3), [0, 1, 1]);
    assert.equal(state.turn, 1);
    assert.equal(events.at(-1).type, 'end');
});

test('relay: landing in an occupied outer pit keeps sowing', () => {
    const s = emptyGame();
    s.pits[0][0] = 2;
    s.pits[0][2] = 3; // last seed lands here → 4 seeds, pick up and sow 3..6
    s.pits[1][0] = 2;
    const { state } = applyMove(s, 0);
    assert.deepEqual(state.pits[0].slice(0, 7), [0, 1, 0, 1, 1, 1, 1]);
    assert.equal(seedCount(state, 0), 5);
});

test('capture: inner-row landing takes both opponent pits in that column', () => {
    const s = emptyGame();
    // Player 0 sows 2 from pit 8 → lands on pit 10 (inner, column 5), occupied.
    s.pits[0][8] = 2;
    s.pits[0][10] = 1;
    const col = columnOf(0, 10);
    const t = pitsInColumn(1, col);
    s.pits[1][t.inner] = 3;
    s.pits[1][t.outer] = 2;
    s.pits[1][0] = 2; // a spare pit elsewhere so player 1 isn't wiped out
    const total = seedCount(s, 0) + seedCount(s, 1);
    const { state, events } = applyMove(s, 8);
    assert.ok(events.some((e) => e.type === 'capture' && e.count === 5));
    assert.equal(state.pits[1][t.inner], 0);
    assert.equal(state.pits[1][t.outer], 0);
    assert.equal(seedCount(state, 0) + seedCount(state, 1), total);
    assert.equal(seedCount(state, 0), 3 + 5);
});

test('no capture when one opponent pit in the column is empty', () => {
    const s = emptyGame();
    s.pits[0][8] = 2;
    s.pits[0][10] = 1;
    const t = pitsInColumn(1, columnOf(0, 10));
    s.pits[1][t.inner] = 3; // outer stays empty
    s.pits[1][0] = 2;
    const { events } = applyMove(s, 8);
    assert.ok(!events.some((e) => e.type === 'capture'));
});

test('player with no legal move loses', () => {
    const s = emptyGame();
    s.pits[0][8] = 2;
    s.pits[0][10] = 1;
    const t = pitsInColumn(1, columnOf(0, 10));
    s.pits[1][t.inner] = 1;
    s.pits[1][t.outer] = 1; // captured → player 1 has nothing left
    const { state } = applyMove(s, 8);
    assert.equal(state.winner, 0);
    assert.deepEqual(legalMoves(state), []);
});

test('random games: seeds are conserved and games finish', () => {
    const rng = mulberry32(42);
    for (let g = 0; g < 200; g++) {
        let s = createGame();
        let guard = 0;
        while (s.winner === null && guard++ < 2000) {
            const moves = legalMoves(s);
            s = applyMove(s, moves[Math.floor(rng() * moves.length)], { withEvents: false }).state;
            assert.equal(seedCount(s, 0) + seedCount(s, 1), 64);
        }
        assert.notEqual(s.winner, null, `game ${g} did not finish`);
    }
});

test('medium bot beats a random player most of the time', () => {
    const rng = mulberry32(7);
    let botWins = 0;
    const games = 20;
    for (let g = 0; g < games; g++) {
        const botSide = g % 2;
        let s = createGame();
        let guard = 0;
        while (s.winner === null && guard++ < 2000) {
            const moves = legalMoves(s);
            const m = s.turn === botSide
                ? chooseBotMove(s, 'medium', rng)
                : moves[Math.floor(rng() * moves.length)];
            s = applyMove(s, m, { withEvents: false }).state;
        }
        if (s.winner === botSide) botWins++;
    }
    assert.ok(botWins >= games * 0.8, `bot won only ${botWins}/${games}`);
});

// ---------------------------------------------------------------------------
// Rule variants
// ---------------------------------------------------------------------------

function allRuleCombos() {
    const combos = [{}];
    for (const [key, values] of Object.entries(RULE_OPTIONS)) {
        const next = [];
        for (const c of combos) for (const v of values) next.push({ ...c, [key]: v });
        combos.splice(0, combos.length, ...next);
    }
    return combos;
}

test('unknown rule values fall back to defaults', () => {
    assert.deepEqual(normalizeRules({ setup: 'nope', minSeeds: 7, extra: 1 }), DEFAULT_RULES);
    assert.equal(normalizeRules({ minSeeds: 1 }).minSeeds, 1);
});

test('every setup gives 32 seeds per side, mirrored', () => {
    const rng = mulberry32(3);
    for (const setup of RULE_OPTIONS.setup) {
        for (let i = 0; i < 20; i++) {
            const s = createGame({ rules: { setup }, rng });
            assert.equal(seedCount(s, 0), 32, setup);
            assert.deepEqual(s.pits[0], s.pits[1], setup);
            assert.ok(legalMoves(s).length > 0, setup);
        }
    }
    assert.deepEqual(createGame({ rules: { setup: 'all2' } }).pits[0], new Array(16).fill(2));
});

test('minSeeds 1 lets single seeds move', () => {
    const s = emptyGame({ minSeeds: 1 });
    s.pits[0][3] = 1;
    s.pits[1][0] = 1;
    assert.deepEqual(legalMoves(s), [3]);
    assert.deepEqual(legalMoves(emptyGame()), []);
});

test("captureNeeds 'inner': an empty opponent outer pit still allows capture", () => {
    const setup = (rules) => {
        const s = emptyGame(rules);
        s.pits[0][8] = 2;
        s.pits[0][10] = 1;
        const t = pitsInColumn(1, columnOf(0, 10));
        s.pits[1][t.inner] = 3; // outer stays empty
        s.pits[1][0] = 2;
        return s;
    };
    const both = applyMove(setup({ captureNeeds: 'both' }), 8);
    const inner = applyMove(setup({ captureNeeds: 'inner' }), 8);
    assert.ok(!both.events.some((e) => e.type === 'capture'));
    const cap = inner.events.find((e) => e.type === 'capture');
    assert.equal(cap.count, 3);
    assert.equal(cap.from.length, 1);
});

test("captureSow 'start' vs 'next' decides where captured seeds go", () => {
    const setup = (captureSow) => {
        const s = emptyGame({ captureSow });
        s.pits[0][8] = 2; // sow 9, 10 → lands on 10 (occupied, inner)
        s.pits[0][10] = 1;
        const t = pitsInColumn(1, columnOf(0, 10));
        s.pits[1][t.inner] = 1;
        s.pits[1][t.outer] = 1; // 2 captured seeds
        s.pits[1][0] = 2;
        return applyMove(s, 8);
    };
    const sowsAfterCapture = ({ events }) => {
        const i = events.findIndex((e) => e.type === 'capture');
        return events.slice(i + 1, i + 3).map((e) => e.pit);
    };
    assert.deepEqual(sowsAfterCapture(setup('start')), [8, 9]);
    assert.deepEqual(sowsAfterCapture(setup('next')), [11, 12]);
});

test('every rule combination: seeds conserved, games finish, bot legal', () => {
    const rng = mulberry32(99);
    for (const rules of allRuleCombos()) {
        for (let g = 0; g < 15; g++) {
            let s = createGame({ rules, rng });
            while (s.winner === null) {
                const moves = legalMoves(s);
                const m = g % 3 === 0 && s.turn === 1
                    ? chooseBotMove(s, 'easy', rng)
                    : moves[Math.floor(rng() * moves.length)];
                assert.ok(moves.includes(m));
                s = applyMove(s, m, { withEvents: false }).state;
                assert.equal(seedCount(s, 0) + seedCount(s, 1), 64, JSON.stringify(rules));
            }
            assert.ok([0, 1, DRAW].includes(s.winner));
        }
    }
});

test('igisoro.html carries the current engine (run games/build.mjs if this fails)', async () => {
    const { readFileSync } = await import('node:fs');
    const { inlineEngine, pagePaths } = await import('../build.mjs');
    const p = pagePaths('igisoro');
    const html = readFileSync(p.html, 'utf8');
    assert.equal(inlineEngine(html, readFileSync(p.engine, 'utf8')), html);
});
