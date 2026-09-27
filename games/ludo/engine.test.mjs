// Run: node --test games/ludo/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGame, applyAction, legalTokens, isLegalAction, chooseBotAction, normalizeRules,
    squareOf, homeCount, seatsFor, START, SAFE, TRACK, HOME_STEP, RULE_OPTIONS, DEFAULT_RULES,
} from './engine.js';

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// rng that yields the given die faces in order
const dice = (...faces) => { let i = 0; return () => (faces[i++ % faces.length] - 1) / 6 + 0.01; };
const roll = (s, face) => applyAction(s, { type: 'roll' }, dice(face));
const move = (s, token) => applyAction(s, { type: 'move', token });

test('board geometry: starts 13 apart, home column entry at the middle of your arm', () => {
    assert.deepEqual(START, [40, 1, 14, 27]);
    for (const p of [0, 1, 2, 3]) {
        assert.equal(squareOf(p, 0), START[p]);
        // The last track square is the middle of its own arm, 2 squares before the start.
        assert.equal((squareOf(p, 50) + 2) % TRACK, START[p]);
        assert.ok(SAFE.has(START[p]));
        assert.ok(SAFE.has((START[p] + 8) % TRACK));
    }
    assert.deepEqual(seatsFor(2), [0, 2]);
    assert.deepEqual(seatsFor(3), [0, 1, 2]);
});

test('need a 6 to leave the yard; no move passes the turn', () => {
    let s = createGame({ players: [0, 2] });
    let r = roll(s, 4);
    assert.ok(r.events.some((e) => e.type === 'pass'));
    assert.equal(r.state.turn, 2);
    assert.equal(r.state.phase, 'roll');
    r = roll(r.state, 6);
    assert.equal(r.state.phase, 'move');
    assert.deepEqual(legalTokens(r.state), [0, 1, 2, 3]);
    r = move(r.state, 1);
    assert.equal(r.state.tokens[2][1], 0);
    assert.equal(r.state.turn, 2, 'a 6 gives another roll');
    assert.ok(r.events.some((e) => e.type === 'again'));
});

test("enter '1or6' lets a 1 leave the yard", () => {
    const s = createGame({ players: [0, 2], rules: { enter: '1or6' } });
    const r = roll(s, 1);
    assert.equal(r.state.phase, 'move');
    const m = move(r.state, 0);
    assert.equal(m.state.tokens[0][0], 0);
    assert.equal(m.state.turn, 2, 'a 1 gives no extra roll');
});

test('capture sends the other token home and gives a bonus roll', () => {
    let s = createGame({ players: [0, 1] });
    // Player 0 token at step 3 (square 43), player 1 token on square 45 = its step 44.
    s.tokens[0][0] = 3;
    s.tokens[1][0] = (45 - START[1] + TRACK) % TRACK;
    assert.equal(squareOf(1, s.tokens[1][0]), 45);
    let r = roll(s, 2);
    r = move(r.state, 0);
    assert.equal(r.state.tokens[1][0], -1);
    const cap = r.events.find((e) => e.type === 'capture');
    assert.deepEqual(cap.victims, [{ player: 1, token: 0 }]);
    assert.equal(r.state.turn, 0);
    assert.equal(r.state.phase, 'roll');
});

test('no capture on safe squares; no bonus when bonus is off', () => {
    let s = createGame({ players: [0, 1] });
    s.tokens[0][0] = 6; // square 46 → +2 = 48 (star)
    s.tokens[1][0] = (48 - START[1] + TRACK) % TRACK;
    let r = move(roll(s, 2).state, 0);
    assert.notEqual(r.state.tokens[1][0], -1);
    s = createGame({ players: [0, 1], rules: { bonus: false } });
    s.tokens[0][0] = 3;
    s.tokens[1][0] = (45 - START[1] + TRACK) % TRACK;
    r = move(roll(s, 2).state, 0);
    assert.equal(r.state.tokens[1][0], -1);
    assert.equal(r.state.turn, 1);
});

