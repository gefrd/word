// Battleship online: starts `wrangler dev` locally (short timers) and plays
// through real WebSockets. Checks that a phone never receives the other
// player's ships. Run: npm test   (from server/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shipCells, cellOf, FLEETS } from '../../games/battleship/engine.js';

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
    waitFor(pred, ms = 8000, orClose = false, since = 0) {
        return new Promise((resolve, reject) => {
            const w = { pred, resolve, orClose, since };
            this.waiters.push(w);
            this.check();
            setTimeout(() => reject(new Error('timeout; last: ' + JSON.stringify(this.msgs.slice(-2)))), ms);
        });
    }
    waitState(pred, ms, since) { return this.waitFor((m) => m.t === 'state' && pred(m), ms, false, since); }
    // The server takes at most 10 messages a second per phone: space them out.
    send(obj) {
        const now = Date.now();
        this.nextSend = Math.max(now, this.nextSend || 0);
        const text = JSON.stringify(obj);
        setTimeout(() => { try { this.ws.send(text); } catch (e) { /* closed */ } }, this.nextSend - now);
        this.nextSend += 120;
    }
    close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
}

// Two fleets that fit both fleet sizes (the Russian fleet uses the first
// 10 entries, the classic fleet the first 5).
const FLEET_A = [
    { x: 0, y: 0, h: true }, { x: 0, y: 2, h: true }, { x: 0, y: 4, h: true }, { x: 0, y: 6, h: true }, { x: 0, y: 8, h: true },
    { x: 7, y: 0, h: true }, { x: 7, y: 2, h: true }, { x: 7, y: 4, h: true }, { x: 7, y: 6, h: true }, { x: 7, y: 8, h: true },
];
const FLEET_B = [
    { x: 9, y: 0, h: false }, { x: 7, y: 0, h: false }, { x: 5, y: 0, h: false }, { x: 3, y: 0, h: false }, { x: 1, y: 0, h: false },
    { x: 9, y: 7, h: false }, { x: 7, y: 7, h: false }, { x: 5, y: 7, h: false }, { x: 3, y: 7, h: false }, { x: 1, y: 7, h: false },
];
const fleetFor = (sizes, f) => f.slice(0, sizes.length);
const cellsOf = (sizes, f) => fleetFor(sizes, f).flatMap((s, i) => shipCells({ ...s, size: sizes[i] }));

// No state a phone gets may hold the other side's unsunk ships, and the
// other side's placement move must arrive without the ships.
function assertNoLeak(client) {
    for (const m of client.msgs) {
        if (m.t !== 'state' || !m.state) continue;
        const foe = 1 - m.you;
        const b = m.state.boards[foe];
        if (m.state.winner === null) {
            assert.equal(b.ships.length, m.state.sunk[foe].length, 'only sunk enemy ships are sent');
            for (const s of b.ships) {
                assert.ok(shipCells(s).every((c) => b.shots[c] === 2), 'a visible enemy ship is fully hit');
            }
        }
        if (m.move && m.move.player === foe && m.move.move.type === 'place') {
            assert.deepEqual(m.move.move, { type: 'place' });
        }
    }
}

async function setupRoom(rules) {
    const { room } = await post('/rooms', { game: 'battleship', rules });
    const a = new Client(room);
    await a.waitState((m) => m.status === 'waiting');
    const b = new Client(room);
    await Promise.all([a, b].map((c) => c.waitState((m) => m.status === 'playing')));
    return { room, a, b };
}

async function placeBoth(a, b, sizes) {
    const n0 = a.state.state.moveCount;
    a.send({ t: 'move', move: { type: 'place', ships: fleetFor(sizes, FLEET_A) }, n: n0 });
    await b.waitState((m) => !!m.state && m.state.moveCount === n0 + 1);
    b.send({ t: 'move', move: { type: 'place', ships: fleetFor(sizes, FLEET_B) }, n: n0 + 1 });
    await Promise.all([a, b].map((c) => c.waitState((m) => !!m.state && m.state.phase === 'battle')));
}

