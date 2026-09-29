// A pasted checklist's HTML is READ in a real browser, and nothing in it runs or loads.
//
// WHY THIS EXISTS. A checklist copied as RENDERED text (an assistant's answer
// selected on the page) has no "#" or "- [ ]" left in its plain text, so the
// paste paths read the clipboard's text/html beside it
// (src/notes/model/pastedHtml.ts). That markup is someone else's. Parsing it
// the obvious way (innerHTML on an element of the page, even a detached one)
// makes a real browser FETCH its images and run their onerror; and even the
// inert way, a browser's parser has shapes it takes seconds on (nested
// <div>s, misnested <b><i>, comments at the top) and one that CRASHES the
// renderer (nested <template>s), which in the app is the whole window. jsdom
// fetches no images whatever the code does, and its parser is not
// Chromium's, so the vitest suite (src/tests/pastedHtml.test.ts) can see
// neither; this can. It bundles the REAL reader (esbuild) into a real
// Chromium and checks:
//
//   1. NEGATIVE CONTROL: the hostile markup through a detached element's
//      innerHTML DOES request its image and run its handler here, so the rig
//      can see the defect it guards against.
//   2. The reader, given the same markup: no request, no handler, nothing
//      added to the page, and only the list is read.
//   3. A rendered checklist selected in the page: its plain text (the
//      selection's own) with its HTML reads as the Markdown it was written
//      in; the plain text alone does not (the owner's defect).
//   4. readPaste over a REAL DataTransfer, as a paste event carries one.
//   5. Markup over the size cap is never parsed.
//   6. Every shape Chromium's parser is slow on (or crashes on) is refused
//      before the parse, fast, and the plain text read instead; NEGATIVE
//      CONTROL: parsed raw, one of them IS slow here. A long, real,
//      well-formed checklist is still read, fast.
//
// SILENT and headless: no media, no clipboard (the selection is serialized in
// the page, never copied), and every request is intercepted and aborted, so
// nothing leaves the machine.
//
//   cd frontend && node e2e/paste-html-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = `
import { readPaste, readPastedItems } from './notes/model/noteContent';
import { MAX_PASTE_HTML, htmlToMarkdown } from './notes/model/pastedHtml';
window.__reader = { readPaste, readPastedItems, htmlToMarkdown, MAX_PASTE_HTML };
`;
const bundle = await build({
    stdin: { contents: entry, resolveDir: join(here, '..', 'src'), loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __APP_VERSION__: '"0"', __RC_ENABLED__: 'true' },
    logLevel: 'error',
});
const readerSrc = bundle.outputFiles[0].text;

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

// Every address is on a reserved name and every request is aborted: the
// point is to SEE a request, never to make one.
const HOSTILE = '<ul><li>a</li><li>b</li></ul>'
    + '<script>window.__ran = (window.__ran || []).concat("script")</script>'
    + '<img src="https://paste-probe.invalid/img.png" onerror="window.__ran = (window.__ran || []).concat(\'img\')">'
    + '<svg onload="window.__ran = (window.__ran || []).concat(\'svg\')"></svg>'
    + '<iframe src="https://paste-probe.invalid/frame.html"></iframe>'
    + '<link rel="stylesheet" href="https://paste-probe.invalid/sheet.css">'
    + '<style>@import "https://paste-probe.invalid/import.css"; li { background: url("https://paste-probe.invalid/bg.png"); }</style>'
    + '<object data="https://paste-probe.invalid/o.bin"></object>';

const RENDERED = `<p>Here's your 0.9.826 test checklist:</p>
<h1>Púca 0.9.826 test checklist</h1>
<h2>Before you start</h2>
<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" disabled=""> Update the desktop app to 0.9.826 (the updater should offer it)</li>
<li class="task-list-item"><input type="checkbox" disabled=""> Let Púca and Púca Notes on your phone pick up the update (open each once)</li>
</ul>
<h2>Calendar</h2>
<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" checked="" disabled=""> Snooze an item from the Notes calendar: it moves once, to your morning time</li>
</ul>
<p>That's everything new in 0.9.826, so tick as you go!</p>`;
const MARKDOWN = `Here's your 0.9.826 test checklist:

# Púca 0.9.826 test checklist

## Before you start
- [ ] Update the desktop app to 0.9.826 (the updater should offer it)
- [ ] Let Púca and Púca Notes on your phone pick up the update (open each once)

## Calendar
- [x] Snooze an item from the Notes calendar: it moves once, to your morning time

That's everything new in 0.9.826, so tick as you go!`;

