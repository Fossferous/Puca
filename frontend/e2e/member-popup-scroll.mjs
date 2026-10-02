// Live real-browser rig: the member profile popup (click a user in the
// right-hand member list) must let you reach EVERYTHING in it, on desktop and
// on a phone, and must not take the member list's scrolling with it.
//
// The bug this pins (owner report, reproduced in triage): the popup was
// `position: fixed; max-height: 450px; overflow: hidden` and placed by a clamp
// that assumed a 400px popup. Its content clipped and could not be scrolled;
// the one child with an overflow rule (Manage Roles) was squeezed to a ~38px
// strip; a click low in the list pushed the popup 34px below the window; and
// on a 390x844 phone it ran under the bottom nav. UserProfileSettings.css's
// generic `.profile-section` rules (loaded globally) also styled the popup's
// sections, adding ~40px it never asked for.
//
// jsdom cannot see any of this (no box model, no scrolling), so this drives the
// real app in headless Edge against a THROWAWAY backend:
//   - desktop 1280x720, mouse: click the member row lowest in the list, then
//     wheel inside the popup until the LAST Manage Roles checkbox is the
//     topmost element at its own centre (document.elementFromPoint — never
//     locator.click, which scrolls clipped containers itself and false-passes);
//   - phone 390x844, isMobile + hasTouch, coarse pointer: tap a member, then
//     drag the popup with RAW CDP touch events (Input.synthesizeScrollGesture
//     does not scroll in headless Edge — measured 0 vs 428 in triage).
// Positive controls, both viewports: the same wheel/drag over the member list
// must move the list, with the popup open and after closing it — which also
// proves the input really reaches the page.
//
// Setup (all through the public API except the owner, who registers in the UI
// so the browser holds real keys): owner + MEMBERS members joined by invite,
// ROLES extra roles, each member given several of them.
//
// Usage (backend on a throwaway DB + a vite dev server pointed at it):
//   API=http://127.0.0.1:3000 APP=http://127.0.0.1:5173 node e2e/member-popup-scroll.mjs [outdir]
// Optional: PREFIX (account-name prefix, default "mps-").
import { chromium } from '@playwright/test';
import { webcrypto, randomFillSync } from 'node:crypto';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:3000';
const APP = process.env.APP || 'http://127.0.0.1:5173';
const PREFIX = process.env.PREFIX || 'mps-';
const outdir = process.argv[2] || 'e2e/shots-member-popup';
fs.mkdirSync(outdir, { recursive: true });

const MEMBERS = 26;
const ROLES = 12;
const ROLES_PER_MEMBER = 6;
const PASS = 'Popup-Scroll-Password-123!';
const RUN = Date.now().toString(36);
const OWNER = `${PREFIX}own-${RUN}`;

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- SRP-6a (v1 identity hash), the same helper e2e/feature-flows.mjs uses ----------
const crypto = webcrypto;
const enc = new TextEncoder();
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
function randBytes(n) { const b = new Uint8Array(n); randomFillSync(b); return b; }
const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX); const g = 2n; const N_BYTES = 256;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { let h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) { const t = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(t); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }
async function idHashFn(u, p) { return await shaBytes(enc.encode(`${u.toLowerCase()}:${p}`)); }
async function xFn(salt, idHash) { return bytesToBig(await shaBytes(salt, idHash)); }
async function kFn() { return bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES))); }
async function uFn(A, B) { return bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B))); }

async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 429) { await sleep(1500); continue; }
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    }
    return { status: 429, body: 'rate-limited' };
}
async function must(method, path, body, token) {
    const r = await api(method, path, body, token);
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
}
async function registerAndLogin(username, password) {
    const salt = randBytes(32);
    const v = modpow(g, await xFn(salt, await idHashFn(username, password)), N);
    await must('POST', '/auth/register', { username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES), public_key: 'x25519:' + Buffer.from(randBytes(32)).toString('base64') });
    const a = bytesToBig(randBytes(32)); const A = modpow(g, a, N);
    const s1 = await must('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    const B = BigInt('0x' + s1.b_pub_hex);
    const u = await uFn(A, B); const k = await kFn();
    const x = await xFn(fromHex(s1.salt_hex), await idHashFn(username, password));
    let base = (B - (k * modpow(g, x, N)) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), minimalBytes(S));
    return (await must('POST', '/auth/login/step2', { username, m_hex: toHex(M1) })).token;
}

