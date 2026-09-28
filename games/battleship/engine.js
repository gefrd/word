// games/battleship/engine.js
// Battleship for 2 players on a 10 × 10 grid. Pure game logic, no DOM — the
// same file runs in the browser (offline play, bot) and on the server
// (online rooms). Ships are secret: the server sends each phone only what
// that player may see (viewFor / viewMove), and the bot plays from the same
// public information a person has, so it never peeks.
//
// Cells are numbered c = y * 10 + x (x = column A..J, y = row 1..10).
// A ship is { x, y, h, size }: its bow at (x, y), going right when h is
// true, down when h is false. Ships may not touch, not even at a corner.
//
// Game flow
// ---------
// phase 'place'  each player sends { type: 'place', ships: [{ x, y, h }] }
//                (ships in fleet order, sizes come from the rules). The
//                first player places first, then the second.
// phase 'battle' the player to move sends { type: 'fire', cell }.
// phase 'over'   all ships of one side are sunk.
//
// Shots are stored per board (the board that was shot AT):
//   0 unknown, 1 miss, 2 hit, 3 water next to a sunk ship (marked
//   automatically, as the other side can't have a ship there).
//
// Rules that differ between places are options in `state.rules`:
//   fleet   'classic'  5 ships: 5, 4, 3, 3, 2
//           'russian'  10 ships: 4, 3, 3, 2, 2, 2, 1, 1, 1, 1
//   again   false      the turn passes after every shot
//           true       a hit (or sinking a ship) earns another shot

export const SIZE = 10;
export const CELLS = SIZE * SIZE;
export const UNKNOWN = 0;
export const MISS = 1;
export const HIT = 2;
export const CLEAR = 3;

export const FLEETS = {
    classic: [5, 4, 3, 3, 2],
    russian: [4, 3, 3, 2, 2, 2, 1, 1, 1, 1],
};

export const DEFAULT_RULES = { fleet: 'classic', again: false };

export const RULE_OPTIONS = {
    fleet: ['classic', 'russian'],
    again: [false, true],
};

export function normalizeRules(rules = {}) {
    const out = { ...DEFAULT_RULES };
    if (!rules || typeof rules !== 'object') return out;
    for (const key of Object.keys(RULE_OPTIONS)) {
        if (RULE_OPTIONS[key].includes(rules[key])) out[key] = rules[key];
    }
    return out;
}

export const cellOf = (x, y) => y * SIZE + x;
export const colName = (x) => 'ABCDEFGHIJ'[x];
export const cellName = (c) => colName(c % SIZE) + (Math.floor(c / SIZE) + 1);

export function shipCells(ship) {
    const out = [];
    for (let i = 0; i < ship.size; i++) {
        out.push(ship.h ? cellOf(ship.x + i, ship.y) : cellOf(ship.x, ship.y + i));
    }
    return out;
}

// The ship's cells plus every cell around them (the no-touch zone).
export function shipHalo(ship) {
    const out = [];
    const x1 = ship.h ? ship.x + ship.size - 1 : ship.x;
    const y1 = ship.h ? ship.y : ship.y + ship.size - 1;
    for (let y = Math.max(0, ship.y - 1); y <= Math.min(SIZE - 1, y1 + 1); y++) {
        for (let x = Math.max(0, ship.x - 1); x <= Math.min(SIZE - 1, x1 + 1); x++) out.push(cellOf(x, y));
    }
    return out;
}

function inBounds(ship) {
    if (!Number.isInteger(ship.x) || !Number.isInteger(ship.y) || !Number.isInteger(ship.size)) return false;
    if (ship.size < 1 || ship.x < 0 || ship.y < 0) return false;
    return ship.h ? ship.x + ship.size <= SIZE && ship.y < SIZE : ship.y + ship.size <= SIZE && ship.x < SIZE;
}

/** Can `ship` go on a board that already has `ships`? (in bounds, no touching) */
export function canPlace(ships, ship) {
    if (!inBounds(ship)) return false;
    const taken = new Set();
    for (const s of ships) if (s) for (const c of shipCells(s)) taken.add(c);
    return shipHalo(ship).every((c) => !taken.has(c));
}

