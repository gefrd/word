// Draughts (10 × 10) through the real server: starts `wrangler dev` locally
// (short timers) and plays over WebSockets. Run: npm test   (from server/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { legalMoves, pieceCount, applyMove } from '../../games/draughts/engine.js';

const PORT = 8900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TURN_MS = 2500;
const QUICK_WAIT_MS = 2000;
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

async function pair(rules) {
    const { room } = await post('/rooms', { game: 'draughts', rules });
    const a = new Client(room);
    await a.waitState(() => true);
    const b = new Client(room);
    await a.waitState((m) => m.status === 'playing');
    await b.waitState((m) => m.status === 'playing');
    return [a, b];
}

// A simple player: the move that takes most, else the first one.
const pick = (st) => legalMoves(st).reduce((best, m) => (m.captures.length > best.captures.length ? m : best));

async function playOut(a, b) {
    const clients = [a, b];
    for (let guard = 0; guard < 700; guard++) {
        const s = a.state;
        if (s.status !== 'playing') return s;
        const st = s.state;
        const me = clients.find((c) => c.state.you === st.turn);
        const n = st.moveCount;
        me.send({ t: 'move', move: { path: pick(st).path }, n });
        await Promise.all(clients.map((c) => c.waitState((m) => m.status === 'over' || (m.state && m.state.moveCount > n))));
    }
    throw new Error('game did not finish');
}

test('draughts: private room, full game, both see the same result, rematch swaps colours', async () => {
    const [a, b] = await pair({ capture: 'free' });
    const s = a.state;
    assert.equal(s.type, 'draughts');
    assert.equal(s.you, 0);
    assert.equal(b.state.you, 1);
    assert.deepEqual(s.state.rules, { capture: 'free' }, 'room rules applied');
    assert.equal(s.state.white, 0, 'first seat plays White');
    assert.equal(s.state.turn, 0);
    assert.equal(pieceCount(s.state, 0), 20);
    assert.ok(s.turnMsLeft > 0 && s.turnMsLeft <= TURN_MS);

    const end = await playOut(a, b);
    assert.equal(end.status, 'over');
    assert.ok([0, 1, -1].includes(end.result.winner));
    assert.ok(['no_moves', 'repetition', 'kings_only', 'endgame', 'limit'].includes(end.result.reason), end.result.reason);
    const bEnd = await b.waitState((m) => m.status === 'over');
    assert.deepEqual(bEnd.result, end.result);
    if (end.result.reason === 'no_moves') assert.equal(legalMoves({ ...end.state, winner: null }).length, 0);

    a.send({ t: 'rematch' });
    await b.waitState((m) => m.status === 'over' && m.rematch[0]);
    const mark = a.msgs.length;
    b.send({ t: 'rematch' });
    const again = await a.waitState((m) => m.status === 'playing' && m.state.moveCount === 0, 8000, mark);
    assert.equal(again.state.white, 1, 'colours swap');
    assert.equal(again.state.turn, 1, 'White moves first');
    a.close(); b.close();
});

