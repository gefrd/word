// Copies each game's engine.js into its single-file HTML page (between the
// @engine-begin/@engine-end markers), so every game stays one self-contained
// file like the other games, while the rules live in one place that the
// online server shares.
// Run: node games/build.mjs            (write)
//      node games/build.mjs --check    (exit 1 if a page is out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PAGES = {
    igisoro: '../igisoro.html',
    ludo: '../ludo.html',
    connect4: '../connect-four.html',
};

export function inlineEngine(html, engine) {
    const code = engine.replace(/^export /gm, '').trimEnd();
    const re = /(\/\/ @engine-begin\n)[\s\S]*?(\/\/ @engine-end)/;
    if (!re.test(html)) throw new Error('engine markers not found');
    return html.replace(re, (_, a, b) => `${a}${code}\n${b}`);
}

export function pagePaths(game) {
    return {
        engine: fileURLToPath(new URL(`./${game}/engine.js`, import.meta.url)),
        html: fileURLToPath(new URL(PAGES[game], import.meta.url)),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    let stale = false;
    for (const game of Object.keys(PAGES)) {
        const p = pagePaths(game);
        const html = readFileSync(p.html, 'utf8');
        const next = inlineEngine(html, readFileSync(p.engine, 'utf8'));
        if (next === html) continue;
        if (check) {
            console.error(`${PAGES[game].slice(3)} is out of date: run node games/build.mjs`);
            stale = true;
        } else {
            writeFileSync(p.html, next);
            console.log(`${PAGES[game].slice(3)} updated`);
        }
    }
    if (stale) process.exit(1);
}
