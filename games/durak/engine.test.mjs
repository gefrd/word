// Run: node --test games/durak/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGame, applyAction, isLegalAction, legalActions, chooseBotAction, normalizeRules,
    beats, makeDeck, seatsFor, viewFor, viewEvents, attackOrder, sortHand,
    RULE_OPTIONS, DEFAULT_RULES, DRAW, HAND,
} from './engine.js';

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A hand-made position: hands and deck given, trump = last deck card's suit.
function position({ hands, deck = [], trump = 'h', players, attacker = 0, rules, bouts = 1 }) {
    const seats = players || hands.map((_, i) => i);
    const s = createGame({ players: seats, rules, rng: mulberry32(1) });
    s.hands = [0, 1, 2, 3].map((p) => (hands[p] ? hands[p].slice() : []));
    s.deck = deck.slice();
    s.trump = trump;
    s.trumpCard = deck.length ? deck[deck.length - 1] : '6' + trump;
    s.discard = [];
    s.bouts = bouts;
    s.attacker = attacker;
    s.defender = seats[(seats.indexOf(attacker) + 1) % seats.length];
    s.turn = attacker;
    s.phase = 'attack';
    s.limit = Math.min(bouts === 0 ? s.rules.firstBout : HAND, s.hands[s.defender].length);
    s.firstCard = null;
    return s;
}
const act = (s, a) => applyAction(s, a);
const allCards = (s) => [...s.hands.flat(), ...s.deck, ...s.discard, ...s.table.flatMap((p) => (p.d ? [p.a, p.d] : [p.a]))];

test('deck, dealing and who starts', () => {
    assert.equal(makeDeck(36).length, 36);
    assert.equal(makeDeck(52).length, 52);
    assert.deepEqual(seatsFor(3), [0, 1, 2]);
    for (let seed = 1; seed <= 50; seed++) {
        const n = 2 + (seed % 3);
        const s = createGame({ players: seatsFor(n), rng: mulberry32(seed) });
        for (const p of s.players) assert.equal(s.hands[p].length, 6);
        assert.equal(s.deck.length, 36 - 6 * n);
        assert.equal(s.trump, s.trumpCard[1]);
        assert.equal(s.deck.at(-1), s.trumpCard);
        assert.equal(new Set(allCards(s)).size, 36);
        // Lowest trump in hand starts.
        const trumps = s.players.flatMap((p) => s.hands[p].filter((c) => c[1] === s.trump).map((c) => [p, c]));
        if (trumps.length) {
            trumps.sort((x, y) => '23456789TJQKA'.indexOf(x[1][0]) - '23456789TJQKA'.indexOf(y[1][0]));
            assert.equal(s.attacker, trumps[0][0]);
            assert.equal(s.firstCard, trumps[0][1]);
        }
        assert.equal(s.defender, s.players[(s.players.indexOf(s.attacker) + 1) % n]);
    }
});

test('beating: higher same suit or any trump', () => {
    assert.ok(beats('7s', '9s', 'h'));
    assert.ok(!beats('9s', '7s', 'h'));
    assert.ok(beats('7s', 'As', 'h'));
    assert.ok(!beats('7s', 'Ad', 'h'));
    assert.ok(beats('As', '6h', 'h'));
    assert.ok(beats('7h', 'Ah', 'h'));
    assert.ok(!beats('Th', '9h', 'h'));
    assert.deepEqual(sortHand(['6h', 'As', '7s', '6s'], 'h'), ['6s', '7s', 'As', '6h']);
});

test('rules normalise to known options', () => {
    assert.deepEqual(normalizeRules({ transfer: true, deck: 99, throwIn: 'x' }), { ...DEFAULT_RULES, transfer: true });
    assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
    assert.equal(Object.keys(RULE_OPTIONS).length, 4);
});

