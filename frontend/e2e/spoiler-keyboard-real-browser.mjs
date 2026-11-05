// A `||spoiler||` as a control, in a REAL browser: the real components/Spoiler.tsx inside the real
// MessageContent, under the real Chat.css and theme.css, the real hotkeys registry (api/hotkeys.ts),
// the real MessagePreview and MessageToasts. jsdom has no accessibility tree, no Tab order, no forced
// colours and no pixels, so vitest (tests/spoilerControl.test.tsx, tests/spoilerPreviews.test.ts) pins
// the attributes and the arithmetic and this pins what a browser builds from them.
//
//   1. KEYBOARD, with REAL keys (page.keyboard): Tab from the control before lands on the spoiler;
//      Enter reveals it and a second Enter hides it; Space the same, and the chat does not scroll
//      (a plain focusable <div> beside it, on which Space does scroll, is the control); a held key
//      does not flicker it; a link in it takes no Tab while it is hidden and does once it is revealed;
//      a real mouse click on the hidden words (through `inert`) still reveals it.
//   2. PUSH-TO-TALK: with a voice hotkey bound to Space (the real registry, registerHold), Space on a
//      focused spoiler, held and repeated, presses nothing and the hotkey takes it; Enter, unbound,
//      still reveals. Bound to Enter, the other way round. Typing "a b" in the composer with Space bound
//      is untouched. Nothing bound: Space reveals (control). NEGATIVE CONTROL: the same page with
//      Spoiler.tsx's `defaultPrevented` line taken out reveals on the push-to-talk key.
//   3. ACCESSIBILITY TREE (Chromium's, over CDP): hidden, there is one button named "Spoiler", collapsed,
//      and no node anywhere carries the hidden words; revealed it is expanded and the words are there.
//   4. FOCUS RING on all eight themes, with and without High Contrast, read back from a screenshot:
//      the ring is 3:1 against the page around it and against the bar. NEGATIVE CONTROL: the ring rule
//      taken out of the stylesheet gives 1:1.
//   5. PREVIEWS: the one component every preview surface renders (reply snapshot, "Replying to", pinned
//      list, search results, collection feed) never prints a spoiler's words, in the page text, the
//      markup or the accessibility tree, whatever the spoiler holds, and revealing it in the message
//      does not change them. The words of a DM toast made as Chat makes them (messagePreviewText) too.
//      The words AROUND a spoiler come out as they were typed on every surface (`my_file_name` stays
//      `my_file_name`, not `my*file*name`).
//      NEGATIVE CONTROLS: the preview as it was (the covering taken out), a toast made of the raw body,
//      and a preview that rewrites the words around the spoiler.
//   6. FORCED COLOURS (a Windows contrast theme, page.emulateMedia forcedColors: active), light and
//      dark: the hidden words are not painted, at rest, under the pointer and with the keyboard on it;
//      the bar is a colour of its own against the page; revealed, the words are painted and read at 4.5:1;
//      the ring is there. NEGATIVE CONTROL: the stylesheet without its forced-colors block paints the words.
//
// Every one of 1-3 is also run against the spoiler as 0.9.856 shipped it (src/tests/fixtures/spoilerAt856.tsx),
// and must FAIL there: Tab skips it, no key reveals it, no button is in the tree, the words are.
//
// No server, no build, nothing leaves the machine (one page on 127.0.0.1), silent (--mute-audio, no sound
// anywhere). Needs Edge or Chromium (Playwright).
//
//   cd frontend && node e2e/spoiler-keyboard-real-browser.mjs
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(HERE, 'src');

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
    if (!ok) failures++;
};
/** A NEGATIVE CONTROL passes when the check it controls FAILS on the old behaviour. */
const control = (name, detected, extra = '') => check(`NEGATIVE CONTROL: ${name}`, detected, extra);

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const SECRET = 'the demon is Alice';
const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';

// ---- The page: the real components, built once per variant -----------------------------------------

