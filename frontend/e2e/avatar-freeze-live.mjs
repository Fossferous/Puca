// Live avatar-freeze checks in a REAL browser. Unit tests can prove the
// snapshot logic, but only a browser proves the user sees pixels — and two
// shipping-blockers here were invisible to jsdom:
//
//  1. loading="lazy" on a display:none <img> means the browser NEVER fetches
//     it (no layout box => never intersects the viewport), so the snapshot is
//     never taken and every frozen avatar renders as an empty circle.
//  2. hide -> unhide remounts a brand-new <canvas> that was never drawn to,
//     leaving a blank 300x150 box where the avatar used to be.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/avatar-freeze-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const USER = 'unhide_' + Date.now().toString(36);
let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('dialog', d => d.accept().catch(() => {}));
try {
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('#username');
    await page.click('.toggle-mode');
    await page.waitForSelector('#inviteCode');
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }

    // Give this user an avatar by uploading through the app's own API, so the
    // URL/auth path is the real one.
    const uid = psql(`SELECT id FROM users WHERE username='${USER}'`);
    const fileId = await page.evaluate(async () => {
        // 2x2 red PNG.
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQ0AABzYAQcRnJoOAAAAAElFTkSuQmCC';
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new Blob([bytes], { type: 'image/png' }), 'a.png');
        const token = localStorage.getItem('auth_token');
        const up = await fetch('http://127.0.0.1:3000/upload', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
        });
        const j = await up.json();
        await fetch('http://127.0.0.1:3000/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ avatar_file_id: j.id }),
        });
        // The profile-bar avatar reads from the SERVER member list, so this
        // user needs a server for allMembers to contain them at all.
        await fetch('http://127.0.0.1:3000/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: 'AvatarProbe' }),
        });
        return j.id;
    });
    check('avatar uploaded + set', !!fileId, fileId);

    await page.reload();
    await page.waitForTimeout(2500);

    // The own-profile bar avatar is a SmartAvatar; frozen => a canvas.
    const state = async () => page.evaluate(() => {
        const bar = document.querySelector('.user-profile-bar .user-avatar');
        const c = bar?.querySelector('canvas');
        return {
            hasCanvas: !!c,
            width: c?.width ?? 0,
            // Non-blank check: at least one non-transparent pixel.
            painted: (() => {
                if (!c) return false;
                try {
                    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
                    return false;
                } catch { return 'tainted'; } // cross-origin: displays fine, can't read
            })(),
            text: bar?.textContent?.trim() ?? '',
        };
    });

    // AUTH GATE: the same file must be refused without credentials, and the
    // response must be marked private so Cloudflare cannot cache it and hand
    // it to an anonymous request at the edge.
    const anon = await page.evaluate(async (id) => {
        const r = await fetch('http://127.0.0.1:3000/files/' + id);
        return { status: r.status, cache: r.headers.get('cache-control') };
    }, fileId);
    check('unauthenticated /files is refused', anon.status === 401 || anon.status === 403, 'status=' + anon.status);
    const authed = await page.evaluate(async (id) => {
        const r = await fetch('http://127.0.0.1:3000/files/' + id, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') },
        });
        return { status: r.status, cache: r.headers.get('cache-control') };
    }, fileId);
    check('authenticated /files succeeds', authed.status === 200, 'status=' + authed.status);
    check('response is Cache-Control: private (no edge caching)',
        !!authed.cache && authed.cache.includes('private'), 'cache-control=' + authed.cache);

    const before = await state();
    check('frozen canvas present before hiding', before.hasCanvas, JSON.stringify(before));
    check('canvas sized from the image (not 300 default)', before.width > 0 && before.width !== 300, `width=${before.width}`);

    // Hide, then un-hide, via the same store the context menu drives.
    await page.evaluate((id) => {
        localStorage.setItem('sovereign_hidden_avatars', JSON.stringify([Number(id)]));
        window.dispatchEvent(new CustomEvent('avatarPrefsChanged', { detail: { userId: Number(id), hidden: true } }));
    }, uid);
    await page.waitForTimeout(600);
    const hid = await state();
    check('hidden shows initials, no canvas', !hid.hasCanvas && hid.text.length > 0, JSON.stringify(hid));

    await page.evaluate((id) => {
        localStorage.setItem('sovereign_hidden_avatars', JSON.stringify([]));
        window.dispatchEvent(new CustomEvent('avatarPrefsChanged', { detail: { userId: Number(id), hidden: false } }));
    }, uid);
    await page.waitForTimeout(1200);
    const after = await state();
    // THE REGRESSION: before the fix this came back as a blank 300-wide canvas.
    check('canvas returns after un-hiding', after.hasCanvas, JSON.stringify(after));
    check('returned canvas is drawn, not the 300 default', after.width > 0 && after.width !== 300, `width=${after.width}`);
    check('returned canvas actually has pixels', after.painted === true || after.painted === 'tainted', String(after.painted));

    // EVERY avatar site must freeze, not just the profile bar — the lazy-load
    // bug hit all of them identically, and each site has its own CSS that has
    // to apply to the <canvas> as well as the <img>.
    await page.evaluate(() => {
        const t = [...document.querySelectorAll('.server-icon')].find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        t?.click();
    });
    await page.waitForTimeout(1500);
    const composer = page.locator('textarea[placeholder^="Message #"]');
    await composer.waitFor({ timeout: 8000 });
    await composer.fill('avatar site check');
    await composer.press('Enter');
    await page.waitForTimeout(2000);

    const sites = await page.evaluate(() => {
        const probe = (sel) => {
            const host = document.querySelector(sel);
            if (!host) return { found: false };
            const c = host.querySelector('canvas');
            const img = host.querySelector('img');
            return {
                found: true,
                hasCanvas: !!c,
                width: c?.width ?? 0,
                // The canvas must inherit the site's sizing/rounding, not
                // collapse to 0x0 because the CSS only ever targeted `img`.
                cssW: c ? Math.round(c.getBoundingClientRect().width) : 0,
                imgHidden: img ? getComputedStyle(img).display === 'none' : null,
            };
        };
        return {
            message: probe('.message-avatar'),
            member: probe('.member-avatar'),
        };
    });
    for (const [name, s] of Object.entries(sites)) {
        if (!s.found) { console.log(`SKIP  ${name} avatar not on screen`); continue; }
        check(`${name} avatar frozen to a drawn canvas`, s.hasCanvas && s.width > 0 && s.width !== 300, JSON.stringify(s));
        check(`${name} canvas has non-zero rendered size (CSS covers canvas)`, s.cssW > 0, `cssW=${s.cssW}`);
        check(`${name} live <img> is hidden while frozen`, s.imgHidden === true, String(s.imgHidden));
    }
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 2).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
