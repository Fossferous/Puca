// Right-click a member > "Move to" — can a person actually SEE and HIT the
// channels it lists? Desktop mouse and 390x844 touch, in a real browser.
//
// WHY THIS EXISTS. "Move to" shipped as a side flyout (`left: 100%`) inside a
// menu with `overflow: hidden`, so the list was painted outside the menu's
// clip and nobody ever saw it: the button highlighted and nothing appeared, on
// every release since the feature landed. Every other gate was blind to it —
// jsdom has no layout, and Playwright's locator.click() SCROLLS an overflow
// container to reach a clipped element, so a click-based test "moved" the
// member through a list no mouse can reach (the triage proved exactly that).
// This rig therefore never uses locator.click(): it presses the real mouse
// (desktop) or taps the touchscreen (phone) at the button's centre, and asks
// document.elementFromPoint whether each listed channel is what a finger or
// pointer would land on. Positive control: the "Move to" button itself must
// pass the same check, so a mount that rendered nothing cannot look like a fix.
//
// It also covers the server icon's "Notification Settings" submenu, which the
// user menu's GLOBAL `.context-submenu` rule used to turn into a side flyout
// too (it is meant to expand inline), and which lives inside the server rail.
//
// It bundles the REAL UserContextMenu and ServerList plus the app's global CSS
// (index.css, mobile.css) with esbuild. SILENT and headless: no media at all.
//
//   cd frontend && node e2e/user-menu-move-to-real-browser.mjs
//
// No server and no build needed. CHANNEL=msedge (default) or CHANNEL=bundled.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** A voice channel name with no break opportunity anywhere in it. */
const LONG_NAME = 'TheVeryLongVoiceChannelNameWithoutAnySpacesAtAll_x';
const entry = `
import './index.css';
import './mobile.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserContextMenu } from './components/UserContextMenu';
import { ServerList } from './components/ServerList';

const log = [];
window.__log = log;
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
qc.setQueryData(['servers'], [{ id: 's1', name: 'Rig Server', owner_id: 1, created_at: '2026-01-01T00:00:00Z' }]);

let setMount = () => {};
function App() {
    const [mount, set] = useState(null);
    setMount = set;
    if (!mount) return null;
    if (mount.kind === 'user') {
        return (
            <div className="chat-container">
                <UserContextMenu
                    key={mount.n}
                    userId={2}
                    username="member"
                    currentUserId={1}
                    position={mount.position}
                    showListenerControls={mount.listener}
                    canModerate={true}
                    canMoveMembers={mount.canMove}
                    voiceMoveTargets={[
                        { id: 11, name: 'General voice' },
                        { id: 12, name: 'AFK', isAfk: true },
                        { id: 13, name: 'Gaming' },
                        // A channel name with no break opportunity (names are
                        // capped at 100 bytes, nothing about spaces): it must
                        // wrap inside the menu, not make it scroll sideways.
                        { id: 14, name: ${JSON.stringify(LONG_NAME)} },
                    ]}
                    availableRoles={mount.roles ? [
                        { id: 21, name: 'Moderator', color: '#f9e2af' },
                        { id: 22, name: 'Member' },
                    ] : []}
                    onToggleCustomSounds={() => log.push('sounds')}
                    onVoiceMove={(id) => log.push('move:' + id)}
                    onVoiceDisconnect={() => log.push('disconnect')}
                    onRoleToggle={(id, add) => log.push('role:' + id + ':' + add)}
                    onClose={() => log.push('close')}
                />
            </div>
        );
    }
    return (
        <div className="chat-container" data-mobile-panel="servers">
            <ServerList
                currentServerId="s1"
                currentUserId={1}
                onSelectServer={() => {}}
                onCreateServer={() => {}}
                onJoinServer={() => {}}
            />
        </div>
    );
}
let n = 0;
window.__mountUser = (position, opts = {}) => setMount({
    kind: 'user', n: ++n, position,
    listener: opts.listener ?? true, canMove: opts.canMove ?? true, roles: !!opts.roles,
});
window.__mountServer = () => setMount({ kind: 'server', n: ++n });
createRoot(document.getElementById('root')).render(
    <QueryClientProvider client={qc}><App /></QueryClientProvider>
);
`;
const bundle = await build({
    stdin: { contents: entry, resolveDir: join(here, '..', 'src'), loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true,
    write: false,
    outdir: join(here, '.rig-out'),
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty', '.ogg': 'empty' },
    define: {
        'process.env.NODE_ENV': '"development"',
        __RC_ENABLED__: 'true',
        __APP_VERSION__: '"0.0.0-rig"',
        'import.meta.env': '{"VITE_API_URL":"http://127.0.0.1:9","DEV":false,"PROD":true,"MODE":"production"}',
    },
    // Vite-only `?url` / `?worker` imports (the noise-suppression wasm, the
    // SFU's E2EE worker) are reached through the voice modules the menu
    // imports; nothing here loads them, so each becomes an inert stub.
    plugins: [{
        name: 'url-stub',
        setup(b) {
            b.onResolve({ filter: /\?(url|worker)$/ }, (a) => ({ path: a.path, namespace: 'url-stub' }));
            b.onLoad({ filter: /.*/, namespace: 'url-stub' }, (a) => ({ contents: a.path.endsWith('?worker') ? 'export default class W {}' : 'export default ""', loader: 'js' }));
        },
    }],
    logOverride: { 'empty-import-meta': 'silent' },
    logLevel: 'warning',
});
const appSrc = bundle.outputFiles.find(f => f.path.endsWith('.js')).text;
const cssSrc = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
if (!cssSrc.includes('.user-context-menu')) throw new Error('rig: the real UserContextMenu.css did not make it into the bundle');

const RIG = 'http://rig.localhost';
const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<link rel="stylesheet" href="/rig.css"></head><body><div id="root"></div><script src="/rig.js"></script></body></html>';

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio'],
});
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));