test('lead must be one rank; throw-in needs a rank on the table', () => {
    const s = position({ hands: [['7s', '7d', '8c', 'Kd', 'Ah', '9s'], ['6s', '9d', 'Qs', 'Jc', '8s', 'Tc']], deck: ['6c', '6h'] });
    assert.ok(!isLegalAction(s, { type: 'attack', cards: ['7s', '8c'] }));
    assert.ok(!isLegalAction(s, { type: 'attack', cards: ['7s', '7s'] }));
    assert.ok(!isLegalAction(s, { type: 'attack', cards: ['6s'] }), 'not in hand');
    assert.ok(!isLegalAction(s, { type: 'pass' }), 'cannot pass the lead');
    assert.ok(!isLegalAction(s, { type: 'take' }));
    assert.ok(!isLegalAction(s, { type: 'attack', cards: ['7s'] }, 1), 'not your turn');
    let { state } = act(s, { type: 'attack', cards: ['7s', '7d'] });
    assert.equal(state.phase, 'defend');
    assert.equal(state.turn, 1);
    assert.ok(!isLegalAction(state, { type: 'defend', card: '6s', target: 0 }), '6 does not beat 7');
    assert.ok(!isLegalAction(state, { type: 'defend', card: '9d', target: 0 }), 'wrong suit');
    ({ state } = act(state, { type: 'defend', card: '9d', target: 1 }));
    assert.equal(state.turn, 1, 'still defending');
    ({ state } = act(state, { type: 'defend', card: '8s', target: 0 }));
    // All beaten: attacker may throw 8 or 9 (ranks on the table).
    assert.equal(state.phase, 'attack');
    assert.equal(state.turn, 0);
    assert.ok(!isLegalAction(state, { type: 'attack', cards: ['Kd'] }));
    assert.ok(isLegalAction(state, { type: 'attack', cards: ['8c', '9s'] }));
    const r = act(state, { type: 'pass' });
    assert.ok(r.events.some((e) => e.type === 'beaten'));
    assert.equal(r.state.attacker, 1, 'defender attacks next');
    assert.equal(r.state.discard.length, 4);
    // Draw: attacker first (needs 4, gets both), defender none left.
    assert.equal(r.state.hands[0].length, 6);
    assert.equal(r.state.hands[1].length, 4);
});

test('drawing: back up to 6 each, attacker first, defender last', () => {
    const deck = ['6c', '7c', '8c', '9c', 'Tc', 'Jc', 'Qc', 'Kc', '6h'];
    const s = position({ hands: [['7s', '7d', '8d', 'Kd', 'Ah', '9s'], ['8s', '9d', 'Qs', 'Jd', '6s', 'Td']], deck });
    let r = act(s, { type: 'attack', cards: ['7s', '7d'] });
    r = act(r.state, { type: 'defend', card: '8s', target: 0 });
    r = act(r.state, { type: 'defend', card: '9d', target: 1 });
    r = act(r.state, { type: 'pass' });
    assert.deepEqual(r.state.hands.map((h) => h.length), [6, 6, 0, 0]);
    assert.deepEqual(r.state.hands[0].slice(-2), ['6c', '7c']);
    assert.deepEqual(r.state.hands[1].slice(-2), ['8c', '9c']);
    assert.equal(r.state.deck.length, 5);
    assert.deepEqual(r.events.filter((e) => e.type === 'draw').map((e) => [e.player, e.count]), [[0, 2], [1, 2]]);
});

