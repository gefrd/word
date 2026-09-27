// One Durable Object per game room. It holds the players' WebSockets and is
// the only place where moves are applied: phones send "I tapped pit 5" or
// "roll the die", the room checks it with the same engine the offline game
// uses (see games.js) and tells every player the result. A modified client
// can't fake a move, a dice roll or a win.
//
// Uses the WebSocket Hibernation API, so an idle room costs nothing: the
// object is evicted from memory between messages and restored from storage.

import { DurableObject } from 'cloudflare:workers';
import { GAMES, DRAW, secureRandom } from './games.js';
import { nameForToken, BOT_NAME } from './names.js';

const DEFAULTS = {
    QUICK_WAIT_MS: 15_000,  // quick match: wait this long, then fill with bots
};
const IDLE_WAITING_MS = 20 * 60_000;     // empty room is deleted
const IDLE_PLAYING_MS = 2 * 60 * 60_000; // abandoned game is deleted
const MAX_MESSAGE = 512;
const MAX_MSGS_PER_SEC = 10;
const EMOTE_GAP_MS = 1_500;

export const EMOTES = ['nice', 'wow', 'laugh', 'fire', 'thanks', 'hurry', 'gg', 'again'];

const OPEN = 1;

export class GameRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.room = null;
        this.rate = new Map();      // ws → { second, count } (fine to lose on eviction)
        this.lastEmote = new Map(); // seat → time
        const num = (k) => { const v = Number(env && env[k]); return Number.isFinite(v) && v > 0 ? v : null; };
        this.cfg = {
            QUICK_WAIT_MS: num('QUICK_WAIT_MS') || DEFAULTS.QUICK_WAIT_MS,
            // Tests shorten these; normally each game sets its own.
            TURN_MS: num('TURN_MS'),
            BOT_DELAY_MS: num('BOT_DELAY_MS'),
        };
        ctx.blockConcurrencyWhile(async () => {
            this.room = (await ctx.storage.get('room')) || null;
        });
    }

    get adapter() {
        return GAMES[this.room.game];
    }

    // ------------------------------------------------------------------ HTTP

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/init' && request.method === 'POST') {
            return this.init(await request.json());
        }
        if (url.pathname.endsWith('/ws')) return this.connect(request, url);
        return new Response('Not found', { status: 404 });
    }

    async init({ code, kind, game, rules, options }) {
        if (this.room) return new Response('Room code in use', { status: 409 });
        const adapter = GAMES[game] || GAMES.igisoro;
        const opts = adapter.normalizeOptions(options);
        const now = Date.now();
        this.room = {
            code,
            game: GAMES[game] ? game : 'igisoro',
            kind: kind === 'quick' ? 'quick' : 'private',
            rules: adapter.normalizeRules(rules),
            options: opts,
            seatOrder: adapter.seatOrder(opts),
            status: 'waiting',          // waiting | playing | over
            seats: new Array(adapter.maxSeats).fill(null), // { token, name, bot, away, timeouts }
            state: null,
            move: null,                 // last action, so clients can animate it
            result: null,               // { winner, reason }
            rematch: [],
            firstPlayer: null,
            deadline: null,             // next timed event (turn / bot / quick wait)
            expiresAt: now + IDLE_WAITING_MS,
        };
        await this.save();
        return Response.json({ code });
    }

    async connect(request, url) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        const reply = () => new Response(null, { status: 101, webSocket: client });
        const fail = (code) => {
            server.send(JSON.stringify({ t: 'error', code }));
            server.close(4000, code);
            return reply();
        };

        const token = url.searchParams.get('token') || '';
        if (!/^[a-f0-9]{32}$/.test(token)) return fail('bad_token');
        const r = this.room;
        if (!r) return fail('not_found');

        let seat = r.seats.findIndex((s) => s && s.token === token);
        let reclaimed = false;
        if (seat === -1) {
            if (r.status === 'waiting') {
                // Someone who left before the game started gives up their seat.
                for (const i of r.seatOrder) if (r.seats[i] && !r.seats[i].bot && !this.isOnline(i)) r.seats[i] = null;
                seat = r.seatOrder.find((i) => !r.seats[i]);
                if (seat === undefined) seat = -1;
            }
            if (seat === -1) return fail('full');
            r.seats[seat] = { token, name: nameForToken(token), bot: false, away: false, timeouts: 0 };
        } else if (r.seats[seat].away) {
            // Came back after a bot took over: take the seat back.
            r.seats[seat].bot = false;
            r.seats[seat].away = false;
            r.seats[seat].timeouts = 0;
            reclaimed = true;
        }

        // Same player on a second tab / after reconnect: keep only the new socket.
        for (const ws of this.ctx.getWebSockets()) {
            if (ws === server) continue;
            const a = ws.deserializeAttachment();
            if (a && a.seat === seat) {
                ws.serializeAttachment({ seat: -1 });
                try { ws.close(4001, 'replaced'); } catch (e) { /* already closed */ }
            }
        }
        server.serializeAttachment({ seat });

        if (r.status === 'waiting') {
            if (r.seatOrder.every((i) => r.seats[i])) this.startGame();
            else if (r.kind === 'quick' && !r.deadline) r.deadline = Date.now() + this.cfg.QUICK_WAIT_MS;
        } else if (reclaimed && r.status === 'playing' && this.adapter.turn(r.state) === seat) {
            this.armTurn(); // the bot's short timer no longer applies
        }
        this.touch();
        await this.save();
        this.broadcast();
        return reply();
    }

    // ------------------------------------------------------------- WebSocket

    async webSocketMessage(ws, data) {
        if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
        if (!this.allow(ws)) return;
        let msg;
        try { msg = JSON.parse(data); } catch (e) { return; }
        const a = ws.deserializeAttachment();
        const r = this.room;
        if (!a || a.seat < 0 || !r || !msg || typeof msg !== 'object') return;
        const seat = a.seat;
        const A = this.adapter;

        switch (msg.t) {
            case 'ping':
                ws.send(JSON.stringify({ t: 'pong', now: Date.now() }));
                return;

            case 'move': {
                if (r.status !== 'playing' || A.turn(r.state) !== seat) return this.error(ws, 'not_your_turn');
                // An action made against an older position (double tap, lag) is dropped.
                if (msg.n !== A.counter(r.state)) return this.sendState(ws, seat);
                const move = A.parseMove(msg);
                if (move === null || !A.isLegal(r.state, move)) return this.error(ws, 'illegal');
                r.seats[seat].timeouts = 0;
                this.play(seat, move, false);
                break;
            }

            case 'start': {
                // The room owner (first seat) starts early; bots fill empty seats.
                if (r.status !== 'waiting' || seat !== r.seatOrder[0]) return;
                this.fillWithBots();
                this.startGame();
                break;
            }

            case 'emote': {
                if (!EMOTES.includes(msg.id)) return;
                const now = Date.now();
                if (now - (this.lastEmote.get(seat) || 0) < EMOTE_GAP_MS) return;
                this.lastEmote.set(seat, now);
                this.sendAll({ t: 'emote', seat, id: msg.id });
                return;
            }

            case 'rematch': {
                if (r.status !== 'over') return;
                r.rematch[seat] = true;
                const ready = r.seatOrder.every((i) => {
                    const s = r.seats[i];
                    return s && (s.bot || r.rematch[i]);
                });
                if (ready) {
                    r.firstPlayer = A.nextFirst(r.firstPlayer, r.seatOrder);
                    this.startGame();
                }
                break;
            }

            case 'resign':
                if (r.status !== 'playing') return;
                this.dropPlayer(seat, 'resign', true);
                break;

            case 'leave':
                if (r.status === 'playing') this.dropPlayer(seat, 'resign', true);
                else if (r.status === 'waiting') r.seats[seat] = null;
                else if (r.seats[seat]) r.seats[seat].token = null; // gone for good
                ws.serializeAttachment({ seat: -1 });
                try { ws.close(1000, 'left'); } catch (e) { /* ignore */ }
                break;

            default:
                return;
        }
        this.touch();
        await this.save();
        this.broadcast();
    }

    async webSocketClose(ws, code) {
        try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch (e) { /* already closed */ }
        this.rate.delete(ws);
        if (this.room) this.broadcast(ws);
    }

    async webSocketError(ws) {
        this.rate.delete(ws);
        if (this.room) this.broadcast(ws);
    }

    // ----------------------------------------------------------------- Timers

    async alarm() {
        const r = this.room;
        if (!r) return;
        const now = Date.now();

        if (r.deadline && now >= r.deadline - 20) {
            r.deadline = null;
            if (r.status === 'waiting' && r.kind === 'quick') {
                // Not enough people came: bots (clearly labelled) fill the seats.
                if (r.seatOrder.some((i) => r.seats[i] && !r.seats[i].bot && this.isOnline(i))) {
                    this.fillWithBots();
                    this.startGame();
                }
            } else if (r.status === 'playing') {
                const A = this.adapter;
                const seat = A.turn(r.state);
                const s = r.seats[seat];
                if (s.bot) {
                    this.play(seat, A.botMove(r.state, 'medium', secureRandom), false);
                } else if (++s.timeouts >= A.maxTimeouts) {
                    this.dropPlayer(seat, 'timeout', false);
                } else {
                    // Missed turn: an automatic (weak) move keeps the game going.
                    this.play(seat, A.botMove(r.state, 'easy', secureRandom), true);
                }
            }
        }

        if (now >= r.expiresAt) {
            if (this.openSockets().length === 0) {
                this.room = null;
                await this.ctx.storage.deleteAll();
                return;
            }
            this.touch();
        }
        await this.save();
        this.broadcast();
    }

    // ------------------------------------------------------------ Game logic

    fillWithBots() {
        const r = this.room;
        for (const i of r.seatOrder) {
            if (!r.seats[i]) r.seats[i] = { token: null, name: BOT_NAME, bot: true, away: false, timeouts: 0 };
        }
    }

    startGame() {
        const r = this.room;
        const A = this.adapter;
        if (r.firstPlayer === null || !r.seatOrder.includes(r.firstPlayer)) r.firstPlayer = r.seatOrder[0];
        r.state = A.create({ rules: r.rules, firstPlayer: r.firstPlayer, seats: r.seatOrder });
        r.status = 'playing';
        r.result = null;
        r.move = null;
        r.rematch = [];
        r.deadline = null;
        for (const s of r.seats) if (s) s.timeouts = 0;
        this.armTurn();
    }

    play(seat, move, auto) {
        const r = this.room;
        const A = this.adapter;
        const { state, events } = A.apply(r.state, move, secureRandom);
        r.state = state;
        r.move = { player: seat, move, events, auto, n: A.counter(state) };
        const w = A.winner(state);
        if (w !== null) this.finish(w, A.reason(state));
        else this.armTurn();
    }

    // A player resigned, left, or kept missing turns. In a 2-player game the
    // other player wins; with more players a bot takes over the seat.
    dropPlayer(seat, reason, gone) {
        const r = this.room;
        const s = r.seats[seat];
        if (r.seatOrder.length === 2) {
            const other = r.seatOrder.find((i) => i !== seat);
            this.finish(other, reason);
        } else {
            s.bot = true;
            s.away = !gone;          // away: can come back and take the seat again
            if (gone) s.token = null;
            s.timeouts = 0;
            const humans = r.seatOrder.filter((i) => r.seats[i] && !r.seats[i].bot);
            if (humans.length === 0) this.finish(DRAW, 'abandoned');
            else this.armTurn();
        }
    }

    finish(winner, reason) {
        const r = this.room;
        r.status = 'over';
        r.result = { winner, reason };
        r.state.winner = winner;
        r.deadline = null;
        r.rematch = [];
    }

    armTurn() {
        const r = this.room;
        if (r.status !== 'playing') return;
        const A = this.adapter;
        const s = r.seats[A.turn(r.state)];
        const botDelay = this.cfg.BOT_DELAY_MS || A.botDelayMs;
        const turnMs = this.cfg.TURN_MS || A.turnMs;
        r.deadline = Date.now() + (s && s.bot ? botDelay : turnMs);
    }

    // ---------------------------------------------------------------- Helpers

    touch() {
        const r = this.room;
        r.expiresAt = Date.now() + (r.status === 'waiting' ? IDLE_WAITING_MS : IDLE_PLAYING_MS);
    }

    async save() {
        const r = this.room;
        await this.ctx.storage.put('room', r);
        const next = Math.min(r.deadline || Infinity, r.expiresAt);
        await this.ctx.storage.setAlarm(next);
    }

    allow(ws) {
        const sec = Math.floor(Date.now() / 1000);
        let e = this.rate.get(ws);
        if (!e || e.second !== sec) { e = { second: sec, count: 0 }; this.rate.set(ws, e); }
        return ++e.count <= MAX_MSGS_PER_SEC;
    }

    openSockets(except) {
        return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === OPEN);
    }

    isOnline(seat, except) {
        return this.openSockets(except).some((ws) => {
            const a = ws.deserializeAttachment();
            return a && a.seat === seat;
        });
    }

    view(seat, except) {
        const r = this.room;
        const A = this.adapter;
        const turnSeat = r.status === 'playing' ? A.turn(r.state) : null;
        return {
            t: 'state',
            type: r.game,
            code: r.kind === 'private' ? r.code : null,
            kind: r.kind,
            status: r.status,
            rules: r.rules,
            options: r.options,
            seatOrder: r.seatOrder,
            you: seat,
            seats: r.seats.map((s, i) => (s ? {
                name: s.name,
                bot: !!s.bot,
                away: !!s.away,
                online: !!s.bot || this.isOnline(i, except),
            } : null)),
            state: r.state,
            // The Igisoro client (first online game) reads the board as `game`.
            game: r.game === 'igisoro' ? r.state : r.game,
            move: r.move,
            result: r.result,
            rematch: r.seats.map((_, i) => !!r.rematch[i]),
            // Sent as "ms left" so the phone's clock doesn't matter.
            turnMsLeft: turnSeat !== null && r.deadline && !r.seats[turnSeat].bot
                ? Math.max(0, r.deadline - Date.now()) : null,
            waitMsLeft: r.status === 'waiting' && r.kind === 'quick' && r.deadline
                ? Math.max(0, r.deadline - Date.now()) : null,
        };
    }

    sendState(ws, seat) {
        try { ws.send(JSON.stringify(this.view(seat))); } catch (e) { /* closed */ }
    }

    error(ws, code) {
        try { ws.send(JSON.stringify({ t: 'error', code })); } catch (e) { /* closed */ }
    }

    broadcast(except) {
        for (const ws of this.openSockets(except)) {
            const a = ws.deserializeAttachment();
            if (a && a.seat >= 0) this.sendState(ws, a.seat);
        }
    }

    sendAll(msg) {
        const text = JSON.stringify(msg);
        for (const ws of this.openSockets()) {
            try { ws.send(text); } catch (e) { /* closed */ }
        }
    }
}