async function open(ctxOpts) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { fail++; console.log('FAIL page error', e.message); });
    // A real origin (not about:blank) so the stores' localStorage reads work.
    // Nothing leaves the browser: this route answers the page and the rig's
    // own two files, and every other request is aborted.
    await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u === RIG + '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
        if (u === RIG + '/rig.css') return route.fulfill({ contentType: 'text/css', body: cssSrc });
        if (u === RIG + '/rig.js') return route.fulfill({ contentType: 'text/javascript', body: appSrc });
        return route.abort();
    });
    // Find an element inside `scope` by its text — for the server menu's rows,
    // the text of the first label span, which excludes the subtitle.
    await page.addInitScript(() => {
        window.__rigFind = (scope, text, tag) => {
            const root = document.querySelector(scope);
            if (!root) return null;
            return [...root.querySelectorAll(tag)].find(e =>
                (e.querySelector(':scope > .menu-text > span')?.textContent ?? e.textContent).trim() === text) ?? null;
        };
    });
    await page.goto(RIG + '/', { waitUntil: 'load' });
    return { ctx, page };
}

/** Scroll `scope` VERTICALLY so the element is inside its box — but only when
 *  a person could: the menu must be a user-scrollable box (overflow-y auto or
 *  scroll). An `overflow: hidden` box can still be scrolled by script, which
 *  is exactly how a click-based test once "moved" a member through a list no
 *  mouse can reach; this refuses to. It never scrolls horizontally. */
async function reveal(page, scope, text, tag = 'button') {
    return page.evaluate(([scope, text, tag]) => {
        const el = window.__rigFind(scope, text, tag);
        const menu = document.querySelector(scope);
        if (!el || !menu) return 'missing';
        const oy = getComputedStyle(menu).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') return 'not-user-scrollable:' + oy;
        const m = menu.getBoundingClientRect(), r = el.getBoundingClientRect();
        if (r.bottom > m.bottom) menu.scrollTop += r.bottom - m.bottom;
        else if (r.top < m.top) menu.scrollTop -= m.top - r.top;
        return 'ok';
    }, [scope, text, tag]);
}

/** Where is the element, and is it what a pointer at its centre lands on? */
async function probe(page, scope, text, tag = 'button') {
    return page.evaluate(([scope, text, tag]) => {
        if (!document.querySelector(scope)) return { found: false, why: 'no ' + scope };
        const el = window.__rigFind(scope, text, tag);
        if (!el) return { found: false, why: 'no element' };
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const W = window.innerWidth, H = window.innerHeight;
        const inViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H;
        const hit = document.elementFromPoint(cx, cy);
        const hits = !!hit && (hit === el || el.contains(hit));
        return {
            found: true, inViewport, hits, cx, cy,
            expanded: el.getAttribute('aria-expanded'),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
            hitDesc: hit ? hit.tagName + '.' + (hit.className || '') : 'null',
            vp: [W, H],
        };
    }, [scope, text, tag]);
}
const desc = (p) => JSON.stringify(p.found ? { rect: p.rect, vp: p.vp, hit: p.hitDesc } : p);
const reachable = (p) => p.found && p.inViewport && p.hits;

async function press(page, p, touch) {
    if (touch) await page.touchscreen.tap(p.cx, p.cy);
    else await page.mouse.click(p.cx, p.cy);
    await frame(page);
}

async function menuBox(page, sel) {
    return page.evaluate((sel) => {
        const m = document.querySelector(sel);
        if (!m) return { ok: false, why: 'no menu' };
        const r = m.getBoundingClientRect();
        return {
            ok: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
            vp: [window.innerWidth, window.innerHeight],
        };
    }, sel);
}

