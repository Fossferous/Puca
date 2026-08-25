// Conversation search, in a real browser.
//
// The unit tests pin the engine; this proves the wiring: that the box exists
// in DMs at all (it used to be inside the channel branch only, which also made
// the Ctrl+K hotkey a silent no-op there), that results are clickable, and —
// the reason this exists — that a BLOCKED user's message never appears as a
// search hit. Blocking gated the message list and reply previews but not
// search, so their text came back verbatim and attributed.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/search-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const A = 'srcha_' + stamp;
const B = 'srchb_' + stamp;
const NEEDLE = 'pineapple' + stamp;

let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch();

async function register(ctx, user) {
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('#username');
    await page.click('.toggle-mode');
    await page.waitForSelector('#inviteCode');
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1300);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
}

const searchFor = async (page, term) => {
    const box = page.locator('.search-bar input');
    await box.waitFor({ timeout: 10000 });
    await box.fill('');
    await box.type(term, { delay: 20 });
    // Debounced at 200 ms, then a network round trip + decrypt.
    await page.waitForTimeout(2500);
    return page.evaluate(() => ({
        items: [...document.querySelectorAll('.search-result-item')].map(e => e.textContent?.trim() || ''),
        footer: document.querySelector('.search-footer')?.textContent?.trim() || '',
        none: !!document.querySelector('.search-no-results'),
    }));
};