/** null if `ships` is a valid fleet for `sizes`, otherwise a short reason. */
export function fleetProblem(sizes, ships) {
    if (!Array.isArray(ships) || ships.length !== sizes.length) return 'count';
    const placed = [];
    for (let i = 0; i < sizes.length; i++) {
        const s = ships[i];
        if (!s || typeof s !== 'object' || typeof s.h !== 'boolean') return 'shape';
        const ship = { x: s.x, y: s.y, h: s.h, size: sizes[i] };
        if (!inBounds(ship)) return 'bounds';
        if (!canPlace(placed, ship)) return 'touch';
        placed.push(ship);
    }
    return null;
}

/**
 * A random valid fleet (ships in fleet order). Ships already in `fixed`
 * (same order, null = not placed yet) are kept where they are when possible.
 */
export function randomFleet(sizes, rng = Math.random, fixed = null) {
    const order = sizes.map((size, i) => i).sort((a, b) => sizes[b] - sizes[a]);
    for (let attempt = 0; attempt < 400; attempt++) {
        const keep = attempt < 200 && fixed ? fixed : null;
        const out = sizes.map((size, i) => (keep && keep[i] ? { x: keep[i].x, y: keep[i].y, h: !!keep[i].h, size } : null));
        let ok = true;
        for (const i of order) {
            if (out[i]) continue;
            let placed = false;
            for (let tries = 0; tries < 300 && !placed; tries++) {
                const h = rng() < 0.5;
                const ship = {
                    x: Math.floor(rng() * (h ? SIZE - sizes[i] + 1 : SIZE)),
                    y: Math.floor(rng() * (h ? SIZE : SIZE - sizes[i] + 1)),
                    h,
                    size: sizes[i],
                };
                if (canPlace(out, ship)) { out[i] = ship; placed = true; }
            }
            if (!placed) { ok = false; break; }
        }
        if (ok && fleetProblem(sizes, out) === null) return out;
    }
    throw new Error('Could not place the fleet');
}

export function createGame({ rules, firstPlayer = 0 } = {}) {
    const r = normalizeRules(rules);
    const first = firstPlayer === 1 ? 1 : 0;
    return {
        rules: r,
        fleet: FLEETS[r.fleet].slice(),
        phase: 'place',
        first,
        turn: first,
        placed: [false, false],
        boards: [0, 1].map(() => ({ ships: [], shots: new Array(CELLS).fill(UNKNOWN) })),
        sunk: [[], []],       // indices of the sunk ships on each board
        fired: [0, 0],        // shots fired by each player
        hits: [0, 0],         // of which hits
        moveCount: 0,
        winner: null,
        last: null,           // { player, cell, result } of the last shot
    };
}

function cloneState(s) {
    return {
        rules: s.rules,
        fleet: s.fleet,
        phase: s.phase,
        first: s.first,
        turn: s.turn,
        placed: s.placed.slice(),
        boards: s.boards.map((b) => ({ ships: b.ships.map((x) => ({ ...x })), shots: b.shots.slice() })),
        sunk: s.sunk.map((x) => x.slice()),
        fired: s.fired.slice(),
        hits: s.hits.slice(),
        moveCount: s.moveCount,
        winner: s.winner,
        last: s.last,
    };
}

/** Sizes of the ships still afloat on board `p` (public information). */
export function shipsLeft(state, p) {
    const left = state.fleet.slice();
    for (const i of state.sunk[p]) left.splice(left.indexOf(state.boards[p].ships[i].size), 1);
    return left;
}

export function isLegalMove(state, move, player = state.turn) {
    if (!move || typeof move !== 'object' || state.winner !== null || player !== state.turn) return false;
    if (move.type === 'place') {
        return state.phase === 'place' && !state.placed[player] && fleetProblem(state.fleet, move.ships) === null;
    }
    if (move.type === 'fire') {
        return state.phase === 'battle' && Number.isInteger(move.cell) && move.cell >= 0 && move.cell < CELLS &&
            state.boards[1 - player].shots[move.cell] === UNKNOWN;
    }
    return false;
}

/** Cells of `player`'s turn that can still be shot. */
export function legalShots(state) {
    if (state.phase !== 'battle' || state.winner !== null) return [];
    const shots = state.boards[1 - state.turn].shots;
    const out = [];
    for (let c = 0; c < CELLS; c++) if (shots[c] === UNKNOWN) out.push(c);
    return out;
}