test('exact roll needed to reach home; reaching home wins with tokensToWin', () => {
    let s = createGame({ players: [0, 2], rules: { tokensToWin: 2 } });
    s.tokens[0] = [HOME_STEP, 53, -1, -1];
    let r = roll(s, 5); // 53 + 5 = 58 > 56: can't move
    assert.ok(r.events.some((e) => e.type === 'pass'));
    s.turn = 0;
    r = roll(s, 3);
    r = move(r.state, 1);
    assert.equal(r.state.tokens[0][1], HOME_STEP);
    assert.equal(r.state.winner, 0);
    assert.equal(homeCount(r.state, 0), 2);
    assert.deepEqual(legalTokens(r.state), []);
    assert.equal(isLegalAction(r.state, { type: 'roll' }), false);
});

test('three sixes in a row forfeit the turn (unless allowed)', () => {
    let s = createGame({ players: [0, 2] });
    s.tokens[0] = [10, -1, -1, -1];
    let r = move(roll(s, 6).state, 0);
    r = move(roll(r.state, 6).state, 0);
    r = roll(r.state, 6);
    assert.ok(r.events.some((e) => e.type === 'forfeit'));
    assert.equal(r.state.turn, 2);
    s = createGame({ players: [0, 2], rules: { threeSixes: 'allowed' } });
    s.tokens[0] = [10, -1, -1, -1];
    r = move(roll(s, 6).state, 0);
    r = move(roll(r.state, 6).state, 0);
    r = roll(r.state, 6);
    assert.equal(r.state.phase, 'move');
});

test('blocks: two tokens of one colour stop others from passing', () => {
    let s = createGame({ players: [0, 1], rules: { blocks: true } });
    s.tokens[0][0] = 2; // square 42
    const wallStep = (45 - START[1] + TRACK) % TRACK;
    s.tokens[1][0] = wallStep;
    s.tokens[1][1] = wallStep; // wall on square 45
    let r = roll(s, 5); // 42 → 47 would pass 45
    assert.ok(r.events.some((e) => e.type === 'pass'));
    s.turn = 0;
    s.rules = normalizeRules({ blocks: false });
    r = move(roll(s, 5).state, 0);
    assert.equal(r.state.tokens[0][0], 7);
});

test('illegal actions throw and do not mutate', () => {
    const s = createGame({ players: [0, 2] });
    const before = JSON.stringify(s);
    assert.throws(() => applyAction(s, { type: 'move', token: 0 }));
    assert.throws(() => applyAction(s, { type: 'dance' }));
    assert.throws(() => applyAction(s, null));
    roll(s, 6);
    assert.equal(JSON.stringify(s), before);
});

test('random games with bots finish for 2, 3 and 4 players and every rule set', () => {
    const rng = mulberry32(5);
    const combos = [DEFAULT_RULES, { enter: '1or6', tokensToWin: 2 }, { blocks: true, bonus: false }, { threeSixes: 'allowed' }];
    for (const rules of combos) {
        for (const n of [2, 3, 4]) {
            for (let g = 0; g < 5; g++) {
                let s = createGame({ players: seatsFor(n), rules });
                let guard = 0;
                while (s.winner === null && guard++ < 5000) {
                    const level = ['easy', 'medium', 'hard'][s.turn % 3];
                    s = applyAction(s, chooseBotAction(s, level, rng), rng, { withEvents: false }).state;
                    for (const p of [0, 1, 2, 3]) assert.equal(s.tokens[p].length, 4);
                }
                assert.notEqual(s.winner, null, JSON.stringify(rules) + ' n=' + n);
            }
        }
    }
    assert.ok(Object.keys(RULE_OPTIONS).length === 5);
});

test('hard bot beats random movers most of the time (4 players)', () => {
    const rng = mulberry32(11);
    let wins = 0;
    const games = 40;
    for (let g = 0; g < games; g++) {
        let s = createGame({ players: [0, 1, 2, 3] });
        while (s.winner === null) {
            let a;
            if (s.turn === 0) a = chooseBotAction(s, 'hard', rng);
            else if (s.phase === 'roll') a = { type: 'roll' };
            else { const m = legalTokens(s); a = { type: 'move', token: m[Math.floor(rng() * m.length)] }; }
            s = applyAction(s, a, rng, { withEvents: false }).state;
        }
        if (s.winner === 0) wins++;
    }
    // A random player would win ~25%.
    assert.ok(wins >= games * 0.45, `hard bot won ${wins}/${games}`);
});