const ENTRY = `
import './index.css';
import './components/Chat.css';
import { createRoot } from 'react-dom/client';
import { MessageContent } from './components/MessageContent';
import { MessagePreview } from './components/MessagePreview';
import { MessageToasts } from './components/MessageToasts';
import { pushMessageToast } from './components/messageToastBus';
import { messagePreviewText } from './api/messagePreview';
import { registerHold, unregisterHold } from './api/hotkeys';

const MEMBERS = [{ id: 2, username: 'alice' }];
const CHANNELS = [{ id: 7, name: 'general' }];
let root = null;
const mount = (el) => {
    root?.unmount();
    root = createRoot(document.getElementById('root'));
    root.render(el);
};
window.__rig = {
    // A message, with a control either side of it for Tab, a tall spacer for Space to scroll, and a composer.
    message(content) {
        mount(
            <main className="chat-main" id="main" style={{ height: '100%', display: 'block', overflow: 'auto' }}>
                <button id="before">before</button>
                <div className="message-content" id="msg" style={{ padding: '24px' }}>
                    <MessageContent content={content} members={MEMBERS} channels={CHANNELS} />
                </div>
                <button id="after">after</button>
                <div id="plain" tabIndex={0} style={{ padding: 8 }}>a plain focusable element</div>
                <div style={{ height: 3000 }} />
                <textarea id="box" />
            </main>
        );
    },
    // The one component every preview surface draws, with the message beside it to reveal.
    previews(contents) {
        mount(
            <main className="chat-main" id="main" style={{ height: '100%', display: 'block', overflow: 'auto' }}>
                {contents.map((c, i) => (
                    <section key={i} data-n={i}>
                        <div className="message-content msg">
                            <MessageContent content={c} members={MEMBERS} channels={CHANNELS} />
                        </div>
                        <div className="previews">
                            <span className="reply-preview"><MessagePreview content={c} max={50} /></span>
                            <span className="reply-content-preview"><MessagePreview content={c} max={60} /></span>
                            <span className="pin-body"><MessagePreview content={c} max={120} /></span>
                            <span className="search-hit"><MessagePreview content={c} max={60} /></span>
                            <span className="feed-content"><MessagePreview content={c} /></span>
                        </div>
                    </section>
                ))}
            </main>
        );
    },
    toast(title, body) { pushMessageToast({ title, body }); },
    toastBodyOf(dm) { return messagePreviewText(dm, 120); },
    bindHold(keyCode) {
        window.__hold = { down: 0, up: 0 };
        registerHold('rig.ptt', () => ({ keyCode, ctrl: false, alt: false, shift: false }), {
            onDown: () => { window.__hold.down++; },
            onUp: () => { window.__hold.up++; },
        });
    },
    unbindHold() { unregisterHold('rig.ptt'); },
};
createRoot(document.getElementById('toasts')).render(<MessageToasts />);
`;

/** Replace exactly one piece of a source file, or throw: a control that stopped controlling must not pass quietly. */
const mutate = (file, from, to) => ({
    name: `mutate-${path.basename(file)}`,
    setup(b) {
        // A path on Windows has backslashes, and one on another system slashes.
        const pattern = file.split('/').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
        b.onLoad({ filter: new RegExp('[\\\\/]' + pattern + '$') }, (args) => {
            const text = fs.readFileSync(args.path, 'utf8');
            if (!text.includes(from)) throw new Error(`rig: ${file} no longer contains the line this control takes out: ${from}`);
            return { contents: text.replace(from, to), loader: file.endsWith('x') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) };
        });
    },
});

/** Remove every top-level block whose header matches `header` (and, if given, whose body matches `body`). */
function removeBlocks(css, header, body = null) {
    let out = '';
    let at = 0;
    let removed = 0;
    const re = new RegExp(header.source, 'g');
    for (let m = re.exec(css); m; m = re.exec(css)) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
        if (body && !body.test(css.slice(m.index, i))) continue;
        out += css.slice(at, m.index);
        at = i;
        removed++;
    }
    return { css: out + css.slice(at), removed };
}

const variants = new Map();
async function variant(name, { plugins = [], css = (c) => c } = {}) {
    if (variants.has(name)) return variants.get(name);
    const result = await build({
        stdin: { contents: ENTRY, resolveDir: SRC, loader: 'tsx', sourcefile: 'spoiler-entry.tsx' },
        bundle: true,
        write: false,
        outdir: path.join(HERE, '.rig-out'),
        format: 'iife',
        target: 'es2022',
        platform: 'browser',
        jsx: 'automatic',
        loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty', '.ogg': 'empty', '.wasm': 'empty' },
        define: {
            'process.env.NODE_ENV': '"production"',
            __RC_ENABLED__: 'false',
            __APP_VERSION__: '"0.0.0-rig"',
            'import.meta.env': JSON.stringify({ VITE_API_URL: 'http://127.0.0.1:1', DEV: false, PROD: true, MODE: 'production' }),
        },
        plugins: [{
            name: 'url-stub',
            setup(b) {
                b.onResolve({ filter: /\?(url|worker)$/ }, (a) => ({ path: a.path, namespace: 'url-stub' }));
                b.onLoad({ filter: /.*/, namespace: 'url-stub' }, (a) => ({ contents: a.path.endsWith('?worker') ? 'export default class W {}' : 'export default ""', loader: 'js' }));
            },
        }, ...plugins],
        logOverride: { 'empty-import-meta': 'silent' },
        logLevel: 'error',
    });
    const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text;
    const rawCss = result.outputFiles.find((f) => f.path.endsWith('.css')).text;
    const built = { js, css: css(rawCss) };
    if (!built.css.includes('.spoiler')) throw new Error('rig: Chat.css did not make it into the bundle');
    variants.set(name, built);
    return built;
}

