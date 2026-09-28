// Durak online: starts `wrangler dev` locally (short timers) and plays through
// real WebSockets. Hidden cards: every player must see only their own hand.
// Run: npm test   (from server/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chooseBotAction, makeDeck, beats } from '../../games/durak/engine.js';

const PORT = 8890 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TURN_MS = 2500;
const QUICK_WAIT_MS = 2500;
let dev;

before(async () => {
    dev = spawn('npx', [
        'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
        '--var', `TURN_MS:${TURN_MS}`, '--var', `QUICK_WAIT_MS:${QUICK_WAIT_MS}`, '--var', 'BOT_DELAY_MS:100',
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let log = '';
    dev.stdout.on('data', (d) => { log += d; });
    dev.stderr.on('data', (d) => { log += d; });
    const start = Date.now();
    for (;;) {
        try {
            const r = await fetch(`${BASE}/health`);
            if (r.ok) break;
        } catch (e) { /* not up yet */ }
        if (Date.now() - start > 60000) throw new Error('wrangler dev did not start:\n' + log);
        await new Promise((r) => setTimeout(r, 300));
    }
});

after(() => {
    try { process.kill(-dev.pid); } catch (e) { /* gone */ }
});

const token = () => randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
    constructor(room, tok = token()) {
        this.token = tok;
        this.msgs = [];
        this.raw = [];
        this.waiters = [];
        this.state = null;
        this.closed = false;
        this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/rooms/${room}/ws?token=${tok}`);
        this.ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.t === 'state') this.state = m;
            this.msgs.push(m);
            this.raw.push(e.data);
            this.check();
        });
        this.ws.addEventListener('close', () => { this.closed = true; this.check(); });
    }
    check() {
        this.waiters = this.waiters.filter((w) => {
            const hit = this.msgs.slice(w.since).find(w.pred);
            if (hit) { w.resolve(hit); return false; }
            if (this.closed && w.orClose) { w.resolve(null); return false; }
            return true;
        });
    }
    waitFor(pred, ms = 8000, orClose = false, since = 0) {
        return new Promise((resolve, reject) => {
            const w = { pred, resolve, orClose, since };
            this.waiters.push(w);
            this.check();
            setTimeout(() => reject(new Error('timeout; last: ' + JSON.stringify(this.msgs.slice(-2)))), ms);
        });
    }
    waitState(pred, ms, since) { return this.waitFor((m) => m.t === 'state' && pred(m), ms, false, since); }
    send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
    close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
}

async function join(room, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const c = new Client(room);
        await c.waitState(() => true);
        out.push(c);
    }
    return out;
}

// Each phone sees only its own cards: the others' hands and the deck (except
// the face-up trump at the bottom) are '??'. The discard is public: every card
// in it was face up on the table.
function checkHidden(m) {
    const st = m.state;
    for (const p of st.players) {
        if (p === m.you) assert.ok(st.hands[p].every((c) => c !== '??'), 'own hand visible');
        else assert.ok(st.hands[p].every((c) => c === '??'), 'hand of seat ' + p + ' leaked to ' + m.you);
    }
    if (st.deck.length) {
        assert.ok(st.deck.slice(0, -1).every((c) => c === '??'), 'deck leaked');
        assert.equal(st.deck.at(-1), st.trumpCard);
    }
    for (const e of (m.move && m.move.events) || []) {
        if (e.type === 'draw' && e.player !== m.you) assert.equal(e.cards, undefined, 'drawn cards leaked');
    }
}

// Humans play like a medium bot, each from their own view, until the game ends.
async function playOut(clients, maxActions = 1500) {
    for (let guard = 0; guard < maxActions; guard++) {
        const s = clients[0].state;
        if (s.status !== 'playing') return s;
        const st = s.state;
        const n = st.actions;
        const mover = clients.find((c) => c.state.you === st.turn && c.state.state.actions === n);
        if (mover) mover.send({ t: 'move', move: chooseBotAction(mover.state.state, 'medium'), n });
        await clients[0].waitState((m) => m.status === 'over' || (m.state && m.state.actions > n), 10000);
        // Let every phone catch up before the next action.
        await Promise.all(clients.map((c) => c.waitState((m) => m.status === 'over' || (m.state && m.state.actions > n), 10000)));
    }
    throw new Error('durak game did not finish');
}

test('durak: 3 players, full game, nobody ever sees cards that are not theirs', async () => {
    const { room } = await post('/rooms', { game: 'durak', players: 3, rules: { transfer: true } });
    const [a, b, c] = await join(room, 3);
    const clients = [a, b, c];
    const starts = await Promise.all(clients.map((x) => x.waitState((m) => m.status === 'playing')));
    starts.forEach((m, i) => {
        assert.equal(m.type, 'durak');
        assert.equal(m.you, i);
        assert.deepEqual(m.seatOrder, [0, 1, 2]);
        assert.equal(m.state.rules.transfer, true);
        assert.equal(m.state.hands[i].length, 6);
        assert.equal(m.state.deck.length, 36 - 18);
        checkHidden(m);
    });
    // Everyone's own hand is different, and all three are real cards.
    const own = starts.map((m, i) => m.state.hands[i]);
    assert.equal(new Set(own.flat()).size, 18);
    assert.ok(own.flat().every((x) => makeDeck(36).includes(x)));

    const end = await playOut(clients);
    assert.equal(end.status, 'over');
    for (const x of clients) {
        const last = await x.waitState((m) => m.status === 'over');
        assert.deepEqual(last.result, end.result);
        for (const m of x.msgs.filter((q) => q.t === 'state' && q.state)) checkHidden(m);
    }
    // Cross-check the raw messages: a card in someone's hand never reaches
    // another phone unless everyone has seen it (on the table, or the trump).
    for (const x of clients) {
        const seen = new Set();
        for (let i = 0; i < x.msgs.length; i++) {
            const m = x.msgs[i];
            if (m.t !== 'state' || !m.state) continue;
            for (const p of m.state.table) { seen.add(p.a); seen.add(p.d); }
            for (const e of (m.move && m.move.events) || []) {
                if (e.type !== 'draw') for (const c of [e.card, ...(e.cards || [])]) seen.add(c);
            }
            seen.add(m.state.trumpCard);
            seen.add(m.state.firstCard);
            for (const y of clients) {
                if (y === x) continue;
                const twin = y.msgs.find((q) => q.t === 'state' && q.state && q.state.actions === m.state.actions);
                if (!twin) continue;
                for (const card of twin.state.hands[twin.you]) {
                    if (seen.has(card)) continue;
                    assert.ok(!x.raw[i].includes('"' + card + '"'), `seat ${x.state.you} saw ${card} of seat ${twin.you}`);
                }
            }
        }
    }
    const st = end.state;
    if (st.loser !== null) {
        assert.ok(st.hands[st.loser].length > 0);
        assert.equal(end.result.reason, 'finished');
        assert.equal(end.result.winner, st.out[0]);
    } else {
        assert.equal(end.result.winner, -1);
    }
    clients.forEach((x) => x.close());
});

test('durak: server rejects moves out of turn, cards you do not hold, bad defence, stale moves', async () => {
    const { room } = await post('/rooms', { game: 'durak', players: 2 });
    const [a, b] = await join(room, 2);
    await a.waitState((m) => m.status === 'playing');
    await b.waitState((m) => m.status === 'playing');
    const st = a.state.state;
    const att = [a, b].find((x) => x.state.you === st.turn);
    const def = att === a ? b : a;
    const mine = att.state.state.hands[att.state.you];
    const notMine = makeDeck(36).find((x) => !mine.includes(x));

    def.send({ t: 'move', move: { type: 'take' }, n: 0 });
    await def.waitFor((m) => m.t === 'error' && m.code === 'not_your_turn');
    att.send({ t: 'move', move: { type: 'attack', cards: [notMine] }, n: 0 });
    await att.waitFor((m) => m.t === 'error' && m.code === 'illegal');
    att.send({ t: 'move', move: { type: 'pass' }, n: 0 });
    await att.waitFor((m) => m.t === 'error' && m.code === 'illegal' && att.msgs.filter((x) => x.code === 'illegal').length === 2);
    att.send({ t: 'move', move: { type: 'attack', cards: ['XX'] }, n: 0 });
    att.send({ t: 'move', move: { type: 'attack', cards: 'Ah' }, n: 0 });
    att.send({ t: 'move', move: { type: 'transfer', card: mine[0] }, n: 0 });
    await att.waitFor(() => att.msgs.filter((x) => x.code === 'illegal').length === 5);
    att.send('not json');
    att.send({ t: 'move', move: { type: 'attack', cards: [mine[0]] }, n: 7 }); // stale → state resent
    await sleep(300);
    assert.equal(att.state.state.actions, 0);

    // A real lead; then the defender tries a card that doesn't beat it.
    const lead = mine[0];
    att.send({ t: 'move', move: { type: 'attack', cards: [lead] }, n: 0 });
    const s1 = await def.waitState((m) => m.state && m.state.actions >= 1);
    assert.deepEqual(s1.move.move, { type: 'attack', cards: [lead] });
    if (s1.state.phase === 'defend') {
        const hand = s1.state.hands[s1.you];
        const bad = hand.find((x) => !beats(lead, x, s1.state.trump));
        if (bad) {
            def.send({ t: 'move', move: { type: 'defend', card: bad, target: 0 }, n: 1 });
            await def.waitFor((m) => m.t === 'error' && m.code === 'illegal');
        }
        // Classic rules: no transfer.
        const same = hand.find((x) => x[0] === lead[0]);
        if (same) {
            def.send({ t: 'move', move: { type: 'transfer', card: same }, n: 1 });
            await def.waitFor((m) => m.t === 'error' && m.code === 'illegal' && def.msgs.filter((x) => x.code === 'illegal').length === (bad ? 2 : 1));
        }
        def.send({ t: 'move', move: { type: 'take' }, n: 1 });
        const s2 = await att.waitState((m) => m.state && m.state.actions >= 2);
        assert.equal(s2.move.events[0].type, 'take');
    }
    a.close(); b.close();
});

test('durak: 4-seat room, owner starts early, bots fill the rest and play, game finishes', async () => {
    const { room } = await post('/rooms', { game: 'durak', players: 4, rules: { deck: 52, throwIn: 'neighbors' } });
    const [a, b] = await join(room, 2);
    await a.waitState((m) => m.seats[1] && m.seats[1].online);
    assert.deepEqual(a.state.seatOrder, [0, 1, 2, 3]);
    b.send({ t: 'start' }); // only the owner may start
    await sleep(300);
    assert.equal(a.state.status, 'waiting');
    a.send({ t: 'start' });
    const st = await b.waitState((m) => m.status === 'playing');
    assert.deepEqual(st.seats.map((x) => x.bot), [false, false, true, true]);
    assert.deepEqual(st.state.players, [0, 1, 2, 3]);
    assert.equal(st.state.deck.length, 52 - 24);
    await a.waitState((m) => m.status === 'playing');
    const end = await playOut([a, b]);
    assert.equal(end.status, 'over');
    const botMoves = a.msgs.filter((m) => m.t === 'state' && m.move && m.move.player >= 2);
    assert.ok(botMoves.length > 0, 'bots played');
    a.close(); b.close();
});

test('durak: rematch deals new cards; quick match alone gets one bot', async () => {
    const { room } = await post('/rooms', { game: 'durak', players: 2 });
    const [a, b] = await join(room, 2);
    await a.waitState((m) => m.status === 'playing');
    const first = a.state.state.hands[a.state.you].join();
    b.send({ t: 'resign' });
    const over = await a.waitState((m) => m.status === 'over');
    assert.deepEqual(over.result, { winner: 0, reason: 'resign' });
    const mark = a.msgs.length;
    a.send({ t: 'rematch' });
    b.send({ t: 'rematch' });
    const again = await a.waitState((m) => m.status === 'playing' && m.state.actions === 0, 8000, mark);
    assert.notEqual(again.state.hands[again.you].join(), first);
    checkHidden(again);
    a.close(); b.close();

    const q = await post('/quick', { game: 'durak' });
    const c = new Client(q.room);
    const s = await c.waitState((m) => m.status === 'playing', QUICK_WAIT_MS + 5000);
    assert.equal(s.type, 'durak');
    assert.deepEqual(s.seatOrder, [0, 1]);
    assert.equal(s.seats.filter((x) => x && x.bot).length, 1);
    checkHidden(s);
    c.close();
});

test('durak: an idle player gets automatic moves, then loses on time', async () => {
    const { room } = await post('/rooms', { game: 'durak', players: 2 });
    const [a, b] = await join(room, 2);
    await a.waitState((m) => m.status === 'playing');
    await b.waitState((m) => m.status === 'playing');
    // Player a does nothing; b plays whenever it is b's turn.
    let auto = false;
    for (let guard = 0; guard < 60 && b.state.status === 'playing'; guard++) {
        const m = b.state;
        const n = m.state.actions;
        if (m.state.turn === m.you) b.send({ t: 'move', move: chooseBotAction(m.state, 'medium'), n });
        const next = await b.waitState((x) => x.status !== 'playing' || x.state.actions > n, TURN_MS + 4000, b.msgs.length);
        if (next.move && next.move.auto) {
            auto = true;
            assert.equal(next.move.player, 0);
        }
    }
    assert.ok(auto, 'no automatic move');
    const over = b.state;
    assert.equal(over.status, 'over');
    // Unless the game happened to finish on its own, a lost on time.
    if (over.result.reason !== 'finished' && over.result.reason !== 'draw') assert.deepEqual(over.result, { winner: 1, reason: 'timeout' });
    a.close(); b.close();
});
