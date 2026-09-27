// Kivu online games server (Cloudflare Worker + Durable Objects).
//
//   POST /rooms  { game, rules, players } → { room }   private room (4-digit code)
//   POST /quick  { game }                 → { room }   quick match (bots after 15 s)
//                game: "igisoro" (default) or "ludo"
//   GET  /rooms/:room/ws?token=…        WebSocket into a room
//   GET  /health
//
// Everything that matters happens inside GameRoom (src/room.js).

import { randomCode } from './util.js';
import { GAMES } from './games.js';

export { GameRoom } from './room.js';
export { Matchmaker } from './matchmaker.js';

const ROOM_RE = /^(\d{4}|q[a-z0-9]{10})$/;

function allowedOrigin(request, env) {
    const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return '*';
    const origin = request.headers.get('Origin');
    if (!origin) return list[0]; // native apps / curl send no Origin
    return list.includes(origin) ? origin : null;
}

function withCors(response, origin) {
    const res = new Response(response.body, response);
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    res.headers.set('Vary', 'Origin');
    return res;
}

function roomStub(env, room) {
    return env.ROOMS.get(env.ROOMS.idFromName('room:' + room));
}

async function createPrivateRoom(request, env) {
    let rules = {};
    let game = 'igisoro';
    let options = {};
    try {
        const body = await request.json();
        if (body && typeof body.rules === 'object' && body.rules) rules = body.rules;
        if (body && GAMES[body.game]) game = body.game;
        if (body && Number.isInteger(body.players)) options = { players: body.players };
    } catch (e) { /* no body: defaults */ }
    for (let attempt = 0; attempt < 12; attempt++) {
        const code = randomCode();
        const res = await roomStub(env, code).fetch('https://room/init', {
            method: 'POST',
            body: JSON.stringify({ code, kind: 'private', game, rules, options }),
        });
        if (res.ok) return Response.json({ room: code });
    }
    return new Response('No free room codes, try again', { status: 503 });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = allowedOrigin(request, env);
        if (origin === null) return new Response('Forbidden', { status: 403 });

        const wsMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/ws$/);
        if (wsMatch) {
            if (!ROOM_RE.test(wsMatch[1])) return new Response('Bad room', { status: 400 });
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket', { status: 426 });
            }
            return roomStub(env, wsMatch[1]).fetch(request);
        }

        if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);

        let res;
        if (url.pathname === '/rooms' && request.method === 'POST') {
            res = await createPrivateRoom(request, env);
        } else if (url.pathname === '/quick' && request.method === 'POST') {
            const mm = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
            res = await mm.fetch('https://matchmaker/quick', { method: 'POST', body: await request.text() });
        } else if (url.pathname === '/health') {
            res = Response.json({ ok: true });
        } else {
            res = new Response('Not found', { status: 404 });
        }
        return withCors(res, origin);
    },
};