// ---------- browser helpers ----------
async function dismissOnboarding(page) {
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* none */ }
    try { await page.click('.welcome-popup-close', { timeout: 1500 }); } catch { /* none */ }
}
async function uiRegister(page, user) {
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.click('.toggle-mode');
    await page.waitForTimeout(500); // the invite field appears only when this server asks for one
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOnboarding(page);
}
async function uiLogin(page, user) {
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOnboarding(page);
}

// Everything the assertions need, measured in ONE evaluate so it is a single
// consistent frame. `last` is the last Manage Roles checkbox row (the lowest
// control in the popup); `hit` says whether elementFromPoint at its centre is
// that row (i.e. it is on screen, not clipped, not covered).
const POPUP_STATE = () => {
    const popup = document.querySelector('.user-profile-popup');
    if (!popup) return null;
    const pr = popup.getBoundingClientRect();
    const boxes = [...popup.querySelectorAll('input[type="checkbox"]')].map(i => i.closest('label') || i);
    const last = boxes[boxes.length - 1] || null;
    let lastInfo = null;
    if (last) {
        const r = last.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const inViewport = cx >= 0 && cx < innerWidth && cy >= 0 && cy < innerHeight;
        const at = inViewport ? document.elementFromPoint(cx, cy) : null;
        lastInfo = { top: r.top, bottom: r.bottom, cx, cy, inViewport, hit: !!at && last.contains(at), at: at ? `${at.tagName}.${at.className}` : null };
    }
    // Every direct child section of the popup: margins it never asked for are
    // the signature of another component's stylesheet leaking in.
    // (A single wrapper child is looked through to the sections it holds.)
    const sectionParent = popup.children.length === 1 ? popup.children[0] : popup;
    const kids = [...sectionParent.children].map(k => ({ cls: String(k.className), h: Math.round(k.getBoundingClientRect().height), mt: getComputedStyle(k).marginTop, radius: getComputedStyle(k).borderTopLeftRadius }));
    const side = document.querySelector('.member-sidebar');
    return {
        rect: { top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right, height: pr.height },
        innerHeight, innerWidth,
        scrollTop: popup.scrollTop, scrollHeight: popup.scrollHeight, clientHeight: popup.clientHeight,
        overflowY: getComputedStyle(popup).overflowY,
        checkboxes: boxes.length,
        last: lastInfo,
        kids,
        sidebarScrollTop: side ? side.scrollTop : null,
    };
};

async function waitForPopupRoles(page) {
    await page.waitForSelector('.user-profile-popup', { timeout: 10000 });
    await page.waitForFunction((n) => document.querySelectorAll('.user-profile-popup input[type="checkbox"]').length >= n, ROLES, { timeout: 10000 });
    await page.waitForTimeout(400); // popupSlide animation (0.15s) + any re-placement after the roles landed
}

async function selectServer(page, name) {
    await page.waitForSelector(`.server-icon[title="${name}"]`, { timeout: 20000 });
    await page.evaluate((n) => document.querySelector(`.server-icon[title="${n}"]`)?.click(), name);
    await page.waitForFunction((n) => document.querySelectorAll('.member-sidebar .member-item').length >= n, MEMBERS, { timeout: 20000 });
    await page.waitForTimeout(600);
}

// A raw one-finger drag through CDP touch events (the only touch scroll that
// moves an overflow box in headless Edge). dy < 0 drags UP = scrolls DOWN.
async function touchDrag(cdp, x, y, dy, steps = 12) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
        await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350);
}

