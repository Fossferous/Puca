// LIVE PROD acceptance for the Tier-2 SFU (feature/sfu-tier2, v0.6.3):
// two fresh accounts on https://app.example.com join an sfu_mode voice channel;
// media must flow THROUGH the LiveKit SFU (wss://sfu.example.com signaling, UDP
// 7882 media to the origin IP) with E2EE on — proven by decoded audio energy
// and a rendering camera tile on the receiving side.
//
// NOTE: run from inside the host LAN this also exercises NAT hairpinning —
// "rooms join but zero media" here means hairpin, not a deploy fault; retest
// from an external vantage before concluding.
//
// Env: INVITE (prod registration invite code). Cleanup: test users' rows stay
// (same policy as other live tests; prune manually if desired).
// Usage: INVITE=... node e2e/sfu-live-2peer.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const APP = 'https://app.example.com';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const AUSER = 'sfua_' + stamp;
const BUSER = 'sfub_' + stamp;
const INVITE = process.env.INVITE || '';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };

// psql inside prod container via the deploy key (setup/inspection only).
const KEY = homedir().replace(/\\/g, '/') + '/.ssh/puca_deploy';
// The live SFU tests need shell access to the box running Postgres and LiveKit.
// There is no sensible default: a wrong host would quietly query the wrong
// database and report a pass, so it must be supplied explicitly.
//
//   SFU_SSH_HOST=root@your-server \
//   [SFU_DB_EXEC='pct exec <ctid> -- ']  # wrapper if the DB is in a container
//   [SFU_DB_NAME=puca] [SFU_SSH_KEY=~/.ssh/id_ed25519] \
//   INVITE=... node e2e/<this-script>
const SSH_HOST = process.env.SFU_SSH_HOST || '';
const SSH_KEY = process.env.SFU_SSH_KEY || KEY;
const DB_EXEC = process.env.SFU_DB_EXEC || '';
const DB_NAME = process.env.SFU_DB_NAME || 'puca';
if (!SSH_HOST) {
    console.error('SFU_SSH_HOST is not set - see the header of this file.');
    process.exit(2);
}
const psql = (sql) => execFileSync('ssh',
    ['-i', SSH_KEY, SSH_HOST, `${DB_EXEC}su postgres -c "psql ${DB_NAME} -t -A -c \\"${sql}\\""`],
    { timeout: 30000 }).toString().trim();

const encErrors = { A: 0, B: 0 };
async function register(ctx, user, tag) {
    const page = await ctx.newPage();
    page.on('console', m => {
        const t = m.text();
        if (/encryption error/i.test(t)) { encErrors[tag]++; console.log(`  [${tag} ENC-ERR]`, t.slice(0, 120)); }
        else if (m.type() === 'error' && !/favicon|manifest/i.test(t)) console.log(`  [${tag} err]`, t.slice(0, 140));
    });
    await page.goto(APP + '/login');
    await page.waitForSelector('#username', { timeout: 20000 });
    await page.click('.toggle-mode');
    await page.waitForSelector('#inviteCode', { timeout: 5000 });
    await page.fill('#inviteCode', INVITE);
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 45000 });
    await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 5000 }); await page.click('.recovery-done-btn'); } catch { /* older flow */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 8000 });
    await page.waitForTimeout(600);
    await page.locator('.template-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(3000);
}

async function joinVoice(page, chName) {
    await page.reload();
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(2000);
    return await page.evaluate((name) => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        // The speaker/AFK icon is an <svg> and contributes no textContent.
        const dump = items.map(n => n.textContent.replace(/\s+/g, ' ').trim());
        const el = items.find(n => !n.classList.contains('afk') && n.textContent.includes(name));
        if (el) { el.click(); return { ok: true, dump }; }
        return { ok: false, dump };
    }, chName);
}

// Decoded-audio proof: RMS energy of the remote <audio> element's stream.
// Fake mic emits a tone; >0.01 RMS means frames decrypted + decoded.
async function remoteAudioRms(page, uid, ms = 3000) {
    return await page.evaluate(async ({ uid, ms }) => {
        const el = document.getElementById('audio-' + uid);
        if (!el || !el.srcObject) return { present: false };
        const track = el.srcObject.getAudioTracks()[0];
        const ctx = new AudioContext();
        await ctx.resume();
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        let peak = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            an.getFloatTimeDomainData(buf);
            const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
            peak = Math.max(peak, rms);
            await new Promise(r => setTimeout(r, 100));
        }
        return { present: true, live: track.readyState === 'live', peakRms: peak };
    }, { uid, ms });
}

