// Run: node --test games/uno/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGame, applyMove, isLegalMove, playableCards, chooseBotMove, normalizeRules, buildDeck,
    viewFor, viewEvents, handCount, deckCount, topCard, seatsFor, RULE_OPTIONS, DEFAULT_RULES, COLORS,
} from './engine.js';

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const byKey = new Map(buildDeck().map((c) => [c.color + ':' + c.value, c]));
// A card by colour/value; `n` picks the second copy.
function card(color, value, n = 0) {
    return buildDeck().filter((c) => c.color === color && c.value === value)[n];
}
// A game with chosen hands and top card; the rest of the deck is in order.
function setup({ players = [0, 1], hands, top, rules, turn, deck }) {
    const s = createGame({ players, rules, firstPlayer: turn, rng: mulberry32(1) });
    const used = new Set();
    s.hands = [0, 1, 2, 3].map((p) => (hands[p] || []).map((c) => { used.add(c.id); return c; }));
    used.add(top.id);
    s.discard = [top];
    s.color = top.color;
    s.deck = deck ? deck.slice() : buildDeck().filter((c) => !used.has(c.id));
    return s;
}
const allCards = (s) => [...s.hands.flat(), ...s.deck, ...s.discard];

test('deck: 108 cards, unique ids, the right mix', () => {
    const d = buildDeck();
    assert.equal(d.length, 108);
    assert.equal(new Set(d.map((c) => c.id)).size, 108);
    assert.equal(d.filter((c) => c.value === 'wild4').length, 4);
    assert.equal(d.filter((c) => c.value === 'wild').length, 4);
    assert.equal(d.filter((c) => c.color === 'red').length, 25);
    assert.equal(d.filter((c) => c.value === '0').length, 4);
    assert.ok(byKey.has('green:draw2'));
});

test('new game: hands dealt from a shuffled deck, first card is a number', () => {
    for (let seed = 1; seed < 40; seed++) {
        const s = createGame({ players: seatsFor(4), rng: mulberry32(seed) });
        assert.deepEqual(s.players, [0, 1, 2, 3]);
        for (const p of s.players) assert.equal(s.hands[p].length, 7);
        assert.match(topCard(s).value, /^[0-9]$/);
        assert.equal(s.color, topCard(s).color);
        assert.equal(allCards(s).length, 108);
        assert.equal(new Set(allCards(s).map((c) => c.id)).size, 108);
    }
    const a = createGame({ rng: mulberry32(5) });
    const b = createGame({ rng: mulberry32(5) });
    const c = createGame({ rng: mulberry32(6) });
    assert.deepEqual(a.hands, b.hands, 'same rng → same deal');
    assert.notDeepEqual(a.hands, c.hands);
    assert.equal(createGame({ players: [0, 1], rules: { handSize: 5 } }).hands[1].length, 5);
    assert.throws(() => createGame({ players: [2] }));
});

test('rules are normalized; unknown values fall back to defaults', () => {
    assert.deepEqual(normalizeRules({ draw: 'x', stack: 'yes', handSize: 9, sayUno: false }), { ...DEFAULT_RULES, sayUno: false });
    assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
    assert.equal(Object.keys(RULE_OPTIONS).length, 4);
});

test('matching: colour, number or symbol; wilds always', () => {
    const s = setup({
        hands: { 0: [card('red', '3'), card('blue', '7'), card('green', '5'), card('blue', 'skip'), card('wild', 'wild')] },
        top: card('red', '7'),
    });
    const ok = playableCards(s).sort((a, b) => a - b);
    assert.deepEqual(ok, [card('red', '3').id, card('blue', '7').id, card('wild', 'wild').id].sort((a, b) => a - b));
    assert.equal(isLegalMove(s, { type: 'play', card: card('green', '5').id }), false);
    assert.equal(isLegalMove(s, { type: 'play', card: card('wild', 'wild').id }), false, 'wild needs a colour');
    assert.equal(isLegalMove(s, { type: 'play', card: card('wild', 'wild').id, color: 'pink' }), false);
    assert.equal(isLegalMove(s, { type: 'play', card: card('wild', 'wild').id, color: 'green' }), true);
    assert.equal(isLegalMove(s, { type: 'play', card: card('red', '9').id }), false, 'not in hand');
    assert.equal(isLegalMove(s, { type: 'pass' }), false);
    assert.equal(isLegalMove(s, { type: 'play', card: card('red', '3').id }, 1), false, 'not your turn');
    const r = applyMove(s, { type: 'play', card: card('wild', 'wild').id, color: 'green' });
    assert.equal(r.state.color, 'green');
    assert.equal(r.state.turn, 1);
    assert.equal(s.hands[0].length, 5, 'old state untouched');
});

