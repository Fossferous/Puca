// Peer-to-peer file transfer between TWO REAL CLIENTS, end to end.
//
// e2e/p2p-loopback.mjs already proves the ENGINE (SCTP, chunking, real
// backpressure, digest) by running both peers inside one page with signalling
// wired directly. It explicitly does not cover the layer above:
//
//   - the WS control plane (FileOffer / FileAccept / FileComplete),
//   - DM authorization (P2P only fires inside a DM),
//   - two INDEPENDENT ICE agents actually finding each other,
//   - the receiver's sink.
//
// That uncovered layer is exactly where "the transfer died" lives, and
// fileTransferManager's own master-switch comment says no byte has ever
// crossed between two peers. This closes that gap.
//
// WHAT THIS FOUND (2026-07-28), and why the suite asserts a PRECONDITION that
// looks odd: the receiver must already have that exact DM open before the
// offer arrives. FileTransfers is mounted in Chat.tsx behind
// `p2pOn && currentDM && ...`, so the incoming offer — and the Accept button
// with it — simply does not exist anywhere else in the app. A recipient
// sitting in a server channel, the Friends panel, or a DIFFERENT DM is never
// told anything, and the sender sits on "Waiting for them to accept…" until
// the 120 s offer TTL quietly reaps it. That is the "transfer died" report:
// not a timing fault in the engine, which is why two timing fixes missed it.
//
// The suite now asserts the FIXED behaviour: the receiver sits on the friends
// view, never opens the DM, and must still see and accept the offer from the
// app-wide tray. Re-scope FileTransfers back inside the DM and this fails.
//
// SCOPE: both browsers run on this machine, so ICE succeeds on host
// candidates. It therefore does NOT prove cross-NAT traversal or TURN relay —
// if this passes but real transfers still fail between two houses, the next
// suspect is ICE/TURN, not the control plane.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/p2p-transfer-2user.mjs
import { chromium } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const SENDER = 'p2ps_' + stamp;
const RECVER = 'p2pr_' + stamp;
// P2P only engages ABOVE the 25 MB upload cap (below it the server path is
// used), and the browser memory sink caps at 256 MB. 30 MB sits between.
const FILE_BYTES = 30 * 1024 * 1024;

let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

const filePath = join(tmpdir(), `p2p-payload-${stamp}.bin`);
// Compressible-but-varied content, so a truncated or reordered result cannot
// accidentally match the digest.
const buf = Buffer.alloc(FILE_BYTES);
for (let i = 0; i < FILE_BYTES; i += 4096) buf.writeUInt32BE(i >>> 0, i);
writeFileSync(filePath, buf);

const browser = await chromium.launch({
    // WITHOUT THIS, headless Chromium hides local IPs behind mDNS candidates
    // that the other context cannot resolve, and ICE flakes for reasons that
    // have nothing to do with the code under test (see the voice e2e notes).
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function register(ctx, user) {
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept().catch(() => {}));
    page.on('console', m => {
        const t = m.text();
        if (/transfer|datachannel|ice|sctp|dtls/i.test(t)) console.log(`    [${user}] ${t.slice(0, 200)}`);
    });
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('#username');
    await page.click('.toggle-mode');
    await page.waitForSelector('#inviteCode');
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1200);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older build */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    // The feature is behind an experimental opt-in; turn it on the same way
    // the settings UI does, then reload so Chat picks it up.
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

/** Read the transfer cards the UI is showing, including any failure reason.
 *  `.xfer-card` is the real class; the loose fallback stays as a canary for a
 *  rename (it would keep this returning SOMETHING rather than []). */
const transferState = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.xfer-card, [class*="xfer"]')]
        .map(e => e.textContent?.trim().slice(0, 300))
        .filter(Boolean));

