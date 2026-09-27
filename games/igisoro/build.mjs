// Copies engine.js into igisoro.html (between the @engine-begin/@engine-end
// markers) so the game stays a single self-contained HTML file like the other
// games, while the rules live in one place.
// Run: node games/igisoro/build.mjs            (write)
//      node games/igisoro/build.mjs --check    (exit 1 if out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const enginePath = fileURLToPath(new URL('./engine.js', import.meta.url));
const htmlPath = fileURLToPath(new URL('../../igisoro.html', import.meta.url));

export function inlineEngine(html, engine) {
    const code = engine.replace(/^export /gm, '').trimEnd();
    const re = /(\/\/ @engine-begin\n)[\s\S]*?(\/\/ @engine-end)/;
    if (!re.test(html)) throw new Error('engine markers not found in igisoro.html');
    return html.replace(re, (_, a, b) => `${a}${code}\n${b}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const html = readFileSync(htmlPath, 'utf8');
    const next = inlineEngine(html, readFileSync(enginePath, 'utf8'));
    if (process.argv.includes('--check')) {
        if (next !== html) {
            console.error('igisoro.html is out of date: run node games/igisoro/build.mjs');
            process.exit(1);
        }
    } else if (next !== html) {
        writeFileSync(htmlPath, next);
        console.log('igisoro.html updated');
    }
}