const MENU = '.user-context-menu';
const TARGETS = ['General voice', 'AFK', 'Gaming', LONG_NAME];
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const SURFACES = [
    // The triage's own coordinates: a right-click on a sidebar voice row.
    { name: 'desktop 1400x900', ctx: { viewport: { width: 1400, height: 900 } }, at: { x: 195, y: 253 }, touch: false },
    // A short window: the expansion must not push anything off the bottom.
    { name: 'desktop 1280x560 (short window)', ctx: { viewport: { width: 1280, height: 560 } }, at: { x: 600, y: 300 }, touch: false },
    // So short the menu hits its height cap ABOVE "Move to"'s list: opening
    // the section has to scroll the menu to show it.
    { name: 'desktop 1100x250 (very short)', ctx: { viewport: { width: 1100, height: 250 } }, at: { x: 500, y: 40 }, touch: false },
    // A phone: a tap on a voice row, and one near the bottom-right corner.
    { name: 'phone 390x844 (tap)', ctx: PHONE, at: { x: 124, y: 137 }, touch: true },
    { name: 'phone 390x844 (bottom-right)', ctx: PHONE, at: { x: 330, y: 700 }, touch: true },
];
const DESK = SURFACES.find(s => s.name === 'desktop 1400x900');
const TAP = SURFACES.find(s => s.name === 'phone 390x844 (tap)');
const VSHORT = SURFACES.find(s => s.name === 'desktop 1100x250 (very short)');

for (const s of SURFACES) {
    const { ctx, page } = await open(s.ctx);
    await page.evaluate((at) => window.__mountUser(at), s.at);
    await frame(page);

    // Positive control: the toggle itself is on screen and hittable.
    const btn = await probe(page, MENU, 'Move to');
    ck(reachable(btn), `${s.name}: positive control — "Move to" is on screen and hittable`, desc(btn));
    ck(btn.expanded === 'false', `${s.name}: "Move to" starts collapsed (aria-expanded=false)`, String(btn.expanded));
    if (!btn.found) { await ctx.close(); continue; }

    await press(page, btn, s.touch);
    const after = await probe(page, MENU, 'Move to');
    ck(after.expanded === 'true', `${s.name}: "Move to" reports aria-expanded=true once open`, String(after.expanded));
    // No scrolling here: opening the section must itself bring the targets
    // into view.
    for (const t of TARGETS) {
        const p = await probe(page, MENU, t);
        ck(reachable(p), `${s.name}: target "${t}" is inside the viewport and is what the pointer lands on`, desc(p));
    }
    ck(reachable(await probe(page, MENU, 'Move to')), `${s.name}: "Move to" itself is still on screen once open`);
    const m = await menuBox(page, MENU);
    ck(m.ok, `${s.name}: the expanded menu is wholly inside the viewport`, JSON.stringify(m));
    const sideways = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    }, MENU);
    ck(sideways.scrollWidth <= sideways.clientWidth, `${s.name}: nothing in the menu overflows sideways`, JSON.stringify(sideways));
    // ...and the long name is wrapped, whole, inside its own row rather than
    // clipped (the row's text must not overflow the row).
    const longRow = await page.evaluate(([sel, name]) => {
        const el = window.__rigFind(sel, name, 'button');
        return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: Math.round(el.getBoundingClientRect().height) } : null;
    }, [MENU, LONG_NAME]);
    ck(!!longRow && longRow.scrollWidth <= longRow.clientWidth, `${s.name}: the long channel name wraps inside its row`, JSON.stringify(longRow));

    // A real press on a listed channel moves the member there.
    await page.evaluate(() => { window.__log.length = 0; });
    const g = await probe(page, MENU, 'Gaming');
    if (g.found) {
        await press(page, g, s.touch);
        const l = await page.evaluate(() => window.__log.slice());
        ck(l.includes('move:13'), `${s.name}: a real ${s.touch ? 'tap' : 'click'} on "Gaming" moves the member there`, JSON.stringify(l));
    }
    await ctx.close();
}

// Nothing is pushed off-screen: with the section open, the menu's LAST item is
// reachable, scrolling the menu the way a person can if it had to cap its
// height.
for (const s of SURFACES) {
    const { ctx, page } = await open(s.ctx);
    await page.evaluate((at) => window.__mountUser(at), s.at);
    await frame(page);
    const btn = await probe(page, MENU, 'Move to');
    if (!btn.found) { ck(false, `${s.name}: menu mounted`); await ctx.close(); continue; }
    await press(page, btn, s.touch);
    const last = 'Disable custom sounds';
    const how = await reveal(page, MENU, last);
    const p = await probe(page, MENU, last);
    ck(reachable(p), `${s.name}: the last item ("${last}") is reachable with the section open`, `${how} ${desc(p)}`);
    await ctx.close();
}

