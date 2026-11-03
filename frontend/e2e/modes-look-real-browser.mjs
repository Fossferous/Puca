// A server mode's background (docs/SERVER_MODES.md) in a REAL browser: the REAL tone curve
// (api/modeLook.ts, api/serverModes.ts, bundled) over real decoded pictures, under the REAL theme
// stylesheet, read back from what the browser actually rendered: a screenshot of the picture
// as CSS draws it, scaled and all. jsdom has no canvas, no JPEG and no compositor, so vitest can
// check the arithmetic and none of this.
//
// For five pictures drawn from nothing (e2e/mode-scenes.mjs), on all eight themes, at 1280x800
// and at a 390x844 phone's two device pixels per CSS pixel:
//   1. AA: every text colour the look sets against EVERY rendered pixel: 4.5:1 or it fails.
//      NEGATIVE CONTROLS, on the same check and must FAIL: the old veil at the strength it could
//      use at most, the theme's own text colours, and a curve that goes too far. And over
//      everything translucent that lies on the picture (hover, selection, a row that mentions
//      you, the composer), since those can move a pixel past what the text is held to: the
//      theme's own selection colour and the plain gold of a mention are the controls.
//   2. The picture is really there, in colour: how much of the original's colour and tonal
//      range survives, against what the old veil left, printed per picture. On the default
//      dark theme it must beat the old veil several times over.
//   3. A bright moon costs only the moon: the night picture is not dimmed for it. A busy picture's
//      fine detail is softened, in lightness only, and a calm picture is left as it is.
//   4. A picture that cannot be read gives no picture and no error. The result is a data:
//      URL, never a blob: (api/authedMedia.ts), and it renders under all five CSPs the app ships.
//   5. What it costs on a phone: decoding and mapping the largest stored picture, with the CPU
//      throttled 6x. Printed, and bounded.
//   6. What the halo around the text has to stay off, under the REAL Chat.css on all eight themes.
//      The REAL spoiler through the REAL message parser: nothing of its hidden words is painted,
//      at rest or under the pointer, read back from the screen, and revealed it has the halo like
//      any text. The composer's autocomplete list: no halo on a solid surface of its own, where on
//      Light it fills the white label's letters. NEGATIVE CONTROLS: with the reset taken out, the
//      same counts find the words, and find more white in the chosen row.
//   7. What has a colour or a chip of its own, in a spoiler: inline code, a link, a bare URL, a
//      mention, @everyone, a channel, through the REAL parser on all eight themes. Nothing of them is
//      painted, at rest or under the pointer, read back from the screen. A press on one only reveals,
//      and a hidden link takes no focus. Revealed, each looks as it does outside a spoiler, and a
//      press on a link or a channel is for that and leaves it revealed (a press on the words hides
//      it again). NEGATIVE CONTROL: with the hiding rule taken out of the stylesheet, the same count
//      finds every kind. Each is rendered as Chat renders a message, beside the REAL LinkPreview: no
//      card under the message gives a spoilered link away, hidden or revealed, and a link outside a
//      spoiler has its card, with the link's own address (the control).
//
// No server, no build, nothing leaves the machine (one page served on 127.0.0.1), silent.
//
//   cd frontend && node e2e/modes-look-real-browser.mjs [outdir]
//
// With an outdir it also writes each picture as rendered, on dark and Light, to look at.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENES, drawScene } from './mode-scenes.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(HERE);
const OUT = process.argv[2] || null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
    if (!ok) failures++;
};

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const OLD_SCRIM_MIN = 0.6;

