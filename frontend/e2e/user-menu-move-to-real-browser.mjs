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
// And the mode selector's menu (docs/SERVER_MODES.md) from the KEYBOARD. It renders last in the
// page, so with the focus left on the selector a keyboard had every control in the sidebar and
// the chat between it and the menu, and the only control that switches a mode was out of reach.
// With real keys: the first enabled item takes the focus, role=menu and menuitem, the arrows,
// Home and End walk it, Escape gives the focus back to the selector, Tab closes it and goes on
// from there, and an Enter held down from opening it presses nothing. NEGATIVE CONTROLS: the same
// items opened by a right click take no focus and no role, and arrows there move nothing. Opened
// with a mouse or a finger the focus is on the menu and on none of its items, no row wears anything
// and Enter and Space press nothing, or a stray key would turn the mode off with nothing on screen
// to say so; the arrows still go in. And when that menu closes, by a pick, by Escape or by a press
// elsewhere, the focus goes to nothing: back on the selector a stray Space or Enter opens the menu
// again as a key's, with Off under the focus for the next one, and a third answers the question Off
// asks. So every way out is followed by the stray keys, the real question's Cancel too (under a fake
// desktop shell). The control is a key's menu, which does give the focus back. At 390x844: 44 px
// rows, nothing clipped, inside the window, and a tap lands.
//
// And a hold on Space or Enter through the REAL hotkeys registry (api/hotkeys.ts), in Edge, Firefox
// and WebKit, because each browser decides for itself what these keys press. A push-to-talk on Space
// clicked whatever had the focus on every press: taps and held keys (repeats) now press no button,
// link, checkbox, radio, summary or button inside [data-owns-keys], and the hold's down and up still
// arrive. The real chain with the hold bound: a mouse's pick, then taps; a key's menu closed, then
// taps on the selector; a question, then taps on OK. CONTROLS: with no hold bound the same keys do
// press those controls; in a field, a textarea and editable text a bound key still types and still
// holds; a hold on Tab or Escape keeps its key's default; a hold bound to Ctrl+Space leaves a bare
// Space alone; a click elsewhere then taps press nothing. A press action on Space held down no longer
// presses the button on its repeats either.
//
// It bundles the REAL UserContextMenu, ServerList and AppDialogs plus the app's global CSS
// (index.css, mobile.css) with esbuild. SILENT and headless: no media at all.
//
//   cd frontend && node e2e/user-menu-move-to-real-browser.mjs
//
// No server and no build needed. CHANNEL=msedge (default) or CHANNEL=bundled.
import { chromium, firefox, webkit } from '@playwright/test';
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
import { ContextMenu } from './components/ContextMenu';
import { useContextMenu } from './components/contextMenuUtils';
import { ModeSelector } from './components/modes/ModeSelector';
import { modeMenuItems } from './components/modes/modeMenu';
import { AppDialogs } from './components/AppDialogs';
import { askConfirm } from './api/appDialogs';
import { registerHold, registerPress, unregisterHold, unregisterPress } from './api/hotkeys';

const log = [];
window.__log = log;
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
qc.setQueryData(['servers'], [{ id: 's1', name: 'Rig Server', owner_id: 1, created_at: '2026-01-01T00:00:00Z' }]);

const mode = (id, name) => ({ id, name, background_file_id: null, accent_color: null, home_channel_id: 21, auto_off: false, channel_ids: [] });
const MODES = {
    active_mode_id: 3, can_switch: true, can_edit: true, can_call_back: true,
    modes: [mode(3, 'Game Night'), mode(4, 'Movie Night'), mode(5, ${JSON.stringify(LONG_NAME)})],
};
/** Chat's wiring of the selector: the same hook, menu, items and calls. */
function ModeRig({ disabledFirst, people }) {
    const { contextMenu, showContextMenu, showContextMenuAt, hideContextMenu } = useContextMenu();
    // Chat's switchMode, the part that matters here: people in the rooms get a question.
    const switchMode = async (id) => {
        if (people && !await askConfirm(people + ' people are in the voice channels of Game Night.')) { log.push('refused'); return; }
        log.push('switch:' + id);
    };
    const items = () => {
        const list = modeMenuItems({
            data: MODES, activeModeId: 3, homeName: 'Town Square',
            onSwitch: (id) => { void switchMode(id); }, onCallBack: () => log.push('callback'), onManage: () => log.push('manage'),
        });
        if (disabledFirst) list[0] = { ...list[0], disabled: true };
        return list;
    };
    return (
        <div className="chat-container">
            <div>
                <button id="rig-before">before</button>
                <ModeSelector data={MODES} activeModeId={3} homeName="Town Square" onOpen={(at, opener, fromKeyboard) => showContextMenuAt(at, items(), opener, 'Mode', fromKeyboard)} />
                <button id="rig-after">after</button>
                <div id="rig-row" onContextMenu={(e) => showContextMenu(e, items())}>A row to right-click</div>
                <div id="rig-nofocus" onMouseDown={(e) => e.preventDefault()}>A press here moves no focus</div>
            </div>
            {contextMenu && (
                <ContextMenu
                    items={contextMenu.items}
                    position={contextMenu.position}
                    onClose={hideContextMenu}
                    opener={contextMenu.opener}
                    label={contextMenu.label}
                    fromKeyboard={contextMenu.fromKeyboard}
                />
            )}
        </div>
    );
}