test('draughts: server rejects cheating — wrong turn, skipping a capture, fake paths, stale moves', async () => {
    const [a, b] = await pair();
    b.send({ t: 'move', move: { path: [15, 20] }, n: 0 }); // not b's turn
    await b.waitFor((m) => m.t === 'error' && m.code === 'not_your_turn');

    const bad = [
        { path: [31, 22] },          // two squares, no capture
        { path: [35, 40] },          // backwards / onto own piece
        { path: [15, 20] },          // opponent's piece
        { path: 'x' }, { path: [31] }, { path: [31, 99] }, 7, null,
        { path: new Array(40).fill(31) },
    ];
    for (const move of bad) a.send({ t: 'move', move, n: 0 });
    await a.waitFor(() => a.msgs.filter((m) => m.code === 'illegal').length === bad.length);
    await sleep(1100); // the server allows 10 messages a second
    a.send('not json');
    a.send({ t: 'move', move: { path: [31, 27] }, n: 5 }); // stale → just resends state
    await sleep(300);
    assert.equal(a.state.state.moveCount, 0);

    // 32-28 19-23: now White must take 28x19. A quiet move is refused.
    a.send({ t: 'move', move: { path: [31, 27] }, n: 0 });
    await b.waitState((m) => m.state && m.state.moveCount === 1);
    b.send({ t: 'move', move: { path: [18, 22] }, n: 1 });
    await a.waitState((m) => m.state && m.state.moveCount === 2);
    const mark = a.msgs.filter((m) => m.code === 'illegal').length;
    a.send({ t: 'move', move: { path: [30, 25] }, n: 2 });
    a.send({ t: 'move', move: { path: [27, 18], captures: [0, 1, 2] }, n: 2 }); // captures come from the server
    const s = await b.waitState((m) => m.state && m.state.moveCount === 3);
    assert.equal(a.msgs.filter((m) => m.code === 'illegal').length, mark + 1);
    assert.deepEqual(s.move.events[0].captures, [22]);
    assert.equal(s.state.board[22], 0);
    assert.equal(pieceCount(s.state, 1), 19);
    assert.equal(pieceCount(s.state, 0), 20);
    a.close(); b.close();
});

test('draughts: quick match alone → a bot (labelled) plays a whole game', async () => {
    const { room } = await post('/quick', { game: 'draughts' });
    const a = new Client(room);
    const s = await a.waitState((m) => m.status === 'playing', QUICK_WAIT_MS + 5000);
    assert.equal(s.type, 'draughts');
    const botSeat = 1 - s.you;
    assert.equal(s.seats[botSeat].bot, true);
    assert.equal(s.seats[botSeat].name, 'Bot');
    let botMoves = 0;
    for (let guard = 0; guard < 700 && a.state.status === 'playing'; guard++) {
        const st = a.state.state;
        const n = st.moveCount;
        if (st.turn === a.state.you) {
            a.send({ t: 'move', move: { path: pick(st).path }, n });
        } else {
            botMoves++;
        }
        const next = await a.waitState((m) => m.status === 'over' || (m.state && m.state.moveCount > n), 10000);
        // Every move the server sends can be replayed with the engine.
        if (next.move && next.state.moveCount === n + 1) {
            assert.equal(applyMove(st, next.move.move).state.board.join(), next.state.board.join());
        }
    }
    assert.equal(a.state.status, 'over');
    assert.ok(botMoves > 5);
    const mark = a.msgs.length;
    a.send({ t: 'rematch' });
    await a.waitState((m) => m.status === 'playing' && m.state.moveCount <= 1, 8000, mark);
    a.close();
});

test('draughts: idle player gets an automatic move, then loses on the second timeout', async () => {
    const [a, b] = await pair();
    const auto = await b.waitState((m) => m.move && m.move.auto, TURN_MS + 3000);
    assert.equal(auto.move.player, 0);
    const st = b.state.state;
    b.send({ t: 'move', move: { path: pick(st).path }, n: st.moveCount });
    const over = await b.waitState((m) => m.status === 'over', TURN_MS * 2 + 4000);
    assert.deepEqual(over.result, { winner: 1, reason: 'timeout' });
    a.close(); b.close();
});

test('draughts: preset emotes only, and leaving counts as resigning', async () => {
    const [a, b] = await pair();
    a.send({ t: 'emote', id: 'you are <b>bad</b>' });
    a.send({ t: 'emote', id: 'gg' });
    const e = await b.waitFor((m) => m.t === 'emote');
    assert.deepEqual(e, { t: 'emote', seat: 0, id: 'gg' });
    b.send({ t: 'leave' });
    const s = await a.waitState((m) => m.status === 'over');
    assert.deepEqual(s.result, { winner: 0, reason: 'resign' });
    a.close(); b.close();
});