const real = await variant('real');
const oldSpoiler = await variant('as-856', {
    plugins: [{
        name: 'spoiler-as-856',
        setup(b) {
            b.onResolve({ filter: /^\.\/Spoiler$/ }, (a) => (a.importer.endsWith('MessageContent.tsx') ? { path: path.join(SRC, 'tests', 'fixtures', 'spoilerAt856.tsx') } : null));
        },
    }],
});
// The controls are built where they are used, and one that cannot be built (the line or the rule it
// takes out is gone) is a FAIL there, after the checks that matter have been run.
const lazy = (name, spec) => async (what) => {
    try {
        return await variant(name, spec);
    } catch (e) {
        check(`the control for ${what} can be built: ${e.message}`, false);
        return null;
    }
};
const getIgnoresHotkeys = lazy('ignores-defaultPrevented', {
    plugins: [mutate('components/Spoiler.tsx', 'if (e.defaultPrevented) return;', '')],
});
const getUncovered = lazy('previews-uncovered', {
    plugins: [mutate('api/messagePreview.ts', "const source = options.spoilers === 'keep' ? typed : coverSpoilers(typed);", 'const source = typed;')],
});
const getRewritten = lazy('previews-rewrite-words', {
    plugins: [mutate('api/messagePreview.ts', 'covered += content.slice(at, span[0]);', "covered += content.slice(at, span[0]).replaceAll('_', '*');")],
});
const getNoForced = lazy('no-forced-colors', {
    css: (c) => {
        const { css, removed } = removeBlocks(c, /@media\s*\(forced-colors:\s*active\)\s*\{/, /\.spoiler/);
        if (removed !== 1) throw new Error(`rig: expected one forced-colors block about .spoiler, found ${removed}`);
        return css;
    },
});
const getNoRing = lazy('no-ring', {
    css: (c) => {
        const { css, removed } = removeBlocks(c, /(^|\n)\.spoiler:focus-visible\s*\{/);
        if (removed !== 1) throw new Error(`rig: expected one .spoiler:focus-visible rule, found ${removed}`);
        return css;
    },
});

const HELPERS = `
window.__px = {
    async load(b64) {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        this.w = c.width; this.h = c.height; this.d = g.getImageData(0, 0, c.width, c.height).data;
        return [this.w, this.h];
    },
    at(x, y) { const i = (y * this.w + x) * 4; return [this.d[i], this.d[i + 1], this.d[i + 2]]; },
    lum([r, g, b]) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    },
    contrast(a, b) { const x = this.lum(a), y = this.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); },
    /** Pixels in the box that are not the reference colour, and the best contrast any of them has against it. */
    off(x0, y0, x1, y1, ref, tol = 24) {
        let n = 0, best = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const p = this.at(x, y);
            if (Math.abs(p[0] - ref[0]) + Math.abs(p[1] - ref[1]) + Math.abs(p[2] - ref[2]) > tol) { n++; best = Math.max(best, this.contrast(p, ref)); }
        }
        return { n, best: n ? best : null };
    },
};
`;

function serve(built) {
    const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title>spoiler</title>
<link rel="stylesheet" href="/a.css"><style>html,body,#root{margin:0;height:100%}</style></head>
<body><div id="root"></div><div id="toasts"></div><script>${HELPERS}</script><script src="/a.js"></script></body></html>`;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/a.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(built.js);
            else if (req.url === '/a.css') res.writeHead(200, { 'content-type': 'text/css' }).end(built.css);
            else res.writeHead(200, { 'content-type': 'text/html' }).end(html);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

/** A page on a built variant, with `content` as the message. */
async function open(built, content, { viewport = { width: 900, height: 600 }, media = null } = {}) {
    const { server, url } = await serve(built);
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    // A link in a message is pressed for real here, and must not leave the page.
    await page.addInitScript(() => document.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('a')) e.preventDefault(); }, true));
    if (media) await page.emulateMedia(media);
    await page.goto(url);
    await page.waitForFunction(() => !!window.__rig);
    if (content !== null) {
        await page.evaluate((c) => window.__rig.message(c), content);
        await page.waitForSelector('.spoiler');
    }
    return { page, context, close: async () => { await context.close(); server.close(); } };
}

const settle = (page, ms = 320) => page.waitForTimeout(ms); // .spoiler transitions all 0.2 s

const state = (page) => page.evaluate(() => {
    const s = document.querySelector('.spoiler');
    const a = document.activeElement;
    return {
        revealed: s.classList.contains('revealed'),
        expanded: s.getAttribute('aria-expanded'),
        role: s.getAttribute('role'),
        focused: a === s,
        active: a ? (a.id || a.className || a.tagName) : null,
    };
});

const axText = async (page, scope = null) => {
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    await cdp.detach();
    const live = nodes.filter((n) => !n.ignored);
    return {
        text: live.map((n) => `${n.role?.value}:${n.name?.value ?? ''}`).join('\n'),
        buttons: live.filter((n) => n.role?.value === 'button').map((n) => ({
            name: n.name?.value ?? '',
            expanded: n.properties?.find((p) => p.name === 'expanded')?.value?.value,
        })),
    };
};

/** Pixels of the spoiler's own bar that are anything but the bar: 0 when nothing of the words is painted. */
async function paintedIn(page, selector = '.spoiler') {
    const box = await page.locator(selector).first().boundingBox();
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    return page.evaluate(async ({ b64 }) => {
        const [w, h] = await window.__px.load(b64);
        const bar = window.__px.at(2, Math.floor(h / 2));
        return { ...window.__px.off(3, 3, w - 3, h - 3, bar), bar };
    }, { b64: png.toString('base64') });
}

// ======================================================================================================
// 1-3. The keyboard, push-to-talk and the tree: the real Spoiler, and the control that is the old one
// ======================================================================================================
const PLAIN = `Before ||${SECRET}|| after`;
const WITH_LINK = `||${SECRET} [a link](https://example.invalid/x)||`;

async function keyboardStory(built, label) {
    const r = {};
    const { page, close } = await open(built, PLAIN);
    await page.focus('#before');
    await page.keyboard.press('Tab');
    r.tabLands = await state(page);
    await page.keyboard.press('Enter');
    r.afterEnter = await state(page);
    await page.keyboard.press('Enter');
    r.afterEnter2 = await state(page);
    await page.keyboard.press('Space');
    r.afterSpace = await state(page);
    await page.keyboard.press('Space');
    r.afterSpace2 = await state(page);
    r.scrolled = await page.evaluate(() => document.getElementById('main').scrollTop);
    await close();
    return r;
}

{
    const r = await keyboardStory(real, 'real');
    check('Tab from the control before lands on the spoiler, and it says it is a button', r.tabLands.focused && r.tabLands.role === 'button' && r.tabLands.expanded === 'false', r.tabLands);
    check('Enter reveals it', r.afterEnter.revealed && r.afterEnter.expanded === 'true', r.afterEnter);
    check('a second Enter hides it again', !r.afterEnter2.revealed && r.afterEnter2.expanded === 'false', r.afterEnter2);
    check('Space reveals it, and a second Space hides it again', r.afterSpace.revealed && !r.afterSpace2.revealed, [r.afterSpace, r.afterSpace2]);
    check('Space on the spoiler does not scroll the chat', r.scrolled === 0, r.scrolled);

    const o = await keyboardStory(oldSpoiler, 'as-856');
    control('the spoiler as 0.9.856 shipped it: Tab skips it, no key reveals it', !o.tabLands.focused && !o.afterEnter.revealed && !o.afterSpace.revealed, { tab: o.tabLands.active, enter: o.afterEnter.revealed, space: o.afterSpace.revealed });
}

{
    // The scroll control: Space on a plain focusable element does scroll, so "did not scroll" above could fail.
    const { page, close } = await open(real, PLAIN);
    await page.focus('#plain');
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(() => document.getElementById('main').scrollTop);
    check('CONTROL: Space on a plain focusable element does scroll this page (so "does not scroll" can fail)', scrolled > 0, scrolled);
    await close();
}

{
    // A held key, a link inside, and the mouse through `inert`.
    const { page, close } = await open(real, WITH_LINK);
    await page.focus('#before');
    await page.keyboard.press('Tab');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    check('a held Enter reveals it once and does not flicker it', (await state(page)).revealed);
    await page.keyboard.press('Enter'); // hide
    await page.keyboard.press('Tab');
    check('hidden, the link in it takes no Tab: the next stop is the control after', (await state(page)).active === 'after', (await state(page)).active);
    await page.focus('#before');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter'); // reveal
    await page.keyboard.press('Tab');
    const onLink = await page.evaluate(() => document.activeElement?.tagName === 'A' && !!document.activeElement.closest('.spoiler.revealed'));
    check('revealed, the link in it is the next Tab stop', onLink);
    await page.keyboard.press('Enter'); // would follow the link; the page records it and does not leave
    check('Enter on the link is the link\'s own and leaves the spoiler revealed', (await state(page)).revealed);
    await close();

    const m = await open(real, PLAIN);
    const box = await m.page.locator('.spoiler').first().boundingBox();
    await m.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const clicked = await state(m.page);
    check('a real click on the hidden words (through inert) reveals it', clicked.revealed && clicked.expanded === 'true', clicked);
    await m.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    check('and a second click hides it again', !(await state(m.page)).revealed);
    await m.close();
}

{
    // Push-to-talk. The real registry, a real key.
    const press = async (page, key) => { await page.keyboard.press(key); };
    const bound = async (built, keyCode) => {
        const o = await open(built, PLAIN);
        await o.page.evaluate((k) => window.__rig.bindHold(k), keyCode);
        await o.page.focus('#before');
        await o.page.keyboard.press('Tab');
        return o;
    };

    const onSpace = await bound(real, 32);
    await onSpace.page.keyboard.down('Space');
    await onSpace.page.keyboard.down('Space'); // a repeat
    await onSpace.page.keyboard.down('Space');
    await onSpace.page.keyboard.up('Space');
    const held = await onSpace.page.evaluate(() => ({ ...window.__hold, revealed: document.querySelector('.spoiler').classList.contains('revealed') }));
    check('a push-to-talk on Space: Space held on a focused spoiler presses nothing, and the hotkey took it', held.down === 1 && held.up === 1 && !held.revealed, held);
    await press(onSpace.page, 'Enter');
    check('and Enter, which is not bound, still reveals it', (await state(onSpace.page)).revealed);
    await onSpace.page.evaluate(() => window.__rig.unbindHold());
    await onSpace.close();

    const onEnter = await bound(real, 13);
    await onEnter.page.keyboard.down('Enter');
    await onEnter.page.keyboard.down('Enter');
    await onEnter.page.keyboard.up('Enter');
    const heldEnter = await onEnter.page.evaluate(() => ({ ...window.__hold, revealed: document.querySelector('.spoiler').classList.contains('revealed') }));
    check('a push-to-talk on Enter: Enter held on a focused spoiler presses nothing', heldEnter.down === 1 && !heldEnter.revealed, heldEnter);
    await press(onEnter.page, 'Space');
    check('and Space, which is not bound, still reveals it', (await state(onEnter.page)).revealed);
    await onEnter.close();

    const typing = await bound(real, 32);
    await typing.page.focus('#box');
    await typing.page.keyboard.type('a b');
    const typed = await typing.page.evaluate(() => ({ value: document.getElementById('box').value, revealed: document.querySelector('.spoiler').classList.contains('revealed'), down: window.__hold.down }));
    check('typing "a b" in the composer with Space bound is untouched, and the hotkey still hears it', typed.value === 'a b' && !typed.revealed && typed.down === 1, typed);
    await typing.close();

    const none = await open(real, PLAIN);
    await none.page.focus('#before');
    await none.page.keyboard.press('Tab');
    await none.page.keyboard.press('Space');
    check('CONTROL: with no hotkey bound, the same Space reveals it', (await state(none.page)).revealed);
    await none.close();

    const ignoresHotkeys = await getIgnoresHotkeys('a spoiler that ignores defaultPrevented');
    if (ignoresHotkeys) {
        const naive = await bound(ignoresHotkeys, 32);
        await naive.page.keyboard.press('Space');
        const naiveState = await state(naive.page);
        control('a spoiler that ignores `defaultPrevented` is revealed by the push-to-talk key', naiveState.revealed, naiveState);
        await naive.close();
    }
}

{
    // The accessibility tree, before and after.
    const hiddenTree = async (built) => {
        const o = await open(built, PLAIN);
        const before = await axText(o.page);
        await o.page.focus('#before');
        await o.page.keyboard.press('Tab');
        await o.page.keyboard.press('Enter');
        const after = await axText(o.page);
        await o.close();
        return { before, after };
    };
    const t = await hiddenTree(real);
    check('hidden: one button named "Spoiler", collapsed', t.before.buttons.some((b) => b.name === 'Spoiler' && b.expanded === false) && !t.before.buttons.some((b) => /demon/i.test(b.name)), t.before.buttons);
    check('hidden: no node of the accessibility tree carries the words', !/demon|Alice/i.test(t.before.text), t.before.text.split('\n').filter((l) => /demon|Alice/i.test(l)));
    check('hidden: the words around it are in the tree (it is only the spoiler that is out)', /Before/.test(t.before.text) && /after/.test(t.before.text));
    check('revealed: the button is expanded and the words are in the tree', t.after.buttons.some((b) => b.expanded === true) && /demon is Alice/i.test(t.after.text), t.after.buttons);
    const old = await hiddenTree(oldSpoiler);
    control('the spoiler as 0.9.856 shipped it has no button in the tree and the words in it', !old.before.buttons.some((b) => b.name === 'Spoiler' || b.expanded !== undefined) && /demon is Alice/i.test(old.before.text), old.before.buttons);
}

// ======================================================================================================
// 4. The focus ring, on all eight themes with and without High Contrast
// ======================================================================================================
async function ringOn(built, theme, contrast, media = null) {
    const o = await open(built, `||${SECRET}||`, { media });
    await o.page.evaluate(({ theme, contrast }) => {
        document.documentElement.dataset.theme = theme;
        if (contrast) document.documentElement.dataset.contrast = 'high';
        else delete document.documentElement.dataset.contrast;
    }, { theme, contrast });
    await o.page.focus('#before');
    await o.page.keyboard.press('Tab');
    await settle(o.page);
    const box = await o.page.locator('.spoiler').first().boundingBox();
    const pad = 12;
    const clip = { x: Math.floor(box.x) - pad, y: Math.floor(box.y) - pad, width: Math.ceil(box.width) + 2 * pad, height: Math.ceil(box.height) + 2 * pad };
    const png = await o.page.screenshot({ clip });
    const css = await o.page.evaluate(() => { const s = getComputedStyle(document.querySelector('.spoiler')); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }; });
    const px = await o.page.evaluate(async ({ b64, x, y, w, h }) => {
        await window.__px.load(b64);
        const cx = x + Math.floor(w / 2);
        const ring = window.__px.at(cx, y - 3);
        const around = window.__px.at(cx, y - 9);
        const bar = window.__px.at(x + 2, y + Math.floor(h / 2));
        return { ring, around, bar, ringVsAround: window.__px.contrast(ring, around), ringVsBar: window.__px.contrast(ring, bar) };
    }, { b64: png.toString('base64'), x: pad, y: pad, w: Math.ceil(box.width), h: Math.ceil(box.height) });
    await o.close();
    return { css, ...px };
}

{
    let worst = Infinity;
    const bad = [];
    for (const contrast of [false, true]) {
        for (const theme of THEMES) {
            const r = await ringOn(real, theme, contrast);
            const ok = r.css.style === 'solid' && r.css.width === '2px' && r.ringVsAround >= 3 && r.ringVsBar >= 3;
            worst = Math.min(worst, r.ringVsAround, r.ringVsBar);
            if (!ok) bad.push({ theme, contrast, css: r.css, ringVsAround: +r.ringVsAround.toFixed(2), ringVsBar: +r.ringVsBar.toFixed(2) });
        }
    }
    check('the focus ring is drawn on all eight themes, with and without High Contrast, at 3:1 against the page and the bar', bad.length === 0, bad.length ? bad : `worst ${worst.toFixed(2)}:1 over 16`);
    const noRing = await getNoRing('the ring');
    if (noRing) {
        const none = await ringOn(noRing, 'dark', false);
        control('the stylesheet without the ring rule leaves only the browser\'s own thin default, not the 2px ring', !(none.css.style === 'solid' && none.css.width === '2px') && none.ringVsAround < 1.2, { css: none.css, ringVsAround: +none.ringVsAround.toFixed(2) });
    }
}

// ======================================================================================================
// 5. Previews
// ======================================================================================================
const PREVIEW_CASES = [
    `the twist is ||${SECRET}|| ok`,
    `||**${SECRET}** \`code ${SECRET}\` [${SECRET}](https://example.invalid/${SECRET}) @alice #general||`,
    `||![${SECRET}.png](sovereign-enc:abc?k=${KEY}&m=image%2Fpng)||`,
    `my_file ||${SECRET}_two||`,
    `a*b ||c*${SECRET}||`,
    `https://example.invalid/a||${SECRET}||`,
    `||${SECRET} ![f.png](sovereign-enc:abc?k=${KEY}&m=image%2Fpng)||`,
    `check my_file_name and user_id ||${SECRET}|| ok`,
];
/** The last case's words around its spoiler, as the preview of every surface prints them. */
const AROUND = /check my_file_name and user_id\s*Spoiler\s*ok/g;
const DM = `see ![photo.png](sovereign-enc:abc?k=${KEY}&m=image%2Fpng) the end is ||${SECRET}||`;

async function previewsOf(built) {
    const o = await open(built, null);
    await o.page.evaluate((c) => window.__rig.previews(c), PREVIEW_CASES);
    await o.page.waitForSelector('.previews');
    const read = () => o.page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('.previews'));
        return { text: all.map((p) => p.innerText).join('\n'), html: all.map((p) => p.innerHTML).join('\n'), chips: all.map((p) => p.querySelectorAll('.msg-preview-att-spoiler').length) };
    });
    const before = await read();
    // The whole page's tree, every message still hidden: the words are in none of it, previews included.
    const ax = await axText(o.page);
    // Reveal every spoiler in the messages, with real keys.
    for (const s of await o.page.locator('.msg .spoiler').all()) { await s.focus(); await o.page.keyboard.press('Enter'); }
    const revealed = await o.page.evaluate(() => document.querySelectorAll('.msg .spoiler.revealed').length);
    const after = await read();
    await o.page.evaluate(({ dm, body }) => window.__rig.toast('alice', body ?? window.__rig.toastBodyOf(dm)), { dm: DM, body: null });
    await o.page.waitForSelector('.message-toast-body');
    const toast = await o.page.evaluate(() => document.querySelector('.message-toast').innerText);
    await o.page.evaluate(({ dm }) => window.__rig.toast('bob', dm), { dm: DM }); // the body as it was: raw
    await o.page.waitForFunction(() => document.querySelectorAll('.message-toast').length === 2);
    const rawToast = await o.page.evaluate(() => document.querySelectorAll('.message-toast')[1].innerText);
    await o.close();
    return { before, after, revealed, ax, toast, rawToast };
}

