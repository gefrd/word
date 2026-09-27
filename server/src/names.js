// Automatic nicknames ("Swift Lion 42"). Players never type a name, so there
// is nothing to moderate. The name is derived from the device token, so the
// same phone keeps the same name.

const ADJECTIVES = [
    'Swift', 'Brave', 'Clever', 'Happy', 'Mighty', 'Calm', 'Lucky', 'Bright',
    'Bold', 'Gentle', 'Quick', 'Wise', 'Sunny', 'Proud', 'Noble', 'Jolly',
];
const ANIMALS = [
    'Lion', 'Gorilla', 'Zebra', 'Giraffe', 'Leopard', 'Elephant', 'Buffalo', 'Crane',
    'Eagle', 'Hippo', 'Rhino', 'Impala', 'Cheetah', 'Monkey', 'Owl', 'Antelope',
];

function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

export function nameForToken(token) {
    const h = hash(token);
    const adj = ADJECTIVES[h % ADJECTIVES.length];
    const animal = ANIMALS[(h >>> 4) % ANIMALS.length];
    const num = 10 + ((h >>> 8) % 90);
    return `${adj} ${animal} ${num}`;
}

export const BOT_NAME = 'Bot';