test('skip, reverse and +2 with 3 players', () => {
    const hands = { 0: [card('red', 'skip'), card('red', 'reverse'), card('red', 'draw2'), card('red', '1')], 1: [card('blue', '1')], 2: [card('blue', '2')] };
    let s = setup({ players: [0, 1, 2], hands, top: card('red', '5') });
    let r = applyMove(s, { type: 'play', card: card('red', 'skip').id });
    assert.equal(r.state.turn, 2);
    assert.ok(r.events.some((e) => e.type === 'skip' && e.player === 1));

    r = applyMove(s, { type: 'play', card: card('red', 'reverse').id });
    assert.equal(r.state.direction, -1);
    assert.equal(r.state.turn, 2);

    r = applyMove(s, { type: 'play', card: card('red', 'draw2').id });
    assert.equal(r.state.hands[1].length, 3);
    assert.equal(r.state.turn, 2);
    const d = r.events.find((e) => e.type === 'draw');
    assert.equal(d.player, 1);
    assert.equal(d.count, 2);
});

test('reverse works like skip with two players', () => {
    const s = setup({ hands: { 0: [card('red', 'reverse'), card('red', '1')], 1: [card('blue', '1')] }, top: card('red', '5') });
    const r = applyMove(s, { type: 'play', card: card('red', 'reverse').id });
    assert.equal(r.state.turn, 0);
});

test('wild +4: next player takes 4 and misses the turn', () => {
    const s = setup({ players: [0, 1, 2], hands: { 0: [card('wild', 'wild4'), card('red', '1')], 1: [card('blue', '1')], 2: [card('blue', '2')] }, top: card('red', '5') });
    const r = applyMove(s, { type: 'play', card: card('wild', 'wild4').id, color: 'blue' });
    assert.equal(r.state.hands[1].length, 5);
    assert.equal(r.state.turn, 2);
    assert.equal(r.state.color, 'blue');
});

test('stacking off: +2 cannot be answered; on: +2 on +2 adds up', () => {
    const hands = { 0: [card('red', 'draw2'), card('red', '1')], 1: [card('blue', 'draw2'), card('blue', '1')], 2: [card('green', '1'), card('green', '2')] };
    let s = setup({ players: [0, 1, 2], hands, top: card('red', '5') });
    let r = applyMove(s, { type: 'play', card: card('red', 'draw2').id });
    assert.equal(r.state.hands[1].length, 4, 'no stacking: takes 2 at once');
    assert.equal(r.state.turn, 2);

    s = setup({ players: [0, 1, 2], hands, top: card('red', '5'), rules: { stack: true } });
    r = applyMove(s, { type: 'play', card: card('red', 'draw2').id });
    assert.equal(r.state.turn, 1);
    assert.equal(r.state.pending, 2);
    assert.deepEqual(playableCards(r.state), [card('blue', 'draw2').id], 'only +2 answers a +2');
    assert.equal(isLegalMove(r.state, { type: 'play', card: card('blue', '1').id }), false);
    r = applyMove(r.state, { type: 'play', card: card('blue', 'draw2').id });
    // Player 2 has no +2: takes 4 automatically and is skipped.
    assert.equal(r.state.hands[2].length, 6);
    assert.equal(r.state.pending, 0);
    assert.equal(r.state.turn, 0);
    assert.ok(r.events.some((e) => e.type === 'draw' && e.player === 2 && e.count === 4));
    assert.ok(r.events.some((e) => e.type === 'stack' && e.total === 4));
});

test('stacking: you may take the cards instead of answering', () => {
    const hands = { 0: [card('red', 'draw2'), card('red', '1')], 1: [card('blue', 'draw2'), card('blue', '1')] };
    const s = setup({ hands, top: card('red', '5'), rules: { stack: true } });
    let r = applyMove(s, { type: 'play', card: card('red', 'draw2').id });
    r = applyMove(r.state, { type: 'draw' });
    assert.equal(r.state.hands[1].length, 4);
    assert.equal(r.state.pending, 0);
    assert.equal(r.state.turn, 0);
    assert.equal(r.state.phase, 'play');
});