{
    const p = await previewsOf(real);
    check('every preview surface: the page text carries none of the words, a ref or a key', !/demon|Alice|sovereign-enc|y8PY2E/i.test(p.before.text), p.before.text.slice(0, 300));
    check('and the markup (title, label, data) carries none either', !/demon|Alice|sovereign-enc|y8PY2E/i.test(p.before.html));
    check('each case is a "Spoiler" chip (and a "Spoiler image" beside it, in the seventh), in all five surfaces', JSON.stringify(p.before.chips) === JSON.stringify([5, 5, 5, 5, 5, 5, 10, 5]), p.before.chips);
    check('the words around a spoiler are printed as typed in all five surfaces: an underscore stays one', (p.before.text.match(AROUND) ?? []).length === 5 && !/my\*file|user\*id/.test(p.before.text), (p.before.text.match(AROUND) ?? []).length);
    check('every spoiler of the messages was revealed with a real key', p.revealed >= PREVIEW_CASES.length, p.revealed);
    check('after revealing: still none of the words, a ref or a key in the previews', !/demon|Alice|sovereign-enc|y8PY2E/i.test(p.after.text), p.after.text.slice(0, 300));
    check('the previews are the same text before and after', p.before.text === p.after.text);
    check('the accessibility tree of the whole page (previews and hidden messages) carries none of the words', !/demon|Alice/i.test(p.ax.text), p.ax.text.split('\n').filter((l) => /demon|Alice/i.test(l)).slice(0, 3));
    check('a DM\'s toast says "Spoiler" and the file by name, and has no word, ref or key', /Spoiler/.test(p.toast) && /photo\.png/.test(p.toast) && !/demon|is Alice|sovereign|y8PY2E|k=/i.test(p.toast), p.toast);
    control('the toast made of the raw body (as it was) prints the words, the ref and the key', /demon is Alice/.test(p.rawToast) && /sovereign-enc/.test(p.rawToast) && /y8PY2E/.test(p.rawToast), p.rawToast.slice(0, 120));

    const uncovered = await getUncovered('the previews');
    const u = uncovered ? await previewsOf(uncovered) : null;
    if (u) control('the previews as they were (the covering taken out) print the words, in the text and in the tree', /demon is Alice/.test(u.before.text) && /[|][|]/.test(u.before.text) && /demon is Alice/.test(u.ax.text), u.before.text.slice(0, 160));

    const rewritten = await getRewritten('the words around a spoiler');
    const w = rewritten ? await previewsOf(rewritten) : null;
    if (w) control('a preview that rewrites the words around a spoiler fails the check above (my*file*name)', (w.before.text.match(AROUND) ?? []).length === 0 && /my\*file/.test(w.before.text), (w.before.text.match(/check my\S* \S* \S* \S*/g) ?? [])[0]);
}

