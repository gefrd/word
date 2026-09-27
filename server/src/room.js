// One Durable Object per game room. It holds the players' WebSockets and is
// the only place where moves are applied: phones send "I tapped pit N", the
// room checks it with the same engine the offline game uses and tells both
// players the result. A modified client can't fake a move or a win.
//
// Uses the WebSocket Hibernation API, so an idle room costs nothing: the
// object is evicted from memory between messages and restored from storage.

import { DurableObject } from 'cloudflare:workers';
import {
    createGame, applyMove, isLegalMove, chooseBotMove, normalizeRules, DRAW,
} from '../../games/igisoro/engine.js';
import { nameForToken, BOT_NAME } from './names.js';

// Defaults; tests shorten them through env vars.
const DEFAULTS = {
    TURN_MS: 45_000,        // time to make a move before an automatic move
    QUICK_WAIT_MS: 15_000,  // quick match: wait this long, then play a bot
    BOT_DELAY_MS: 1_200,    // bot "thinking" time, so its move is visible
};
const MAX_TIMEOUTS = 2;                  // missed turns in a row → you lose
const IDLE_WAITING_MS = 20 * 60_000;     // empty private room is deleted
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
        this.lastEmote = [0, 0];
        this.cfg = {};
        for (const k of Object.keys(DEFAULTS)) {
            const v = Number(env && env[k]);
            this.cfg[k] = Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
        }
        ctx.blockConcurrencyWhile(async () => {
            this.room = (await ctx.storage.get('room')) || null;
        });
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

    async init({ code, kind, rules }) {
        if (this.room) return new Response('Room code in use', { status: 409 });
        const now = Date.now();
        this.room = {
            code,
            kind: kind === 'quick' ? 'quick' : 'private',
            rules: normalizeRules(rules),
            status: 'waiting',          // waiting | playing | over
            seats: [null, null],        // { token, name, bot, timeouts }
            game: null,
            move: null,                 // last move, so clients can animate it
            result: null,               // { winner, reason }
            rematch: [false, false],
            firstPlayer: 0,
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

        let seat = r.seats.findIndex((s) => s && !s.bot && s.token === token);
        if (seat === -1) {
            if (r.status === 'waiting') {
                // Someone who left before the game started gives up their seat.
                for (let i = 0; i < 2; i++) if (r.seats[i] && !this.isOnline(i)) r.seats[i] = null;
                seat = r.seats.findIndex((s) => !s);
            }
            if (seat === -1) return fail('full');
            r.seats[seat] = { token, name: nameForToken(token), bot: false, timeouts: 0 };
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
            if (r.seats[0] && r.seats[1]) this.startGame();
            else if (r.kind === 'quick') r.deadline = Date.now() + this.cfg.QUICK_WAIT_MS;
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

        switch (msg.t) {
            case 'ping':
                ws.send(JSON.stringify({ t: 'pong', now: Date.now() }));
                return;

            case 'move': {
                if (r.status !== 'playing' || r.game.turn !== seat) return this.error(ws, 'not_your_turn');
                // A move made against an older position (double tap, lag) is dropped.
                if (msg.n !== r.game.moveCount) return this.sendState(ws, seat);
                if (!isLegalMove(r.game, msg.pit)) return this.error(ws, 'illegal');
                r.seats[seat].timeouts = 0;
                this.play(seat, msg.pit, false);
                break;
            }

            case 'emote': {
                if (!EMOTES.includes(msg.id)) return;
                const now = Date.now();
                if (now - this.lastEmote[seat] < EMOTE_GAP_MS) return;
                this.lastEmote[seat] = now;
                this.sendAll({ t: 'emote', seat, id: msg.id });
                return;
            }

            case 'rematch': {
                if (r.status !== 'over') return;
                r.rematch[seat] = true;
                const other = r.seats[1 - seat];
                if (!other || other.bot) r.rematch[1 - seat] = true;
                if (r.rematch[0] && r.rematch[1] && r.seats[0] && r.seats[1]) {
                    r.firstPlayer = 1 - r.firstPlayer;
                    this.startGame();
                }
                break;
            }

            case 'resign':
                if (r.status !== 'playing') return;
                this.finish(1 - seat, 'resign');
                break;

            case 'leave':
                if (r.status === 'playing') this.finish(1 - seat, 'resign');
                else if (r.status === 'waiting') r.seats[seat] = null;
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
                // Nobody came: play against a bot (clearly labelled as one).
                const human = r.seats.findIndex((s) => s);
                if (human !== -1 && this.isOnline(human)) {
                    r.seats[1 - human] = { bot: true, name: BOT_NAME, timeouts: 0 };
                    this.startGame();
                }
            } else if (r.status === 'playing') {
                const seat = r.game.turn;
                const s = r.seats[seat];
                if (s.bot) {
                    this.play(seat, chooseBotMove(r.game, 'medium'), false);
                } else if (++s.timeouts >= MAX_TIMEOUTS) {
                    this.finish(1 - seat, 'timeout');
                } else {
                    // Missed turn: an automatic (weak) move keeps the game going.
                    this.play(seat, chooseBotMove(r.game, 'easy'), true);
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

    startGame() {
        const r = this.room;
        r.game = createGame({ rules: r.rules, firstPlayer: r.firstPlayer });
        r.status = 'playing';
        r.result = null;
        r.move = null;
        r.rematch = [false, false];
        for (const s of r.seats) if (s) s.timeouts = 0;
        this.armTurn();
    }

    play(seat, pit, auto) {
        const r = this.room;
        const { state, events } = applyMove(r.game, pit);
        r.game = state;
        r.move = { player: seat, pit, events, auto, n: state.moveCount };
        if (state.winner !== null) {
            this.finish(state.winner, state.winner === DRAW ? 'draw' : 'no_moves');
        } else {
            this.armTurn();
        }
    }

    finish(winner, reason) {
        const r = this.room;
        r.status = 'over';
        r.result = { winner, reason };
        r.game.winner = winner;
        r.deadline = null;
        r.rematch = [false, false];
    }

    armTurn() {
        const r = this.room;
        const s = r.seats[r.game.turn];
        r.deadline = Date.now() + (s && s.bot ? this.cfg.BOT_DELAY_MS : this.cfg.TURN_MS);
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
        return {
            t: 'state',
            code: r.kind === 'private' ? r.code : null,
            kind: r.kind,
            status: r.status,
            rules: r.rules,
            you: seat,
            seats: r.seats.map((s, i) => (s ? { name: s.name, bot: !!s.bot, online: !!s.bot || this.isOnline(i, except) } : null)),
            game: r.game,
            move: r.move,
            result: r.result,
            rematch: r.rematch,
            // Sent as "ms left" so the phone's clock doesn't matter.
            turnMsLeft: r.status === 'playing' && r.deadline && !r.seats[r.game.turn].bot
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
