// Uno end-to-end tests: starts `wrangler dev` locally (short timers) and plays
// through real WebSockets. Run: npm test   (from server/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { playableCards } from '../../games/uno/engine.js';

const PORT = 8900 + Math.floor(Math.random() * 100);
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
        this.waiters = [];
        this.state = null;
        this.closed = false;
        this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/rooms/${room}/ws?token=${tok}`);
        this.ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            m.raw = e.data;
            if (m.t === 'state') this.state = m;
            this.msgs.push(m);
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
            setTimeout(() => reject(new Error('timeout; last: ' + JSON.stringify(this.msgs.slice(-2).map((m) => m.raw)))), ms);
        });
    }
    waitState(pred, ms, since) { return this.waitFor((m) => m.t === 'state' && pred(m), ms, false, since); }
    send(obj) { this.ws.send(JSON.stringify(obj)); }
    close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
}

// Simple player: play the first card that fits (saying UNO), else draw.
function unoMove(st) {
    if (st.phase === 'drawn') return { type: 'play', card: st.drawn, color: 'red', uno: true };
    const ids = playableCards(st, st.turn);
    if (ids.length) return { type: 'play', card: ids[0], color: 'blue', uno: true };
    return { type: 'draw' };
}

async function playUno(clients, maxActions = 3000) {
    for (let guard = 0; guard < maxActions; guard++) {
        const s = clients[0].state;
        if (s.status !== 'playing') return s;
        const st = s.state;
        const mover = clients.find((c) => c.state.you === st.turn);
        const n = st.actions;
        if (mover) mover.send({ t: 'move', move: unoMove(mover.state.state), n });
        await clients[0].waitState((m) => m.status === 'over' || (m.state && m.state.actions > n), 10000);
    }
    throw new Error('uno game did not finish');
}

async function twoPlayerRoom(rules) {
    const { room } = await post('/rooms', { game: 'uno', players: 2, rules });
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await a.waitState((m) => m.status === 'playing');
    await b.waitState((m) => m.status === 'playing');
    return [a, b, room];
}

test('uno: 2-player room plays a full game; nobody ever sees the other hand or the deck', async () => {
    const [a, b] = await twoPlayerRoom({ handSize: 5, stack: true });
    const s0 = a.state;
    assert.equal(s0.type, 'uno');
    assert.deepEqual(s0.seatOrder, [0, 1]);
    assert.equal(s0.state.rules.handSize, 5);
    assert.equal(s0.state.rules.stack, true);
    assert.equal(s0.state.hands[0].length, 5);
    assert.equal(s0.state.hands[1], 5, 'the other hand is only a count');
    assert.equal(typeof s0.state.deck, 'number');
    assert.ok(s0.turnMsLeft > 0 && s0.turnMsLeft <= TURN_MS);

    const end = await playUno([a, b]);
    assert.equal(end.status, 'over');
    assert.equal(end.result.reason, 'finished');
    const bEnd = await b.waitState((m) => m.status === 'over');
    assert.deepEqual(bEnd.result, end.result);
    const w = end.result.winner;
    assert.equal(bEnd.state.hands[w] === 0 || (Array.isArray(bEnd.state.hands[w]) && bEnd.state.hands[w].length === 0), true);

    // Compare what each phone got with the other phone's hand at the same moment.
    for (const [me, other] of [[a, b], [b, a]]) {
        const hands = new Map();
        for (const m of other.msgs) if (m.t === 'state' && m.state) hands.set(m.state.actions, m.state.hands[other.state.you]);
        let checked = 0;
        for (const m of me.msgs) {
            if (m.t !== 'state' || !m.state) continue;
            assert.equal(typeof m.state.hands[other.state.you], 'number');
            assert.equal(typeof m.state.deck, 'number');
            for (const e of (m.move && m.move.events) || []) {
                if ((e.type === 'draw' || e.type === 'penalty') && e.player !== me.state.you) assert.equal(e.cards, undefined);
            }
            const secret = hands.get(m.state.actions);
            if (!secret) continue;
            for (const c of secret) assert.ok(!m.raw.includes('{"id":' + c.id + ','), 'card ' + c.id + ' leaked to seat ' + me.state.you);
            checked++;
        }
        assert.ok(checked > 5, 'checked ' + checked);
    }
    // Own drawn cards are visible to their owner.
    const ownDraws = [a, b].flatMap((c) => c.msgs.filter((m) => m.t === 'state' && m.move)
        .flatMap((m) => m.move.events.filter((e) => e.type === 'draw' && e.player === c.state.you)));
    assert.ok(ownDraws.length > 0 && ownDraws.every((e) => Array.isArray(e.cards) && e.cards.length === e.count));

    // Rematch: the other player starts.
    a.send({ t: 'rematch' });
    const mark = a.msgs.length;
    b.send({ t: 'rematch' });
    const again = await a.waitState((m) => m.status === 'playing' && m.state.actions === 0, 8000, mark);
    assert.equal(again.state.hands[0].length, 5);
    assert.equal(again.state.turn, 1, 'the other player starts');
    a.close(); b.close();
});

test('uno: the server shuffles; rooms get different deals', async () => {
    const deals = [];
    for (let k = 0; k < 2; k++) {
        const [a, b] = await twoPlayerRoom();
        deals.push(JSON.stringify(a.state.state.hands[0]) + JSON.stringify(b.state.state.hands[1]));
        a.close(); b.close();
    }
    assert.notEqual(deals[0], deals[1]);
});

test('uno: server rejects moves out of turn, cards you do not hold, wilds without a colour, stale moves', async () => {
    const [a, b] = await twoPlayerRoom();
    const [me, other] = a.state.state.turn === a.state.you ? [a, b] : [b, a];
    other.send({ t: 'move', move: { type: 'draw' }, n: 0 });
    await other.waitFor((m) => m.t === 'error' && m.code === 'not_your_turn');

    // A card from the other player's hand (the mover can't see it, but ids are guessable).
    const theirs = other.state.state.hands[other.state.you][0];
    me.send({ t: 'move', move: { type: 'play', card: theirs.id, color: 'red' }, n: 0 });
    await me.waitFor((m) => m.t === 'error' && m.code === 'illegal');
    me.send({ t: 'move', move: { type: 'pass' }, n: 0 });
    await me.waitFor((m) => m.t === 'error' && me.msgs.filter((x) => x.code === 'illegal').length === 2);
    me.send({ t: 'move', move: { type: 'play', card: 'x' }, n: 0 });
    await me.waitFor((m) => m.t === 'error' && me.msgs.filter((x) => x.code === 'illegal').length === 3);
    const wild = me.state.state.hands[me.state.you].find((c) => c.color === 'wild');
    if (wild) {
        me.send({ t: 'move', move: { type: 'play', card: wild.id, color: 'purple' }, n: 0 });
        await me.waitFor((m) => m.t === 'error' && me.msgs.filter((x) => x.code === 'illegal').length === 4);
    }
    me.send({ t: 'move', move: { type: 'draw' }, n: 7 }); // stale → just resends state
    await sleep(300);
    assert.equal(me.state.state.actions, 0);

    me.send({ t: 'move', move: { type: 'draw', cards: 5 }, n: 0 });
    const s = await other.waitState((m) => m.state && m.state.actions === 1);
    assert.equal(s.move.player, me.state.you);
    assert.deepEqual(s.move.move, { type: 'draw' });
    assert.equal(s.state.hands[me.state.you], 8, 'drew exactly one card');
    a.close(); b.close();
});

test('uno: 4 seats, owner starts early, bots fill and play, game finishes', async () => {
    const { room } = await post('/rooms', { game: 'uno', players: 4, rules: { handSize: 5 } });
    const a = new Client(room);
    const s0 = await a.waitState((m) => m.status === 'waiting');
    assert.deepEqual(s0.seatOrder, [0, 1, 2, 3]);
    const b = new Client(room);
    await b.waitState(() => true);
    await a.waitState((m) => m.seats[1] && m.seats[1].online);
    b.send({ t: 'start' }); // only the owner may start
    await sleep(300);
    assert.equal(a.state.status, 'waiting');
    a.send({ t: 'start' });
    const st = await b.waitState((m) => m.status === 'playing');
    assert.deepEqual(st.seats.map((x) => x.bot), [false, false, true, true]);
    assert.deepEqual(st.state.players, [0, 1, 2, 3]);
    assert.deepEqual([0, 2, 3].map((p) => st.state.hands[p]), [5, 5, 5]);
    await a.waitState((m) => m.status === 'playing');
    const end = await playUno([a, b]);
    assert.equal(end.status, 'over');
    assert.ok([0, 1, 2, 3].includes(end.result.winner));
    const botMoves = a.msgs.filter((m) => m.t === 'state' && m.move && m.move.player >= 2);
    assert.ok(botMoves.length > 0, 'bots played');
    a.close(); b.close();
});

test('uno: idle player gets automatic moves, then loses a 2-player game', async () => {
    const [a, b] = await twoPlayerRoom();
    const [idle, active] = a.state.state.turn === a.state.you ? [a, b] : [b, a];
    const auto = await active.waitState((m) => m.move && m.move.auto, TURN_MS + 3000);
    assert.equal(auto.move.player, idle.state.you);
    let over = null;
    for (let guard = 0; guard < 40 && !over; guard++) {
        const st = active.state;
        if (st.status === 'over') { over = st; break; }
        const n = st.state.actions;
        if (st.state.turn === st.you) active.send({ t: 'move', move: unoMove(st.state), n });
        const next = await active.waitState((m) => m.status === 'over' || m.state.actions > n, TURN_MS + 4000, active.msgs.length);
        if (next.status === 'over') over = next;
    }
    assert.ok(over, 'game did not end');
    assert.deepEqual(over.result, { winner: active.state.you, reason: 'timeout' });
    a.close(); b.close();
});

test('uno: quick match alone fills three bots', async () => {
    const { room } = await post('/quick', { game: 'uno' });
    const a = new Client(room);
    const s = await a.waitState((m) => m.status === 'playing', QUICK_WAIT_MS + 5000);
    assert.equal(s.type, 'uno');
    assert.equal(s.seats.filter((x) => x.bot).length, 3);
    assert.equal(s.state.hands[s.you].length, 7);
    a.close();
});