// ======================================================================================================
// 6. Forced colours: a Windows contrast theme
// ======================================================================================================
async function forcedStory(built, scheme) {
    const o = await open(built, `Before ||${SECRET}|| after`, { media: { forcedColors: 'active', colorScheme: scheme } });
    const r = {};
    r.active = await o.page.evaluate(() => matchMedia('(forced-colors: active)').matches);
    r.atRest = await paintedIn(o.page);
    const box = await o.page.locator('.spoiler').first().boundingBox();
    await o.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await settle(o.page);
    r.hovered = await paintedIn(o.page);
    await o.page.mouse.move(2, 2);
    await o.page.focus('#before');
    await o.page.keyboard.press('Tab');
    await settle(o.page);
    r.focused = await paintedIn(o.page);
    // The bar against the page around it.
    const pad = 10;
    const png = await o.page.screenshot({ clip: { x: Math.floor(box.x) - pad, y: Math.floor(box.y) - pad, width: Math.ceil(box.width) + 2 * pad, height: Math.ceil(box.height) + 2 * pad } });
    r.ring = await o.page.evaluate(async ({ b64, pad, w, h }) => {
        await window.__px.load(b64);
        const cx = pad + Math.floor(w / 2);
        const ring = window.__px.at(cx, pad - 3);
        const around = window.__px.at(cx, pad - 9);
        const bar = window.__px.at(pad + 2, pad + Math.floor(h / 2));
        return { barVsPage: window.__px.contrast(bar, around), ringVsPage: window.__px.contrast(ring, around) };
    }, { b64: png.toString('base64'), pad, w: Math.ceil(box.width), h: Math.ceil(box.height) });
    // Revealed.
    await o.page.keyboard.press('Enter');
    await settle(o.page);
    r.revealed = await paintedIn(o.page);
    await o.close();
    return r;
}