const bundle = (await build({
    stdin: {
        contents: `
            import { mapPicture, pictureStyle, readPictureTheme, readThemeColor } from './api/modeLook';
            import { PICTURE_CEILING, PICTURE_FLOOR, PICTURE_TEXT_TOKENS, contrast, luminance, parseCssColor, pictureLimit, planTone, toneMap } from './api/serverModes';
            window.__look = { mapPicture, pictureStyle, readPictureTheme, readThemeColor, PICTURE_CEILING, PICTURE_FLOOR, PICTURE_TEXT_TOKENS, contrast, luminance, parseCssColor, pictureLimit, planTone, toneMap };
        `,
        resolveDir: path.join(HERE, 'src'),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    define: { __RC_ENABLED__: 'false', 'import.meta.env': '{}' },
})).outputFiles[0].text;
const themeCss = fs.readFileSync(path.join(HERE, 'src', 'styles', 'theme.css'), 'utf8');

// The chat's stylesheet and the real message parser, for what the halo must stay off (6). The
// composer's list is written out as Chat.tsx writes it: it is no component of its own.
const chatBuild = await build({
    stdin: {
        contents: `
            import './index.css';
            import './components/Chat.css';
            import { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { MessageContent } from './components/MessageContent';
            import { LinkPreview } from './components/LinkPreview';
            import { mapPicture, pictureStyle, readPictureTheme } from './api/modeLook';
            window.__chat = { mapPicture, pictureStyle, readPictureTheme };
            // What a press did, with nothing really opened.
            window.__pressed = [];
            document.addEventListener('click', (e) => {
                const a = e.target.closest?.('a');
                if (a) { e.preventDefault(); window.__pressed.push('opened ' + a.getAttribute('href')); }
            }, true);
            const MEMBERS = [{ id: 2, username: 'alice' }];
            const CHANNELS = [{ id: 7, name: 'general' }];
            const said = (content) => <MessageContent content={content} members={MEMBERS} channels={CHANNELS} onChannelClick={() => window.__pressed.push('channel')} />;
            const KINDS = {
                code: '||\`the code\`||',
                link: '||[the link](https://example.invalid/hidden)||',
                url: '||https://example.invalid/bare||',
                mention: '||@alice||',
                everyone: '||@everyone||',
                channel: '||#general||',
                mixed: '||words \`the code\` [the link](https://example.invalid/mixed) @alice||',
                formats: '||**bold** *lean* __under__ ~~struck~~ :fire:||',
            };
            const OPEN = '\`the code\` [the link](https://example.invalid/open) @alice @everyone #general';
            function Kinds() {
                const [n, set] = useState(0);
                window.__resetKinds = () => set((x) => x + 1);
                return (
                    <div className="message-content" id="kinds" key={n}>
                        {Object.entries(KINDS).map(([kind, content]) => <div key={kind} data-kind={kind}>{said(content)}<LinkPreview content={content} /></div>)}
                    </div>
                );
            }
            createRoot(document.getElementById('root')).render(
                <main className="chat-main" id="main" style={{ height: '100%' }}>
                    <div className="message-content" id="said">
                        <MessageContent content="Plain words. ||the demon is **Alice**||" members={[]} />
                    </div>
                    <Kinds />
                    <div className="message-content" id="open">{said(OPEN)}<LinkPreview content={OPEN} /></div>
                    <form className="message-form" style={{ marginTop: 'auto' }} onSubmit={(e) => e.preventDefault()}>
                        <div className="input-wrapper">
                            <div className="composer-autocomplete">
                                <div className="autocomplete-header">MEMBERS</div>
                                <div className="autocomplete-item active">
                                    <span className="ac-avatar">A</span>
                                    <span className="ac-name">Alice in the chosen row</span>
                                    <span className="ac-sub">@alice</span>
                                </div>
                                <div className="autocomplete-item">
                                    <span className="ac-avatar">B</span>
                                    <span className="ac-name">Bob</span>
                                    <span className="ac-sub">@bob</span>
                                </div>
                            </div>
                            <textarea className="message-textarea" defaultValue="@" />
                        </div>
                        <button type="submit">Send</button>
                    </form>
                </main>,
            );
        `,
        resolveDir: path.join(HERE, 'src'),
        loader: 'tsx',
        sourcefile: 'chat-entry.tsx',
    },
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
    }],
    logOverride: { 'empty-import-meta': 'silent' },
    logLevel: 'error',
});
const chatJs = chatBuild.outputFiles.find((f) => f.path.endsWith('.js')).text;
const chatCss = chatBuild.outputFiles.find((f) => f.path.endsWith('.css')).text;
if (!chatCss.includes('.composer-autocomplete')) throw new Error('rig: Chat.css did not make it into the bundle');
const CHAT_PAGE = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title>look in the chat</title>
<link rel="stylesheet" href="/chat.css"><style>html,body,#root{margin:0;height:100%}</style></head>
<body><div id="root"></div><script src="/chat.js"></script></body></html>`;
const PAGE = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title>look</title>
<link rel="stylesheet" href="/theme.css">
<style>html,body{margin:0;height:100%;background:var(--bg-primary)}#box,#over{position:fixed;inset:0}</style></head>
<body><div id="box"></div><div id="over"></div><script src="/look.js"></script></body></html>`;

function serve(csp) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const headers = csp ? { 'content-security-policy': csp } : {};
            if (req.url === '/look.js') res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }).end(bundle);
            else if (req.url === '/theme.css') res.writeHead(200, { ...headers, 'content-type': 'text/css' }).end(themeCss);
            else if (req.url === '/chat.js') res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }).end(chatJs);
            else if (req.url === '/chat.css') res.writeHead(200, { ...headers, 'content-type': 'text/css' }).end(chatCss);
            else if (req.url === '/chat') res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(CHAT_PAGE);
            else res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(PAGE);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

/** Read a screenshot's pixels in the page. */
const pixelsOf = (page, png) => page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    window.__shot = g.getImageData(0, 0, c.width, c.height).data;
    return [c.width, c.height];
}, png.toString('base64'));

/** Worst contrast of each colour over every pixel of the last screenshot, and how many pixels fail. */
const worstOver = (page, colours) => page.evaluate((colours) => {
    const lin = new Float64Array(256);
    for (let i = 0; i < 256; i++) { const v = i / 255; lin[i] = v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
    const d = window.__shot;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < d.length; i += 4) {
        const y = 0.2126 * lin[d[i]] + 0.7152 * lin[d[i + 1]] + 0.0722 * lin[d[i + 2]];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
    }
    const out = {};
    for (const [token, [r, g, b]] of Object.entries(colours)) {
        const t = 0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b];
        const against = (y) => (Math.max(t, y) + 0.05) / (Math.min(t, y) + 0.05);
        out[token] = Math.min(against(lo), against(hi));
    }
    return { lo, hi, worst: out };
}, colours);