/** The kinds of thing Space and Enter press, and the kinds they type into. */
const pressed = (name) => () => log.push(name);
function ControlsRig() {
    return (
        <div className="chat-container">
            <div>
                <button id="c-button" onClick={pressed('button')}>Mute</button>
                <a id="c-link" href="#went" onClick={(e) => { e.preventDefault(); log.push('link'); }}>A link</a>
                <input id="c-check" type="checkbox" onChange={pressed('check')} />
                <input id="c-radio" type="radio" onChange={pressed('radio')} />
                <input id="c-inbutton" type="button" value="An input button" onClick={pressed('inbutton')} />
                <details><summary id="c-summary" onClick={pressed('summary')}>A summary</summary>Inside it</details>
                <div data-owns-keys=""><button id="c-owned" onClick={pressed('owned')}>In a dialog that owns its keys</button></div>
                <input id="c-text" type="text" />
                <textarea id="c-area" />
                <div id="c-edit" contentEditable suppressContentEditableWarning style={{ minHeight: 20 }} />
            </div>
        </div>
    );
}

let setMount = () => {};
function App() {
    const [mount, set] = useState(null);
    setMount = set;
    window.__rigReady = true;
    if (!mount) return null;
    if (mount.kind === 'mode') return <ModeRig key={mount.n} disabledFirst={mount.disabledFirst} people={mount.people} />;
    if (mount.kind === 'controls') return <ControlsRig key={mount.n} />;
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
window.__mountMode = (opts = {}) => setMount({ kind: 'mode', n: ++n, disabledFirst: !!opts.disabledFirst, people: opts.people ?? 0 });
window.__mountControls = () => setMount({ kind: 'controls', n: ++n });
window.__hold = { down: 0, up: 0 };
window.__bindHold = (keyCode, mods = {}) => registerHold('rig.hold', () => ({ keyCode, ctrl: !!mods.ctrl, alt: false, shift: false }), {
    onDown: () => { window.__hold.down++; },
    onUp: () => { window.__hold.up++; },
});
window.__unbindHold = () => unregisterHold('rig.hold');
window.__bindPress = (keyCode) => registerPress('rig.press', () => ({ keyCode, ctrl: false, alt: false, shift: false }), () => log.push('press-action'));
window.__unbindPress = () => unregisterPress('rig.press');
// What a key's default was left as, once everything has heard it.
window.addEventListener('keydown', (e) => { window.__lastKey = { key: e.key, prevented: e.defaultPrevented }; });
createRoot(document.getElementById('root')).render(
    <QueryClientProvider client={qc}><App /><AppDialogs /></QueryClientProvider>
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

async function open(ctxOpts, { desktopShell = false, on = browser } = {}) {
    const ctx = await on.newContext(ctxOpts);
    const page = await ctx.newPage();
    // api/appDialogs.ts asks in the page only in the desktop shell: all it asks is that this exists.
    if (desktopShell) await page.addInitScript(() => { window.__TAURI_INTERNALS__ = {}; });
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
    await page.waitForFunction(() => window.__rigReady);
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

// ======================= the mode selector's menu ===========================
const MM = '.context-menu';
const ROWS = ['Off', 'Game Night', 'Movie Night', LONG_NAME, 'Call everyone to Town Square', 'Manage modes'];
/** What has the focus, by the name a check can read. */
const focusOn = (page) => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return a.getAttribute('data-testid') || a.id || a.textContent.trim();
});
const logged = (page) => page.evaluate(() => window.__log.slice());
const menuOpen = (page) => page.evaluate((m) => !!document.querySelector(m), MM);
/** The focus is on the menu itself, and so on none of its items. */
const onTheMenu = (page) => page.evaluate((m) => document.activeElement === document.querySelector(m), MM);
const key = async (page, name) => { await page.keyboard.press(name); await frame(page); };
/** How the row with the focus looks, and whether a browser calls it a keyboard's focus. */
const ring = (page) => page.evaluate(() => {
    const a = document.activeElement;
    const c = getComputedStyle(a);
    return { visible: a.matches(':focus-visible'), outline: c.outlineStyle, background: c.backgroundColor };
});

{
    const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } });
    const fresh = async (opts) => { await page.evaluate((o) => { window.__log.length = 0; window.__mountMode(o); }, opts); await frame(page); };
    await fresh();
    await page.locator('#rig-before').focus();
    await key(page, 'Tab');
    ck(await focusOn(page) === 'mode-selector', 'keyboard: Tab reaches the selector', await focusOn(page));

    await key(page, 'Enter');
    ck(await menuOpen(page), 'keyboard: Enter on the selector opens the menu');
    ck(await focusOn(page) === 'Off', 'keyboard: the first item has the focus, not the control behind it', await focusOn(page));
    await page.waitForTimeout(150); // The row's fill has a 0.1 s transition.
    const seen = await ring(page);
    ck(seen.visible && seen.outline !== 'none' && seen.background === 'rgb(88, 101, 242)', 'keyboard: and it shows, ringed and filled', JSON.stringify(seen));
    const roles = await page.evaluate((m) => {
        const menu = document.querySelector(m);
        return {
            role: menu.getAttribute('role'),
            label: menu.getAttribute('aria-label'),
            items: [...menu.querySelectorAll('button')].map((b) => b.getAttribute('role')),
            separators: [...menu.querySelectorAll('.context-menu-separator')].map((d) => d.getAttribute('role')),
        };
    }, MM);
    ck(roles.role === 'menu' && roles.label === 'Mode' && roles.items.length === ROWS.length && roles.items.every((r) => r === 'menuitem')
        && roles.separators.length === 1 && roles.separators[0] === 'separator', 'keyboard: role=menu with a name, role=menuitem on every item', JSON.stringify(roles));
    ck((await logged(page)).length === 0, 'keyboard: opening it pressed nothing', JSON.stringify(await logged(page)));

    const walked = [];
    for (let i = 1; i < ROWS.length; i++) { await key(page, 'ArrowDown'); walked.push(await focusOn(page)); }
    ck(JSON.stringify(walked) === JSON.stringify(ROWS.slice(1)), 'keyboard: Down walks every item in order, over the separator', JSON.stringify(walked));
    await key(page, 'ArrowDown');
    ck(await focusOn(page) === 'Off', 'keyboard: Down from the last comes round to the first', await focusOn(page));
    await key(page, 'ArrowUp');
    ck(await focusOn(page) === 'Manage modes', 'keyboard: Up from the first comes round to the last', await focusOn(page));
    await key(page, 'ArrowUp');
    ck(await focusOn(page) === 'Call everyone to Town Square', 'keyboard: Up goes back one, over nothing', await focusOn(page));
    await key(page, 'Home');
    ck(await focusOn(page) === 'Off', 'keyboard: Home is the first item', await focusOn(page));
    await key(page, 'End');
    ck(await focusOn(page) === 'Manage modes', 'keyboard: End is the last item', await focusOn(page));
    await key(page, 'Escape');
    ck(!await menuOpen(page) && await focusOn(page) === 'mode-selector', 'keyboard: Escape closes it and the focus is back on the selector', await focusOn(page));
    ck((await logged(page)).length === 0, 'keyboard: and all of that pressed nothing', JSON.stringify(await logged(page)));

    await key(page, 'Space');
    ck(await menuOpen(page) && await focusOn(page) === 'Off', 'keyboard: Space opens it as well, focus on the first item', await focusOn(page));
    await key(page, 'Tab');
    ck(!await menuOpen(page) && await focusOn(page) === 'rig-after', 'keyboard: Tab closes it and goes on to what comes after the selector', await focusOn(page));
    await page.keyboard.press('Shift+Tab');
    await frame(page);
    await key(page, 'Enter');
    await page.keyboard.press('Shift+Tab');
    await frame(page);
    ck(!await menuOpen(page) && await focusOn(page) === 'rig-before', 'keyboard: Shift+Tab closes it and goes back from the selector', await focusOn(page));

    await key(page, 'Tab');
    await key(page, 'Enter');
    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    ck(JSON.stringify(await logged(page)) === '["switch:4"]', 'keyboard: Enter on an item presses that item, once', JSON.stringify(await logged(page)));
    ck(!await menuOpen(page) && await focusOn(page) === 'mode-selector', 'keyboard: and the focus is back on the selector, so a question has somewhere to return it', await focusOn(page));
    await key(page, 'Enter');
    await key(page, 'End');
    await key(page, 'Space');
    ck(JSON.stringify(await logged(page)) === '["switch:4","manage"]', 'keyboard: Space on an item presses it too', JSON.stringify(await logged(page)));

    // The Enter that opens it, held down. Off is under it now, and Off can end calls.
    await fresh();
    await page.locator('[data-testid="mode-selector"]').focus();
    await page.keyboard.down('Enter');
    await frame(page);
    ck(await focusOn(page) === 'Off', 'held Enter: the first press opened it', await focusOn(page));
    await page.keyboard.down('Enter'); // Playwright marks a second down as the key repeating.
    await frame(page);
    await page.keyboard.down('Enter');
    await frame(page);
    await page.keyboard.up('Enter');
    await frame(page);
    ck((await logged(page)).length === 0 && await menuOpen(page), 'held Enter: the repeats press nothing, and the menu stays', JSON.stringify(await logged(page)));
    await key(page, 'Enter');
    ck(JSON.stringify(await logged(page)) === '["switch:null"]', 'CONTROL: a new press of Enter does press Off', JSON.stringify(await logged(page)));

    // An item that cannot be pressed takes no focus.
    await fresh({ disabledFirst: true });
    await page.locator('[data-testid="mode-selector"]').focus();
    await key(page, 'Enter');
    ck(await focusOn(page) === 'Game Night', 'disabled first item: the focus starts on the first it can press', await focusOn(page));
    await key(page, 'ArrowUp');
    ck(await focusOn(page) === 'Manage modes', 'disabled first item: Up goes round past it', await focusOn(page));
    await key(page, 'Home');
    ck(await focusOn(page) === 'Game Night', 'disabled first item: Home stops short of it', await focusOn(page));
    await key(page, 'Escape');

    // NEGATIVE CONTROL: the same items at the pointer. A right click stays what it was.
    await fresh();
    const row = await page.locator('#rig-row').boundingBox();
    await page.mouse.click(row.x + 20, row.y + row.height / 2, { button: 'right' });
    await frame(page);
    ck(await menuOpen(page), 'CONTROL: a right click opens the same items');
    const atPointer = await page.evaluate((m) => {
        const menu = document.querySelector(m);
        return {
            inside: menu.contains(document.activeElement),
            role: menu.getAttribute('role'),
            label: menu.getAttribute('aria-label'),
            items: [...menu.querySelectorAll('button')].map((b) => b.getAttribute('role')),
            count: menu.querySelectorAll('button').length,
        };
    }, MM);
    ck(!atPointer.inside && atPointer.count === ROWS.length, 'NEGATIVE CONTROL: right click: the first item does NOT take the focus', JSON.stringify(atPointer));
    ck(atPointer.role === null && atPointer.label === null && atPointer.items.every((r) => r === null), 'NEGATIVE CONTROL: right click: no menu role', JSON.stringify(atPointer));
    const beforeArrow = await focusOn(page);
    await key(page, 'ArrowDown');
    await key(page, 'End');
    ck(await focusOn(page) === beforeArrow, 'NEGATIVE CONTROL: right click: the arrows and End move nothing', await focusOn(page));
    await key(page, 'Escape');
    ck(!await menuOpen(page) && await focusOn(page) === beforeArrow, 'NEGATIVE CONTROL: right click: Escape closes it and gives the focus to nobody', await focusOn(page));

    // A mouse on the selector: the focus goes to the menu, and to none of its items. Nothing on
    // the screen would say an item had it, and Off is the first: a stray Enter or Space, or a
    // push-to-talk on Space coming up, would turn the mode off. The control is the keyboard's
    // open above, where "a new press of Enter does press Off".
    await fresh();
    const sel = await page.locator('[data-testid="mode-selector"]').boundingBox();
    const clickSelector = async () => { await page.mouse.click(sel.x + sel.width / 2, sel.y + sel.height / 2); await frame(page); };
    // The chain a mouse's menu must not start: Space or Enter on the selector opens it as a key's, and
    // the next one presses Off. Here with no hold bound at all: this half is about the focus alone.
    const strayKeys = async (after) => {
        const before = (await logged(page)).length;
        for (const name of ['Space', 'Enter', 'Space', 'Enter']) await key(page, name);
        ck(!await menuOpen(page) && (await logged(page)).length === before, `mouse: after ${after}, stray Space and Enter open nothing and press nothing`, JSON.stringify(await logged(page)));
    };
    await clickSelector();
    ck(await onTheMenu(page), 'mouse: the focus is on the menu, on no item', await focusOn(page));
    await page.mouse.move(2, 2);
    await page.waitForTimeout(150); // The row's fill has a 0.1 s transition.
    const quiet = await ring(page);
    ck(!quiet.visible && quiet.outline === 'none', 'mouse: which shows no ring', JSON.stringify(quiet));
    const rowsWearing = await page.evaluate((m) => [...document.querySelectorAll(`${m} button`)].filter((b) => {
        const c = getComputedStyle(b);
        return c.outlineStyle !== 'none' || c.backgroundColor !== 'rgba(0, 0, 0, 0)';
    }).map((b) => b.textContent), MM);
    ck(rowsWearing.length === 0, 'mouse: and no item wears a ring or a fill', JSON.stringify(rowsWearing));
    await key(page, 'Enter');
    ck((await logged(page)).length === 0 && await menuOpen(page), 'mouse: a stray Enter presses nothing, and the menu stays', JSON.stringify(await logged(page)));
    await key(page, 'Space');
    ck((await logged(page)).length === 0 && await menuOpen(page), 'mouse: nor does a stray Space, or a push-to-talk on it', JSON.stringify(await logged(page)));
    ck(await onTheMenu(page), 'mouse: and the focus is still on the menu', await focusOn(page));
    await key(page, 'ArrowDown');
    ck(await focusOn(page) === 'Off', 'mouse: Down goes in at the first item', await focusOn(page));
    await page.waitForTimeout(150);
    const lit = await ring(page);
    ck(lit.visible && lit.outline !== 'none' && lit.background === 'rgb(88, 101, 242)', 'mouse: and there it shows, as a keyboard\'s does', JSON.stringify(lit));
    await key(page, 'Escape');
    ck(!await menuOpen(page) && await focusOn(page) === 'body', 'mouse: Escape leaves the focus on nothing, not on the selector', await focusOn(page));
    await strayKeys('Escape');
    await clickSelector();
    await key(page, 'ArrowUp');
    ck(await focusOn(page) === 'Manage modes', 'mouse: Up goes in at the last item', await focusOn(page));
    await key(page, 'Escape');
    await clickSelector();
    await key(page, 'Tab');
    ck(!await menuOpen(page) && await focusOn(page) === 'rig-after', 'mouse: Tab closes it and goes on from the selector', await focusOn(page));
    ck((await logged(page)).length === 0, 'mouse: and all of that pressed nothing', JSON.stringify(await logged(page)));
    await clickSelector();
    for (const name of ROWS) {
        const p = await probe(page, MM, name);
        ck(reachable(p), `mouse: "${name}" is on screen and what a pointer hits`, desc(p));
    }
    await press(page, await probe(page, MM, 'Movie Night'), false);
    ck(JSON.stringify(await logged(page)) === '["switch:4"]' && !await menuOpen(page), 'mouse: a click on an item presses it', JSON.stringify(await logged(page)));
    ck(await focusOn(page) === 'body', 'mouse: and the focus is on nothing, not on the selector', await focusOn(page));
    await page.evaluate(() => { window.__log.length = 0; });
    await strayKeys('a pick');

    // A press elsewhere. The press moves the focus by itself, unless what it lands on stops that
    // (a notice's close button does): the selector is still not left holding it, however it got it.
    const pressOn = async (selector) => { const b = await page.locator(selector).boundingBox(); await page.mouse.click(b.x + 5, b.y + 5); await frame(page); };
    await clickSelector();
    await pressOn('#rig-row');
    ck(!await menuOpen(page) && await focusOn(page) === 'body', 'mouse: a press elsewhere closes it, the focus on nothing', await focusOn(page));
    await strayKeys('a press elsewhere');
    await clickSelector();
    await page.locator('[data-testid="mode-selector"]').focus();
    await pressOn('#rig-nofocus');
    ck(!await menuOpen(page) && await focusOn(page) === 'body', 'mouse: a press that moves no focus still does not leave the selector holding it', await focusOn(page));

    // CONTROL: nothing has stopped these keys. From the selector, a key's menu, as above.
    await page.locator('[data-testid="mode-selector"]').focus();
    await key(page, 'Space');
    ck(await menuOpen(page) && await focusOn(page) === 'Off', 'CONTROL: with the focus put on the selector, Space does open it as a key\'s', await focusOn(page));
    await key(page, 'Space');
    ck(JSON.stringify(await logged(page)) === '["switch:null"]', 'CONTROL: and the next Space does press Off', JSON.stringify(await logged(page)));
    await ctx.close();
}