test('taking: attackers may add cards, defender picks everything up and is skipped', () => {
    const s = position({
        players: [0, 1, 2],
        hands: [['7s', '7d', 'Kd'], ['8s', 'Ac', 'Jc'], ['7c', '7h', 'Qd']],
        deck: [],
    });
    let { state } = act(s, { type: 'attack', cards: ['7s'] });
    ({ state } = act(state, { type: 'take' }));
    assert.equal(state.phase, 'throw');
    assert.equal(state.turn, 0, 'main attacker adds first');
    ({ state } = act(state, { type: 'attack', cards: ['7d'] }));
    assert.equal(state.turn, 2, 'then the next player');
    // Limit: defender held 3 cards, so at most 3 cards in the bout.
    assert.ok(!isLegalAction(state, { type: 'attack', cards: ['7c', '7h'] }));
    const r = act(state, { type: 'attack', cards: ['7c'] });
    assert.equal(r.state.hands[1].length, 6);
    assert.ok(r.events.some((e) => e.type === 'pickup' && e.cards.length === 3));
    assert.equal(r.state.attacker, 2, 'the player after the defender attacks');
    assert.equal(r.state.defender, 0);
});

test('forced take when nothing beats the attack', () => {
    const s = position({ hands: [['As', '6d'], ['6s', '7c']], deck: ['8c', '9c', 'Th'] });
    const r = act(s, { type: 'attack', cards: ['As'] });
    assert.ok(r.events.some((e) => e.type === 'take' && e.forced));
    // Attacker has nothing to add → defender picks up; attacker leads again.
    assert.equal(r.state.hands[1].length, 3);
    assert.equal(r.state.attacker, 0);
    assert.equal(r.state.phase, 'attack');
});

test('transfer: same rank passes the attack to the next player', () => {
    const rules = { transfer: true };
    const s = position({
        rules, players: [0, 1, 2],
        hands: [['7s', 'Kd', 'Ac'], ['7d', '9s', 'Tc'], ['8s', '8d', 'Jc', 'Qh']],
        deck: ['6c', '9h'],
    });
    let { state } = act(s, { type: 'attack', cards: ['7s'] });
    assert.ok(isLegalAction(state, { type: 'transfer', card: '7d' }));
    assert.ok(!isLegalAction(state, { type: 'transfer', card: '9s' }));
    const r = act(state, { type: 'transfer', card: '7d' });
    state = r.state;
    assert.equal(state.defender, 2);
    assert.equal(state.attacker, 1);
    assert.equal(state.turn, 2);
    assert.equal(state.table.length, 2);
    assert.deepEqual(r.events[0], { type: 'transfer', player: 1, card: '7d', to: 2 });
    // No transfer once a card is beaten.
    ({ state } = act(state, { type: 'defend', card: '8s', target: 0 }));
    assert.ok(!legalActions(state).some((a) => a.type === 'transfer'));
    // Classic rules: no transfer at all.
    const c = position({ hands: [['7s'], ['7d', '9s']], deck: ['6c'] });
    assert.ok(!isLegalAction(act(c, { type: 'attack', cards: ['7s'] }).state, { type: 'transfer', card: '7d' }));
});

test('transfer needs enough cards in the next hand', () => {
    const s = position({
        rules: { transfer: true },
        hands: [['7s', '7c'], ['7d', '9s', 'Tc']],
        deck: ['6c'],
    });
    // 2 players: transfer goes back to the attacker, who holds 0 cards after leading two.
    const { state } = act(s, { type: 'attack', cards: ['7s', '7c'] });
    assert.ok(!isLegalAction(state, { type: 'transfer', card: '7d' }));
});

test('neighbours rule: only players next to the defender throw in', () => {
    const s = position({
        rules: { throwIn: 'neighbors' },
        players: [0, 1, 2, 3],
        hands: [['7s', 'Kd'], ['8s', 'Ac', 'Jc', 'Ad'], ['7c', 'Qd'], ['7h', 'Qc']],
        deck: ['6c', '9h'],
    });
    assert.deepEqual(attackOrder(s), [0, 2]);
    const all = position({ players: [0, 1, 2, 3], hands: s.hands, deck: s.deck });
    assert.deepEqual(attackOrder(all), [0, 2, 3]);
});

test('first bout limit of 5', () => {
    const s = position({
        rules: { firstBout: 5 }, bouts: 0,
        hands: [['7s', '7d', '7c', '8s', '8d', '8c'], ['As', 'Ad', 'Ac', 'Ah', 'Ks', 'Kd']],
        deck: ['6c'],
    });
    assert.equal(s.limit, 5);
});