/** How much picture there is in the last screenshot: colourfulness (Hasler and Süsstrunk) and tonal range. */
const seen = (page) => page.evaluate(() => {
    const d = window.__shot;
    let n = 0;
    let rgM = 0, rgS = 0, ybM = 0, ybS = 0;
    const luma = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 16) {
        const rg = d[i] - d[i + 1];
        const yb = (d[i] + d[i + 1]) / 2 - d[i + 2];
        n++;
        const dr = rg - rgM; rgM += dr / n; rgS += dr * (rg - rgM);
        const dy = yb - ybM; ybM += dy / n; ybS += dy * (yb - ybM);
        luma[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    }
    const at = (p) => { let s = 0; for (let v = 0; v < 256; v++) { s += luma[v]; if (s >= n * p) return v; } return 255; };
    const colourfulness = Math.sqrt(rgS / n + ybS / n) + 0.3 * Math.sqrt(rgM * rgM + ybM * ybM);
    return { colourfulness: Math.round(colourfulness * 10) / 10, p5: at(0.05), p50: at(0.5), p95: at(0.95) };
});

const show = (page, css) => page.evaluate((css) => {
    const box = document.getElementById('box');
    box.removeAttribute('style');
    for (const [k, v] of Object.entries(css)) {
        if (k.startsWith('--')) box.style.setProperty(k, v);
        else box.style[k] = v;
    }
    return getComputedStyle(box).backgroundImage.slice(0, 22);
}, css);
const drawn = async (page) => {
    await page.evaluate(async () => {
        const m = /url\("(.+)"\)/.exec(getComputedStyle(document.getElementById('box')).backgroundImage);
        if (m) await new Promise((done) => { const i = new Image(); i.onload = i.onerror = done; i.src = m[1]; });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
    });
};

const setTheme = (page, theme) => page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

/** The real look for a picture on the page's current theme. */
const theLook = (page, source, tooStrong = 1) => page.evaluate(async ({ source, tooStrong }) => {
    const L = window.__look;
    const theme = L.readPictureTheme();
    const limit = tooStrong === 1 ? theme.limit : { ...theme.limit, luminance: theme.limit.kind === 'ceiling' ? theme.limit.luminance * tooStrong : theme.limit.luminance / tooStrong };
    const picture = await L.mapPicture(`data:image/jpeg;base64,${source}`, limit);
    const text = Object.fromEntries(Object.entries(theme.text).map(([t, c]) => [t, L.parseCssColor(c)]));
    return {
        css: L.pictureStyle(picture.url, theme),
        text,
        plan: picture.plan,
        detail: picture.detail,
        keep: picture.keep,
        urlKind: picture.url.slice(0, 15),
        urlChars: picture.url.length,
        surfaces: { hover: theme.hover, active: theme.active, mention: theme.mention, 'mention hover': theme.mentionHover, composer: theme.composer },
        ownHover: getComputedStyle(document.documentElement).getPropertyValue('--bg-modifier-active'),
    };
}, { source, tooStrong });

