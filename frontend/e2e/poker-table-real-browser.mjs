// Real-browser rig: the Poker table as a TABLE (docs/GAMES.md, *The table on
// screen*) - the oval, the seats around it, the board that turns as it is
// dealt, and the main and side pots on the felt - at 1280x800 and on a
// 390x844 coarse-pointer phone, with and without reduced motion.
//
// It drives e2e/poker-table-harness.html (the real GamesView, the app's real
// stylesheets, the contract's own fixture reshaped into a four-handed hand
// with a short all-in; no server) headless and checks:
//   1. before the flop: five board slots, all face down, none naming a card;
//   2. the flop arriving as the next version: exactly three cards turn, each
//      a running 3-D animation, one after another (increasing delays), the
//      other two slots still face down; when they have run, every card is
//      face up (no transform left);
//   3. with prefers-reduced-motion: the same flop has NO animation at all and
//      the cards are face up at once;
//   4. the main pot and the side pot are on the felt, the side pot the viewer
//      did not cover marked - and the felt's text, every pot pill included,
//      is >= 4.5:1 against the felt (composited);
//   5. no seat tile sits on another, on the board or on the pots, and none
//      leaves the table; the viewer's seat is at the bottom;
//   6. the phone: no horizontal overflow measured with clientWidth (never
//      innerWidth), with a 460 px injection as the positive control.
// SILENT: the harness switches game sounds off before mounting and the
// browser runs with --mute-audio.
//
// Usage: start the dev server in frontend/
//   npx vite --port 5402 --strictPort --host 127.0.0.1
// then: node e2e/poker-table-real-browser.mjs [outdir] [baseURL]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outdir = process.argv[2] || 'e2e/shots-poker-table';
const BASE = process.argv[3] || 'http://127.0.0.1:5402';
fs.mkdirSync(outdir, { recursive: true });

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** In the page: the board, the flips and the felt. */
const PROBE = () => {
    const board = document.querySelector('.gboard');
    const flips = [...document.querySelectorAll('.gboard .pflip')];
    const anims = flips.map(f => f.querySelector('.pflip-inner').getAnimations());
    const down = [...document.querySelectorAll('.gboard > .pcard-back')];
    return {
        slots: board ? board.children.length : 0,
        down: down.length,
        downNaming: down.filter(d => d.hasAttribute('data-card') || /[2-9TJQKA][cdhs]/.test(d.outerHTML)).length,
        faces: flips.map(f => f.querySelector('[data-card]')?.getAttribute('data-card')),
        running: anims.map(a => a.filter(x => x.playState !== 'finished').length),
        delays: anims.map(a => (a[0] ? a[0].effect.getTiming().delay : null)),
        transforms: flips.map(f => getComputedStyle(f.querySelector('.pflip-inner')).transform),
        pills: [...document.querySelectorAll('.gpot-pill')].map(p => ({ text: p.textContent.trim(), out: p.classList.contains('gpot-out') })),
    };
};