{
    // The desktop's question, which is in the page (components/AppDialogs.tsx). It gives the focus
    // back to what had it, so the menu's item decides where a Cancel lands.
    const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } }, { desktopShell: true });
    const fresh = async () => { await page.evaluate(() => { window.__log.length = 0; window.__mountMode({ people: 2 }); }); await frame(page); };
    const QB = (name) => page.locator('.app-question button', { hasText: name });
    const questionOpen = () => page.evaluate(() => !!document.querySelector('.app-question'));
    const clickOn = async (locator) => { const b = await locator.boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await frame(page); };
    await fresh();
    await clickOn(page.locator('[data-testid="mode-selector"]'));
    await press(page, await probe(page, MM, 'Movie Night'), false);
    ck(await questionOpen() && await focusOn(page) === 'OK', 'question, mouse: a pick that asks puts the focus on OK', await focusOn(page));
    await clickOn(QB('Cancel'));
    ck(!await questionOpen() && JSON.stringify(await logged(page)) === '["refused"]', 'question, mouse: Cancel refuses', JSON.stringify(await logged(page)));
    ck(await focusOn(page) === 'body', 'question, mouse: and the focus lands on nothing', await focusOn(page));
    await page.evaluate(() => { window.__log.length = 0; });
    for (const name of ['Space', 'Enter', 'Space', 'Enter']) await key(page, name);
    ck(!await menuOpen(page) && !await questionOpen() && (await logged(page)).length === 0, 'question, mouse: and stray keys open nothing and press nothing', JSON.stringify(await logged(page)));

    await fresh();
    await clickOn(page.locator('[data-testid="mode-selector"]'));
    await press(page, await probe(page, MM, 'Movie Night'), false);
    await key(page, 'Escape');
    ck(!await questionOpen() && await focusOn(page) === 'body', 'question, mouse: Escape refuses, the focus on nothing', await focusOn(page));

    await fresh();
    await page.locator('[data-testid="mode-selector"]').focus();
    await key(page, 'Enter');
    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    ck(await questionOpen() && await focusOn(page) === 'OK', 'question, keyboard: a pick that asks puts the focus on OK', await focusOn(page));
    await clickOn(QB('Cancel'));
    ck(!await questionOpen() && await focusOn(page) === 'mode-selector', 'question, keyboard: Cancel gives it back to the selector, where a keyboard carries on', await focusOn(page));
    await key(page, 'Enter');
    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    await key(page, 'Escape');
    ck(!await questionOpen() && await focusOn(page) === 'mode-selector', 'question, keyboard: Escape does too', await focusOn(page));
    await ctx.close();
}