/** What the old code did with this picture on this theme. */
const oldLook = (page, source) => page.evaluate(async (source) => {
    const L = window.__look;
    const img = new Image();
    img.src = `data:image/jpeg;base64,${source}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 32);
    const { data } = g.getImageData(0, 0, 32, 32);
    let dark = [255, 255, 255];
    let light = [0, 0, 0];
    const weight = ([r, gg, b]) => 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    for (let i = 0; i < data.length; i += 4) {
        const p = [data[i], data[i + 1], data[i + 2]];
        if (weight(p) < weight(dark)) dark = p;
        if (weight(p) > weight(light)) light = p;
    }
    const surface = L.readThemeColor('--bg-primary');
    const texts = ['--text-normal', '--text-muted', '--text-link'].map(L.readThemeColor);
    const mix = (o, u, a) => [o[0] * a + u[0] * (1 - a), o[1] * a + u[1] * (1 - a), o[2] * a + u[2] * (1 - a)];
    const floor = (t) => { const own = L.contrast(t, surface); return own >= 4.5 ? 4.5 : own * 0.9; };
    let alpha = 0.97;
    for (let a = 0.6; a < 0.97; a += 0.01) {
        if ([dark, light].every(p => texts.every(t => L.contrast(t, mix(surface, p, a)) >= floor(t)))) { alpha = Math.round(a * 100) / 100; break; }
    }
    const veil = (v) => `rgba(${surface[0]}, ${surface[1]}, ${surface[2]}, ${v})`;
    return { alpha, veil: veil(alpha), veilAtMin: veil(0.6), texts: Object.fromEntries(['--text-normal', '--text-muted', '--text-link'].map((t, i) => [t, texts[i]])) };
}, source);

const { server, url } = await serve(null);
try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await desktop.newPage();
    page.on('pageerror', (e) => check('no uncaught page error', false, e.message.slice(0, 300)));
    await page.goto(url);
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const phone = await phoneCtx.newPage();
    await phone.goto(url);

    const sources = {};
    for (const scene of SCENES) sources[scene] = await page.evaluate(drawScene, scene);

    // ── 1 and 2. Every picture on every theme, read back from the screen.
    const report = [];
    let tightest = { contrast: Infinity };
    const note = (scene, theme, size, held) => {
        for (const [token, c] of Object.entries(held.worst)) if (c < tightest.contrast) tightest = { contrast: Math.round(c * 100) / 100, token, scene, theme, size };
    };
    for (const scene of SCENES) {
        for (const theme of THEMES) {
            await setTheme(page, theme);
            const look = await theLook(page, sources[scene]);
            await show(page, look.css);
            await drawn(page);
            const png = await page.screenshot();
            await pixelsOf(page, png);
            const held = await worstOver(page, look.text);
            const low = Object.entries(held.worst).filter(([, c]) => c < 4.5).map(([t, c]) => `${t} ${c.toFixed(2)}`);
            check(`${scene} on ${theme}: every text colour holds at 4.5:1 over every rendered pixel`, low.length === 0, { low, gain: Math.round(look.plan.gain * 100) / 100, luminance: [held.lo.toFixed(3), held.hi.toFixed(3)] });
            note(scene, theme, '1280x800', held);
            const now = await seen(page);
            if (OUT && (theme === 'dark' || theme === 'light')) fs.writeFileSync(path.join(OUT, `${scene}-${theme}.png`), png);

            // Phone: the same mapped picture drawn at another size and scale.
            await setTheme(phone, theme);
            await show(phone, look.css);
            await drawn(phone);
            await pixelsOf(phone, await phone.screenshot());
            const heldPhone = await worstOver(phone, look.text);
            const lowPhone = Object.entries(heldPhone.worst).filter(([, c]) => c < 4.5).map(([t, c]) => `${t} ${c.toFixed(2)}`);
            check(`${scene} on ${theme}, 390x844: every rendered pixel too`, lowPhone.length === 0, lowPhone);
            note(scene, theme, '390x844', heldPhone);

            if (theme === 'dark' || theme === 'light') {
                // The old look on the same page: the veil this picture got, over the original.
                const old = await oldLook(page, sources[scene]);
                await show(page, { backgroundImage: `linear-gradient(${old.veil}, ${old.veil}), url("data:image/jpeg;base64,${sources[scene]}")`, backgroundSize: 'cover', backgroundPosition: 'center' });
                await drawn(page);
                await pixelsOf(page, await page.screenshot());
                const before = await seen(page);
                // The original, for how much of it there was to keep.
                await show(page, { backgroundImage: `url("data:image/jpeg;base64,${sources[scene]}")`, backgroundSize: 'cover', backgroundPosition: 'center' });
                await drawn(page);
                await pixelsOf(page, await page.screenshot());
                const original = await seen(page);
                report.push({ scene, theme, oldVeil: old.alpha, gain: Math.round(look.plan.gain * 1000) / 1000, original, before, now, detail: look.detail, keep: look.keep });

                // NEGATIVE CONTROL: the strongest veil the old code could use, with the text it had.
                if (scene === 'daylight' || scene === 'snow' || scene === 'night') {
                    await show(page, { backgroundImage: `linear-gradient(${old.veilAtMin}, ${old.veilAtMin}), url("data:image/jpeg;base64,${sources[scene]}")`, backgroundSize: 'cover', backgroundPosition: 'center' });
                    await drawn(page);
                    await pixelsOf(page, await page.screenshot());
                    const weak = await worstOver(page, old.texts);
                    const expectFail = (theme === 'dark') === (scene !== 'night');
                    if (expectFail) check(`NEGATIVE CONTROL: ${scene} on ${theme} under a 60% veil fails the same check`, Object.values(weak.worst).some(c => c < 4.5), weak.worst);
                }
            }
        }
    }
    console.log(`TIGHTEST ${JSON.stringify(tightest)}`);
    for (const r of report) {
        console.log(`DETAIL ${r.scene} on ${r.theme}: ${r.detail.toFixed(3)}, keeps ${r.keep.toFixed(2)}; colourfulness ${r.now.colourfulness}`);
        if (r.scene === 'busy') {
            check(`busy on ${r.theme}: it is measured busy, and softened`, r.keep < 1, { detail: r.detail, keep: r.keep });
            check(`busy on ${r.theme}: and keeps its colour`, r.now.colourfulness >= r.before.colourfulness * 2, { old: r.before.colourfulness, now: r.now.colourfulness });
        } else if (r.scene === 'lines') {
            check(`lines on ${r.theme}: nothing but fine detail, so softened as well`, r.keep < 1, { detail: r.detail, keep: r.keep });
        } else {
            check(`${r.scene} on ${r.theme}: a calm picture is left as it is`, r.keep === 1, { detail: r.detail, keep: r.keep });
        }
    }
    for (const r of report) console.log(`SEEN  ${r.scene} on ${r.theme}: old veil ${r.oldVeil}, new gain ${r.gain}; colourfulness original ${r.original.colourfulness}, old ${r.before.colourfulness}, new ${r.now.colourfulness}; tonal range p5-p95 original ${r.original.p5}-${r.original.p95}, old ${r.before.p5}-${r.before.p95}, new ${r.now.p5}-${r.now.p95}`);
    for (const r of report.filter(x => x.theme === 'dark')) {
        check(`${r.scene} on dark: far more colour than the old veil left`, r.now.colourfulness >= r.before.colourfulness * 1.8 || r.original.colourfulness < 15, { old: r.before.colourfulness, now: r.now.colourfulness });
        check(`${r.scene} on dark: and more tonal range`, r.now.p95 - r.now.p5 > r.before.p95 - r.before.p5, { old: [r.before.p5, r.before.p95], now: [r.now.p5, r.now.p95] });
    }

    // NEGATIVE CONTROLS on the curve: the same picture, the same text.
    await setTheme(page, 'dark');
    const daylight = await theLook(page, sources.daylight);
    const strong = await theLook(page, sources.daylight, 1.6);
    await show(page, { ...strong.css });
    await drawn(page);
    await pixelsOf(page, await page.screenshot());
    const tooFar = await worstOver(page, daylight.text);
    check('NEGATIVE CONTROL: a curve that goes too far on dark fails the same check', Object.values(tooFar.worst).some(c => c < 4.5), tooFar.worst);
    await setTheme(page, 'light');
    const onLight = await theLook(page, sources.night);
    const strongLight = await theLook(page, sources.night, 1.6);
    await show(page, { ...strongLight.css });
    await drawn(page);
    await pixelsOf(page, await page.screenshot());
    const tooFarLight = await worstOver(page, onLight.text);
    check('NEGATIVE CONTROL: and on Light', Object.values(tooFarLight.worst).some(c => c < 4.5), tooFarLight.worst);
    await setTheme(page, 'dark');
    const own = await page.evaluate(() => Object.fromEntries(window.__look.PICTURE_TEXT_TOKENS.map(t => [t, window.__look.readThemeColor(t)])));
    await show(page, daylight.css);
    await drawn(page);
    await pixelsOf(page, await page.screenshot());
    const ownHeld = await worstOver(page, own);
    check('NEGATIVE CONTROL: the theme\'s own text colours do not hold: the reading colours are needed', ownHeld.worst['--text-muted'] < 4.5, ownHeld.worst);

    // Everything translucent over the picture. The two pictures with hard, bright parts.
    const over = (p, colour) => p.evaluate((c) => { document.getElementById('over').style.background = c; }, colour);
    for (const theme of THEMES) {
        await setTheme(page, theme);
        for (const scene of ['daylight', 'night']) {
            const look = await theLook(page, sources[scene]);
            await show(page, look.css);
            await drawn(page);
            for (const [name, colour] of Object.entries(look.surfaces)) {
                await over(page, colour);
                await pixelsOf(page, await page.screenshot());
                const held = await worstOver(page, look.text);
                const low = Object.entries(held.worst).filter(([, c]) => c < 4.5).map(([t, c]) => `${t} ${c.toFixed(2)}`);
                check(`${scene} on ${theme}, under ${name}: every text colour still holds`, low.length === 0, low);
            }
            if (scene === 'night' && theme === 'amoled') {
                await over(page, look.ownHover);
                await pixelsOf(page, await page.screenshot());
                const held = await worstOver(page, look.text);
                check('NEGATIVE CONTROL: the theme\'s own selection colour over the same picture fails', Object.values(held.worst).some(c => c < 4.5), held.worst);
                await over(page, 'rgba(250, 166, 26, 0.15)');
                await pixelsOf(page, await page.screenshot());
                const gold = await worstOver(page, look.text);
                check('NEGATIVE CONTROL: and so does the plain gold of a row that mentions you', Object.values(gold.worst).some(c => c < 4.5), gold.worst);
            }
            await over(page, 'transparent');
        }
    }
    await setTheme(page, 'dark');

    // ── 3. A bright moon costs only the moon.
    const night = await theLook(page, sources.night);
    check('a bright moon does not dim the night picture', night.plan.gain >= 1, night.plan);

    // ── 4. What cannot be read, and what comes back.
    check('the mapped picture is a data: URL, never a blob:', night.urlKind.startsWith('data:image/jpeg'), night.urlKind);
    const broken = await page.evaluate(async () => {
        const L = window.__look;
        return {
            garbage: await L.mapPicture('data:image/jpeg;base64,bm90IGEgcGljdHVyZQ==', L.pictureLimit([24, 25, 28])),
            nothing: await L.mapPicture('data:image/png;base64,', L.pictureLimit([24, 25, 28])),
        };
    });
    check('a picture that cannot be read gives no picture, and no error', broken.garbage === null && broken.nothing === null, broken);

    // Under every CSP the app ships.
    const { buildPolicy, injectCsp } = await import(pathToFileURL(path.join(HERE, 'scripts', 'cap-index-csp.mjs')).href);
    void injectCsp;
    const policies = {
        caddy: /Content-Security-Policy "([^"]+)"/.exec(fs.readFileSync(path.join(REPO, 'deploy', 'Caddyfile.example.com'), 'utf8'))?.[1],
        tool: (() => {
            const py = fs.readFileSync(path.join(REPO, 'deploy', 'ops', 'add-webapp-csp.py'), 'utf8');
            const body = /csp = \(([\s\S]*?)\n\s*\)/.exec(py)?.[1];
            return body ? [...body.matchAll(/f?"([^"]*)"/g)].map((m) => m[1]).join('').replace('{connect}', "'self'") : undefined;
        })(),
        tauri: JSON.parse(fs.readFileSync(path.join(HERE, 'src-tauri', 'tauri.conf.json'), 'utf8')).app?.security?.csp,
        tauriLite: JSON.parse(fs.readFileSync(path.join(HERE, 'src-tauri', 'tauri.lite.conf.json'), 'utf8')).app?.security?.csp,
        capacitor: buildPolicy({ apiUrl: 'http://127.0.0.1:1' }),
    };
    for (const [name, csp] of Object.entries(policies)) {
        check(`${name}: the policy was found`, !!csp);
        if (!csp) continue;
        const s = await serve(csp);
        const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
        const p = await ctx.newPage();
        const refused = [];
        p.on('console', m => { if (/Content Security Policy/i.test(m.text())) refused.push(m.text().slice(0, 160)); });
        await p.goto(s.url);
        await p.waitForFunction(() => !!window.__look, null, { timeout: 8000 }).catch(() => {});
        const look = await theLook(p, sources.balloons);
        await show(p, look.css);
        await drawn(p);
        await pixelsOf(p, await p.screenshot());
        const shown = await seen(p);
        check(`${name}: the picture maps and shows, nothing refused`, shown.colourfulness > 10 && refused.length === 0, { shown, refused });
        await ctx.close();
        s.server.close();
    }

    // ── 5. What it costs. The largest picture the server stores, on a phone's CPU.
    const cdp = await phoneCtx.newCDPSession(phone);
    const cost = async (rate) => {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        const r = await phone.evaluate(async (source) => {
            const L = window.__look;
            const limit = L.pictureLimit([24, 25, 28]);
            const t0 = performance.now();
            const m = await L.mapPicture(`data:image/jpeg;base64,${source}`, limit);
            return { ms: Math.round(performance.now() - t0), chars: m.url.length };
        }, sources.busy);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        return r;
    };
    const free = await cost(1);
    const slow = await cost(6);
    console.log(`COST  decode + map + encode, 1600x900: ${free.ms} ms here, ${slow.ms} ms at 6x CPU throttle; data: URL ${Math.round(free.chars / 1024)} KiB; pixels in memory while mapping ${Math.round(1600 * 900 * 4 / 1048576 * 10) / 10} MiB`);
    check('on a phone\'s CPU it takes under 3 s, once per mode and theme', slow.ms < 3000, slow);
    check('and what stays in memory is a fraction of the raw pixels', free.chars < 1600 * 900 * 4 / 2, free);

    // ── 6. What the halo has to stay off.
    const chat = await desktop.newPage();
    chat.on('pageerror', (e) => check('no uncaught page error in the chat', false, e.message.slice(0, 300)));
    await chat.goto(`${url}chat`);
    await chat.waitForFunction(() => !!window.__chat && !!document.querySelector('.spoiler'), null, { timeout: 15000 });
    /** The transition on a spoiler is all 0.2 s, its halo and its bar included. */
    const settled = () => chat.waitForTimeout(260);
    const shadowOf = (selector) => chat.evaluate((s) => getComputedStyle(document.querySelector(s)).textShadow, selector);
    /** Let the halo through what resets it, as nothing reset it before. */
    const letThrough = (selector) => chat.evaluate((s) => {
        const rule = document.createElement('style');
        rule.id = 'let-through';
        rule.textContent = `${s} { text-shadow: inherit !important; }`;
        document.head.appendChild(rule);
    }, selector);
    const putBack = () => chat.evaluate(() => document.getElementById('let-through')?.remove());
    /** Read the screen inside a box, its rounded ends left out. */
    const shotOf = async (selector) => {
        const box = await chat.evaluate((s) => {
            const el = document.querySelector(s);
            const r = el.getBoundingClientRect();
            return { x: r.x + 4, y: r.y + 1, width: r.width - 8, height: r.height - 2, fill: getComputedStyle(el).backgroundColor };
        }, selector);
        const { fill, ...clip } = box;
        await pixelsOf(chat, await chat.screenshot({ clip }));
        return fill;
    };
    /** How many pixels inside a spoiler's bar are anything but the bar. */
    const paintedOn = async (selector) => {
        const fill = await shotOf(selector);
        return chat.evaluate((fill) => {
            const [r, g, b] = fill.match(/[\d.]+/g).map(Number);
            const d = window.__shot;
            let painted = 0;
            for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) > 2 || Math.abs(d[i + 1] - g) > 2 || Math.abs(d[i + 2] - b) > 2) painted++;
            return painted;
        }, fill);
    };
    const whiteIn = async (selector) => {
        await shotOf(selector);
        return chat.evaluate(() => {
            const d = window.__shot;
            let white = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
            return white;
        });
    };
    const centreOf = (selector) => chat.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
    }, selector);
    const restAndHover = async () => {
        await chat.mouse.move(2, 2);
        await settled();
        const rest = await paintedOn('.spoiler');
        await chat.mouse.move(...await centreOf('.spoiler'));
        await settled();
        const hovered = await paintedOn('.spoiler');
        await chat.mouse.move(2, 2);
        await settled();
        return { rest, hovered };
    };
    // Where the halo is the colour of the bar at rest, and only hovering shows it.
    const SAME_AS_THE_BAR = new Set(['light', 'amoled']);
    // The spoilers of 7, by what each holds, and the ones with a look of their own.
    const KINDS = ['code', 'link', 'url', 'mention', 'everyone', 'channel', 'mixed', 'formats'];
    const OWN_LOOK = KINDS.filter((kind) => kind !== 'formats');
    const inKind = (kind) => `[data-kind="${kind}"] .spoiler`;
    /** Take the rule that hides them out of the REAL stylesheet, and put it back as it was. */
    const takeOutHidingRule = () => chat.evaluate(() => {
        window.__taken = [];
        for (const sheet of document.styleSheets) {
            [...sheet.cssRules].forEach((rule, i) => {
                if (rule.selectorText?.includes('.spoiler:not(.revealed) .inline-code')) window.__taken.push([sheet, rule.cssText, i]);
            });
        }
        for (const [sheet, , i] of window.__taken) sheet.deleteRule(i);
        return window.__taken.length;
    });
    const putBackHidingRule = () => chat.evaluate(() => {
        for (const [sheet, text, i] of window.__taken) sheet.insertRule(text, i);
    });
    for (const theme of THEMES) {
        await chat.evaluate(async ({ theme, source }) => {
            document.documentElement.setAttribute('data-theme', theme);
            const { mapPicture, pictureStyle, readPictureTheme } = window.__chat;
            const look = readPictureTheme();
            const picture = await mapPicture(`data:image/jpeg;base64,${source}`, look.limit);
            const main = document.getElementById('main');
            for (const [k, v] of Object.entries(pictureStyle(picture.url, look))) {
                if (k.startsWith('--')) main.style.setProperty(k, v);
                else main.style[k] = v;
            }
        }, { theme, source: sources.daylight });
        const halo = await shadowOf('#said');
        check(`halo on ${theme}: CONTROL: the words around the spoiler wear it`, halo !== 'none', halo);

        const hidden = await restAndHover();
        check(`spoiler on ${theme}: nothing of the hidden words is painted, at rest or under the pointer`, hidden.rest === 0 && hidden.hovered === 0, hidden);
        await letThrough('.spoiler:not(.revealed)');
        const through = await restAndHover();
        await putBack();
        check(`NEGATIVE CONTROL: spoiler on ${theme}: with the halo let through, the same count finds the words`, (SAME_AS_THE_BAR.has(theme) ? through.hovered : through.rest) > 0, through);

        await chat.mouse.click(...await centreOf('.spoiler'));
        await chat.mouse.move(2, 2);
        await settled();
        const revealed = await chat.evaluate(() => {
            const el = document.querySelector('.spoiler.revealed');
            return el && { shadow: getComputedStyle(el).textShadow, colour: getComputedStyle(el).color };
        });
        check(`spoiler on ${theme}: revealed, it has the halo like the words around it`, revealed?.shadow === halo && !/, 0\)$/.test(revealed.colour), revealed);
        await chat.mouse.click(...await centreOf('.spoiler'));
        const again = await restAndHover();
        check(`spoiler on ${theme}: hidden again, nothing is painted`, again.rest === 0 && again.hovered === 0, again);

        // ── 7. What has a colour or a chip of its own.
        await chat.evaluate(() => { window.__resetKinds(); window.__pressed.length = 0; });
        await settled();
        const counted = async () => {
            const out = {};
            for (const kind of KINDS) out[kind] = await paintedOn(inKind(kind));
            return out;
        };
        const atRest = await counted();
        check(`spoiler holding each kind on ${theme}: nothing is painted at rest, chips included`, Object.values(atRest).every((n) => n === 0), atRest);
        const cards = () => chat.evaluate(() => ({
            hidden: [...document.querySelectorAll('#kinds .link-preview-card')].map((a) => a.getAttribute('href')),
            open: [...document.querySelectorAll('#open .link-preview-card')].map((a) => a.getAttribute('href')),
        }));
        const cardsAtRest = await cards();
        check(`spoiler holding a link on ${theme}: no card under the message gives it away`, cardsAtRest.hidden.length === 0, cardsAtRest);
        check(`CONTROL: a link outside a spoiler on ${theme}: its card, with the link's own address`, JSON.stringify(cardsAtRest.open) === JSON.stringify(['https://example.invalid/open']), cardsAtRest);
        const underPointer = {};
        for (const kind of KINDS) {
            await chat.mouse.move(...await centreOf(inKind(kind)));
            await settled();
            underPointer[kind] = await paintedOn(inKind(kind));
        }
        await chat.mouse.move(2, 2);
        await settled();
        check(`spoiler holding each kind on ${theme}: nor under the pointer`, Object.values(underPointer).every((n) => n === 0), underPointer);

        const ruleOut = await takeOutHidingRule();
        const shownThrough = await counted();
        await putBackHidingRule();
        check(`NEGATIVE CONTROL: spoiler holding each kind on ${theme}: with the hiding rule taken out, the same count finds each`,
            ruleOut === 1 && OWN_LOOK.every((kind) => shownThrough[kind] > 0), { ruleOut, shownThrough });

        const hiddenLink = await chat.evaluate(() => {
            const a = document.querySelector('[data-kind="link"] a');
            a.focus();
            const r = a.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { focused: document.activeElement === a, hitsTheSpoiler: !!hit?.matches('.spoiler'), width: r.width };
        });
        check(`hidden link on ${theme}: takes no focus, and a pointer on it lands on the spoiler`, !hiddenLink.focused && hiddenLink.hitsTheSpoiler && hiddenLink.width > 0, hiddenLink);
        for (const kind of KINDS) await chat.mouse.click(...await centreOf(inKind(kind)));
        await chat.mouse.move(2, 2);
        await settled();
        const afterPress = await chat.evaluate(() => ({ pressed: window.__pressed.slice(), revealed: document.querySelectorAll('#kinds .spoiler.revealed').length }));
        check(`spoiler holding each kind on ${theme}: the first press only reveals: nothing opened, no channel entered`, afterPress.pressed.length === 0 && afterPress.revealed === KINDS.length, afterPress);
        const cardsRevealed = await cards();
        check(`spoiler holding a link on ${theme}: revealed, it is in the message, and still no card`, cardsRevealed.hidden.length === 0, cardsRevealed);

        const looks = await chat.evaluate(() => {
            const read = (el) => { const c = getComputedStyle(el); return { colour: c.color, background: c.backgroundColor, visibility: c.visibility }; };
            return Object.fromEntries(['.inline-code', '.message-link', '.mention:not(.everyone):not(.channel)', '.mention.everyone', '.mention.channel'].map((s) => [s, {
                revealed: read(document.querySelector(`#kinds ${s}`)),
                outside: read(document.querySelector(`#open ${s}`)),
            }]));
        });
        check(`revealed on ${theme}: each looks as it does outside a spoiler`, Object.values(looks).every((l) => JSON.stringify(l.revealed) === JSON.stringify(l.outside) && l.revealed.visibility === 'visible' && !/, 0\)$/.test(l.revealed.colour)), looks);
        const painted = {};
        for (const kind of OWN_LOOK) {
            const clip = await chat.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, inKind(kind));
            const shown = await chat.screenshot({ clip });
            await chat.addStyleTag({ content: '#kinds .spoiler * { visibility: hidden !important; }' }).then((h) => h.evaluate((el) => { el.id = 'bar-only'; }));
            const bare = await chat.screenshot({ clip });
            await chat.evaluate(() => document.getElementById('bar-only').remove());
            painted[kind] = !shown.equals(bare);
        }
        check(`revealed on ${theme}: each is really on the screen`, Object.values(painted).every(Boolean), painted);

        for (const kind of ['link', 'url', 'channel', 'code']) await chat.mouse.click(...await centreOf(inKind(kind)));
        await chat.mouse.move(2, 2);
        const stayed = await chat.evaluate(() => ({
            pressed: window.__pressed.slice(),
            link: !!document.querySelector('[data-kind="link"] .spoiler.revealed'),
            url: !!document.querySelector('[data-kind="url"] .spoiler.revealed'),
            channel: !!document.querySelector('[data-kind="channel"] .spoiler.revealed'),
            code: !!document.querySelector('[data-kind="code"] .spoiler.revealed'),
        }));
        check(`revealed on ${theme}: a press on a link or a channel is for that, and leaves it revealed`,
            JSON.stringify(stayed.pressed) === JSON.stringify(['opened https://example.invalid/hidden', 'opened https://example.invalid/bare', 'channel']) && stayed.link && stayed.url && stayed.channel, stayed);
        check(`CONTROL: revealed on ${theme}: a press on anything else hides it again`, !stayed.code, stayed);

        const list = await chat.evaluate(() => Object.fromEntries(['.composer-autocomplete', '.autocomplete-header', '.autocomplete-item.active', '.ac-avatar', '.ac-name', '.ac-sub']
            .map((s) => [s, getComputedStyle(document.querySelector(s)).textShadow])));
        check(`autocomplete on ${theme}: no halo anywhere in the list`, Object.values(list).every((v) => v === 'none'), list);
        const white = await whiteIn('.autocomplete-item.active');
        await letThrough('.composer-autocomplete');
        const whiteThrough = await whiteIn('.autocomplete-item.active');
        const listThrough = await shadowOf('.autocomplete-item.active');
        await putBack();
        check(`NEGATIVE CONTROL: autocomplete on ${theme}: with the halo let through, the chosen row has it`, listThrough === halo, listThrough);
        if (theme === 'light') {
            check('NEGATIVE CONTROL: autocomplete on light: and it paints white around the white label', whiteThrough > white * 1.2, { white, whiteThrough });
        }
    }
    // Why the white labels on fills elsewhere in the chat (Send and the rest) need nothing: they are
    // buttons, and a browser's own stylesheet gives a button no text-shadow.
    check('a button in the chat takes no halo: the browser\'s own rule', (await shadowOf('.message-form button[type="submit"]')) === 'none');
    await chat.close();
    await desktop.close();
    await phoneCtx.close();
} catch (e) {
    check('the script ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
    server.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures ? 1 : 0);
