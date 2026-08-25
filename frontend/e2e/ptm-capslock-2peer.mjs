// Live 2-peer PUSH-TO-MUTE test — the "hold to mute doesn't work" report.
// Peer A binds PTM to CAPSLOCK (the user's actual key), holds it, and we
// assert the REAL outgoing gate (sender track disabled via
// __pucaMeshDiag) across two hold cycles (the CapsLock LED toggle must
// not invert anything) PLUS the UI feedback (mic button red + explanatory
// title while held) whose absence made a working hold read as broken.
// Prereqs: backend :3000 + vite :5173. Usage: node e2e/ptm-capslock-2peer.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const AUSER = 'ptmhold_' + stamp;
const BUSER = 'ptmpeer_' + stamp;

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch({
    args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Real-address host candidates. Headless Chromium's mDNS (.local)
        // candidate resolution is a race, and when it loses, the only
        // remaining ICE pairs go via the STUN-reflexive address — which on a
        // VPN'd dev machine hairpins requests but EATS the responses, so ICE
        // sits in 'checking' for 15s and Chromium kills a call whose media
        // is actually flowing (the pc-rebuild cascade this suite kept
        // tripping over). Same-machine tests must connect host<->host.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
});

async function register(ctx, user) {
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') console.log(`  [${user} err]`, m.text().slice(0, 140)); });
    await page.goto('http://localhost:5173/login');
    await page.waitForURL('**/login');
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.waitForSelector('#inviteCode', { timeout: 5000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1200);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older flow */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

// Select the (single) server on the rail, then join the named voice channel.
async function joinVoice(page, chName) {
    await page.reload();
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(1500);
    const result = await page.evaluate((name) => {
        // Voice channels render the name as raw text inside `.voice-channel`
        // (beside a speaker/AFK icon span), NOT in a `.channel-name` element.
        // The icon is an <svg> and contributes no textContent, so collapsing
        // whitespace is all this needs.
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const dump = items.map(n => n.textContent.replace(/\s+/g, ' ').trim());
        const el = items.find(n => !n.classList.contains('afk') && n.textContent.includes(name));
        if (el) { el.click(); return { ok: true, dump }; }
        return { ok: false, dump };
    }, chName);
    return result;
}

try {
    // --- Peer A: fresh owner, one server ---
    const ctxA = await browser.newContext();
    const pageA = await register(ctxA, AUSER);
    await createServer(pageA, 'PtmTest');
    const aId = psql(`SELECT id FROM users WHERE username='${AUSER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aId} ORDER BY id DESC LIMIT 1`);
    check('server created for owner', !!serverId);

    // --- Peer B: fresh, inserted as member ---
    const ctxB = await browser.newContext();
    const pageB = await register(ctxB, BUSER);
    const bId = psql(`SELECT id FROM users WHERE username='${BUSER}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);
    check('peer B is a server member', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${bId}`) === '1');

    // --- Both join the "default" voice channel ---
    const jA = await joinVoice(pageA, 'default');
    const jB = await joinVoice(pageB, 'default');
    console.log('  A voice channels:', JSON.stringify(jA.dump), '-> joined:', jA.ok);
    console.log('  B voice channels:', JSON.stringify(jB.dump), '-> joined:', jB.ok);
    check('both joined the voice channel', jA.ok && jB.ok);
    await pageA.waitForTimeout(6000); // mesh WebRTC connect
    check('A shows Voice Connected', await pageA.locator('.voice-connection-info').count() > 0);
    check('B shows Voice Connected', await pageB.locator('.voice-connection-info').count() > 0);

    // --- A switches to push-to-mute bound to CAPSLOCK (the field report) ---
    await pageA.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
        s.voiceInputMode = 'pushToMute';
        s.ptmBinding = { keyCode: 20, ctrl: false, alt: false, shift: false, label: 'CapsLock' };
        localStorage.setItem('sovereign_settings', JSON.stringify(s));
        window.dispatchEvent(new CustomEvent('settingsChanged'));
    });
    await pageA.waitForTimeout(1500);

    const senderState = () => pageA.evaluate(async () => {
        const d = await window.__pucaMeshDiag();
        return (d[0]?.senders ?? []).join(',');
    });

    const idle = await senderState();
    console.log('  A sender (PTM idle):', idle);
    check('PTM idle: mic OPEN', /audio:live(?!:disabled)/.test(idle));

    await pageA.keyboard.down('CapsLock');
    await pageA.waitForTimeout(400);
    const held = await senderState();
    console.log('  A sender (CapsLock HELD):', held);
    check('CapsLock held: mic MUTED', /audio:live:disabled/.test(held));
    // The fix for the report: the mic button must SHOW the held state.
    const micBtn = await pageA.evaluate(() => {
        const b = document.querySelector('.voice-controls-compact .voice-btn');
        return { cls: b?.className ?? '', title: b?.getAttribute('title') ?? '' };
    });
    console.log('  mic button while held:', JSON.stringify(micBtn));
    check('mic button turns red while PTM held', micBtn.cls.includes('active'));
    check('mic button title explains the hold', /push-to-mute held/i.test(micBtn.title));

    await pageA.keyboard.up('CapsLock');
    await pageA.waitForTimeout(400);
    const released = await senderState();
    console.log('  A sender (released):', released);
    check('CapsLock released: mic OPEN again', /audio:live(?!:disabled)/.test(released));

    // Second hold cycle — a toggling LED state must not invert the gate.
    await pageA.keyboard.down('CapsLock');
    await pageA.waitForTimeout(400);
    const held2 = await senderState();
    console.log('  A sender (2nd hold):', held2);
    check('2nd hold: mic MUTED again', /audio:live:disabled/.test(held2));
    await pageA.keyboard.up('CapsLock');
    await pageA.waitForTimeout(400);
    const rel2 = await senderState();
    check('2nd release: mic OPEN again', /audio:live(?!:disabled)/.test(rel2));
} catch (e) {
    console.log('EXCEPTION:', String(e).slice(0, 300));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
