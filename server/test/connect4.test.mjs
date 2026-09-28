// End-to-end tests for Connect 4 online: starts `wrangler dev` locally (short
// timers) and plays through real WebSockets. Run: npm test   (from server/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legalMoves, DRAW } from '../../games/connect4/engine.js';

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

async function privateGame(rules) {
    const { room } = await post('/rooms', { game: 'connect4', rules });
    const a = new Client(room);
    await a.waitState((m) => m.status === 'waiting');
    const b = new Client(room);
    await Promise.all([a, b].map((c) => c.waitState((m) => m.status === 'playing')));
    return { room, a, b };
}

// The player whose turn it is drops into `pick(state)` (default: first free column).
async function step(a, b, pick = (st) => legalMoves(st)[0]) {
    const clients = [a, b];
    const s = a.state;
    const me = clients[s.you === s.state.turn ? 0 : 1];
    const n = me.state.state.moveCount;
    me.send({ t: 'move', move: pick(me.state.state), n });
    await Promise.all(clients.map((c) => c.waitState((m) => m.status === 'over' || (m.state && m.state.moveCount > n))));
}

test('connect4: private room, full game to four in a row, rematch swaps first player', async () => {
    const { room, a, b } = await privateGame({ size: '6x5' });
    assert.match(room, /^\d{4}$/);
    const s = a.state;
    assert.equal(s.type, 'connect4');
    assert.equal(s.code, room);
    assert.deepEqual(s.rules, { size: '6x5' });
    assert.equal(s.state.cols, 6);
    assert.equal(s.state.rows, 5);
    assert.equal(s.state.turn, 0);
    assert.equal(b.state.you, 1);
    assert.ok(s.turnMsLeft > 0 && s.turnMsLeft <= TURN_MS);

    // Red (seat 0): 0, 1, 2, 3 along the bottom; yellow stacks on column 5.
    for (const col of [0, 5, 1, 5, 2, 5, 3]) await step(a, b, () => col);
    const end = a.state;
    assert.equal(end.status, 'over');
    assert.deepEqual(end.result, { winner: 0, reason: 'four' });
    assert.deepEqual(end.state.winLine, [24, 25, 26, 27]);
    assert.equal(end.move.player, 0);
    assert.deepEqual(end.move.events[0], { type: 'drop', player: 0, col: 3, row: 4 });
    assert.deepEqual(b.state.result, end.result);

    a.send({ t: 'rematch' });
    await b.waitState((m) => m.status === 'over' && m.rematch[0]);
    const mark = a.msgs.length;
    b.send({ t: 'rematch' });
    const again = await a.waitState((m) => m.status === 'playing' && m.state.moveCount === 0, 8000, mark);
    assert.equal(again.state.turn, 1, 'the other player starts the rematch');
    assert.equal(again.state.grid.every((v) => v === null), true);
    a.close(); b.close();
});

test('connect4: a whole game played to the end agrees on both phones', async () => {
    const { a, b } = await privateGame();
    for (let guard = 0; guard < 50 && a.state.status === 'playing'; guard++) await step(a, b);
    assert.equal(a.state.status, 'over');
    const bEnd = await b.waitState((m) => m.status === 'over');
    assert.deepEqual(bEnd.result, a.state.result);
    assert.deepEqual(bEnd.state.grid, a.state.state.grid);
    assert.ok(a.state.result.winner === 0 || a.state.result.winner === 1 || a.state.result.winner === DRAW);
    a.close(); b.close();
});

test('connect4: server rejects cheating — wrong turn, full column, bad column, stale move', async () => {
    const { a, b } = await privateGame();
    // Yellow tries to move first.
    b.send({ t: 'move', move: 3, n: 0 });
    await b.waitFor((m) => m.t === 'error' && m.code === 'not_your_turn');
    // Fill column 0 (6 discs), then try a 7th.
    for (let k = 0; k < 6; k++) await step(a, b, () => 0);
    assert.equal(a.state.state.grid[0], 1);
    let mark = a.msgs.length;
    a.send({ t: 'move', move: 0, n: 6 });
    await a.waitFor((m) => m.t === 'error' && m.code === 'illegal', 8000, false, mark);
    // A move sent for an old position is dropped (the server re-sends the state).
    mark = a.msgs.length;
    a.send({ t: 'move', move: 3, n: 2 });
    const re = await a.waitState(() => true, 8000, mark);
    assert.equal(re.state.moveCount, 6);
    assert.equal(re.state.grid.filter((v) => v !== null).length, 6);
    // Nonsense columns (after a pause: the server drops more than 10 messages a second).
    await sleep(1100);
    for (const move of [7, -1, 2.5, '3', null, { col: 3 }]) {
        mark = a.msgs.length;
        a.send({ t: 'move', move, n: 6 });
        await a.waitFor((m) => m.t === 'error' && m.code === 'illegal', 8000, false, mark);
    }
    assert.equal(a.state.state.moveCount, 6, 'nothing was played');
    // Emotes: preset only.
    mark = b.msgs.length;
    a.send({ t: 'emote', id: 'hello <b>' });
    a.send({ t: 'emote', id: 'gg' });
    const e = await b.waitFor((m) => m.t === 'emote', 8000, false, mark);
    assert.deepEqual(e, { t: 'emote', seat: 0, id: 'gg' });
    a.close(); b.close();
});

