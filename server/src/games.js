// Games the server can host. Each adapter wraps a pure engine from games/
// (the same file the offline game uses) behind one small interface, so the
// room code in room.js is the same for every game.
//
// Adapter fields (see the two below for examples):
//   turnMs, botDelayMs, maxTimeouts, maxSeats
//   seatOrder(options)            seats in join order, e.g. [0, 2] for 2 of 4
//   normalizeRules(rules), normalizeOptions(options)
//   create({ rules, firstPlayer, seats }) → state
//   parseMove(msg) → move | null  (msg is what the phone sent; never trust it)
//   isLegal(state, move), apply(state, move, rng) → { state, events }
//   turn(state) → seat, counter(state) → number of actions so far
//   winner(state) → null | seat | -1 (draw), reason(state) → string
//   botMove(state, level, rng), nextFirst(prevFirst, seats)
// Optional, for hidden information (cards, ships, secret words):
//   viewFor(state, seat) → the state as that seat may see it
//   viewMove(move, seat, state) → the last move as that seat may see it

import * as igisoro from '../../games/igisoro/engine.js';
import * as ludo from '../../games/ludo/engine.js';
import * as draughts from '../../games/draughts/engine.js';
import * as durak from '../../games/durak/engine.js';
import * as connect4 from '../../games/connect4/engine.js';
import * as uno from '../../games/uno/engine.js';
import * as battleship from '../../games/battleship/engine.js';

const DRAW = -1;