{
    // A window too short for the list: the focus takes the list with it.
    const { ctx, page } = await open({ viewport: { width: 1100, height: 200 } });
    await page.evaluate(() => window.__mountMode());
    await frame(page);
    await page.locator('[data-testid="mode-selector"]').focus();
    await key(page, 'Enter');
    const first = await probe(page, MM, 'Off');
    ck(reachable(first), 'short window: the first item with the focus is on screen', desc(first));
    await key(page, 'End');
    const last = await probe(page, MM, 'Manage modes');
    ck(await focusOn(page) === 'Manage modes' && reachable(last), 'short window: End scrolls the last item into view', desc(last));
    await ctx.close();
}

{
    const { ctx, page } = await open(PHONE);
    await page.evaluate(() => { window.__log.length = 0; window.__mountMode(); });
    await frame(page);
    const sel = await page.locator('[data-testid="mode-selector"]').boundingBox();
    await page.touchscreen.tap(sel.x + sel.width / 2, sel.y + sel.height / 2);
    await page.waitForTimeout(400); // It scales in from 95%: measured any sooner, 44 px reads 42.
    ck(await onTheMenu(page), 'phone: the focus is on the menu, on no item', await focusOn(page));
    const quiet = await ring(page);
    ck(!quiet.visible && quiet.outline === 'none', 'phone: which shows no ring', JSON.stringify(quiet));
    const box = await menuBox(page, MM);
    ck(box.ok, 'phone: the menu is wholly inside the window', JSON.stringify(box));
    const shape = await page.evaluate((m) => {
        const menu = document.querySelector(m);
        return {
            heights: [...menu.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height)),
            clippedDown: menu.scrollHeight > menu.clientHeight,
            clippedAcross: menu.scrollWidth > menu.clientWidth,
            page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        };
    }, MM);
    ck(shape.heights.length === ROWS.length && shape.heights.every((h) => h >= 44), 'phone: every row is a 44 px target', JSON.stringify(shape.heights));
    ck(!shape.clippedDown && !shape.clippedAcross && shape.page, 'phone: nothing is clipped and nothing scrolls sideways', JSON.stringify(shape));
    for (const name of ROWS) {
        const p = await probe(page, MM, name);
        ck(reachable(p), `phone: "${name}" is on screen and what a finger lands on`, desc(p));
    }
    await press(page, await probe(page, MM, 'Movie Night'), true);
    ck(JSON.stringify(await logged(page)) === '["switch:4"]' && !await menuOpen(page), 'phone: a tap on an item presses it, and closes the menu', JSON.stringify(await logged(page)));
    ck(await focusOn(page) === 'body', 'phone: and the focus is on nothing, not on the selector', await focusOn(page));
    await ctx.close();
}

