// A single Durable Object that pairs up "quick match" players.
// The first player gets a fresh room and waits in it; the next player within
// a few seconds is sent to the same room. If nobody comes, the room itself
// starts a game against a bot (see GameRoom.alarm).

import { DurableObject } from 'cloudflare:workers';
import { randomId } from './util.js';

const DEFAULT_QUICK_WAIT_MS = 15_000;

export class Matchmaker extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.waiting = null; // { room, expires } — losing it on eviction is harmless
        const v = Number(env && env.QUICK_WAIT_MS);
        this.quickWait = Number.isFinite(v) && v > 0 ? v : DEFAULT_QUICK_WAIT_MS;
    }

    async fetch() {
        const now = Date.now();
        if (this.waiting && this.waiting.expires > now) {
            const { room } = this.waiting;
            this.waiting = null;
            return Response.json({ room, matched: true });
        }
        const room = 'q' + randomId(10);
        // Stop offering the room a bit before it switches to a bot.
        this.waiting = { room, expires: now + this.quickWait * 0.8 };
        const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName('room:' + room));
        const res = await stub.fetch('https://room/init', {
            method: 'POST',
            body: JSON.stringify({ code: room, kind: 'quick' }),
        });
        if (!res.ok) {
            if (this.waiting && this.waiting.room === room) this.waiting = null;
            return new Response('Busy', { status: 503 });
        }
        return Response.json({ room, matched: false });
    }
}