/** WCAG contrast of every text node on the felt against the felt. */
const FELT_CONTRAST = () => {
    const rgba = (s) => { const m = s.match(/[\d.]+/g); const [r, g, b, a = 1] = m.map(Number); return [r, g, b, a]; };
    const centre = document.querySelector('.gtable-oval .gcentre');
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(centre).getPropertyValue('--felt').trim();
    document.body.appendChild(probe);
    const felt = rgba(getComputedStyle(probe).color);
    probe.remove();
    const lum = ([r, g, b]) => [r, g, b].map(v => v / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3]));
    const out = [];
    for (const el of centre.querySelectorAll('*')) {
        const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if (!own || el.closest('.pcard')) continue;
        let bg = felt.slice(0, 3);
        const layers = [];
        for (let e = el; e && e !== centre; e = e.parentElement) {
            const c = rgba(getComputedStyle(e).backgroundColor);
            if (c[3] > 0) layers.unshift(c);
        }
        for (const l of layers) bg = over(l, bg);
        const ink = over(rgba(getComputedStyle(el).color), bg);
        const [a, b] = [lum(ink), lum(bg)].sort((x, y) => y - x);
        out.push({ text: el.textContent.trim().slice(0, 20), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
    }
    return out;
};

/** In the page: seat tiles against each other, the board, the pots and the table. */
const SEATS = () => {
    const oval = document.querySelector('.gtable-oval');
    const box = oval.getBoundingClientRect();
    const meets = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const seats = [...oval.querySelectorAll('.gseat')].map(e => e.getBoundingClientRect());
    const bets = [...oval.querySelectorAll('.gseat-bet')].map(e => e.getBoundingClientRect());
    const middle = ['.gboard', '.gpot'].map(q => oval.querySelector(q).getBoundingClientRect());
    const clashes = [];
    seats.forEach((a, i) => {
        seats.forEach((b, j) => { if (j > i && meets(a, b)) clashes.push(`seat ${i} on seat ${j}`); });
        middle.forEach((m, k) => { if (meets(a, m)) clashes.push(`seat ${i} on ${k ? 'the pots' : 'the board'}`); });
        if (a.left < box.left - 0.5 || a.right > box.right + 0.5 || a.top < box.top - 0.5 || a.bottom > box.bottom + 0.5) clashes.push(`seat ${i} outside the table`);
    });
    bets.forEach((a, i) => middle.forEach((m, k) => { if (meets(a, m)) clashes.push(`bet ${i} on ${k ? 'the pots' : 'the board'}`); }));
    const me = oval.querySelector('.gseat-me');
    const vw = document.documentElement.clientWidth;
    const overflow = [...document.querySelectorAll('.games-view, .games-view *')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => (r.width || r.height) && (r.right > vw + 0.5 || r.left < -0.5))
        .map(({ e, r }) => `${String(e.className).slice(0, 30)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    return {
        seats: seats.length,
        clashes,
        meAtBottom: !!me && me.classList.contains('gseat-side-bottom') && me.getBoundingClientRect().top > box.top + box.height / 2,
        overflow: overflow.slice(0, 5),
        scrollWidth: document.documentElement.scrollWidth,
        vw,
    };
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });
try {
    for (const [label, ctxOpts] of [
        ['desktop', { viewport: { width: 1280, height: 800 } }],
        ['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
        ['desktop-reduced-motion', { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }],
    ]) {
        const ctx = await browser.newContext(ctxOpts);
        const page = await ctx.newPage();
        page.on('pageerror', e => console.log(`  [${label} pageerror]`, e.message.slice(0, 200)));
        await page.goto(`${BASE}/e2e/poker-table-harness.html`, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.__pokerReady && document.querySelector('.gtable-oval'), null, { timeout: 60000 });
        await sleep(400);
        const before = await page.evaluate(PROBE);
        check(`${label}: before the flop, five slots, all face down, none naming a card`, before.slots === 5 && before.down === 5 && before.downNaming === 0 && before.faces.length === 0, before);
        await page.evaluate(() => window.__pokerFlop());
        await sleep(120);
        const mid = await page.evaluate(PROBE);
        check(`${label}: the flop - three cards, the other two still face down with no card in them`, mid.faces.join(' ') === '3d Ah 2d' && mid.down === 2 && mid.downNaming === 0, mid);
        if (label.endsWith('reduced-motion')) {
            check(`${label}: no animation at all, the cards face up at once`, mid.running.every(n => n === 0) && mid.transforms.every(t => t === 'none'), mid);
        } else {
            const d = mid.delays;
            check(`${label}: each of the three turns with its own animation, one after another`, mid.running.every(n => n === 1) && d[0] > 0 && d[1] > d[0] && d[2] > d[1], mid);
            await shot(page, `${label}-flop-turning`);
            await sleep(1600);
            const after = await page.evaluate(PROBE);
            check(`${label}: when they have turned, every card rests face up`, after.running.every(n => n === 0) && after.transforms.every(t => t === 'none'), after);
        }
        check(`${label}: the main pot and the side pot are on the felt, the one you did not cover marked`,
            mid.pills.length === 2 && /^Main pot 240/.test(mid.pills[0].text) && !mid.pills[0].out && /^Side pot 120/.test(mid.pills[1].text) && mid.pills[1].out, mid.pills);
        const contrast = await page.evaluate(FELT_CONTRAST);
        check(`${label}: every text on the felt >= 4.5:1 against it`, contrast.length >= 4 && contrast.every(c => c.ratio >= 4.5), contrast);
        const seats = await page.evaluate(SEATS);
        check(`${label}: six seats around the table, you at the bottom, nothing on anything, all inside`, seats.seats === 6 && seats.clashes.length === 0 && seats.meAtBottom, seats);
        if (label === 'phone') {
            check('phone: no horizontal overflow (clientWidth)', seats.overflow.length === 0 && seats.scrollWidth <= seats.vw, seats);
            await page.evaluate(() => {
                const d = document.createElement('div');
                d.id = '__w460'; d.style.cssText = 'width:460px;height:8px;background:red;flex-shrink:0';
                document.querySelector('.games-scroll').appendChild(d);
            });
            const g460 = await page.evaluate(SEATS);
            check('POSITIVE CONTROL: a 460 px element injected into the table is caught', g460.overflow.length > 0, g460.overflow);
            await page.evaluate(() => document.getElementById('__w460')?.remove());
        }
        await shot(page, `${label}-flop-side-pot`);
        await ctx.close();
    }
} finally {
    await browser.close();
}

async function shot(page, name) {
    const f = path.join(outdir, `${name}.png`);
    await page.screenshot({ path: f });
    console.log('SHOT', f);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