const CHANNEL = process.env.CHANNEL || 'bundled';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio'],
});

/** A page with the reader loaded and every request recorded, then aborted. */
async function newPage() {
    const page = await browser.newPage();
    const requests = [];
    await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('https://paste-probe.invalid/')) requests.push(url);
        return route.abort();
    });
    await page.setContent('<!doctype html><meta charset="utf-8"><body><div id="root"></div></body>');
    await page.addScriptTag({ content: readerSrc });
    return { page, requests };
}
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 300)));

// 1. NEGATIVE CONTROL: the obvious parse, which this rig must be able to see.
{
    const { page, requests } = await newPage();
    await page.evaluate((html) => { document.createElement('div').innerHTML = html; }, HOSTILE);
    await settle(page);
    const ran = await page.evaluate(() => window.__ran ?? []);
    ck(requests.some((u) => u.endsWith('/img.png')), 'negative control: innerHTML on a detached element of the page fetches its image', JSON.stringify(requests));
    ck(ran.includes('img'), 'negative control: ...and runs its onerror', JSON.stringify(ran));
    await page.close();
}

// 2. The reader, given the same markup.
{
    const { page, requests } = await newPage();
    const result = await page.evaluate((html) => {
        window.__mutations = 0;
        new MutationObserver((r) => { window.__mutations += r.length; })
            .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        const before = document.documentElement.outerHTML;
        const read = window.__reader.readPastedItems('a\nb', { html });
        return { items: read?.items ?? null, before };
    }, HOSTILE);
    await settle(page);
    const after = await page.evaluate(() => ({ html: document.documentElement.outerHTML, ran: window.__ran ?? [], mutations: window.__mutations }));
    ck(JSON.stringify(result.items) === '["a","b"]', 'the reader reads only the list', JSON.stringify(result.items));
    ck(requests.length === 0, 'the reader fetches nothing: no image, frame, stylesheet, import or object', JSON.stringify(requests));
    ck(after.ran.length === 0, 'the reader runs nothing: no script, no onerror, no onload', JSON.stringify(after.ran));
    ck(after.mutations === 0 && after.html === result.before, 'the reader adds nothing to the page', `mutations=${after.mutations}`);
    await page.close();
}

