// ONE CAPTURE OF A SURFACE WHILE SHARING IT WITH CLIPS ARMED, in a real
// browser (docs/CLIPS.md, "Sharing while armed"; replayBuffer.ts
// followShareCapture, replayWorker.ts Ring.rebindVideo).
//
// WHY. A clip buffer armed with the picker captures a surface with
// getDisplayMedia. Sharing the same surface captured it AGAIN, beside it: two
// readbacks and two colour conversions of every frame (frontend/e2e/
// clip-share-cpu-measure.mjs measures what that costs). Now the ring moves
// onto a clone of the share's track and stops its own capture, without
// changing anything about the clip. vitest pins the decisions with stand-ins;
// what only a real browser can show is that the move is real: a real clone,
// a real VideoEncoder carried across the switch, and a clip that a real MSE
// player plays.
//
// WHAT IT CHECKS, on the real replayBuffer.ts + rtc/media.ts + replay worker
// (e2e/clip-share/, built by vite.clipshareharness.config.ts). The "screen"
// is a canvas whose every frame carries its number, captured once per
// getDisplayMedia call (a headless browser has no screen to pick; a known
// picture is what lets the clip's frames be checked):
//   - a share of the same surface: the ring follows it, the ring's own
//     capture ENDS and the share's is the only one left (ONE capture);
//   - the share stops: the ring keeps reading (its clone outlives it);
//   - a clip spanning before the share, the share and after it seals with
//     NOTHING LOST (lostMs 0, as long as asked), plays, and its frames are
//     the screen's, in order, across both switches (the same picture the
//     share sent);
//   - CONTROLS: a share of ANOTHER surface, and a share captured SMALLER
//     than the clip, are not followed: two captures stay live, and the clip
//     is unaffected.
//
//   cd frontend && node e2e/clip-share-follow-real-browser.mjs
//
// Builds its own harness; no server, no network. Silent (--mute-audio, no
// audio track anywhere, muted elements). Headless: no window, no focus.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..'); // frontend/
let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); } else { fail++; console.log('FAIL', label, extra); }
    return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execFileSync(process.execPath, [join(HERE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.clipshareharness.config.ts', '--logLevel', 'error'], { cwd: HERE, stdio: 'inherit' });
const ROOT = join(HERE, 'e2e-artifacts', 'clip-share-dist');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '') || 'index.html';
    if (rel.includes('..')) { res.writeHead(403); return res.end(); }
    try {
        const body = await readFile(join(ROOT, rel));
        res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
        res.end(body);
    } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
    headless: true,
    channel: process.env.CHANNEL || 'msedge',
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  X>', String(e).slice(0, 300)));
page.on('console', (m) => { const t = m.text(); if (/\[clips\]|error/i.test(t)) console.log('  C>', t.slice(0, 220)); });
await page.goto(origin);
await page.waitForFunction(() => !!window.harness);

const H = (fn, arg) => page.evaluate(fn, arg);
const state = () => H(() => window.harness.state());
const captures = () => H(() => window.harness.captures());
async function until(pred, ms, what) {
    const t0 = Date.now();
    for (;;) {
        const s = await state();
        if (pred(s)) return s;
        if (Date.now() - t0 > ms) { console.log(`  (timed out waiting for ${what}: ${JSON.stringify(s)})`); return s; }
        await sleep(200);
    }
}

try {
    // ---- arm by hand, then share the same surface ------------------------------
    await H(() => window.harness.next('clip'));
    await H(() => window.harness.arm(60));
    let s = await until((x) => x.phase === 'armed' && !!x.videoCodec, 15_000, 'the ring to arm');
    ck(s.phase === 'armed', 'the clip buffer arms from the picker capture', `${s.width}x${s.height} ${s.videoCodec}`);
    await sleep(5_000);
    const beforeFollow = await H(() => window.harness.frameNo());

    await H(() => window.harness.next('share'));
    await H(() => window.harness.share());
    s = await until((x) => x.sharedCapture, 12_000, 'the ring to follow the share');
    // When it did not, its own answer for the live share says why.
    if (!s.sharedCapture) console.log('  followShareCapture says:', await H(() => window.harness.follow()));
    ck(s.sharedCapture, 'a share of the SAME surface: the ring follows its capture');
    const followedAt = await H(() => window.harness.frameNo());
    let caps = await captures();
    ck(caps.find((c) => c.purpose === 'clip')?.state === 'ended', 'the clip buffer\'s own capture has ENDED', JSON.stringify(caps));
    ck(caps.filter((c) => c.state === 'live').length === 1 && caps.find((c) => c.purpose === 'share')?.state === 'live', 'ONE capture of the surface is left, the share\'s', JSON.stringify(caps));
    ck(s.phase === 'armed' && s.width === 1920 && s.height === 1080, 'the ring is still armed at the same size', `${s.phase} ${s.width}x${s.height}`);

    await sleep(4_000);
    const stopAt = await H(() => window.harness.frameNo());
    await H(() => window.harness.stopShare());
    caps = await captures();
    ck(caps.every((c) => c.state === 'ended'), 'the share stopped: its own track ended too', JSON.stringify(caps));
    await sleep(4_000);
    s = await state();
    ck(s.phase === 'armed' && s.sharedCapture && s.fps >= 15, "and the ring is still fed, from the share's capture (its clone outlives the share)", `phase=${s.phase} shared=${s.sharedCapture} fps=${s.fps} buffered=${s.bufferedMs}ms`);

    // ---- a clip across all of it --------------------------------------------------
    const sealed = await H((ms) => window.harness.seal(ms), 30_000);
    ck(sealed.ok, 'a clip of the last 30 s seals', sealed.message ?? '');
    const info = sealed.info ?? {};
    ck(info.lostMs === 0, 'nothing was lost at the switches (lostMs 0)', `lostMs=${info.lostMs}`);
    // ~5 s of its own capture, ~4 s of the share, ~4 s after: ~13 s, all of it.
    ck(info.durationMs >= 12_000, 'the clip holds all of it: its own capture, the share and after', `duration=${info.durationMs} ms`);
    ck(info.width === 1920 && info.height === 1080, 'the clip is the screen\'s size', `${info.width}x${info.height}`);

    const w = await H(() => window.harness.watch());
    ck(w.muted && w.width === 1920 && w.height === 1080, 'it plays, at the screen\'s size (muted)', `${w.width}x${w.height} duration=${w.durationMs}`);
    const seen = w.seen;
    const increasing = seen.every((n, i) => i === 0 || n > seen[i - 1]);
    ck(seen.length >= 100 && increasing, 'every frame shown is the screen\'s, in order', `frames read=${seen.length} unreadable=${w.unreadable} first=${seen[0]} last=${seen[seen.length - 1]}`);
    const maxGap = seen.reduce((m, n, i) => (i ? Math.max(m, n - seen[i - 1]) : m), 0);
    ck(maxGap <= 6, 'with no hole anywhere, the two switches included', `largest step between frames shown: ${maxGap}`);
    ck(seen[0] < beforeFollow && seen.some((n) => n > followedAt && n < stopAt) && seen[seen.length - 1] > stopAt,
        'and it spans the ring\'s own capture, the share\'s, and after the share', `first=${seen[0]} < ${beforeFollow}; follow at ${followedAt}; share stopped at ${stopAt} < last=${seen[seen.length - 1]}`);
    await H(() => window.harness.disarm());

    // ---- the other order: sharing first, then arming by hand -------------------
    // The worker's arm() is async (its key, the codec probe): the follow must
    // wait for it, or the worker refuses a ring that is not running yet.
    await H(() => window.harness.next('share-first'));
    await H(() => window.harness.share());
    await H(() => window.harness.next('clip'));
    await H(() => window.harness.arm(60));
    s = await until((x) => x.sharedCapture, 15_000, 'the ring to follow a share already live');
    caps = (await captures()).slice(-2);
    ck(s.sharedCapture && caps.find((c) => c.purpose === 'clip')?.state === 'ended' && caps.find((c) => c.purpose === 'share-first')?.state === 'live',
        'sharing first, then arming: the buffer follows the share once its worker has armed (one capture)', JSON.stringify(caps));
    await H(() => window.harness.stopShare());
    await H(() => window.harness.disarm());

    // ---- CONTROL: a share of ANOTHER surface is not followed --------------------
    await H(() => window.harness.next('clip'));
    await H(() => window.harness.arm(60));
    s = await until((x) => x.phase === 'armed' && !!x.videoCodec, 15_000, 'the second arm');
    await H(() => window.harness.next('share-other', 'screen:other:0'));
    await H(() => window.harness.share());
    await sleep(3_000);
    s = await state();
    caps = (await captures()).slice(-2);
    ck(!s.sharedCapture && caps.every((c) => c.state === 'live'), 'CONTROL: a share of ANOTHER surface is not followed; two captures stay live', JSON.stringify(caps));
    await H(() => window.harness.stopShare());
    await H(() => window.harness.disarm());

    // ---- CONTROL: a share captured SMALLER than the clip is not followed --------
    await H(() => window.harness.next('clip'));
    await H(() => window.harness.arm(60));
    s = await until((x) => x.phase === 'armed' && !!x.videoCodec, 15_000, 'the third arm');
    await sleep(3_000);
    await H(() => window.harness.next('share-small', 'screen:rig:0', 1));
    await H(() => window.harness.share(1280, 720));
    await sleep(4_000);
    s = await state();
    caps = (await captures()).slice(-2);
    ck(!s.sharedCapture && caps.every((c) => c.state === 'live'), 'CONTROL: a share captured smaller (1280x720) is refused by the worker; the ring keeps its own capture', JSON.stringify(caps));
    const sealed2 = await H((ms) => window.harness.seal(ms), 30_000);
    ck(sealed2.ok && sealed2.info.lostMs === 0 && sealed2.info.width === 1920, 'and its clip is unaffected (1920x1080, nothing lost)', JSON.stringify(sealed2.info ? { w: sealed2.info.width, lost: sealed2.info.lostMs, dur: sealed2.info.durationMs } : sealed2));
    await H(() => window.harness.stopShare());
    await H(() => window.harness.disarm());
} finally {
    await browser.close();
    server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
