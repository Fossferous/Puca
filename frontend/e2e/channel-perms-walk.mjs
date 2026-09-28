// Walk the Edit Channel → Permissions tab of a VOICE channel at desktop size
// and at 390x844 with a coarse pointer (docs/DESIGN_PHILOSOPHY.md: a new
// surface needs walk screenshots). Checks the four voice rows are there, the
// tri-state buttons meet 44px on the phone, nothing overflows sideways, and
// Save stays reachable. Screenshots land in OUT_DIR for a human to look at.
//
// Headless and muted; talks only to a local backend. Prereqs as in
// speak-perms-live.mjs: a throwaway backend and the client served at APP.
// Usage: APP=http://127.0.0.1:5181 OUT_DIR=<dir> node e2e/channel-perms-walk.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5181';
const OUT_DIR = process.env.OUT_DIR || '.';
const CHANNEL = process.env.CHANNEL || 'msedge';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
fs.mkdirSync(OUT_DIR, { recursive: true });

const args = ['--mute-audio', '--host-resolver-rules=MAP svrn.lol ~NOTFOUND, MAP *.svrn.lol ~NOTFOUND'];
const browser = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, headless: true, args });
const result = { app: APP, runs: [] };
let ok = true;

async function register(page, u) {
    await page.goto(APP + '/login');
    await page.waitForSelector('#username', { timeout: 60_000 });
    await page.click('.toggle-mode');
    await page.fill('#username', u); await page.fill('#password', PASS); await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60_000 }); await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type=checkbox]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* none */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
}

// On a phone the server rail and the channel list are panes of their own,
// reached from the bottom nav (mobile-walk2.mjs does the same), and taps.
async function createServer(page, name, phone) {
    const press = (loc, o) => (phone ? loc.tap(o) : loc.click(o));
    if (phone) { await page.locator('.mobile-nav-btn').nth(0).tap(); await page.waitForTimeout(600); }
    await press(page.locator('.server-icon.add-server'), { timeout: 5000 });
    await page.waitForTimeout(500);
    await press(page.locator('.template-card').first(), { timeout: 4000 });
    await page.waitForTimeout(300);
    await press(page.locator('.audience-card').first(), { timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await press(page.locator('.wizard-actions .create-btn'));
    await page.waitForTimeout(2500);
    if (phone) { await page.locator('.mobile-nav-btn').nth(1).tap(); await page.waitForTimeout(800); }
}

for (const shape of [
    { name: 'desktop', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
    { name: 'phone-390x844', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
    const run = { shape: shape.name };
    const ctx = await browser.newContext({ viewport: shape.viewport, isMobile: shape.isMobile, hasTouch: shape.hasTouch, deviceScaleFactor: 1 });
    await ctx.route(/https?:\/\/([^/]*\.)?svrn\.lol(\/|$)/, r => r.abort());
    const page = await ctx.newPage();
    try {
        await register(page, `walk_${shape.name.slice(0, 5)}_${stamp}`);
        await createServer(page, `Walk_${shape.name.slice(0, 5)}_${stamp}`, shape.isMobile);
        // Open the voice channel's context menu (right-click, or the event a long-press raises).
        const opened = await page.evaluate(() => {
            const el = [...document.querySelectorAll('.voice-channel')].find(n => !n.classList.contains('afk'));
            if (!el) return false;
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10, button: 2 }));
            return true;
        });
        if (!opened) throw new Error('no voice channel to open');
        await page.getByText('Edit Channel', { exact: true }).first().click({ timeout: 5000 });
        await page.getByRole('button', { name: /^Permissions$/ }).first().click({ timeout: 5000 });
        await page.locator('.channel-perms-role').first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
        const m = await page.evaluate(() => {
            const labels = [...document.querySelectorAll('.channel-perm-label')].map(l => l.firstChild?.textContent?.trim() ?? '');
            const tri = [...document.querySelectorAll('.tri-btn')].map(b => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
            const save = [...document.querySelectorAll('button')].find(b => /save permissions/i.test(b.textContent || ''));
            save?.scrollIntoView({ block: 'center' });
            const sr = save?.getBoundingClientRect();
            return {
                labels,
                hint: document.querySelector('.channel-perms-voice-hint')?.textContent?.trim().slice(0, 80) ?? null,
                minTri: tri.length ? { w: Math.min(...tri.map(t => t.w)), h: Math.min(...tri.map(t => t.h)) } : null,
                overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                saveVisible: !!sr && sr.bottom <= innerHeight && sr.top >= 0 && sr.width > 0,
            };
        });
        Object.assign(run, m);
        await page.locator('.channel-perms-voice-hint').scrollIntoViewIfNeeded().catch(() => {});
        await page.screenshot({ path: path.join(OUT_DIR, `channel-perms-${shape.name}.png`) });
        // And the voice rows themselves.
        await page.locator('.channel-perm-label', { hasText: 'Speak' }).first().scrollIntoViewIfNeeded().catch(() => {});
        await page.screenshot({ path: path.join(OUT_DIR, `channel-perms-${shape.name}-voice-rows.png`) });
        const voiceRows = ['Connect', 'Speak', 'Video', 'Stream'].every(l => m.labels.includes(l));
        const touchOk = !shape.isMobile || (m.minTri && m.minTri.w >= 44 && m.minTri.h >= 44);
        run.pass = voiceRows && !!m.hint && touchOk && !m.overflowX && m.saveVisible;
        if (!run.pass) ok = false;
    } catch (e) {
        run.error = String(e?.message || e);
        ok = false;
        await page.screenshot({ path: path.join(OUT_DIR, `channel-perms-${shape.name}-error.png`) }).catch(() => {});
    }
    result.runs.push(run);
    await ctx.close();
}
await browser.close();
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