const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
    if (!INVITE) { console.log('FATAL: INVITE env not set'); process.exit(1); }

    // A registers + creates the server.
    const ctxA = await browser.newContext();
    const pageA = await register(ctxA, AUSER, 'A');
    await createServer(pageA, 'SfuLive');
    const aId = psql(`SELECT id FROM users WHERE username='${AUSER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aId} ORDER BY created_at DESC LIMIT 1`);
    check('server created on prod', !!serverId, serverId);

    // Default voice channel from the server bootstrap → flip to SFU mode.
    const chRow = psql(`SELECT id||'|'||name FROM channels WHERE server_id='${serverId}' AND type=1 AND COALESCE(is_afk,false)=false ORDER BY id LIMIT 1`);
    const [chId, chName] = chRow.split('|');
    check('voice channel found', !!chId, chRow);
    psql(`UPDATE channels SET sfu_mode=true WHERE id=${chId}`);
    check('sfu_mode enabled', psql(`SELECT sfu_mode FROM channels WHERE id=${chId}`) === 't');

    // B registers and becomes a member BEFORE anyone joins voice, so the first
    // channel-key epoch is minted wrapped for BOTH (new-joiner key acquisition
    // is lazy — see docs/SFU_TIER2_DESIGN.md appendix).
    const ctxB = await browser.newContext();
    const pageB = await register(ctxB, BUSER, 'B');
    const bId = psql(`SELECT id FROM users WHERE username='${BUSER}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);
    check('B is a member', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${bId}`) === '1');

    // A joins voice first (mints the media epoch), then B.
    const jvA = await joinVoice(pageA, chName);
    check('A clicked voice channel', jvA.ok, JSON.stringify(jvA.dump));
    await pageA.waitForTimeout(6000);
    const jvB = await joinVoice(pageB, chName);
    check('B clicked voice channel', jvB.ok, JSON.stringify(jvB.dump));
    await pageB.waitForTimeout(10000);

    // Voice error surfaces?
    for (const [tag, page] of [['A', pageA], ['B', pageB]]) {
        // The absence of `.voice-error-mini` is only meaningful if the voice UI
        // rendered at all — on a blank page, a crashed app or a renamed class
        // the selector finds nothing and this reports "no voice error".
        const probe = await page.evaluate(() => ({
            err: document.querySelector('.voice-error-mini')?.textContent || '',
            voiceUi: !!document.querySelector('.voice-panel, .voice-channel-panel, [class*="voice-"]'),
        }));
        check(`${tag} voice UI is on screen (control for the error check)`, probe.voiceUi);
        check(`${tag} joined without voice error`, !probe.err, probe.err);
    }

    // Server-side truth: the LiveKit room exists with 2 participants.
    const lkJournal = execFileSync('ssh', ['-i', SSH_KEY, SSH_HOST,
        `${DB_EXEC}bash -c "journalctl -u livekit --since '-5 min' --no-pager | grep -c 'participant active.*sfu_${chId}' || true"`],
        { timeout: 30000 }).toString().trim();
    check('LiveKit saw 2 participants join sfu_' + chId, Number(lkJournal) >= 2, 'journal count=' + lkJournal);

    // Decoded media on both sides (audio RMS through the SFU with E2EE on).
    const bHearsA = await remoteAudioRms(pageB, Number(aId));
    check('B receives A audio element', bHearsA.present === true, JSON.stringify(bHearsA));
    check('B decodes A audio (E2EE through SFU)', (bHearsA.peakRms || 0) > 0.01, 'peakRms=' + bHearsA.peakRms);
    const aHearsB = await remoteAudioRms(pageA, Number(bId));
    check('A decodes B audio', (aHearsB.peakRms || 0) > 0.01, 'peakRms=' + aHearsB.peakRms);

    // Camera through the SFU: A turns on fake cam; B must RENDER frames.
    await pageA.evaluate(() => {
        const btn = [...document.querySelectorAll('.voice-btn')].find(b => (b.title || '').includes('Camera'));
        btn?.click();
    });
    await pageB.waitForTimeout(9000);
    const cam = await pageB.evaluate(() => {
        const v = document.querySelector('.remote-camera-tile video');
        return v ? { found: true, w: v.videoWidth, h: v.videoHeight } : { found: false };
    });
    check('B renders A camera via SFU (videoWidth>0)', cam.found && cam.w > 0, JSON.stringify(cam));

    check('no EncryptionError on A', encErrors.A === 0, String(encErrors.A));
    check('no EncryptionError on B', encErrors.B === 0, String(encErrors.B));

    // Hang up both (frees the SFU slots + rotates nothing).
    for (const page of [pageA, pageB]) {
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.voice-btn')].find(b => /disconnect|hang/i.test(b.title || ''));
            btn?.click();
        });
    }
    await pageA.waitForTimeout(1500);
} catch (e) {
    console.log('FATAL', e.message);
    failures++;
} finally {
    await browser.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
