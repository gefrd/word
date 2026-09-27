const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
}

export function randomCode() {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    return String(1000 + (n % 9000));
}