export const GAMES = {
    igisoro: {
        turnMs: 45_000,
        botDelayMs: 1_200,
        maxTimeouts: 2,
        maxSeats: 2,
        seatOrder: () => [0, 1],
        normalizeRules: igisoro.normalizeRules,
        normalizeOptions: () => ({ players: 2 }),
        create: ({ rules, firstPlayer }) => igisoro.createGame({ rules, firstPlayer }),
        // Igisoro clients send { pit }; accept { move: pit } too.
        parseMove: (msg) => (Number.isInteger(msg.pit) ? msg.pit : Number.isInteger(msg.move) ? msg.move : null),
        isLegal: (state, move) => igisoro.isLegalMove(state, move),
        apply: (state, move) => igisoro.applyMove(state, move),
        turn: (state) => state.turn,
        counter: (state) => state.moveCount,
        winner: (state) => state.winner,
        reason: (state) => (state.winner === igisoro.DRAW ? 'draw' : 'no_moves'),
        botMove: (state, level, rng) => igisoro.chooseBotMove(state, level, rng),
        nextFirst: (prev) => 1 - prev,
    },

    ludo: {
        turnMs: 20_000,
        botDelayMs: 700,
        maxTimeouts: 4, // two whole turns (roll + move each)
        maxSeats: 4,
        seatOrder: (options) => ludo.seatsFor(options.players),
        normalizeRules: ludo.normalizeRules,
        normalizeOptions: (o = {}) => ({ players: [2, 3, 4].includes(o.players) ? o.players : 4 }),
        create: ({ rules, firstPlayer, seats }) => ludo.createGame({ rules, players: seats, firstPlayer }),
        parseMove: (msg) => {
            const m = msg.move;
            if (!m || typeof m !== 'object') return null;
            if (m.type === 'roll') return { type: 'roll' };
            if (m.type === 'move' && Number.isInteger(m.token)) return { type: 'move', token: m.token };
            return null;
        },
        isLegal: (state, move) => ludo.isLegalAction(state, move),
        apply: (state, move, rng) => ludo.applyAction(state, move, rng),
        turn: (state) => state.turn,
        counter: (state) => state.actions,
        winner: (state) => state.winner,
        reason: () => 'finished',
        botMove: (state, level, rng) => ludo.chooseBotAction(state, level, rng),
        nextFirst: (prev, seats) => seats[(seats.indexOf(prev) + 1) % seats.length],
    },

    draughts: {
        turnMs: 60_000,
    },

    connect4: {
        turnMs: 30_000,
    battleship: {
        turnMs: 45_000,         // also the time to place your fleet
        botDelayMs: 900,
        maxTimeouts: 2,
        maxSeats: 2,
        seatOrder: () => [0, 1],
        normalizeRules: draughts.normalizeRules,
        normalizeOptions: () => ({ players: 2 }),
        // firstPlayer gets White; rematches swap colours.
        create: ({ rules, firstPlayer }) => draughts.createGame({ rules, firstPlayer }),
        // Phones send { move: { path: [from, ..., to] } }; the engine finds the captures.
        parseMove: (msg) => draughts.parseMove(msg.move),
        isLegal: (state, move) => draughts.isLegalMove(state, move),
        apply: (state, move) => draughts.applyMove(state, move),
        turn: (state) => state.turn,
        counter: (state) => state.moveCount,
        winner: (state) => state.winner,
        reason: (state) => state.reason || 'no_moves',
        botMove: (state, level, rng) => draughts.chooseBotMove(state, level, rng),
        nextFirst: (prev) => 1 - prev,
    },

    durak: {
        turnMs: 30_000,
        botDelayMs: 900,
        maxTimeouts: 3,
        maxSeats: 4,
        seatOrder: (options) => durak.seatsFor(options.players),
        normalizeRules: durak.normalizeRules,
        normalizeOptions: (o = {}) => ({ players: [2, 3, 4].includes(o.players) ? o.players : 2 }),
        // The server shuffles; the deck stays on the server (see viewFor).
        create: ({ rules, firstPlayer, seats }) => durak.createGame({ rules, players: seats, firstPlayer, rng: secureRandom }),
        parseMove: (msg) => {
            const m = msg.move;
            if (!m || typeof m !== 'object') return null;
            const card = durak.isCard;
            if (m.type === 'pass' || m.type === 'take') return { type: m.type };
            if (m.type === 'defend' && card(m.card) && Number.isInteger(m.target)) return { type: 'defend', card: m.card, target: m.target };
            if (m.type === 'transfer' && card(m.card)) return { type: 'transfer', card: m.card };
            if (m.type === 'attack' && Array.isArray(m.cards) && m.cards.length <= 6 && m.cards.every(card)) return { type: 'attack', cards: m.cards.slice() };
            return null;
        },
        isLegal: (state, move) => durak.isLegalAction(state, move),
        apply: (state, move, rng) => durak.applyAction(state, move, rng),
        turn: (state) => state.turn,
        counter: (state) => state.actions,
        winner: (state) => state.winner,
        reason: (state) => (state.loser === null ? 'draw' : 'finished'),
        botMove: (state, level, rng) => durak.chooseBotAction(durak.viewFor(state, state.turn), level, rng),
        nextFirst: (prev, seats) => seats[(seats.indexOf(prev) + 1) % seats.length],
        viewFor: (state, seat) => durak.viewFor(state, seat),
        viewMove: (move, seat) => ({ ...move, events: durak.viewEvents(move.events, seat) }),
    },
        normalizeRules: connect4.normalizeRules,
        normalizeOptions: () => ({ players: 2 }),
        create: ({ rules, firstPlayer }) => connect4.createGame({ rules, firstPlayer }),
        // Clients send { move: col }; accept { col } too.
        parseMove: (msg) => (Number.isInteger(msg.move) ? msg.move : Number.isInteger(msg.col) ? msg.col : null),
        isLegal: (state, move) => connect4.isLegalMove(state, move),
        apply: (state, move) => connect4.applyMove(state, move),
        turn: (state) => state.turn,
        counter: (state) => state.moveCount,
        winner: (state) => state.winner,
        reason: (state) => (state.winner === connect4.DRAW ? 'draw' : 'four'),
        botMove: (state, level, rng) => connect4.chooseBotMove(state, level, rng),
        nextFirst: (prev) => 1 - prev,
    },

    uno: {
        turnMs: 25_000,
        botDelayMs: 900,
        maxTimeouts: 3,
        maxSeats: 4,
        seatOrder: (options) => uno.seatsFor(options.players),
        normalizeRules: uno.normalizeRules,
        normalizeOptions: (o = {}) => ({ players: [2, 3, 4].includes(o.players) ? o.players : 4 }),
        // The server shuffles the deck.
        create: ({ rules, firstPlayer, seats }) => uno.createGame({ rules, players: seats, firstPlayer, rng: secureRandom }),
        parseMove: (msg) => {
            const m = msg.move;
            if (!m || typeof m !== 'object') return null;
            if (m.type === 'draw' || m.type === 'pass') return { type: m.type };
            if (m.type !== 'play' || !Number.isInteger(m.card)) return null;
            const move = { type: 'play', card: m.card };
            if (uno.COLORS.includes(m.color)) move.color = m.color;
            if (m.uno === true) move.uno = true;
            return move;
        },
        isLegal: (state, move) => uno.isLegalMove(state, move),
        apply: (state, move, rng) => uno.applyMove(state, move, rng),
        turn: (state) => state.turn,
        counter: (state) => state.actions,
        winner: (state) => state.winner,
        reason: () => 'finished',
        botMove: (state, level, rng) => uno.chooseBotMove(state, level, rng),
        nextFirst: (prev, seats) => seats[(seats.indexOf(prev) + 1) % seats.length],
        // Cards are secret: each phone gets only its own hand.
        viewFor: (state, seat) => uno.viewFor(state, seat),
        viewMove: (move, seat) => ({ ...move, events: uno.viewEvents(move.events, seat) }),
        normalizeRules: battleship.normalizeRules,
        normalizeOptions: () => ({ players: 2 }),
        create: ({ rules, firstPlayer }) => battleship.createGame({ rules, firstPlayer }),
        parseMove: (msg) => {
            const m = msg.move;
            if (!m || typeof m !== 'object') return null;
            if (m.type === 'fire' && Number.isInteger(m.cell)) return { type: 'fire', cell: m.cell };
            if (m.type === 'place' && Array.isArray(m.ships) && m.ships.length <= 10) {
                const ships = m.ships.map((s) => (s && typeof s === 'object' ? { x: s.x, y: s.y, h: s.h } : null));
                return { type: 'place', ships };
            }
            return null;
        },
        isLegal: (state, move) => battleship.isLegalMove(state, move),
        apply: (state, move) => battleship.applyMove(state, move),
        turn: (state) => state.turn,
        counter: (state) => state.moveCount,
        winner: (state) => state.winner,
        reason: () => 'fleet_sunk',
        botMove: (state, level, rng) => battleship.chooseBotMove(state, level, rng),
        nextFirst: (prev) => 1 - prev,
        // Ships are secret: each phone gets its own fleet and only the sunk
        // enemy ships, and never sees the other player's placement move.
        viewFor: (state, seat) => battleship.viewFor(state, seat),
        viewMove: (move, seat) => battleship.viewMove(move, seat),
    },
};

export { DRAW };

export function secureRandom() {
    return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}
