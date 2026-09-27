// End-to-end tests: starts `wrangler dev` locally (short timers) and plays
// through real WebSockets. Run: npm test   (from server/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legalMoves, seedCount } from '../../games/igisoro/engine.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
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
    // `since`: only look at messages from this index on (default: all).
    waitFor(pred, ms = 8000, orClose = false, since = 0) {
        return new Promise((resolve, reject) => {
            const w = { pred, resolve, orClose, since };
            this.waiters.push(w);
            this.check();
            setTimeout(() => reject(new Error('timeout; last: ' + JSON.stringify(this.msgs.slice(-2)))), ms);
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

// Both players always play their first legal move until the game ends.
async function playOut(a, b) {
    const clients = [a, b];
    for (let guard = 0; guard < 500; guard++) {
        const s = a.state;
        if (s.status !== 'playing') return s;
        const me = clients[s.you === s.game.turn ? 0 : 1];
        const st = me.state;
        const n = st.game.moveCount;
        me.send({ t: 'move', pit: legalMoves(st.game)[0], n });
        await Promise.all(clients.map((c) => c.waitState((m) => m.status === 'over' || (m.game && m.game.moveCount > n))));
    }
    throw new Error('game did not finish');
}

test('health and CORS', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('private room: create, join, full game, both see the same result', async () => {
    const { room } = await post('/rooms', { rules: { setup: 'all2' } });
    assert.match(room, /^\d{4}$/);
    const a = new Client(room);
    const s0 = await a.waitState((m) => m.status === 'waiting');
    assert.equal(s0.code, room);
    assert.equal(s0.you, 0);
    assert.match(s0.seats[0].name, /^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);

    const b = new Client(room);
    const [sa, sb] = await Promise.all([
        a.waitState((m) => m.status === 'playing'),
        b.waitState((m) => m.status === 'playing'),
    ]);
    assert.equal(sb.you, 1);
    assert.deepEqual(sa.game.pits[0], new Array(16).fill(2), 'room rules applied');
    assert.ok(sa.turnMsLeft > 0 && sa.turnMsLeft <= TURN_MS);

    const end = await playOut(a, b);
    assert.equal(end.status, 'over');
    assert.equal(end.result.reason, 'no_moves');
    const bEnd = await b.waitState((m) => m.status === 'over');
    assert.deepEqual(bEnd.result, end.result);
    assert.equal(seedCount(end.game, 0) + seedCount(end.game, 1), 64);

    // Rematch needs both players; first player swaps.
    a.send({ t: 'rematch' });
    const r1 = await b.waitState((m) => m.status === 'over' && m.rematch[0]);
    assert.equal(r1.rematch[1], false);
    const mark = a.msgs.length;
    b.send({ t: 'rematch' });
    const again = await a.waitState((m) => m.status === 'playing' && m.game.moveCount === 0, 8000, mark);
    assert.equal(again.game.turn, 1);
    a.close(); b.close();
});

test('server rejects cheating: wrong turn, illegal pit, stale move', async () => {
    const { room } = await post('/rooms');
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await a.waitState((m) => m.status === 'playing');
    await b.waitState((m) => m.status === 'playing');

    b.send({ t: 'move', pit: 0, n: 0 }); // not b's turn
    await b.waitFor((m) => m.t === 'error' && m.code === 'not_your_turn');
    a.send({ t: 'move', pit: 12, n: 0 }); // empty inner pit
    await a.waitFor((m) => m.t === 'error' && m.code === 'illegal');
    a.send({ t: 'move', pit: 99, n: 0 });
    await a.waitFor((m) => m.t === 'error' && m.code === 'illegal' && a.msgs.filter((x) => x.code === 'illegal').length === 2);
    a.send('not json');
    a.send({ t: 'move', pit: 0, n: 5 }); // stale → just resends state
    await sleep(300);
    assert.equal(a.state.game.moveCount, 0);
    a.send({ t: 'move', pit: 0, n: 0 });
    const s = await b.waitState((m) => m.game && m.game.moveCount === 1);
    assert.equal(s.move.player, 0);
    assert.ok(s.move.events.length > 0);
    a.close(); b.close();
});

test('room is full for a third player; unknown code is not found', async () => {
    const { room } = await post('/rooms');
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await b.waitState((m) => m.status === 'playing');
    const c = new Client(room);
    await c.waitFor((m) => m.t === 'error' && m.code === 'full');
    const d = new Client('0001');
    const e = await d.waitFor((m) => m.t === 'error');
    assert.equal(e.code, 'not_found');
    a.close(); b.close();
});

test('reconnect keeps your seat; opponent sees you offline then online', async () => {
    const { room } = await post('/rooms');
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await a.waitState((m) => m.status === 'playing');
    await b.waitState((m) => m.status === 'playing');
    a.close();
    await b.waitState((m) => m.seats[0].online === false);
    const a2 = new Client(room, a.token);
    const s = await a2.waitState((m) => m.status === 'playing');
    assert.equal(s.you, 0);
    await b.waitState((m) => m.seats[0].online === true);
    a2.close(); b.close();
});

test('quick match pairs two players', async () => {
    const q1 = await post('/quick');
    const q2 = await post('/quick');
    assert.equal(q1.room, q2.room);
    assert.equal(q2.matched, true);
    const a = new Client(q1.room);
    await a.waitState((m) => m.status === 'waiting' && m.waitMsLeft > 0);
    const b = new Client(q2.room);
    const s = await b.waitState((m) => m.status === 'playing');
    assert.equal(s.code, null, 'quick rooms have no shareable code');
    assert.ok(s.seats.every((x) => !x.bot));
    a.close(); b.close();
});

test('quick match alone → bot joins, labelled as bot, and plays', async () => {
    await sleep(QUICK_WAIT_MS); // let the previous waiting slot expire
    const { room } = await post('/quick');
    const a = new Client(room);
    const s = await a.waitState((m) => m.status === 'playing', QUICK_WAIT_MS + 5000);
    const botSeat = 1 - s.you;
    assert.equal(s.seats[botSeat].bot, true);
    assert.equal(s.seats[botSeat].name, 'Bot');
    // Play a whole game vs the bot.
    for (let guard = 0; guard < 1000 && a.state.status === 'playing'; guard++) {
        const st = a.state;
        if (st.game.turn === st.you) {
            const n = st.game.moveCount;
            a.send({ t: 'move', pit: legalMoves(st.game)[0], n });
            await a.waitState((m) => m.status === 'over' || (m.game && m.game.moveCount > n));
        } else {
            const n = st.game.moveCount;
            await a.waitState((m) => m.status === 'over' || (m.game && m.game.moveCount > n));
        }
    }
    assert.equal(a.state.status, 'over', 'moves: ' + a.state.game.moveCount);
    // Rematch vs bot starts right away.
    const mark = a.msgs.length;
    a.send({ t: 'rematch' });
    await a.waitState((m) => m.status === 'playing' && m.game.moveCount <= 1, 8000, mark);
    a.close();
});

test('idle player: automatic move, then loses on the second timeout', async () => {
    const { room } = await post('/rooms');
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await a.waitState((m) => m.status === 'playing');
    // Player 0 does nothing.
    const auto = await b.waitState((m) => m.move && m.move.auto, TURN_MS + 3000);
    assert.equal(auto.move.player, 0);
    // Player 1 moves normally.
    const st = b.state;
    b.send({ t: 'move', pit: legalMoves(st.game)[0], n: st.game.moveCount });
    const over = await b.waitState((m) => m.status === 'over', TURN_MS * 2 + 4000);
    assert.deepEqual(over.result, { winner: 1, reason: 'timeout' });
    a.close(); b.close();
});

test('emotes: preset ones are relayed, anything else is ignored', async () => {
    const { room } = await post('/rooms');
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await b.waitState((m) => m.status === 'playing');
    a.send({ t: 'emote', id: 'hello <b>spam</b>' });
    a.send({ t: 'emote', id: 'nice' });
    const e = await b.waitFor((m) => m.t === 'emote');
    assert.deepEqual(e, { t: 'emote', seat: 0, id: 'nice' });
    a.send({ t: 'emote', id: 'wow' }); // too soon → dropped
    await sleep(400);
    assert.equal(b.msgs.filter((m) => m.t === 'emote').length, 1);
    a.close(); b.close();
});

test('resign ends the game for the other player', async () => {
    const { room } = await post('/rooms');
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await b.waitState((m) => m.status === 'playing');
    b.send({ t: 'resign' });
    const s = await a.waitState((m) => m.status === 'over');
    assert.deepEqual(s.result, { winner: 0, reason: 'resign' });
    a.close(); b.close();
});
