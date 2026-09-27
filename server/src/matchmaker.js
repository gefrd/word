// A single Durable Object that groups "quick match" players, per game.
// The first player gets a fresh room and waits in it; the next players within
// a few seconds are sent to the same room until it is full. If not enough
// people come, the room fills the empty seats with bots (see GameRoom.alarm).

import { DurableObject } from 'cloudflare:workers';
import { randomId } from './util.js';
import { GAMES } from './games.js';

const DEFAULT_QUICK_WAIT_MS = 15_000;

export class Matchmaker extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.waiting = new Map(); // game → { room, expires, left }; losing it on eviction is harmless
        const v = Number(env && env.QUICK_WAIT_MS);
        this.quickWait = Number.isFinite(v) && v > 0 ? v : DEFAULT_QUICK_WAIT_MS;
    }

    async fetch(request) {
        let game = 'igisoro';
        try { const b = await request.json(); if (b && GAMES[b.game]) game = b.game; } catch (e) { /* default */ }
        const now = Date.now();
        const w = this.waiting.get(game);
        if (w && w.expires > now && w.left > 0) {
            if (--w.left === 0) this.waiting.delete(game);
            return Response.json({ room: w.room, matched: true });
        }
        const room = 'q' + randomId(10);
        const adapter = GAMES[game];
        const options = adapter.normalizeOptions({});
        // Stop offering the room a bit before it switches to bots.
        const entry = { room, expires: now + this.quickWait * 0.8, left: adapter.seatOrder(options).length - 1 };
        this.waiting.set(game, entry);
        const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName('room:' + room));
        const res = await stub.fetch('https://room/init', {
            method: 'POST',
            body: JSON.stringify({ code: room, kind: 'quick', game, options }),
        });
        if (!res.ok) {
            if (this.waiting.get(game) === entry) this.waiting.delete(game);
            return new Response('Busy', { status: 503 });
        }
        return Response.json({ room, matched: false });
    }
}
