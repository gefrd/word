// src/modules/tools/docx-reader.js
// Lightweight offline .docx reader shared by word.js and converter.js.
// Reads word/document.xml with JSZip + DOMParser and keeps the structure most
// everyday documents need: headings, paragraphs, bold/italic/underline, lists
// and simple tables. No extra dependency beyond JSZip (already used).

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function getJSZip() {
    if (typeof window !== 'undefined' && window.JSZip) return window.JSZip;
    const m = await import('jszip');
    return m.default || m;
}

function wAttr(el, name) {
    return el.getAttributeNS(W_NS, name) || el.getAttribute('w:' + name) || '';
}

// A run property such as <w:b/> is on unless it says w:val="false"/"0".
function isOn(rPr, tag) {
    if (!rPr) return false;
    const el = rPr.getElementsByTagNameNS(W_NS, tag)[0];
    if (!el) return false;
    const v = wAttr(el, 'val');
    return v !== 'false' && v !== '0' && v !== 'none';
}

function childrenNS(el, localName) {
    const out = [];
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (c.namespaceURI === W_NS && c.localName === localName) out.push(c);
    }
    return out;
}

function readParagraph(p) {
    const pPr = childrenNS(p, 'pPr')[0];
    const styleEl = pPr && pPr.getElementsByTagNameNS(W_NS, 'pStyle')[0];
    const style = styleEl ? wAttr(styleEl, 'val') : '';
    const m = style.match(/heading\s*(\d)/i);
    const level = /^title$/i.test(style) ? 1 : (m ? Math.min(3, Number(m[1])) : 0);
    const bullet = !!(pPr && pPr.getElementsByTagNameNS(W_NS, 'numPr').length) || /list/i.test(style);

    const runs = [];
    const all = p.getElementsByTagNameNS(W_NS, 'r');
    for (let i = 0; i < all.length; i++) {
        const r = all[i];
        const rPr = childrenNS(r, 'rPr')[0];
        let text = '';
        for (let c = r.firstElementChild; c; c = c.nextElementSibling) {
            if (c.namespaceURI !== W_NS) continue;
            if (c.localName === 't') text += c.textContent;
            else if (c.localName === 'tab') text += '\t';
            else if (c.localName === 'br' || c.localName === 'cr') text += '\n';
        }
        if (text) runs.push({ text, b: isOn(rPr, 'b'), i: isOn(rPr, 'i'), u: isOn(rPr, 'u') });
    }
    return { type: level ? 'h' + level : (bullet ? 'li' : 'p'), runs };
}

/**
 * Parse a .docx file into blocks:
 *   { type: 'p'|'h1'|'h2'|'h3'|'li', runs: [{ text, b, i, u }] }
 *   { type: 'table', rows: [[cellText, ...], ...] }
 */
export async function readDocx(arrayBuffer) {
    const JSZip = await getJSZip();
    let zip;
    try {
        zip = await JSZip.loadAsync(arrayBuffer);
    } catch (e) {
        throw new Error('This file is not a valid .docx document');
    }
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('This file is not a valid .docx document');
    const xml = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
    const body = xml.getElementsByTagNameNS(W_NS, 'body')[0];
    if (!body) return [];

    const blocks = [];
    for (let el = body.firstElementChild; el; el = el.nextElementSibling) {
        if (el.namespaceURI !== W_NS) continue;
        if (el.localName === 'p') {
            blocks.push(readParagraph(el));
        } else if (el.localName === 'tbl') {
            const rows = childrenNS(el, 'tr').map(tr => childrenNS(tr, 'tc').map(tc =>
                childrenNS(tc, 'p').map(p => readParagraph(p).runs.map(r => r.text).join('')).join('\n')
            ));
            blocks.push({ type: 'table', rows });
        }
    }
    return blocks;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function runsToHtml(runs) {
    return runs.map(r => {
        let h = escapeHtml(r.text).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
        if (r.u) h = `<u>${h}</u>`;
        if (r.i) h = `<em>${h}</em>`;
        if (r.b) h = `<strong>${h}</strong>`;
        return h;
    }).join('');
}

export function docxBlocksToHtml(blocks) {
    let html = '';
    let inList = false;
    for (const block of blocks) {
        if (block.type !== 'li' && inList) { html += '</ul>'; inList = false; }
        if (block.type === 'table') {
            html += '<table><tbody>' + block.rows.map(row =>
                '<tr>' + row.map(cell => `<td><p>${escapeHtml(cell).replace(/\n/g, '<br>')}</p></td>`).join('') + '</tr>'
            ).join('') + '</tbody></table>';
        } else if (block.type === 'li') {
            if (!inList) { html += '<ul>'; inList = true; }
            html += `<li><p>${runsToHtml(block.runs)}</p></li>`;
        } else {
            const tag = block.type === 'p' ? 'p' : block.type;
            html += `<${tag}>${runsToHtml(block.runs)}</${tag}>`;
        }
    }
    if (inList) html += '</ul>';
    return html;
}

export function docxBlocksToMarkdown(blocks) {
    return blocks.map(block => {
        if (block.type === 'table') {
            return block.rows.map(row => row.map(c => c.replace(/\n/g, ' ')).join('\t')).join('\n');
        }
        const text = block.runs.map(r => r.text).join('');
        if (!text.trim()) return '';
        if (block.type === 'li') return '- ' + text;
        if (block.type[0] === 'h') return '#'.repeat(Number(block.type[1])) + ' ' + text;
        return text;
    }).join('\n\n').replace(/\n{3,}/g, '\n\n');
}