/**
 * Apply `move` for the player whose turn it is. Returns { state, events }
 * with a new state; throws on an illegal move.
 * Events: placed {player}, battle {turn}, shot {player, cell, result:
 * 'miss' | 'hit' | 'sunk', ship?, cleared?}, turn {player}, again {player},
 * win {player}.
 */
export function applyMove(prev, move) {
    if (!isLegalMove(prev, move)) throw new Error('Illegal move: ' + JSON.stringify(move));
    const s = cloneState(prev);
    const me = s.turn;
    const foe = 1 - me;
    const events = [];
    s.moveCount++;

    if (move.type === 'place') {
        s.boards[me].ships = move.ships.map((m, i) => ({ x: m.x, y: m.y, h: !!m.h, size: s.fleet[i] }));
        s.placed[me] = true;
        events.push({ type: 'placed', player: me });
        if (s.placed[foe]) {
            s.phase = 'battle';
            s.turn = s.first;
            events.push({ type: 'battle', turn: s.turn });
        } else {
            s.turn = foe;
        }
        return { state: s, events };
    }

    const board = s.boards[foe];
    const cell = move.cell;
    const idx = board.ships.findIndex((ship) => shipCells(ship).includes(cell));
    s.fired[me]++;
    let result = 'miss';
    const ev = { type: 'shot', player: me, cell, result };
    if (idx < 0) {
        board.shots[cell] = MISS;
    } else {
        board.shots[cell] = HIT;
        s.hits[me]++;
        const ship = board.ships[idx];
        result = 'hit';
        if (shipCells(ship).every((c) => board.shots[c] === HIT)) {
            result = 'sunk';
            s.sunk[foe].push(idx);
            ev.ship = { ...ship };
            ev.cleared = [];
            for (const c of shipHalo(ship)) {
                if (board.shots[c] === UNKNOWN) { board.shots[c] = CLEAR; ev.cleared.push(c); }
            }
        }
    }
    ev.result = result;
    events.push(ev);
    s.last = { player: me, cell, result };

    if (s.sunk[foe].length === s.fleet.length) {
        s.winner = me;
        s.phase = 'over';
        events.push({ type: 'win', player: me });
    } else if (result !== 'miss' && s.rules.again) {
        events.push({ type: 'again', player: me });
    } else {
        s.turn = foe;
        events.push({ type: 'turn', player: foe });
    }
    return { state: s, events };
}

// ---------------------------------------------------------------------------
// Hidden information
// ---------------------------------------------------------------------------

/**
 * The state as `seat` may see it: the other side's ships are removed except
 * the sunk ones (and all of them once the game is over). `hidden` marks the
 * board whose unsunk ships were taken out.
 */
export function viewFor(state, seat) {
    const s = cloneState(state);
    if (s.winner !== null) return s;
    for (const p of [0, 1]) {
        if (p === seat) continue;
        s.boards[p].ships = state.sunk[p].map((i) => ({ ...state.boards[p].ships[i] }));
        s.sunk[p] = s.boards[p].ships.map((_, i) => i);
        s.boards[p].hidden = true;
    }
    return s;
}

/** The last move as `seat` may see it: another player's fleet stays secret. */
export function viewMove(move, seat) {
    if (move && move.move && move.move.type === 'place' && move.player !== seat) {
        return { ...move, move: { type: 'place' } };
    }
    return move;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export const BOT_LEVELS = ['easy', 'medium', 'hard'];

const around8 = (c) => {
    const x = c % SIZE, y = Math.floor(c / SIZE), out = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) out.push(cellOf(nx, ny));
        }
    }
    return out;
};
const around4 = (c) => {
    const x = c % SIZE, y = Math.floor(c / SIZE), out = [];
    if (x > 0) out.push(c - 1);
    if (x < SIZE - 1) out.push(c + 1);
    if (y > 0) out.push(c - SIZE);
    if (y < SIZE - 1) out.push(c + SIZE);
    return out;
};

// What the player to move knows about the board it shoots at: the shots,
// the ships already sunk and the sizes still afloat. Nothing else.
function knowledge(state) {
    const target = 1 - state.turn;
    const board = state.boards[target];
    const sunkCells = new Set();
    for (const i of state.sunk[target]) for (const c of shipCells(board.ships[i])) sunkCells.add(c);
    const open = []; // hits on ships not sunk yet
    for (let c = 0; c < CELLS; c++) if (board.shots[c] === HIT && !sunkCells.has(c)) open.push(c);
    return { shots: board.shots, open, left: shipsLeft(state, target) };
}