// 3 and 4. A rendered checklist, selected in the page and pasted.
{
    const { page } = await newPage();
    const r = await page.evaluate(({ rendered, markdown }) => {
        const msg = document.getElementById('root');
        msg.innerHTML = rendered;              // the page's OWN content, as a chat app shows it
        const range = document.createRange();
        range.selectNodeContents(msg);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const text = sel.toString();
        const holder = document.createElement('div');
        holder.appendChild(range.cloneContents());
        const html = holder.innerHTML;
        const { readPastedItems, readPaste } = window.__reader;
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        dt.setData('text/html', html);
        const event = new ClipboardEvent('paste', { clipboardData: dt });
        return {
            text,
            both: readPastedItems(text, { html }),
            alone: readPastedItems(text),
            markdown: readPastedItems(markdown),
            viaEvent: readPaste(event.clipboardData),
        };
    }, { rendered: RENDERED, markdown: MARKDOWN });
    ck(!/[#[]/.test(r.text), 'the selection\'s plain text has no Markdown marks left', JSON.stringify(r.text.slice(0, 80)));
    ck(JSON.stringify(r.both) === JSON.stringify(r.markdown), 'text with its HTML reads as the Markdown it was written in', JSON.stringify(r.both));
    ck(r.both?.title === 'Púca 0.9.826 test checklist' && r.both?.items.filter((i) => i.startsWith('## ')).length === 2, '...titled, with its two sections as headings');
    ck(r.alone?.title === null && r.alone?.items.includes('Before you start'), 'POSITIVE CONTROL: the plain text alone is one item per line, a heading among them', JSON.stringify(r.alone?.items.slice(0, 3)));
    ck(JSON.stringify(r.viaEvent.read) === JSON.stringify(r.markdown) && r.viaEvent.text === r.text, 'readPaste reads both formats of a real paste event\'s DataTransfer');
    await page.close();
}

// 5. Size.
{
    const { page } = await newPage();
    const r = await page.evaluate(() => {
        const { readPastedItems, MAX_PASTE_HTML } = window.__reader;
        let parses = 0;
        const real = DOMParser.prototype.parseFromString;
        DOMParser.prototype.parseFromString = function (...a) { parses++; return real.apply(this, a); };
        const list = '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>';
        const huge = readPastedItems('Milk\nBread', { html: list + '<p>' + 'x'.repeat(MAX_PASTE_HTML) + '</p>' });
        DOMParser.prototype.parseFromString = real;
        return { title: huge?.title ?? null, items: huge?.items, parses };
    });
    ck(r.parses === 0 && r.title === null && JSON.stringify(r.items) === '["Milk","Bread"]', 'over the cap: never parsed, the plain text read', `parses=${r.parses}`);
    await page.close();
}

// 6. What the parser is slow on, or crashes on. Each in a page of its own,
// so a crash names its shape. Every one is under the size cap.
const LIST = '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>';
const COSTLY = {
    'nested <div>': `'<div>'.repeat(50000) + LIST`,
    'nested <span>': `'<span>'.repeat(150000) + LIST`,
    'nested <template> (crashed the renderer)': `'<template>'.repeat(5000) + LIST`,
    'misnested <b><i><u><s>': `'<b><i><u><s>x</b>'.repeat(40000) + LIST`,
    '<a><div>x</a>': `'<a><div>x</a>'.repeat(30000) + LIST`,
    '<div><table><td></div>': `'<div><table><td></div>'.repeat(30000) + LIST`,
    'comments at the top': `'<!---->'.repeat(40000) + LIST`,
    'comments after </html>': `'x' + '</html><!---->'.repeat(40000) + LIST`,
    'a repeated <html> with attributes': `Array.from({ length: 40000 }, (_, i) => '<html a' + i + '>').join('') + LIST`,
};
for (const [shape, expr] of Object.entries(COSTLY)) {
    const { page } = await newPage();
    try {
        const r = await page.evaluate(({ expr, list }) => {
            window.LIST = list;                     // the shape is built in global scope
            const html = (0, eval)(expr);
            const t0 = performance.now();
            const read = window.__reader.readPastedItems('Milk\nBread', { html });
            return { ms: performance.now() - t0, kb: Math.round(html.length / 1000), title: read?.title ?? null, items: read?.items };
        }, { expr, list: LIST });
        ck(r.ms < 150 && r.title === null && JSON.stringify(r.items) === '["Milk","Bread"]', `${shape}: refused before the parse, the plain text read`, `${Math.round(r.ms)} ms for ${r.kb} KB`);
    } catch (e) {
        ck(false, `${shape}: refused before the parse`, String(e.message).split('\n')[0]);
    }
    await page.close().catch(() => {});
}
{
    const { page } = await newPage();
    const r = await page.evaluate((list) => {
        // NEGATIVE CONTROL: the same kind of shape, parsed raw, is slow here.
        const t0 = performance.now();
        new DOMParser().parseFromString('<div>'.repeat(20000) + list, 'text/html');
        const rawMs = performance.now() - t0;
        // POSITIVE CONTROL: a long real checklist, the way Chromium copies one
        // (every element styled inline), is still read, and fast.
        const step = (i) => `<li style="color: rgb(31, 31, 31); font-family: system-ui; font-size: 16px; margin: 0px; white-space: normal;"><input type="checkbox" disabled=""> Step ${i}</li>`;
        const long = '<h1 style="font-size: 24px;">Long list</h1><ul style="padding-left: 24px;">' + Array.from({ length: 5000 }, (_, i) => step(i + 1)).join('') + '</ul>';
        const t1 = performance.now();
        const read = window.__reader.readPastedItems('x\ny', { html: long });
        return { rawMs, longMs: performance.now() - t1, kb: Math.round(long.length / 1000), title: read?.title ?? null, total: read?.total ?? 0 };
    }, LIST);
    ck(r.rawMs > 300, 'NEGATIVE CONTROL: 20k nested <div>s parsed raw take this browser a long time', `${Math.round(r.rawMs)} ms`);
    ck(r.title === 'Long list' && r.total === 5000 && r.longMs < 500, 'POSITIVE CONTROL: a 5000-step styled checklist is read, fast', `${Math.round(r.longMs)} ms for ${r.kb} KB`);
    await page.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