test('game ends: last player with cards is the durak; simultaneous finish is a draw', () => {
    const s = position({ hands: [['7s'], ['9s', '6d']], deck: [] });
    let r = act(s, { type: 'attack', cards: ['7s'] });
    r = act(r.state, { type: 'defend', card: '9s', target: 0 });
    // Attacker is out of cards and can't add: bout beaten, player 0 is out.
    assert.equal(r.state.phase, 'over');
    assert.equal(r.state.loser, 1);
    assert.equal(r.state.winner, 0);
    const d = position({ hands: [['7s'], ['9s']], deck: [] });
    r = act(act(d, { type: 'attack', cards: ['7s'] }).state, { type: 'defend', card: '9s', target: 0 });
    assert.equal(r.state.loser, null);
    assert.equal(r.state.winner, DRAW);
});

test('out players are skipped in 3-player games', () => {
    const s = position({ players: [0, 1, 2], hands: [['7s'], ['9s', '6d'], ['Kd', 'Qd']], deck: [] });
    let r = act(s, { type: 'attack', cards: ['7s'] });
    r = act(r.state, { type: 'defend', card: '9s', target: 0 });
    // Player 2 may throw 7 or 9 — has none → bout beaten; 0 is out.
    assert.deepEqual(r.state.out, [0]);
    assert.equal(r.state.phase, 'attack');
    assert.equal(r.state.attacker, 1);
    assert.equal(r.state.defender, 2);
});

test('illegal actions throw and do not mutate', () => {
    const s = createGame({ rng: mulberry32(3) });
    const before = JSON.stringify(s);
    assert.throws(() => applyAction(s, { type: 'take' }));
    assert.throws(() => applyAction(s, { type: 'attack', cards: ['??'] }));
    assert.throws(() => applyAction(s, { type: 'attack', cards: 'Ah' }));
    assert.throws(() => applyAction(s, null));
    applyAction(s, legalActions(s)[0]);
    assert.equal(JSON.stringify(s), before);
});

test('viewFor hides other hands and the deck; draw events are private', () => {
    const s = createGame({ players: [0, 1, 2], rng: mulberry32(9) });
    const v = viewFor(s, 1);
    assert.deepEqual(v.hands[1], s.hands[1]);
    assert.ok(v.hands[0].every((c) => c === '??'));
    assert.equal(v.hands[0].length, 6);
    assert.equal(v.deck.length, s.deck.length);
    assert.equal(v.deck.at(-1), s.trumpCard, 'the trump at the bottom is face up');
    assert.ok(v.deck.slice(0, -1).every((c) => c === '??'));
    const text = JSON.stringify(v);
    // The lowest trump that chose the first attacker is shown to everyone.
    for (const c of [...s.hands[0], ...s.hands[2], ...s.deck.slice(0, -1)]) if (c !== s.firstCard) assert.ok(!text.includes('"' + c + '"'), c);
    const ev = [{ type: 'draw', player: 0, count: 2, cards: ['7s', '8s'] }, { type: 'draw', player: 1, count: 1, cards: ['Ah'] }];
    assert.deepEqual(viewEvents(ev, 1), [{ type: 'draw', player: 0, count: 2 }, ev[1]]);
});

test('bot decides only from what its seat can see', () => {
    for (let seed = 1; seed <= 30; seed++) {
        let s = createGame({ players: seatsFor(2 + (seed % 3)), rules: { transfer: seed % 2 === 0 }, rng: mulberry32(seed) });
        const rng = mulberry32(seed * 7);
        for (let k = 0; k < 400 && s.winner === null; k++) {
            for (const level of k % 15 === 0 ? ['easy', 'medium', 'hard'] : ['easy', 'medium']) {
                const a = chooseBotAction(s, level, mulberry32(k));
                const b = chooseBotAction(viewFor(s, s.turn), level, mulberry32(k));
                assert.deepEqual(a, b);
            }
            s = applyAction(s, chooseBotAction(s, 'medium', rng), rng, { withEvents: false }).state;
        }
    }
});