test("draw 'one': a card that fits may be played or kept; one that doesn't ends the turn", () => {
    const hands = { 0: [card('blue', '1'), card('blue', '2')], 1: [card('green', '1')] };
    // Deck order: pop() takes from the end.
    let s = setup({ hands, top: card('red', '5'), deck: [card('yellow', '9'), card('red', '8')] });
    let r = applyMove(s, { type: 'draw' });
    assert.equal(r.state.phase, 'drawn');
    assert.equal(r.state.turn, 0);
    assert.equal(r.state.drawn, card('red', '8').id);
    assert.deepEqual(playableCards(r.state), [card('red', '8').id]);
    assert.equal(isLegalMove(r.state, { type: 'draw' }), false);
    const kept = applyMove(r.state, { type: 'pass' });
    assert.equal(kept.state.turn, 1);
    assert.equal(kept.state.hands[0].length, 3);
    const played = applyMove(r.state, { type: 'play', card: card('red', '8').id });
    assert.equal(played.state.turn, 1);
    assert.equal(played.state.hands[0].length, 2);

    s = setup({ hands, top: card('red', '5'), deck: [card('red', '8'), card('yellow', '9')] });
    r = applyMove(s, { type: 'draw' });
    assert.equal(r.state.turn, 1, 'no fit: turn passes');
    assert.equal(r.state.hands[0].length, 3);
    assert.equal(r.state.lacks[0], 'red', 'everyone saw the player had no red');
});

test("draw 'untilPlayable': keeps drawing until a card fits", () => {
    const hands = { 0: [card('blue', '1'), card('blue', '2')], 1: [card('green', '1')] };
    const s = setup({
        hands, top: card('red', '5'), rules: { draw: 'untilPlayable' },
        deck: [card('green', '3'), card('red', '8'), card('yellow', '9'), card('yellow', '4')],
    });
    const r = applyMove(s, { type: 'draw' });
    assert.equal(r.state.hands[0].length, 5);
    assert.equal(r.state.phase, 'drawn');
    assert.equal(r.state.drawn, card('red', '8').id);
    assert.equal(r.events.filter((e) => e.type === 'draw').length, 3);
});

test('UNO: forgetting it costs 2 cards; saying it is safe; the rule can be off', () => {
    const hands = { 0: [card('red', '1'), card('red', '2')], 1: [card('green', '1'), card('green', '2')] };
    let s = setup({ hands, top: card('red', '5') });
    let r = applyMove(s, { type: 'play', card: card('red', '1').id });
    assert.equal(r.state.hands[0].length, 3);
    assert.ok(r.events.some((e) => e.type === 'penalty' && e.count === 2));
    assert.equal(r.state.said[0], false);

    r = applyMove(s, { type: 'play', card: card('red', '1').id, uno: true });
    assert.equal(r.state.hands[0].length, 1);
    assert.equal(r.state.said[0], true);
    assert.ok(r.events.some((e) => e.type === 'uno'));

    s = setup({ hands, top: card('red', '5'), rules: { sayUno: false } });
    r = applyMove(s, { type: 'play', card: card('red', '1').id });
    assert.equal(r.state.hands[0].length, 1);
});

test('playing the last card wins', () => {
    const s = setup({ hands: { 0: [card('red', 'draw2')], 1: [card('green', '1')] }, top: card('red', '5') });
    const r = applyMove(s, { type: 'play', card: card('red', 'draw2').id });
    assert.equal(r.state.winner, 0);
    assert.equal(r.state.phase, 'over');
    assert.equal(isLegalMove(r.state, { type: 'draw' }), false);
});

test('empty deck: the discard pile is reshuffled, the top card stays', () => {
    const s = setup({ hands: { 0: [card('blue', '1'), card('blue', '2')], 1: [card('green', '1')] }, top: card('red', '5'), deck: [] });
    s.discard = [card('yellow', '3'), card('yellow', '4'), card('red', '5')];
    const r = applyMove(s, { type: 'draw' }, mulberry32(3));
    assert.ok(r.events.some((e) => e.type === 'reshuffle'));
    assert.deepEqual(r.state.discard, [card('red', '5')]);
    assert.equal(r.state.hands[0].length + r.state.deck.length, 4);
});

