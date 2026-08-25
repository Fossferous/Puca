// Peer-to-peer file transfer to YOURSELF — PC to phone, one account, two
// devices signed in at once.
//
// This is the case ordinary two-party routing cannot express: both legs carry
// the same user id, so `peer_of(me)` answers `me` and a user-scoped send hands
// each device its own SDP offer back. The server pins each leg to a CONNECTION
// (FileTransfer::from_conn / to_conn) so the two sockets can actually reach
// each other; this proves that end to end rather than by inspection.
//
// Two browser CONTEXTS = two devices: separate storage, separate WebSocket,
// separate ICE agent, same account.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/p2p-self-transfer.mjs
import { chromium } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const USER = 'p2pself_' + stamp;
// Over the 25 MB server-upload cap (which is what routes it peer-to-peer) and
// under the 256 MB browser memory sink.
const FILE_BYTES = 30 * 1024 * 1024;

let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

const filePath = join(tmpdir(), `p2p-self-${stamp}.bin`);
const buf = Buffer.alloc(FILE_BYTES);
for (let i = 0; i < FILE_BYTES; i += 4096) buf.writeUInt32BE(i >>> 0, i);
writeFileSync(filePath, buf);

const browser = await chromium.launch({
    // Headless Chromium otherwise hides local IPs behind mDNS candidates the
    // other context cannot resolve, and ICE flakes for unrelated reasons.
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function signIn(ctx, label, { register }) {
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept().catch(() => {}));
    page.on('pageerror', e => console.log(`    [${label}] PAGEERROR ${String(e).slice(0, 200)}`));
    page.on('console', m => {
        const t = m.text();
        if (/p2p|datachannel|ice=|sctp|server error/i.test(t)) console.log(`    [${label}] ${t.slice(0, 200)}`);
    });
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('#username');
    if (register) {
        await page.click('.toggle-mode');
        await page.waitForSelector('#inviteCode');
    }
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older build */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    await page.evaluate(() => {
        const k = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        s.experimentalP2PTransfers = true;
        localStorage.setItem(k, JSON.stringify(s));
    });
    await page.reload();
    await page.waitForTimeout(2000);
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
}

const rows = (page) => page.evaluate(() =>
    [...document.querySelectorAll('[class*="xfer"]')].map(e => e.textContent?.trim().slice(0, 200)).filter(Boolean));

try {
    // Device 1 registers; device 2 signs in to the SAME account.
    const pc = await signIn(await browser.newContext(), 'pc', { register: true });
    const phone = await signIn(await browser.newContext(), 'phone', { register: false });
    check('same account signed in on two devices', true);

    // Open the conversation with yourself, from the PC.
    const opened = await pc.evaluate(async () => {
        const token = localStorage.getItem('auth_token');
        const api = 'http://127.0.0.1:3000';
        const me = await fetch(`${api}/profile`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        const conv = await fetch(`${api}/dms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ user_id: me.id }),
        });
        const body = await conv.json().catch(() => null);
        return { ok: conv.ok, status: conv.status, myId: me.id, otherId: body?.other_user_id };
    });
    check('can open a conversation with yourself', opened.ok, `status=${opened.status}`);
    check('the conversation reports YOU as the other party', opened.otherId === opened.myId,
        `other=${opened.otherId} me=${opened.myId}`);

    for (const [label, page] of [['pc', pc], ['phone', phone]]) {
        await page.reload();
        await page.waitForTimeout(2500);
        try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
        const row = page.locator('.dm-item', { hasText: USER }).first();
        await row.waitFor({ timeout: 15000 });
        await row.click();
        await page.locator('textarea[placeholder^="Message @"]').waitFor({ timeout: 15000 });
        check(`${label} opened the self-conversation`, true);
    }

    // Send the large file from the PC.
    await pc.locator('input[type="file"]').first().setInputFiles(filePath);
    await pc.waitForTimeout(4000);
    const pcRows = await rows(pc);
    check('PC shows an outgoing transfer (P2P path taken)', pcRows.length > 0, JSON.stringify(pcRows).slice(0, 200));

    // THE POINT: the offer must appear on the PHONE, not bounce back to the PC.
    const phoneSaw = await phone.evaluate(async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const btn = [...document.querySelectorAll('button')].find(b => /accept/i.test(b.textContent || ''));
            if (btn) { btn.click(); return true; }
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    });
    check('the offer reached the OTHER device and was accepted', phoneSaw,
        phoneSaw ? '' : JSON.stringify(await rows(phone)).slice(0, 200));

    // And the PC must NOT have been offered its own file.
    const pcSelfOffered = await pc.evaluate(() =>
        [...document.querySelectorAll('button')].some(b => /accept/i.test(b.textContent || '')));
    check('the sending device was NOT offered its own file', !pcSelfOffered);

    const outcome = await phone.evaluate(async () => {
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            const txt = document.body.innerText;
            if (/saved to|complete|verified/i.test(txt)) return { done: true, txt: txt.slice(0, 300) };
            if (/failed|could not/i.test(txt)) return { done: false, txt: txt.slice(0, 300) };
            await new Promise(r => setTimeout(r, 1000));
        }
        return { done: false, txt: 'TIMED OUT: ' + document.body.innerText.slice(0, 300) };
    });
    check('30 MB arrived on the other device', outcome.done, outcome.txt.replace(/\s+/g, ' ').slice(0, 220));
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    try { rmSync(filePath); } catch { /* gone */ }
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