for (const scheme of ['light', 'dark']) {
    const r = await forcedStory(real, scheme);
    check(`forced colours (${scheme}) are really on in the page`, r.active);
    check(`forced colours (${scheme}): nothing of the hidden words is painted, at rest, under the pointer or with the keyboard on it`, r.atRest.n === 0 && r.hovered.n === 0 && r.focused.n === 0, { atRest: r.atRest.n, hovered: r.hovered.n, focused: r.focused.n });
    check(`forced colours (${scheme}): the bar stands out from the page (3:1) and so does the keyboard's ring`, r.ring.barVsPage >= 3 && r.ring.ringVsPage >= 3, r.ring);
    check(`forced colours (${scheme}): revealed, the words are painted and read at 4.5:1 on their ground`, r.revealed.n > 0 && r.revealed.best >= 4.5, { painted: r.revealed.n, best: r.revealed.best });
}
{
    const noForced = await getNoForced('forced colours');
    if (noForced) {
        const o = await forcedStory(noForced, 'light');
        control('the stylesheet without its forced-colors block prints the hidden words in the clear', o.atRest.n > 0, { painted: o.atRest.n });
    }
    const normal = await open(real, `Before ||${SECRET}|| after`);
    const rest = await paintedIn(normal.page);
    check('CONTROL: without forced colours the real stylesheet paints none either (unchanged)', rest.n === 0, rest);
    await normal.page.focus('#before');
    await normal.page.keyboard.press('Tab');
    await normal.page.keyboard.press('Enter');
    await settle(normal.page);
    const shown = await paintedIn(normal.page);
    check('CONTROL: revealed, without forced colours, the words are painted', shown.n > 0, shown);
    await normal.close();
}

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