// ======================= a hold on Space or Enter ===========================
const SPACE = 32, ENTER = 13;
/** One whole engine: what these keys press is each browser's own decision. */
async function holdKeys(engine, on) {
    const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } }, { on, desktopShell: true });
    const say = (what) => `${engine}: ${what}`;
    /** A quick press; and one held long enough to repeat (Playwright marks a second down as one). */
    const tap = async (name) => { await page.keyboard.down(name); await frame(page); await page.keyboard.up(name); await frame(page); };
    const heldDown = async (name) => {
        await page.keyboard.down(name);
        await page.keyboard.down(name);
        await page.keyboard.down(name);
        await frame(page);
        await page.keyboard.up(name);
        await frame(page);
    };
    const reset = () => page.evaluate(() => { window.__log.length = 0; window.__hold.down = 0; window.__hold.up = 0; });
    const hold = () => page.evaluate(() => ({ ...window.__hold }));
    const controls = async () => { await page.evaluate(() => { window.__log.length = 0; window.__mountControls(); }); await frame(page); };
    const CONTROLS = ['c-button', 'c-link', 'c-check', 'c-radio', 'c-inbutton', 'c-summary', 'c-owned'];
    const toggled = () => page.evaluate(() => ({
        check: document.getElementById('c-check').checked,
        radio: document.getElementById('c-radio').checked,
        open: document.querySelector('details').open,
        hash: location.hash,
    }));
    const untouched = (t) => !t.check && !t.radio && !t.open && !t.hash;

    for (const [name, code] of [['Space', SPACE], ['Enter', ENTER]]) {
        await controls();
        await page.evaluate((code) => window.__bindHold(code), code);
        for (const id of CONTROLS) {
            await reset();
            await page.locator('#' + id).focus();
            await tap(name);
            await heldDown(name);
            const did = await logged(page);
            const h = await hold();
            ck(did.length === 0 && untouched(await toggled()), say(`a hold on ${name}: taps and held keys press nothing on #${id}`), JSON.stringify({ did, t: await toggled() }));
            ck(h.down === 2 && h.up === 2, say(`a hold on ${name}: on #${id} its down and up both still arrive`), JSON.stringify(h));
        }
        // Typing stays typing, and the hold still holds: you hold push-to-talk while typing.
        for (const [id, typed] of [['c-text', name === 'Space' ? ' ' : ''], ['c-area', name === 'Space' ? ' ' : '\n']]) {
            await reset();
            await page.locator('#' + id).fill('');
            await page.locator('#' + id).focus();
            await tap(name);
            const value = await page.locator('#' + id).inputValue();
            ck(value === typed && (await hold()).down === 1, say(`CONTROL: a hold on ${name}: in #${id} it still types and still holds`), JSON.stringify({ value, hold: await hold() }));
        }
        await reset();
        await page.locator('#c-edit').focus();
        await tap(name);
        const edited = await page.evaluate(() => document.getElementById('c-edit').innerHTML);
        ck(edited !== '' && (await hold()).down === 1, say(`CONTROL: a hold on ${name}: in editable text it still types and still holds`), JSON.stringify(edited));
        await page.evaluate(() => window.__unbindHold());

        // CONTROL: no hold, and the same key does press every one of them.
        await controls();
        const fired = {};
        for (const id of CONTROLS) {
            await reset();
            await page.locator('#' + id).focus();
            await tap(name);
            fired[id] = (await logged(page)).length;
        }
        const t = await toggled();
        const expected = name === 'Space'
            // Enter on a checkbox or radio presses nothing, in any browser; Space on a link scrolls.
            ? fired['c-button'] && fired['c-check'] && fired['c-radio'] && fired['c-inbutton'] && fired['c-summary'] && fired['c-owned']
            : fired['c-button'] && fired['c-link'] && fired['c-inbutton'] && fired['c-summary'] && fired['c-owned'];
        ck(!!expected, say(`CONTROL: no hold: ${name} does press them`), JSON.stringify({ fired, t }));
    }

    // Only these two keys. A hold on Tab or Escape keeps what the key does.
    await controls();
    await page.evaluate(() => window.__bindHold(9));
    await reset();
    await page.locator('#c-button').focus();
    await tap('Tab');
    // On to the link, or past it: Safari's Tab skips links unless told otherwise.
    ck(['c-link', 'c-check'].includes(await focusOn(page)) && (await hold()).down === 1, say('CONTROL: a hold on Tab: the focus still moves on, and it holds'), await focusOn(page));
    await page.evaluate(() => window.__bindHold(27));
    await reset();
    await page.locator('#c-button').focus();
    await tap('Escape');
    const esc = await page.evaluate(() => window.__lastKey);
    ck(esc.key === 'Escape' && !esc.prevented && (await hold()).down === 1, say('CONTROL: a hold on Escape: its default is left alone, and it holds'), JSON.stringify(esc));
    await page.evaluate(() => window.__unbindHold());

    // Bound with a modifier: a bare Space is no such key, and Ctrl+Space is.
    await controls();
    await page.evaluate((code) => window.__bindHold(code, { ctrl: true }), SPACE);
    await reset();
    await page.locator('#c-button').focus();
    await tap('Space');
    ck(JSON.stringify(await logged(page)) === '["button"]' && (await hold()).down === 0, say('CONTROL: a hold on Ctrl+Space: a bare Space still presses the button, and holds nothing'), JSON.stringify(await logged(page)));
    await reset();
    await page.keyboard.down('Control');
    await tap('Space');
    await page.keyboard.up('Control');
    await frame(page);
    ck((await logged(page)).length === 0 && (await hold()).down === 1, say('a hold on Ctrl+Space: Ctrl+Space holds, and presses nothing'), JSON.stringify(await logged(page)));
    await page.evaluate(() => window.__unbindHold());

    // A press action has the same key and the same repeats: its first press was always swallowed.
    await controls();
    await page.evaluate((code) => window.__bindPress(code), SPACE);
    await reset();
    await page.locator('#c-button').focus();
    await heldDown('Space');
    ck(JSON.stringify(await logged(page)) === '["press-action"]', say('a press action on Space held down: acts once, and its repeats press no button'), JSON.stringify(await logged(page)));
    await page.evaluate(() => window.__unbindPress());

    // ---- THE REAL CHAIN: the menu and the question, with a hold on Space. ----
    const fresh = async (opts) => { await page.evaluate((o) => { window.__log.length = 0; window.__mountMode(o); }, opts); await frame(page); };
    const clickOn = async (selector, text) => {
        const box = await (text ? page.locator(selector, { hasText: text }) : page.locator(selector)).first().boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await frame(page);
    };
    const SEL = '[data-testid="mode-selector"]';
    const questionOpen = () => page.evaluate(() => !!document.querySelector('.app-question'));
    const threeTaps = async () => { await tap('Space'); await tap('Space'); await tap('Space'); };
    await page.evaluate((code) => window.__bindHold(code), SPACE);

    await fresh();
    await reset();
    await clickOn(SEL);
    await clickOn('.context-menu-item', 'Movie Night');
    await threeTaps();
    ck(JSON.stringify(await logged(page)) === '["switch:4"]' && !await menuOpen(page), say('chain: a mouse\'s pick, then three push-to-talk taps: no menu and no Off'), JSON.stringify(await logged(page)));
    ck((await hold()).down === 3 && (await hold()).up === 3, say('chain: and all three really were push-to-talk'), JSON.stringify(await hold()));

    await fresh();
    await reset();
    await clickOn(SEL);
    await clickOn('#rig-row');
    await threeTaps();
    ck((await logged(page)).length === 0 && !await menuOpen(page), say('CONTROL: chain: a click elsewhere, then taps: nothing'), JSON.stringify(await logged(page)));

    // The focus on the selector, as a key's menu leaves it: the hold is all that stands in the way.
    await fresh();
    await reset();
    await page.locator(SEL).focus();
    await threeTaps();
    ck((await logged(page)).length === 0 && !await menuOpen(page), say('chain: the focus on the selector, then taps: the hold opens nothing'), JSON.stringify(await logged(page)));
    await tap('Enter');
    ck(await menuOpen(page), say('CONTROL: chain: Enter, which is not the hold, still opens it'));
    await threeTaps();
    ck((await logged(page)).length === 0 && await menuOpen(page), say('chain: with Off under the focus, the taps press nothing'), JSON.stringify(await logged(page)));
    await tap('Enter');
    ck(JSON.stringify(await logged(page)) === '["switch:null"]', say('CONTROL: chain: and Enter there does press Off'), JSON.stringify(await logged(page)));

    // The question, whose OK has the focus: taps do not answer it. Its own keys still do.
    await fresh({ people: 2 });
    await reset();
    await clickOn(SEL);
    await clickOn('.context-menu-item', 'Movie Night');
    ck(await questionOpen(), say('chain: with people in the rooms, a pick asks'));
    await threeTaps();
    ck(await questionOpen() && (await logged(page)).length === 0, say('chain: three taps on its OK do not answer it'), JSON.stringify(await logged(page)));
    ck((await hold()).down === 3 && (await hold()).up === 3, say('chain: the hold still hears them behind the question'), JSON.stringify(await hold()));
    await tap('Enter');
    ck(!await questionOpen() && JSON.stringify(await logged(page)) === '["switch:4"]', say('CONTROL: chain: Enter on OK, which is not the hold, answers it'), JSON.stringify(await logged(page)));
    await fresh({ people: 2 });
    await clickOn(SEL);
    await clickOn('.context-menu-item', 'Movie Night');
    await tap('Escape');
    ck(!await questionOpen() && JSON.stringify(await logged(page)) === '["refused"]', say('CONTROL: chain: Escape refuses it'), JSON.stringify(await logged(page)));
    await page.evaluate(() => window.__unbindHold());
    await fresh({ people: 2 });
    await clickOn(SEL);
    await clickOn('.context-menu-item', 'Movie Night');
    await tap('Space');
    ck(!await questionOpen() && JSON.stringify(await logged(page)) === '["switch:4"]', say('CONTROL: chain: with no hold, Space on OK does answer it'), JSON.stringify(await logged(page)));
    await ctx.close();
}

await holdKeys(CHANNEL, browser);
for (const [engine, type, off, opts] of [
    ['firefox', firefox, process.env.FIREFOX === '0', { firefoxUserPrefs: { 'media.volume_scale': '0' } }],
    ['webkit', webkit, process.env.WEBKIT === '0', {}],
]) {
    if (off) { console.log(`SKIP ${engine}: switched off`); continue; }
    const other = await type.launch({ headless: true, ...opts }).catch((e) => { console.log(`SKIP ${engine}: ${String(e.message).split('\n')[0]} (npx playwright install ${engine})`); return null; });
    if (!other) continue;
    await holdKeys(engine, other);
    await other.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