// Member-list case: the viewer is NOT in a call with this member, but holds
// MOVE_MEMBERS. Moderation is offered; the local listener controls are not.
for (const s of [DESK, TAP]) {
    const { ctx, page } = await open(s.ctx);
    await page.evaluate((at) => window.__mountUser(at, { listener: false, canMove: true }), s.at);
    await frame(page);
    const mv = await probe(page, MENU, 'Move to');
    const dc = await probe(page, MENU, 'Disconnect from voice');
    const vol = await page.evaluate((sel) => !!document.querySelector(sel + ' input[type="range"]'), MENU);
    ck(reachable(mv) && reachable(dc), `${s.name}: not in their call — "Move to" and "Disconnect from voice" offered`, desc(mv) + ' ' + desc(dc));
    ck(!vol, `${s.name}: not in their call — no local volume slider`);
    await ctx.close();
}

// Roles: the same inline pattern (the list is not wired from Chat today, but
// the component must not carry a second clipped flyout).
for (const s of [DESK, TAP]) {
    const { ctx, page } = await open(s.ctx);
    await page.evaluate((at) => window.__mountUser(at, { roles: true }), s.at);
    await frame(page);
    await reveal(page, MENU, 'Roles');
    const roles = await probe(page, MENU, 'Roles');
    ck(reachable(roles), `${s.name}: positive control — "Roles" is hittable`, desc(roles));
    if (roles.found) {
        await press(page, roles, s.touch);
        for (const r of ['Moderator', 'Member']) {
            const how = await reveal(page, MENU, r, 'label');
            const p = await probe(page, MENU, r, 'label');
            ck(reachable(p), `${s.name}: role "${r}" is on screen and hittable`, `${how} ${desc(p)}`);
        }
    }
    await ctx.close();
}

// Server icon > Notification Settings: inline under its row, inside the menu,
// on screen at desktop and phone width (on a phone the rail is a 72px,
// transformed, overflow-clipped panel — the menu must not be clipped by it).
const SM = '.server-context-menu';
const LEVELS = ['All Messages', 'Mentions Only', 'Nothing'];
for (const s of [DESK, TAP, VSHORT]) {
    const { ctx, page } = await open(s.ctx);
    await page.evaluate(() => window.__mountServer());
    await frame(page);
    const icon = await page.evaluate(() => {
        const el = document.querySelector('.server-icons .server-icon');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    ck(!!icon, `${s.name}: server icon rendered`);
    if (!icon) { await ctx.close(); continue; }
    // A right-click on desktop; Android's long-press delivers the same
    // contextmenu event, which Playwright's touchscreen cannot synthesise.
    await page.mouse.click(icon.cx, icon.cy, { button: 'right' });
    await frame(page);
    const toggle = await probe(page, SM, 'Notification Settings', 'div.has-submenu');
    ck(reachable(toggle), `${s.name}: positive control — "Notification Settings" is on screen and hittable`, desc(toggle));
    const closed = await menuBox(page, SM);
    ck(closed.ok, `${s.name}: the server menu is wholly inside the viewport`, JSON.stringify(closed));
    if (!toggle.found) { await ctx.close(); continue; }
    await press(page, toggle, s.touch);
    const placement = await page.evaluate((SM) => {
        const menu = document.querySelector(SM);
        const sub = menu?.querySelector('.context-submenu');
        if (!sub) return { found: false };
        const m = menu.getBoundingClientRect(), r = sub.getBoundingClientRect();
        return {
            found: true,
            position: getComputedStyle(sub).position,
            insideMenu: r.left >= m.left - 0.5 && r.right <= m.right + 0.5,
            sub: [r.left, r.top, r.right, r.bottom].map(Math.round),
            menu: [m.left, m.top, m.right, m.bottom].map(Math.round),
        };
    }, SM);
    ck(placement.found && placement.position === 'static' && placement.insideMenu,
        `${s.name}: the notification levels expand INLINE inside the server menu (no flyout)`, JSON.stringify(placement));
    for (const level of LEVELS) {
        const how = await reveal(page, SM, level, '.context-submenu .context-menu-item');
        const p = await probe(page, SM, level, '.context-submenu .context-menu-item');
        ck(reachable(p), `${s.name}: notification level "${level}" is on screen and hittable`, `${how} ${desc(p)}`);
    }
    const expanded = await menuBox(page, SM);
    ck(expanded.ok, `${s.name}: the expanded server menu is wholly inside the viewport`, JSON.stringify(expanded));
    await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