test('private room: placement is secret, full game, only sunk ships are ever sent', async () => {
    const { a, b } = await setupRoom({ fleet: 'russian', again: true });
    assert.equal(a.state.type, 'battleship');
    assert.equal(a.state.you, 0);
    assert.equal(a.state.state.phase, 'place');
    assert.deepEqual(a.state.rules, { fleet: 'russian', again: true });
    assert.equal(a.state.state.turn, 0, 'first player places first');
    const sizes = FLEETS.russian;

    // Player 1 can't place before player 0.
    b.send({ t: 'move', move: { type: 'place', ships: fleetFor(sizes, FLEET_B) }, n: 0 });
    assert.equal((await b.waitFor((m) => m.t === 'error')).code, 'not_your_turn');

    await placeBoth(a, b, sizes);
    assertNoLeak(a);
    assertNoLeak(b);
    assert.deepEqual(a.state.state.boards[0].ships.map(({ x, y, h }) => ({ x, y, h })), fleetFor(sizes, FLEET_A), 'own fleet is sent');
    assert.equal(b.state.state.boards[0].ships.length, 0);
    assert.equal(b.state.state.boards[0].hidden, true);

    // Player 0 sinks everything (hits keep the turn), with one miss in between.
    const targets = cellsOf(sizes, FLEET_B);
    const miss = cellOf(0, 9);
    assert.ok(!targets.includes(miss));
    let i = 0;
    let missed = false;
    for (let guard = 0; guard < 300 && a.state.status === 'playing'; guard++) {
        const st = a.state.state;
        const n = st.moveCount;
        if (st.turn === 0) {
            const cell = !missed && i === 3 ? miss : targets[i++];
            if (cell === miss) missed = true;
            a.send({ t: 'move', move: { type: 'fire', cell }, n });
        } else {
            // Player 1 shoots at water it hasn't tried yet.
            const free = [];
            for (let c = 0; c < 100; c++) if (st.boards[0].shots[c] === 0 && !cellsOf(sizes, FLEET_A).includes(c)) free.push(c);
            b.send({ t: 'move', move: { type: 'fire', cell: free[0] }, n });
        }
        await Promise.all([a, b].map((c) => c.waitState((m) => m.status === 'over' || (!!m.state && m.state.moveCount > n))));
        assertNoLeak(a);
        assertNoLeak(b);
    }
    const end = a.state;
    assert.equal(end.status, 'over');
    assert.deepEqual(end.result, { winner: 0, reason: 'fleet_sunk' });
    const bEnd = await b.waitState((m) => m.status === 'over');
    assert.equal(bEnd.state.boards[0].ships.length, 10, 'loser sees the whole enemy fleet at the end');
    assert.equal(bEnd.state.hits[0], 20);

    // Rematch: the other player places and shoots first.
    a.send({ t: 'rematch' });
    await b.waitState((m) => m.status === 'over' && m.rematch[0]);
    const mark = a.msgs.length;
    b.send({ t: 'rematch' });
    const again = await a.waitState((m) => m.status === 'playing' && m.state.moveCount === 0, 8000, mark);
    assert.equal(again.state.turn, 1);
    assert.equal(again.state.boards[0].ships.length, 0, 'fresh boards');
    a.close(); b.close();
});

test('server rejects cheating: out of turn, bad fleet, same cell twice, stale n, junk', async () => {
    const { a, b } = await setupRoom({});
    const sizes = FLEETS.classic;
    // Touching ships / wrong count / oversized input.
    const touching = fleetFor(sizes, FLEET_A).map((s, i) => (i === 1 ? { x: 1, y: 1, h: true } : s));
    a.send({ t: 'move', move: { type: 'place', ships: touching }, n: 0 });
    assert.equal((await a.waitFor((m) => m.t === 'error' && m.code === 'illegal')).code, 'illegal');
    let mark = a.msgs.length;
    a.send({ t: 'move', move: { type: 'place', ships: FLEET_A }, n: 0 }); // 10 ships in a 5-ship game
    await a.waitFor((m) => m.t === 'error' && m.code === 'illegal', 8000, false, mark);
    mark = a.msgs.length;
    a.send({ t: 'move', move: { type: 'fire', cell: 3 }, n: 0 }); // no firing while placing
    await a.waitFor((m) => m.t === 'error' && m.code === 'illegal', 8000, false, mark);

    await placeBoth(a, b, sizes);
    const n = a.state.state.moveCount;
    b.send({ t: 'move', move: { type: 'fire', cell: 0 }, n });
    assert.equal((await b.waitFor((m) => m.t === 'error')).code, 'not_your_turn');
    for (const bad of [{ type: 'fire', cell: 100 }, { type: 'fire', cell: -1 }, { type: 'fire', cell: '5' }, { type: 'nuke' }]) {
        mark = a.msgs.length;
        a.send({ t: 'move', move: bad, n });
        await a.waitFor((m) => m.t === 'error' && m.code === 'illegal', 8000, false, mark);
    }
    a.send({ t: 'move', move: { type: 'fire', cell: 55 }, n });
    await b.waitState((m) => !!m.state && m.state.moveCount === n + 1);
    b.send({ t: 'move', move: { type: 'fire', cell: 55 }, n: n + 1 });
    await a.waitState((m) => !!m.state && m.state.moveCount === n + 2);
    // Same cell again, and a stale counter (dropped, state is re-sent).
    mark = a.msgs.length;
    a.send({ t: 'move', move: { type: 'fire', cell: 55 }, n: n + 2 });
    await a.waitFor((m) => m.t === 'error' && m.code === 'illegal', 8000, false, mark);
    mark = a.msgs.length;
    a.send({ t: 'move', move: { type: 'fire', cell: 56 }, n: n });
    const resent = await a.waitState(() => true, 8000, mark);
    assert.equal(resent.state.moveCount, n + 2);
    assert.equal(resent.state.boards[1].shots[56], 0);
    assertNoLeak(a);
    assertNoLeak(b);
    a.close(); b.close();
});