const browser = await chromium.launch({
    channel: 'msedge', headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
    // ---------------- setup ----------------
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const desk = await dctx.newPage();
    desk.on('dialog', d => d.dismiss().catch(() => {}));
    let pageErrors = 0;
    desk.on('pageerror', e => { pageErrors++; console.log('[pageerror]', String(e).slice(0, 200)); });
    await uiRegister(desk, OWNER);
    const ownerToken = await desk.evaluate(() => localStorage.getItem('auth_token'));
    check('setup: owner registered in the UI and holds a token', !!ownerToken);

    const SERVER = `mps-srv-${RUN}`;
    const srv = await must('POST', '/servers', { name: SERVER }, ownerToken);
    const roleIds = [];
    for (let i = 0; i < ROLES; i++) {
        const color = '#' + ((0x3a5fcd + i * 0x0f1733) & 0xffffff).toString(16).padStart(6, '0');
        const r = await must('POST', `/servers/${srv.id}/roles`, { name: `mps-role-${String(i).padStart(2, '0')}`, color, permissions: 0 }, ownerToken);
        roleIds.push(r.id);
    }
    const inv = await must('POST', `/servers/${srv.id}/invites`, {}, ownerToken);
    for (let m = 0; m < MEMBERS; m++) {
        const user = `${PREFIX}m${String(m).padStart(2, '0')}-${RUN}`;
        const t = await registerAndLogin(user, PASS);
        await must('POST', `/invites/${inv.code}/join`, {}, t);
        const me = await must('GET', `/servers/${srv.id}/members-with-roles`, null, ownerToken).then(list => list.find(x => x.username === user));
        for (let k = 0; k < ROLES_PER_MEMBER; k++) {
            const rid = roleIds[(m + k) % ROLES];
            const res = await api('PUT', `/servers/${srv.id}/members/${me.id}/roles/${rid}`, {}, ownerToken);
            if (![200, 201, 204].includes(res.status)) throw new Error(`assign role -> ${res.status}`);
        }
    }
    const mwr = await must('GET', `/servers/${srv.id}/members-with-roles`, null, ownerToken);
    check('setup: server has owner + members with roles', mwr.length >= MEMBERS + 1, `members=${mwr.length}`);

    // ---------------- desktop 1280x720 ----------------
    await desk.reload({ waitUntil: 'domcontentloaded' });
    await desk.waitForTimeout(1500);
    await dismissOnboarding(desk);
    await selectServer(desk, SERVER);

    const list = await desk.evaluate(() => {
        const s = document.querySelector('.member-sidebar');
        const r = s.getBoundingClientRect();
        return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    check('desktop: the member list overflows (the scenario needs it)', list.scrollHeight > list.clientHeight + 200, `${list.scrollHeight} > ${list.clientHeight}`);

    // Positive control 1: the list scrolls with no popup.
    const listX = Math.round((list.left + list.right) / 2);
    await desk.mouse.move(listX, Math.round(list.top + list.clientHeight / 2));
    await desk.mouse.wheel(0, 300); await desk.waitForTimeout(400);
    let st = await desk.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
    check('desktop control: the member list wheel-scrolls with no popup', st > 0, `scrollTop ${st}`);
    await desk.evaluate(() => { document.querySelector('.member-sidebar').scrollTop = 0; });
    await desk.waitForTimeout(200);

    // Click the member row lowest on screen (fully visible) — the worst case
    // for the placement clamp. A REAL mouse click, after confirming the point
    // really lands on that row.
    const target = await desk.evaluate(() => {
        const rows = [...document.querySelectorAll('.member-sidebar .member-item')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.top >= 0 && r.bottom <= innerHeight - 4)
            .filter(({ el }) => !el.querySelector('.owner-crown'));
        const { el, r } = rows[rows.length - 1];
        const x = r.left + 30, y = r.top + r.height / 2;
        return { x, y, name: el.textContent.trim().slice(0, 40), hit: el.contains(document.elementFromPoint(x, y)) };
    });
    check('desktop: the click point is on the lowest visible member row', target.hit, `${target.name} at y=${Math.round(target.y)}`);
    await desk.mouse.click(target.x, target.y);
    await waitForPopupRoles(desk);
    let s = await desk.evaluate(POPUP_STATE);
    await desk.screenshot({ path: `${outdir}/desktop-popup-open.png` });
    console.log('  desktop popup:', JSON.stringify({ rect: s.rect, sh: s.scrollHeight, ch: s.clientHeight, oy: s.overflowY, kids: s.kids }));
    check('desktop: popup is fully inside the window (top)', s.rect.top >= 0, `top=${s.rect.top}`);
    check('desktop: popup is fully inside the window (bottom)', s.rect.bottom <= s.innerHeight, `bottom=${s.rect.bottom} innerHeight=${s.innerHeight}`);
    check('desktop: popup lists every assignable role', s.checkboxes === ROLES, `checkboxes=${s.checkboxes}`);
    // UserProfileSettings.css's `.profile-section` gave every popup section an
    // 8px card radius and the later ones a 16px top margin; the popup's own
    // CSS asks for neither.
    check('desktop: no popup section carries a margin/radius from another component\'s CSS',
        s.kids.length >= 3 && s.kids.every(k => k.mt === '0px' && k.radius === '0px'),
        s.kids.map(k => `${k.cls}:mt=${k.mt},r=${k.radius}`).join(', '));
    check('desktop: the last role checkbox is NOT reachable before scrolling (scenario is real)', !s.last.hit, `at=${s.last.at} cy=${Math.round(s.last.cy)}`);

    // Wheel inside the popup until the last checkbox is the top element at its centre.
    const pcx = Math.round((s.rect.left + s.rect.right) / 2);
    const pcy = Math.round(Math.min(s.rect.top + 120, (s.rect.top + s.rect.bottom) / 2));
    const sideBefore = s.sidebarScrollTop;
    await desk.mouse.move(pcx, pcy);
    for (let i = 0; i < 15 && !s.last.hit; i++) {
        await desk.mouse.wheel(0, 200); await desk.waitForTimeout(250);
        s = await desk.evaluate(POPUP_STATE);
    }
    await desk.screenshot({ path: `${outdir}/desktop-popup-scrolled.png` });
    check('desktop: wheel inside the popup brings the LAST role checkbox on screen (elementFromPoint)', s.last.hit, `at=${s.last.at} cy=${Math.round(s.last.cy)} popup.scrollTop=${s.scrollTop}`);
    check('desktop: wheeling the popup did not scroll the member list', s.sidebarScrollTop === sideBefore, `${sideBefore} -> ${s.sidebarScrollTop}`);

    // Toggle that last role for real: the control is not just visible, it works.
    if (s.last.hit) {
        const before = await desk.evaluate(() => { const b = [...document.querySelectorAll('.user-profile-popup input[type="checkbox"]')]; return b[b.length - 1].checked; });
        await desk.mouse.click(s.last.cx, s.last.cy);
        await desk.waitForFunction((b) => { const x = [...document.querySelectorAll('.user-profile-popup input[type="checkbox"]')]; const c = x[x.length - 1]; return c.checked !== b && !c.disabled; }, before, { timeout: 8000 }).catch(() => {});
        const after = await desk.evaluate(() => { const b = [...document.querySelectorAll('.user-profile-popup input[type="checkbox"]')]; return b[b.length - 1].checked; });
        check('desktop: clicking the last role checkbox toggles it', after !== before, `${before} -> ${after}`);
    }

    // Positive control 2: the list still scrolls with the popup OPEN (popup opens to the left).
    const listPoint = await desk.evaluate(() => {
        const r = document.querySelector('.member-sidebar').getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height * 0.6);
        const at = document.elementFromPoint(x, y);
        return { x, y, inList: !!at && !!at.closest('.member-sidebar'), inPopup: !!at && !!at.closest('.user-profile-popup') };
    });
    check('desktop: with the popup open, the member list is still the top element under the pointer', listPoint.inList && !listPoint.inPopup, JSON.stringify(listPoint));
    let side0 = await desk.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
    await desk.mouse.move(listPoint.x, listPoint.y);
    await desk.mouse.wheel(0, 300); await desk.waitForTimeout(400);
    let side1 = await desk.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
    check('desktop: the member list wheel-scrolls with the popup open', side1 > side0, `${side0} -> ${side1}`);

    // Close (mousedown outside, on the chat) and the list must still scroll.
    await desk.mouse.click(400, 300);
    await desk.waitForTimeout(300);
    check('desktop: clicking outside closes the popup', await desk.locator('.user-profile-popup').count() === 0);
    side0 = side1;
    await desk.mouse.move(listPoint.x, listPoint.y);
    await desk.mouse.wheel(0, 300); await desk.waitForTimeout(400);
    side1 = await desk.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
    check('desktop: the member list wheel-scrolls after closing the popup', side1 > side0 || side1 >= list.scrollHeight - list.clientHeight - 1, `${side0} -> ${side1}`);
    // A short window, shrunk WHILE the popup is open: it must re-place and
    // re-cap itself (the old clamp left the bottom 34px off-screen at any
    // height), and everything in it must still be reachable.
    const low = await desk.evaluate(() => {
        const rows = [...document.querySelectorAll('.member-sidebar .member-item')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.top >= 0 && r.bottom <= innerHeight - 4);
        const { r } = rows[rows.length - 1];
        return { x: r.left + 30, y: r.top + r.height / 2 };
    });
    await desk.mouse.click(low.x, low.y);
    await waitForPopupRoles(desk);
    await desk.setViewportSize({ width: 1280, height: 460 });
    await desk.waitForTimeout(500);
    s = await desk.evaluate(POPUP_STATE);
    check('desktop 1280x460 (resized while open): popup is inside the window', s.rect.top >= 0 && s.rect.bottom <= s.innerHeight, `top=${s.rect.top} bottom=${s.rect.bottom} innerHeight=${s.innerHeight}`);
    await desk.mouse.move(Math.round((s.rect.left + s.rect.right) / 2), Math.round(s.rect.top + 60));
    for (let i = 0; i < 20 && !s.last.hit; i++) {
        await desk.mouse.wheel(0, 200); await desk.waitForTimeout(200);
        s = await desk.evaluate(POPUP_STATE);
    }
    await desk.screenshot({ path: `${outdir}/desktop-460-scrolled.png` });
    check('desktop 1280x460: the last role checkbox is reachable by wheel', s.last.hit, `at=${s.last.at} cy=${Math.round(s.last.cy)}`);
    await desk.mouse.click(400, 100);
    await desk.setViewportSize({ width: 1280, height: 720 });
    check('desktop: no page errors', pageErrors === 0, `pageErrors=${pageErrors}`);

    // ---------------- phone 390x844, coarse pointer ----------------
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const phone = await mctx.newPage();
    phone.on('dialog', d => d.dismiss().catch(() => {}));
    let mErrors = 0;
    phone.on('pageerror', e => { mErrors++; console.log('[pageerror/phone]', String(e).slice(0, 200)); });
    await uiLogin(phone, OWNER);
    const coarse = await phone.evaluate(() => matchMedia('(pointer: coarse) and (max-width: 1024px)').matches);
    check('phone: the coarse-pointer mobile layout is active', coarse);
    // Server rail lives in the "servers" panel; pick the server, then open Members.
    await phone.evaluate(() => [...document.querySelectorAll('.mobile-nav-btn')].find(b => /server/i.test(b.textContent || b.getAttribute('aria-label') || ''))?.click());
    await phone.waitForTimeout(500);
    await selectServer(phone, SERVER);
    await phone.evaluate(() => [...document.querySelectorAll('.mobile-nav-btn')].find(b => /member/i.test(b.textContent || b.getAttribute('aria-label') || ''))?.click());
    await phone.waitForTimeout(700);
    const cdp = await mctx.newCDPSession(phone);

    const mlist = await phone.evaluate(() => {
        const s = document.querySelector('.member-sidebar'); const r = s.getBoundingClientRect();
        const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, navTop: nav ? nav.top : innerHeight };
    });
    check('phone: the Members panel is on screen and its list overflows', mlist.left < 390 && mlist.scrollHeight > mlist.clientHeight + 200, JSON.stringify(mlist));

    // Positive control: a raw drag scrolls the list with no popup.
    const mx = Math.round((Math.max(mlist.left, 0) + Math.min(mlist.right, 390)) / 2);
    await touchDrag(cdp, mx, 600, -250);
    let mst = await phone.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
    check('phone control: the member list drag-scrolls with no popup', mst > 0, `scrollTop ${mst}`);
    await phone.evaluate(() => { document.querySelector('.member-sidebar').scrollTop = 0; });
    await phone.waitForTimeout(200);

    // Tap a member low in the list.
    const mt = await phone.evaluate(() => {
        const navTop = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect().top ?? innerHeight;
        const rows = [...document.querySelectorAll('.member-sidebar .member-item')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.top >= 0 && r.bottom <= navTop - 4)
            .filter(({ el }) => !el.querySelector('.owner-crown'));
        const { el, r } = rows[Math.max(0, rows.length - 4)];
        const x = r.left + 40, y = r.top + r.height / 2;
        return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
    });
    check('phone: the tap point is on a member row', mt.hit, `y=${Math.round(mt.y)}`);
    await phone.touchscreen.tap(mt.x, mt.y);
    await waitForPopupRoles(phone);
    let ps = await phone.evaluate(POPUP_STATE);
    await phone.screenshot({ path: `${outdir}/phone-popup-open.png` });
    console.log('  phone popup:', JSON.stringify({ rect: ps.rect, sh: ps.scrollHeight, ch: ps.clientHeight, oy: ps.overflowY, navTop: mlist.navTop }));
    check('phone: popup fits the screen width', ps.rect.left >= 0 && ps.rect.right <= ps.innerWidth, `left=${ps.rect.left} right=${ps.rect.right}`);
    check('phone: popup top is on screen', ps.rect.top >= 0, `top=${ps.rect.top}`);
    check('phone: popup does not run under the bottom nav', ps.rect.bottom <= mlist.navTop, `bottom=${ps.rect.bottom} navTop=${mlist.navTop}`);

    // Drag inside the popup until the last checkbox is reachable, and above the nav.
    const qx = Math.round((ps.rect.left + ps.rect.right) / 2);
    const qy = Math.round(Math.min(ps.rect.bottom - 40, ps.rect.top + ps.rect.height * 0.7));
    const mside0 = ps.sidebarScrollTop;
    const reachable = (st) => st.last.hit && st.last.cy < mlist.navTop;
    for (let i = 0; i < 12 && !reachable(ps); i++) {
        await touchDrag(cdp, qx, qy, -220);
        ps = await phone.evaluate(POPUP_STATE);
    }
    await phone.screenshot({ path: `${outdir}/phone-popup-scrolled.png` });
    check('phone: a touch drag inside the popup brings the LAST role checkbox on screen, above the nav', reachable(ps), `at=${ps.last.at} cy=${Math.round(ps.last.cy)} navTop=${mlist.navTop} popup.scrollTop=${ps.scrollTop}`);
    check('phone: dragging the popup did not scroll the member list behind it', ps.sidebarScrollTop === mside0, `${mside0} -> ${ps.sidebarScrollTop}`);

    // With the popup open, part of the list must still be uncovered and drag-scrollable.
    const open = await phone.evaluate(() => {
        const s = document.querySelector('.member-sidebar').getBoundingClientRect();
        const p = document.querySelector('.user-profile-popup').getBoundingClientRect();
        const x = Math.round(Math.max(s.left, 0) + 40);
        for (let y = Math.round(s.top + 20); y < p.top - 10; y += 10) {
            const at = document.elementFromPoint(x, y);
            if (at && at.closest('.member-sidebar') && !at.closest('.user-profile-popup')) return { x, y, ok: true };
        }
        return { ok: false, top: p.top };
    });
    check('phone: with the popup open, part of the member list is still uncovered', open.ok, JSON.stringify(open));
    if (open.ok) {
        const a = await phone.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
        // The uncovered band is short: drag within it.
        await touchDrag(cdp, open.x, open.y + 60 > 0 ? Math.min(open.y + 60, ps.rect.top - 8) : open.y, -50);
        const b = await phone.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
        check('phone: the member list drag-scrolls with the popup open', b > a, `${a} -> ${b}`);
    }

    // Close with a tap outside the popup (on the list's section heading), then the list scrolls.
    const head = await phone.evaluate(() => {
        const h = document.querySelector('.member-sidebar .member-section-title'); const r = h.getBoundingClientRect();
        return { x: r.left + 20, y: r.top + r.height / 2, visible: r.top >= 0 && r.bottom <= innerHeight };
    });
    if (!head.visible) await phone.evaluate(() => { document.querySelector('.member-sidebar').scrollTop = 0; });
    const head2 = await phone.evaluate(() => { const r = document.querySelector('.member-sidebar .member-section-title').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
    await phone.touchscreen.tap(head2.x, head2.y);
    await phone.waitForTimeout(400);
    check('phone: tapping outside closes the popup', await phone.locator('.user-profile-popup').count() === 0);
    await phone.evaluate(() => { document.querySelector('.member-sidebar').scrollTop = 0; });
    await touchDrag(cdp, mx, 600, -250);
    mst = await phone.evaluate(() => document.querySelector('.member-sidebar').scrollTop);
    check('phone: the member list drag-scrolls after closing the popup', mst > 0, `scrollTop ${mst}`);
    check('phone: no page errors', mErrors === 0, `pageErrors=${mErrors}`);
} catch (e) {
    console.log('EXCEPTION:', String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