try {
    const ctxA = await browser.newContext();
    const sender = await register(ctxA, SENDER);
    const ctxB = await browser.newContext();
    const receiver = await register(ctxB, RECVER);
    check('both clients signed in with P2P enabled', true);

    // Sender opens a DM with the receiver by username (Friends -> search).
    const opened = await sender.evaluate(async (name) => {
        const token = localStorage.getItem('auth_token');
        const api = 'http://127.0.0.1:3000';
        const list = await fetch(`${api}/users/search?q=${encodeURIComponent(name)}`, {
            headers: { Authorization: `Bearer ${token}` },
        }).then(r => r.ok ? r.json() : []).catch(() => []);
        const target = Array.isArray(list) ? list.find(u => u.username === name) : null;
        if (!target) return { ok: false, why: 'user search found nobody' };
        const conv = await fetch(`${api}/dms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ user_id: target.id }),
        });
        return { ok: conv.ok, why: `POST /dms ${conv.status}`, id: target.id };
    }, RECVER);
    check('DM conversation created', opened.ok, JSON.stringify(opened));

    await sender.reload();
    await sender.waitForTimeout(2500);

    // Click into the DM in the sidebar. A real Playwright click, not a
    // dispatched one: React's handler is what opens the conversation.
    const dmRow = sender.locator('.dm-item', { hasText: RECVER }).first();
    await dmRow.waitFor({ timeout: 15000 });
    await dmRow.click();
    // The composer only mounts once a conversation is actually selected, so
    // waiting for it is what proves the DM opened.
    const composer = sender.locator('textarea[placeholder^="Message @"]');
    await composer.waitFor({ timeout: 15000 });
    check('sender opened the DM (composer mounted)', true);

    // THE REGRESSION CASE: the receiver is deliberately NOT looking at that
    // DM. They sit on the Friends panel — exactly where a real recipient is
    // when a file arrives unannounced. Before the app-wide tray this produced
    // no offer, no Accept button and no notification anywhere, and the sender
    // hung on "Waiting for them to accept…" until the offer TTL reaped it.
    await receiver.reload();
    await receiver.waitForTimeout(2500);
    try { await receiver.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    const onDm = await receiver.evaluate(() =>
        !!document.querySelector('textarea[placeholder^="Message @"]'));
    check('receiver is NOT in the DM when the offer arrives', !onDm,
        onDm ? 'receiver was already in the DM — the case under test is void' : 'on the friends/home view');

    // Attach the >25 MB file through the composer's real file input, which is
    // the code path that decides server-upload vs peer-to-peer.
    const input = sender.locator('input[type="file"]').first();
    await input.setInputFiles(filePath);
    await sender.waitForTimeout(4000);

    const senderRows = await transferState(sender);
    check('sender shows a transfer (P2P path taken, not server upload)',
        senderRows.length > 0, JSON.stringify(senderRows).slice(0, 300));

    // Receiver should see the offer and be able to accept it.
    await receiver.waitForTimeout(2000);
    const accepted = await receiver.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /accept/i.test(b.textContent || ''));
        if (!btn) return false;
        btn.click();
        return true;
    });
    check('receiver saw the offer and accepted', accepted,
        accepted ? '' : JSON.stringify(await transferState(receiver)).slice(0, 300));

    // Wait for terminal state on the RECEIVER (complete or failed), up to 3 min.
    const outcome = await receiver.evaluate(async () => {
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            const txt = document.body.innerText;
            if (/saved to|complete|verified/i.test(txt)) return { done: true, txt: txt.slice(0, 400) };
            if (/failed|error|could not/i.test(txt)) return { done: false, txt: txt.slice(0, 400) };
            await new Promise(r => setTimeout(r, 1000));
        }
        return { done: false, txt: 'TIMED OUT: ' + document.body.innerText.slice(0, 400) };
    });
    check('transfer reached the receiver', outcome.done, outcome.txt.replace(/\s+/g, ' ').slice(0, 300));

    if (!outcome.done) {
        console.log('\n--- sender rows ---');
        console.log(JSON.stringify(await transferState(sender), null, 1).slice(0, 800));
        console.log('--- receiver rows ---');
        console.log(JSON.stringify(await transferState(receiver), null, 1).slice(0, 800));
    }
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    try { rmSync(filePath); } catch { /* already gone */ }
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