test('connect4: reconnect keeps your seat and the board', async () => {
    const { room, a, b } = await privateGame();
    await step(a, b, () => 3);
    const tok = b.token;
    b.close();
    await a.waitState((m) => m.seats[1] && !m.seats[1].online);
    const b2 = new Client(room, tok);
    const s = await b2.waitState((m) => m.status === 'playing');
    assert.equal(s.you, 1);
    assert.equal(s.state.grid[5 * 7 + 3], 0);
    await a.waitState((m) => m.seats[1] && m.seats[1].online);
    // A third phone can't get in.
    const c = new Client(room);
    await c.waitFor((m) => m.t === 'error' && m.code === 'full');
    a.close(); b2.close(); c.close();
});

test('connect4: quick match pairs two players of this game', async () => {
    const r1 = await post('/quick', { game: 'connect4' });
    const r2 = await post('/quick', { game: 'connect4' });
    assert.equal(r1.room, r2.room);
    const a = new Client(r1.room);
    const b = new Client(r2.room);
    const [sa, sb] = await Promise.all([a, b].map((c) => c.waitState((m) => m.status === 'playing')));
    assert.equal(sa.type, 'connect4');
    assert.equal(sa.kind, 'quick');
    assert.equal(sa.code, null);
    assert.notEqual(sa.you, sb.you);
    assert.ok(!sa.seats[0].bot && !sa.seats[1].bot);
    a.close(); b.close();
});

test('connect4: quick match alone → a labelled bot joins and plays', async () => {
    const { room } = await post('/quick', { game: 'connect4' });
    const a = new Client(room);
    const w = await a.waitState((m) => m.status === 'waiting');
    assert.ok(w.waitMsLeft > 0);
    const s = await a.waitState((m) => m.status === 'playing', QUICK_WAIT_MS + 8000);
    assert.equal(s.seats[1 - s.you].bot, true);
    assert.equal(s.seats[1 - s.you].name, 'Bot');
    // Play the first free column until the game ends; the bot must answer every time.
    for (let guard = 0; guard < 50 && a.state.status === 'playing'; guard++) {
        const st = a.state;
        if (st.state.turn === st.you) {
            const n = st.state.moveCount;
            a.send({ t: 'move', move: legalMoves(st.state)[0], n });
            await a.waitState((m) => m.status === 'over' || (m.state && m.state.moveCount > n));
        } else {
            const n = st.state.moveCount;
            await a.waitState((m) => m.status === 'over' || (m.state && m.state.moveCount > n));
        }
    }
    assert.equal(a.state.status, 'over');
    assert.equal(a.state.result.reason, a.state.result.winner === DRAW ? 'draw' : 'four');
    a.close();
});

test('connect4: idle player gets an automatic move, then loses on the second timeout', async () => {
    const { a, b } = await privateGame();
    const auto = await a.waitState((m) => m.move && m.move.auto, TURN_MS + 5000);
    assert.equal(auto.move.player, 0);
    assert.equal(auto.state.moveCount, 1);
    // Yellow answers, then red idles again.
    await b.waitState((m) => m.state && m.state.moveCount === 1);
    b.send({ t: 'move', move: 3, n: 1 });
    const end = await a.waitState((m) => m.status === 'over', TURN_MS * 2 + 5000);
    assert.deepEqual(end.result, { winner: 1, reason: 'timeout' });
    a.close(); b.close();
});

test('connect4: leaving during a game gives the win to the other player', async () => {
    const { a, b } = await privateGame();
    await step(a, b, () => 3);
    b.send({ t: 'leave' });
    const end = await a.waitState((m) => m.status === 'over');
    assert.deepEqual(end.result, { winner: 0, reason: 'resign' });
    await sleep(100);
    a.close(); b.close();
});