test('viewFor hides other hands, the deck and the drawn card', () => {
    const s = createGame({ players: [0, 1, 2], rng: mulberry32(9) });
    const v = viewFor(s, 1);
    assert.deepEqual(v.hands[1], s.hands[1]);
    assert.equal(v.hands[0], 7);
    assert.equal(v.hands[2], 7);
    assert.equal(v.deck, s.deck.length);
    assert.equal(handCount(v, 0), 7);
    assert.equal(deckCount(v), s.deck.length);
    const text = JSON.stringify(v);
    for (const c of [...s.hands[0], ...s.hands[2], ...s.deck]) {
        assert.ok(!text.includes('"id":' + c.id + ','), 'card ' + c.id + ' leaked');
    }
    // A drawn card that fits is shown only to its owner.
    const t = setup({ hands: { 0: [card('blue', '1'), card('blue', '2')], 1: [card('green', '1')] }, top: card('red', '5'), deck: [card('red', '8')] });
    const r = applyMove(t, { type: 'draw' });
    assert.equal(viewFor(r.state, 0).drawn, card('red', '8').id);
    assert.equal(viewFor(r.state, 1).drawn, null);
    const ev = viewEvents(r.events, 1).find((e) => e.type === 'draw');
    assert.deepEqual(ev, { type: 'draw', player: 0, count: 1 });
    assert.deepEqual(viewEvents(r.events, 0).find((e) => e.type === 'draw').cards, [card('red', '8')]);
    // The bot and the rules still work on a player's view.
    assert.deepEqual(playableCards(viewFor(r.state, 0)), [card('red', '8').id]);
});

test('bots only make legal moves and games always finish (all rule sets, 2–4 players)', () => {
    const rng = mulberry32(42);
    const keys = Object.keys(RULE_OPTIONS);
    for (let mask = 0; mask < 16; mask++) {
        const rules = {};
        keys.forEach((k, i) => { rules[k] = RULE_OPTIONS[k][(mask >> i) & 1]; });
        for (const n of [2, 3, 4]) {
            let s = createGame({ players: seatsFor(n), rules, rng });
            let guard = 0;
            while (s.winner === null && guard++ < 5000) {
                const m = chooseBotMove(s, ['easy', 'medium', 'hard'][s.turn % 3], rng);
                assert.ok(isLegalMove(s, m), JSON.stringify(m));
                s = applyMove(s, m, rng, { withEvents: false }).state;
                assert.equal(allCards(s).length, 108);
            }
            assert.notEqual(s.winner, null, JSON.stringify(rules) + ' n=' + n);
        }
    }
});

test('bots on a player view choose the same kind of move', () => {
    const rng = mulberry32(8);
    let s = createGame({ players: [0, 1, 2, 3], rng });
    for (let k = 0; k < 60 && s.winner === null; k++) {
        const m = chooseBotMove(viewFor(s, s.turn), 'hard', rng);
        assert.ok(isLegalMove(s, m));
        s = applyMove(s, m, rng).state;
    }
});

test('medium bot beats random players', () => {
    const rng = mulberry32(11);
    let wins = 0;
    const games = 300;
    for (let g = 0; g < games; g++) {
        let s = createGame({ players: [0, 1], rng, firstPlayer: g % 2 });
        while (s.winner === null) {
            let m;
            if (s.turn === 0) m = chooseBotMove(s, 'medium', rng);
            else if (s.phase === 'drawn') m = { type: 'pass' };
            else {
                const ids = playableCards(s);
                m = ids.length ? { type: 'play', card: ids[Math.floor(rng() * ids.length)], color: COLORS[Math.floor(rng() * 4)], uno: true } : { type: 'draw' };
            }
            s = applyMove(s, m, rng, { withEvents: false }).state;
        }
        if (s.winner === 0) wins++;
    }
    assert.ok(wins >= games * 0.56, `medium bot won ${wins}/${games}`);
});

test('uno.html carries the current engine (run games/build.mjs if this fails)', async () => {
    const { readFileSync } = await import('node:fs');
    const { inlineEngine, pagePaths } = await import('../build.mjs');
    const p = pagePaths('uno');
    const html = readFileSync(p.html, 'utf8');
    assert.equal(inlineEngine(html, readFileSync(p.engine, 'utf8')), html);
});