try {
    const ctxA = await browser.newContext();
    const alice = await register(ctxA, A);
    const ctxB = await browser.newContext();
    const bob = await register(ctxB, B);

    // Shared server so both can post in a channel.
    await alice.locator('.server-icon.add-server').click({ timeout: 8000 });
    await alice.waitForTimeout(600);
    await alice.locator('.template-card').first().click({ timeout: 5000 });
    await alice.waitForTimeout(300);
    await alice.locator('.audience-card').first().click({ timeout: 5000 });
    await alice.waitForTimeout(300);
    await alice.locator('.server-name-input input').fill('SearchTest');
    await alice.locator('.wizard-actions .create-btn').click();
    await alice.waitForTimeout(3000);

    const aId = psql(`SELECT id FROM users WHERE username='${A}'`);
    const bId = psql(`SELECT id FROM users WHERE username='${B}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aId} ORDER BY id DESC LIMIT 1`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);
    check('two users in one server', !!serverId);

    // Bob posts the needle in the channel.
    await bob.reload();
    await bob.waitForTimeout(2500);
    await bob.evaluate(() => {
        const t = [...document.querySelectorAll('.server-icon')].find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        t?.click();
    });
    await bob.waitForTimeout(1500);
    const bobComposer = bob.locator('textarea[placeholder^="Message #"]');
    await bobComposer.waitFor({ timeout: 10000 });
    await bobComposer.fill(`${NEEDLE} from bob`);
    await bobComposer.press('Enter');
    await bob.waitForTimeout(1500);

    // Alice posts the SAME needle herself. This is the positive control for
    // the block assertion below: after blocking Bob, search must still return
    // Alice's own hit. Without it, "no results for any reason" — a broken
    // search, a failed fetch, a renamed selector — would pass as if blocking
    // were working.
    await alice.reload();
    await alice.waitForTimeout(2500);
    try { await alice.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    await alice.evaluate(() => {
        const t = [...document.querySelectorAll('.server-icon')].find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        t?.click();
    });
    await alice.waitForTimeout(1500);
    const aliceComposer = alice.locator('textarea[placeholder^="Message #"]');
    await aliceComposer.waitFor({ timeout: 10000 });
    await aliceComposer.fill(`${NEEDLE} from alice`);
    await aliceComposer.press('Enter');
    await alice.waitForTimeout(1500);

    // Alice can find it.
    await alice.reload();
    await alice.waitForTimeout(2500);
    try { await alice.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    const found = await searchFor(alice, NEEDLE);
    check('channel search finds BOTH authors before blocking',
        found.items.some(t => t.includes('from bob')) && found.items.some(t => t.includes('from alice')),
        JSON.stringify(found).slice(0, 300));
    check('the footer states how much was searched', /Searched \d+ message/.test(found.footer), found.footer);

    // THE LEAK: block Bob, then search again. His message must vanish.
    await alice.evaluate(async (id) => {
        const token = localStorage.getItem('auth_token');
        await fetch(`http://127.0.0.1:3000/users/${id}/block`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
        });
    }, bId);
    await alice.reload();
    await alice.waitForTimeout(3000);
    try { await alice.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    const afterBlock = await searchFor(alice, NEEDLE);
    check('a BLOCKED user\'s message is not a search hit',
        !afterBlock.items.some(t => t.includes('from bob')), JSON.stringify(afterBlock).slice(0, 300));
    // THE CONTROL: search must still be WORKING. Without this, the assertion
    // above passes on an empty result set — a broken search, a failed fetch or
    // a renamed selector would all read as "blocking works".
    check('control: search still returns the non-blocked author',
        afterBlock.items.some(t => t.includes('from alice')), JSON.stringify(afterBlock).slice(0, 300));

    // And a DM hit must actually JUMP, not claim the message is unloaded.
    // Only channel rows carried an element id, so every DM result was a dead
    // click that blamed "further back than the loaded history".
    await alice.evaluate(async () => {
        const token = localStorage.getItem('auth_token');
        const me = await fetch('http://127.0.0.1:3000/profile', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        await fetch('http://127.0.0.1:3000/dms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ user_id: me.id }),
        });
    });

    // Search exists in DMs too (it used to be channel-only).
    await alice.evaluate(async (id) => {
        const token = localStorage.getItem('auth_token');
        await fetch('http://127.0.0.1:3000/dms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ user_id: Number(id) }),
        });
    }, aId);
    await alice.reload();
    await alice.waitForTimeout(2500);
    try { await alice.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    // Alice is on a SERVER view; the DM list lives in the home view, so go
    // there first (the rail's direct-messages button).
    await alice.evaluate(() => {
        const btn = [...document.querySelectorAll('.server-icon, button')]
            .find(e => /direct message/i.test(e.getAttribute('title') || ''));
        btn?.click();
    });
    await alice.waitForTimeout(1500);
    const dmRow = alice.locator('.dm-item').first();
    await dmRow.waitFor({ timeout: 12000 });
    await dmRow.click();
    await alice.locator('textarea[placeholder^="Message @"]').waitFor({ timeout: 12000 });
    const dmBoxExists = await alice.locator('.search-bar input').count();
    check('the search box exists inside a DM', dmBoxExists > 0);

    // Post a DM to self, then search for it and CLICK the hit. The previous
    // version of this file only checked the box existed — which is exactly how
    // "every DM result is a dead click" reached a release candidate.
    const dmComposer = alice.locator('textarea[placeholder^="Message @"]');
    await dmComposer.fill(`${NEEDLE} in a dm`);
    await dmComposer.press('Enter');
    await alice.waitForTimeout(1800);
    const dmFound = await searchFor(alice, NEEDLE);
    check('DM search finds the message', dmFound.items.some(t => t.includes('in a dm')),
        JSON.stringify(dmFound).slice(0, 250));
    const jumped = await alice.evaluate(() => {
        const row = document.querySelector('.search-result-item');
        if (!row) return { clicked: false };
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { clicked: true };
    });
    await alice.waitForTimeout(900);
    const jumpState = await alice.evaluate(() => ({
        notice: document.querySelector('.search-jump-notice')?.textContent?.trim() || '',
        highlighted: !!document.querySelector('.message.highlight'),
    }));
    check('clicking a DM result jumps instead of claiming it is unloaded',
        jumped.clicked && jumpState.notice === '' && jumpState.highlighted,
        JSON.stringify(jumpState));
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