test('idle player: fleet is placed automatically (still secret), then loses on the second timeout', async () => {
    const { a, b } = await setupRoom({});
    // Player 0 does nothing: the server places a random fleet for them.
    const auto = await b.waitState((m) => m.move && m.move.auto, TURN_MS + 3000);
    assert.equal(auto.move.player, 0);
    assert.deepEqual(auto.move.move, { type: 'place' }, 'auto fleet is not shown to the other player');
    assert.equal(auto.state.boards[0].ships.length, 0);
    const own = await a.waitState((m) => m.state && m.state.placed[0]);
    assert.equal(own.state.boards[0].ships.length, 5, 'player 0 sees the fleet placed for them');
    assert.equal(own.move.move.ships.length, 5);
    // Player 1 places, then player 0 keeps idling and loses.
    b.send({ t: 'move', move: { type: 'place', ships: fleetFor(FLEETS.classic, FLEET_B) }, n: 1 });
    const over = await b.waitState((m) => m.status === 'over', TURN_MS * 2 + 4000);
    assert.deepEqual(over.result, { winner: 1, reason: 'timeout' });
    assert.equal(over.state.boards[0].ships.length, 5, 'fleets are shown after the game');
    assertNoLeak(a);
    assertNoLeak(b);
    a.close(); b.close();
});

test('quick match alone → bot places, shoots, never leaks its fleet, game finishes', async () => {
    const { room } = await post('/quick', { game: 'battleship' });
    assert.match(room, /^q[a-z0-9]{10}$/);
    const a = new Client(room);
    const s = await a.waitState((m) => m.status === 'playing', QUICK_WAIT_MS + 5000);
    assert.equal(s.type, 'battleship');
    const botSeat = 1 - s.you;
    assert.equal(s.seats[botSeat].bot, true);
    for (let guard = 0; guard < 400 && a.state.status === 'playing'; guard++) {
        const st = a.state.state;
        const n = st.moveCount;
        if (st.turn === a.state.you) {
            const move = st.phase === 'place'
                ? { type: 'place', ships: fleetFor(st.fleet, FLEET_A) }
                : { type: 'fire', cell: st.boards[botSeat].shots.indexOf(0) };
            a.send({ t: 'move', move, n });
        }
        await a.waitState((m) => m.status === 'over' || (!!m.state && m.state.moveCount > n));
    }
    assert.equal(a.state.status, 'over');
    assert.equal(a.state.state.boards[botSeat].ships.length, 5);
    assertNoLeak(a);
    a.close();
});

test('resign ends the game; the winner then sees both fleets', async () => {
    const { a, b } = await setupRoom({});
    await placeBoth(a, b, FLEETS.classic);
    b.send({ t: 'resign' });
    const s = await a.waitState((m) => m.status === 'over');
    assert.deepEqual(s.result, { winner: 0, reason: 'resign' });
    assert.equal(s.state.boards[1].ships.length, 5);
    a.close(); b.close();
});