test('bots finish every game; cards are conserved (all player counts and rules)', () => {
    const rng = mulberry32(42);
    let games = 0;
    for (const deck of RULE_OPTIONS.deck) {
        for (const transfer of RULE_OPTIONS.transfer) {
            for (const throwIn of RULE_OPTIONS.throwIn) {
                for (const n of [2, 3, 4]) {
                    for (let g = 0; g < 6; g++) {
                        const rules = { deck, transfer, throwIn, firstBout: g % 2 ? 5 : 6 };
                        let s = createGame({ players: seatsFor(n), rules, rng });
                        let guard = 0;
                        while (s.winner === null && guard++ < 5000) {
                            assert.ok(s.players.includes(s.turn));
                            const legal = legalActions(s);
                            assert.ok(legal.length > 0);
                            for (const a of legal) assert.ok(isLegalAction(s, a), JSON.stringify(a));
                            const level = ['easy', 'medium'][s.turn % 2];
                            const a = rng() < 0.15 ? legal[Math.floor(rng() * legal.length)] : chooseBotAction(s, level, rng);
                            const bouts = s.bouts;
                            s = applyAction(s, a, rng, { withEvents: false }).state;
                            if (s.bouts > bouts && s.deck.length > 0) {
                                // Cards left in the deck: everyone drew back up to 6.
                                for (const p of s.players) assert.ok(s.hands[p].length >= HAND, 'short hand');
                            }
                            assert.equal(allCards(s).length, deck);
                            assert.equal(new Set(allCards(s)).size, deck);
                        }
                        assert.notEqual(s.winner, null, JSON.stringify(rules) + ' n=' + n);
                        assert.ok(s.actions < 3000, 'finished normally');
                        const holding = s.players.filter((p) => s.hands[p].length > 0);
                        assert.ok(holding.length <= 1);
                        if (s.loser !== null) assert.deepEqual(holding, [s.loser]);
                        games++;
                    }
                }
            }
        }
    }
    assert.equal(games, 144);
});

test('medium bot beats random players most of the time', () => {
    const rng = mulberry32(5);
    let lost = 0;
    const games = 200;
    for (let g = 0; g < games; g++) {
        let s = createGame({ players: [0, 1], rng });
        while (s.winner === null) {
            let a;
            if (s.turn === 0) a = chooseBotAction(s, 'medium', rng);
            else { const l = legalActions(s); a = l[Math.floor(rng() * l.length)]; }
            s = applyAction(s, a, rng, { withEvents: false }).state;
        }
        if (s.loser === 0) lost++;
    }
    assert.ok(lost <= games * 0.3, `medium bot was the durak ${lost}/${games}`);
});

test('hard bot is the durak less often than medium (a fair share would be half)', () => {
    const rng = mulberry32(8);
    let lost = 0;
    const games = 60;
    for (let g = 0; g < games; g++) {
        let s = createGame({ players: [0, 1], rules: { transfer: g % 2 === 1 }, rng });
        while (s.winner === null) {
            s = applyAction(s, chooseBotAction(s, s.turn === g % 2 ? 'hard' : 'medium', rng), rng, { withEvents: false }).state;
        }
        if (s.loser === g % 2) lost++;
    }
    assert.ok(lost <= games * 0.35, `hard bot was the durak ${lost}/${games}`);
});

test('durak.html carries the current engine (run games/build.mjs if this fails)', async () => {
    const { readFileSync } = await import('node:fs');
    const { inlineEngine, pagePaths } = await import('../build.mjs');
    const p = pagePaths('durak');
    const html = readFileSync(p.html, 'utf8');
    assert.equal(inlineEngine(html, readFileSync(p.engine, 'utf8')), html);
});