// Could a ship of `size` lie on these cells, given what is known?
// It can't cover a shot-at cell other than an open hit, and every open hit
// right next to it must be part of it (ships don't touch).
function fits(k, openSet, cells) {
    const mine = new Set(cells);
    let covered = 0;
    for (const c of cells) {
        const v = k.shots[c];
        if (v === HIT && openSet.has(c)) covered++;
        else if (v !== UNKNOWN) return -1;
    }
    for (const c of cells) {
        for (const n of around8(c)) if (!mine.has(n) && openSet.has(n)) return -1;
    }
    return covered;
}

// For each cell, how many ways the remaining ships can cover it.
function density(k) {
    const openSet = new Set(k.open);
    const score = new Array(CELLS).fill(0);
    const sizes = [...new Set(k.left)];
    for (const size of sizes) {
        const count = k.left.filter((x) => x === size).length;
        for (const h of [true, false]) {
            for (let y = 0; y < (h ? SIZE : SIZE - size + 1); y++) {
                for (let x = 0; x < (h ? SIZE - size + 1 : SIZE); x++) {
                    const cells = shipCells({ x, y, h, size });
                    const covered = fits(k, openSet, cells);
                    if (covered < 0) continue;
                    if (k.open.length && covered === 0) continue; // finish the wounded ship first
                    const w = count * (covered ? Math.pow(40, covered) : 1);
                    for (const c of cells) if (k.shots[c] === UNKNOWN) score[c] += w;
                }
            }
        }
    }
    return score;
}

// Cells next to open hits that could still hold the rest of that ship.
function targetCells(k, lineOnly) {
    const openSet = new Set(k.open);
    // Diagonal neighbours of any hit are always water.
    const water = new Set();
    for (const c of k.open) {
        const x = c % SIZE, y = Math.floor(c / SIZE);
        for (const n of around8(c)) if (n % SIZE !== x && Math.floor(n / SIZE) !== y) water.add(n);
    }
    let cands = [];
    for (const c of k.open) {
        for (const n of around4(c)) {
            if (k.shots[n] === UNKNOWN && !water.has(n)) cands.push({ n, from: c });
        }
    }
    if (lineOnly) {
        // Two hits in a row: keep going along that line.
        const inLine = cands.filter(({ n, from }) => {
            const back = from - (n - from);
            const sameRow = Math.floor(back / SIZE) === Math.floor(from / SIZE);
            return back >= 0 && back < CELLS && (Math.abs(n - from) === 1 ? sameRow : true) && openSet.has(back);
        });
        if (inLine.length) cands = inLine;
    }
    return [...new Set(cands.map((c) => c.n))];
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

function bestOf(score, rng) {
    let best = -1;
    let cells = [];
    for (let c = 0; c < CELLS; c++) {
        if (score[c] > best) { best = score[c]; cells = [c]; } else if (score[c] === best) cells.push(c);
    }
    return best > 0 ? pick(cells, rng) : null;
}

/** The bot's move: { type: 'place', ships } or { type: 'fire', cell }. */
export function chooseBotMove(state, level = 'medium', rng = Math.random) {
    if (state.winner !== null) return null;
    if (state.phase === 'place') {
        return { type: 'place', ships: randomFleet(state.fleet, rng).map(({ x, y, h }) => ({ x, y, h })) };
    }
    const free = legalShots(state);
    if (!free.length) return null;
    const k = knowledge(state);
    let cell = null;

    if (level === 'hard') {
        cell = bestOf(density(k), rng);
    } else if (level === 'medium') {
        if (k.open.length) {
            const t = targetCells(k, true);
            if (t.length) cell = pick(t, rng);
        } else {
            const minShip = Math.min(...k.left);
            const parity = free.filter((c) => ((c % SIZE) + Math.floor(c / SIZE)) % Math.max(2, minShip) === 0);
            if (parity.length && rng() < 0.75) cell = pick(parity, rng);
        }
    } else if (k.open.length && rng() < 0.5) {
        const t = targetCells(k, false);
        if (t.length) cell = pick(t, rng);
    }
    if (cell === null) cell = pick(free, rng);
    return { type: 'fire', cell };
}
