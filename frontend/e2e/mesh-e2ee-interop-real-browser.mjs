// Are mesh calls end-to-end encrypted between a Chromium peer and a peer on
// the STANDARD WebRTC Encoded Transform (Firefox here; Safari and the iPhone
// home-screen app run the same path) — in real browsers, with real frames?
//
// WHY THIS EXISTS. Mesh frame encryption used Chromium's createEncodedStreams
// only, so every Firefox and Safari user was "local-unsupported": under the
// default "Require encryption for calls" they could not take part in a mesh
// call at all. The standard path (rtc/scriptTransform.ts, a worker running
// the SAME frameCrypto.ts) fixes that only if the two kinds of peer read each
// other's frames, which nothing but real engines can show: vitest has no
// WebRTC, jsdom no workers, and a unit test of the frame functions proves
// the bytes, not that an RTCRtpScriptTransform in Firefox hands those bytes
// to them, or that the worker loads under the app's own CSP.
//
// So two pages — each the REAL rtc/manager.ts with its real crypto and the
// worker chunk Vite emits for it (vite.meshharness.config.ts) — call each
// other, signalled through this script as the server would, and each one's
// "microphone" is a tone at its own frequency. What a page HEARS is measured:
// the tone's frequency in the decoded remote voice. A decoder fed ciphertext
// makes noise or nothing, never the tone.
//
//   - Chromium (createEncodedStreams) <-> Firefox (RTCRtpScriptTransform):
//     encrypted both ways, each hears the other, video decodes, VP8 chosen,
//     each engine on its OWN path (never both on one sender or receiver).
//   - Wrong-key control: the Firefox side switched to another key mid-call
//     hears nothing and is heard by nobody; its own key put back, both hear
//     again — so key changes reach the worker, in both directions.
//   - Ciphertext-on-the-wire control: the Firefox side made to pass frames
//     through UNOPENED hears no tone (the wire carries no plaintext Opus),
//     and the Chromium side, still enforcing, refuses the plaintext it is
//     then sent.
//   - Key rotation: both sides moved to a new key mid-call keep hearing each
//     other (the worker takes the new key; nothing rebuilds).
//   - Video is judged OPENED by each receiver's own transform counts (the
//     worker's on Firefox, the page's on Chromium), never by framesDecoded:
//     a VP8 decoder "decodes" a sealed frame, whose header is clear.
//   - Firefox <-> Firefox, and Chromium forced onto the standard path <->
//     Chromium on createEncodedStreams.
//   - Glare, then renegotiation: both offer at once with cameras on, Firefox
//     the polite one, then Firefox offers again (an ICE restart): Edge must
//     apply it, with nothing refused and nothing rebuilt.
//   - The worker's half of enforcement: Edge sending plaintext, Firefox
//     requiring encryption plays none of it (its worker drops every frame);
//     not requiring it, the control, it plays them.
//   - A spoiled DTLS pin, enforcement off, found by either side: nothing
//     sent toward the substitution, nothing played from it.
//   - The audit catching a transform frames go by: Chromium on the standard
//     path with its early wraps switched off (its ontrack transform then
//     ignored), fed plaintext — nothing heard while unproven, then the path
//     given up FOR THE CALL ("could not be confirmed on this call"), and the
//     next call tries it again; with the early wraps on, the control, the
//     path is kept.
//   - No false alarms: on Firefox (the audited engine) a mute, a microphone
//     swapped through the noise-mode path (the new tone heard), cameras
//     turned off and a screen share at one frame a second each way — nothing
//     given up, still encrypted, both shares opened.
//   - A worker 20 s late: not given up while it loads, nothing of Firefox's
//     microphone reaches a peer that would play it, then encrypted.
//   - A sender transform the engine ignores (Chromium, its sender's
//     `transform` setter made a no-op), enforced, toward a peer that plays
//     plaintext: the sender carries a silent stand-in until sealed, so the
//     peer hears NOTHING, and the audit gives the path up over the frames
//     that went past. Again for a camera turned on 11 s into an encrypted
//     call (the hold's valve must count from the hold): the peer is shown
//     black, never the picture; CONTROL: with its transform, the camera is.
//   - A Safari-shaped offer (H.264 first, as Safari's default is): the answer
//     still picks VP8, the codec whose header the frame format leaves clear.
//   - Fail-closed: Firefox with NEITHER API, under enforcement, sends and
//     plays nothing (the F-1 guards), while its control above does.
//   - The worker loads under every CSP the app ships (deploy/Caddyfile
//     example, deploy/ops/add-webapp-csp.py, the Android meta from
//     scripts/cap-index-csp.mjs, tauri.conf.json, tauri.lite.conf.json); a
//     policy WITHOUT worker-src 'self' must stop it, and the call must then
//     fall back to "this browser cannot encrypt" (blocked) rather than to
//     silence that claims to be encrypted.
//   - WebKit: Playwright's Windows build has no WebRTC at all; reported SKIP
//     with what it lacks. Safari itself is unverified here.
//
//   cd frontend && node e2e/mesh-e2ee-interop-real-browser.mjs
//
// Builds its own harness; no server needed. Silent by construction:
// --mute-audio, media.volume_scale 0, every element muted, the tones go to
// MediaStream destinations only. Headless: no window, no focus.
import { chromium, firefox, webkit } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..'); // frontend/
const REPO = join(HERE, '..');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let pass = 0, fail = 0, skip = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); } else { fail++; console.log('FAIL', label, extra); }
    return cond;
};
const sk = (label, why) => { skip++; console.log('SKIP', label, why); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execFileSync(process.execPath, [join(HERE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.meshharness.config.ts', '--logLevel', 'error'], { cwd: HERE, stdio: 'inherit' });
const ROOT = join(HERE, 'e2e-artifacts', 'mesh-e2ee-dist');

// ---- The Content-Security-Policies the app ships, read from where they live ----
function csps() {
    const caddy = /Content-Security-Policy "([^"]+)"/.exec(readFileSync(join(REPO, 'deploy', 'Caddyfile.example.com'), 'utf8'))?.[1];
    const tool = (() => {
        const py = readFileSync(join(REPO, 'deploy', 'ops', 'add-webapp-csp.py'), 'utf8');
        const body = /csp = \(([\s\S]*?)\n\s*\)/.exec(py)?.[1];
        return body ? [...body.matchAll(/f?"([^"]*)"/g)].map((m) => m[1]).join('').replace('{connect}', "'self'") : undefined;
    })();
    const tauri = JSON.parse(readFileSync(join(HERE, 'src-tauri', 'tauri.conf.json'), 'utf8')).app?.security?.csp;
    const lite = JSON.parse(readFileSync(join(HERE, 'src-tauri', 'tauri.lite.conf.json'), 'utf8')).app?.security?.csp;
    return { caddy, tool, tauri, lite };
}
const POLICIES = csps();
const { buildPolicy } = await import(pathToFileURL(join(HERE, 'scripts', 'cap-index-csp.mjs')).href);
POLICIES.androidMeta = buildPolicy({ apiUrl: 'http://127.0.0.1:9' });
for (const [name, p] of Object.entries(POLICIES)) {
    if (!ck(typeof p === 'string' && p.includes('worker-src'), `policy ${name} found in the repo`, p ? '' : '(missing)')) process.exit(1);
}

// ---- Serving the harness, one origin per policy ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const servers = [];
async function serve(csp, { delayWorkerMs = 0 } = {}) {
    const server = http.createServer(async (req, res) => {
        const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
        if (rel.includes('..')) { res.writeHead(403); return res.end(); }
        // A slow network, a busy self-hosted server: the worker's chunk arriving late.
        if (delayWorkerMs && /scriptTransform\.worker/.test(rel)) await sleep(delayWorkerMs);
        for (const candidate of [join(ROOT, rel), join(ROOT, 'index.html')]) {
            try {
                const body = await readFile(candidate);
                // Caddy sets the header on every response of the vhost — the
                // worker script's own response carries it too.
                res.writeHead(200, { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream', ...(csp ? { 'content-security-policy': csp } : {}) });
                return res.end(body);
            } catch { /* next */ }
        }
        res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/`;
}

// ---- Engines ----
const CHROMIUM_ARGS = ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
async function launchChromium() {
    try {
        return { browser: await chromium.launch({ channel: 'msedge', headless: true, args: CHROMIUM_ARGS }), name: 'Edge' };
    } catch {
        return { browser: await chromium.launch({ headless: true, args: CHROMIUM_ARGS }), name: 'Chromium' };
    }
}
const FIREFOX_PREFS = {
    'media.volume_scale': '0.0',
    'media.autoplay.default': 0,
    'media.autoplay.block-webaudio': false,
    'media.autoplay.blocking_policy': 0,
    'media.peerconnection.ice.obfuscate_host_addresses': false,
};
const cr = await launchChromium();
let ff;
try {
    ff = { browser: await firefox.launch({ headless: true, firefoxUserPrefs: FIREFOX_PREFS }), name: 'Firefox' };
} catch (e) {
    // The standard path cannot be shown without an engine that has only it.
    console.log(`FAIL Firefox did not launch (npx playwright install firefox): ${e.message.split('\n')[0]}`);
    process.exit(1);
}

/** Hide createEncodedStreams: Chromium then takes the standard path. */
const HIDE_ENCODED_STREAMS = () => {
    delete RTCRtpSender.prototype.createEncodedStreams;
    delete RTCRtpReceiver.prototype.createEncodedStreams;
};
/** Hide the standard path too: an engine with NEITHER API. */
const HIDE_SCRIPT_TRANSFORM = () => { delete window.RTCRtpScriptTransform; };

/** Put H.264 first in every m=video section, as Safari's own offers do. */
function h264First(sdp) {
    const lines = sdp.split('\r\n');
    const starts = lines.map((l, i) => (l.startsWith('m=') ? i : -1)).filter((i) => i >= 0);
    starts.forEach((start, k) => {
        if (!lines[start].startsWith('m=video')) return;
        const end = starts[k + 1] ?? lines.length;
        const h264 = new Set();
        for (let i = start; i < end; i++) {
            const m = /^a=rtpmap:(\d+) H264\//i.exec(lines[i]);
            if (m) h264.add(m[1]);
        }
        const parts = lines[start].split(' ');
        const pts = parts.slice(3);
        lines[start] = [...parts.slice(0, 3), ...pts.filter((p) => h264.has(p)), ...pts.filter((p) => !h264.has(p))].join(' ');
    });
    return lines.join('\r\n');
}

const TONE = { 1: 600, 2: 900 };

/**
 * Two participants, ids 1 and 2, on engines `a` and `b`, each signed in
 * with a real identity, signalling relayed through here — and rewritten on
 * the way, as a server could: `rewriteOffer(sdp)` for every offer, or
 * `rewrite(type, fromUid, sdp)` for every offer and answer. With `glare`,
 * the first offer from each side is held until both have sent one, then
 * both are delivered at once: each side receives the other's while its own
 * is outstanding.
 */
async function pair({ a, b, csp = POLICIES.caddy, initA, initB, rewriteOffer, rewrite, glare = false, delayWorkerMs = 0 }) {
    const origin = await serve(csp, { delayWorkerMs });
    const pages = {};
    const logs = { 1: [], 2: [] };
    const heldOffers = [];
    let glareDone = !glare;
    for (const [uid, eng, init] of [[1, a, initA], [2, b, initB]]) {
        const ctx = await eng.browser.newContext();
        const page = await ctx.newPage();
        page.on('console', (m) => logs[uid].push(`${m.type()}: ${m.text()}`));
        page.on('pageerror', (e) => logs[uid].push(`pageerror: ${e.message}`));
        if (init) await page.addInitScript(init);
        await page.exposeBinding('__relay', async (_src, to, type, data) => {
            const target = pages[to];
            if (!target) return;
            let body = data;
            if ((type === 'Offer' && rewriteOffer) || ((type === 'Offer' || type === 'Answer') && rewrite)) {
                const env = JSON.parse(data);
                if (type === 'Offer' && rewriteOffer) env.sdp = rewriteOffer(env.sdp);
                if (rewrite) env.sdp = rewrite(type, uid, env.sdp);
                body = JSON.stringify(env);
            }
            const payload = type === 'IceCandidate' ? { from_user: uid, candidate: body } : { from_user: uid, sdp: body };
            const send = () => target.evaluate(([t, p]) => window.__deliver(t, p), [type, payload]).catch(() => {});
            if (!glareDone && type === 'Offer') {
                heldOffers.push(send);
                if (heldOffers.length < 2) return;
                glareDone = true;
                await Promise.all(heldOffers.map((f) => f()));
                return;
            }
            await send();
        });
        await page.goto(origin);
        await page.waitForFunction(() => !!window.harness, null, { timeout: 15_000 });
        pages[uid] = page;
    }
    const keys = {};
    for (const uid of [1, 2]) keys[uid] = await pages[uid].evaluate(([pw, salt]) => window.harness.signIn(pw, salt), [`password-${uid}-${randomBytes(4).toString('hex')}`, randomBytes(16).toString('hex')]);
    await pages[1].evaluate((k) => window.harness.setPeerKeys(k), { 2: keys[2] });
    await pages[2].evaluate((k) => window.harness.setPeerKeys(k), { 1: keys[1] });
    return { pages, logs, close: async () => { for (const p of Object.values(pages)) await p.context().close(); } };
}

/** Both in the channel first, then the call: as in the app, nobody's offer
 *  reaches a page that has no manager to take it. `required` is both
 *  sides' "Require encryption", or [page 1's, page 2's]. */
async function enterCall(p, { required = true, camera = true } = {}) {
    const [r1, r2] = Array.isArray(required) ? required : [required, required];
    await p.pages[1].evaluate((o) => window.harness.join(1, 2, o), { required: r1, tone: TONE[1], camera });
    await p.pages[2].evaluate((o) => window.harness.join(2, 1, o), { required: r2, tone: TONE[2], camera });
    await p.pages[1].evaluate(() => window.harness.call(2));
    await p.pages[2].evaluate(() => window.harness.call(1));
}

/** Wait until `pred(page1State, page2State)` holds, or the deadline. */
async function until(p, read, pred, ms = 20_000) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
        last = [await read(p.pages[1], 2), await read(p.pages[2], 1)];
        if (pred(...last)) return last;
        await sleep(250);
    }
    return last;
}
const statusOf = (page, peerId) => page.evaluate((id) => window.harness.status(id), peerId);
const hears = (page, peerId) => page.evaluate(([id, f]) => window.harness.tone(id, f), [peerId, TONE[peerId]]);
const inbound = (page, peerId) => page.evaluate((id) => window.harness.inbound(id), peerId);
const countsOf = (page, peerId) => page.evaluate((id) => window.harness.frameCounts(id), peerId);
/** One direction and kind of a page's frame transforms, summed. */
const tally = (counts, op, kind) => counts.filter((c) => c.op === op && c.kind === kind)
    .reduce((t, c) => ({ seen: t.seen + c.seen, done: t.done + c.done, clear: t.clear + c.clear, dropped: t.dropped + c.dropped }), { seen: 0, done: 0, clear: 0, dropped: 0 });
const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
/** How the counts of one direction and kind moved over `ms`. */
async function moved(page, peerId, op, kind, ms = 2000) {
    const before = tally(await countsOf(page, peerId), op, kind);
    await sleep(ms);
    return delta(tally(await countsOf(page, peerId), op, kind), before);
}
const PRESENT = (t) => t.present >= 9;
const ABSENT = (t) => t.present <= 2;
const fmt = (t) => `${t.present}/${t.of} margins=${t.marginDb.join(',')}`;

async function bothHear(p, tag, label = 'each hears the other') {
    const h1 = await hears(p.pages[1], 2), h2 = await hears(p.pages[2], 1);
    ck(PRESENT(h1) && PRESENT(h2), `${tag} ${label}`, `1 hears 2: ${fmt(h1)} | 2 hears 1: ${fmt(h2)}`);
}

/**
 * Video OPENED both ways — counted by the receivers' own transforms (the
 * worker's counts on Firefox, the page's on Chromium). Not framesDecoded: the
 * VP8 header stays clear, so a decoder fed sealed frames still "decodes"
 * them, into garbage, and the count rises either way.
 */
async function videoFlows(p, tag) {
    const [o1, o2] = await Promise.all([moved(p.pages[1], 2, 'open', 'video'), moved(p.pages[2], 1, 'open', 'video')]);
    const after = [await inbound(p.pages[1], 2), await inbound(p.pages[2], 1)];
    const decodes = ck(o1.done > 10 && o2.done > 10 && o1.dropped === 0 && o2.dropped === 0, `${tag} video OPENED both ways (each receiver's transform decrypted it)`,
        `video frames opened in 2 s: 1<-2 ${o1.done} (dropped ${o1.dropped}), 2<-1 ${o2.done} (dropped ${o2.dropped})`);
    const codecs = after.map((x) => `stats ${x.videoCodec}, answer ${x.answeredVideoCodecs.join('+')}`);
    const vp8 = ck(after.every((x) => x.answeredVideoCodecs.length > 0 && x.answeredVideoCodecs.every((c) => /^vp8$/i.test(c))
        && (x.videoCodec === null || /vp8/i.test(x.videoCodec))), `${tag} VP8 on every video section`, codecs.join(' | '));
    if (!decodes || !vp8) {
        for (const uid of [1, 2]) console.log(`   page ${uid}:`, JSON.stringify(await p.pages[uid].evaluate((id) => window.harness.descriptions(id), uid === 1 ? 2 : 1)));
    }
}

const run = async (name, fn) => {
    if (ONLY && !ONLY.includes(name)) return;
    console.log(`\n== ${name}`);
    try { await fn(); } catch (e) { ck(false, `${name}: threw`, e.stack?.split('\n').slice(0, 3).join(' / ')); }
};

const dumpLogs = (p, tag) => {
    for (const uid of [1, 2]) {
        const interesting = p.logs[uid].filter((l) => /media-e2ee|pageerror|error/i.test(l)).slice(-8);
        if (interesting.length) console.log(`   ${tag} page ${uid} log:\n     ${interesting.join('\n     ')}`);
    }
};

// ------------------------------------------------------------------------
await run('chromium-firefox', async () => {
    const tag = `[${cr.name} <-> ${ff.name}]`;
    const p = await pair({ a: cr, b: ff });
    try {
        const apis = [await p.pages[1].evaluate(() => window.harness.api()), await p.pages[2].evaluate(() => window.harness.api())];
        ck(apis[0] === 'encoded-streams' && apis[1] === 'script-transform', `${tag} each engine on its own path`, JSON.stringify(apis));
        await enterCall(p);
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        ck(s1?.encrypted && s2?.encrypted && s1.reason === 'encrypted' && s2.reason === 'encrypted', `${tag} encrypted both ways under enforcement`, JSON.stringify([s1, s2]));
        await sleep(1500);
        const w1 = await p.pages[1].evaluate(() => window.harness.wiring(2));
        const w2 = await p.pages[2].evaluate(() => window.harness.wiring(1));
        ck(w1.insertableStreams === true && [...w1.senders, ...w1.receivers].every((x) => x.transform === null),
            `${tag} Chromium: createEncodedStreams only, no transform on any sender or receiver`, JSON.stringify(w1));
        ck(w2.insertableStreams !== true && w2.senders.length >= 2 && [...w2.senders, ...w2.receivers].every((x) => x.transform === 'RTCRtpScriptTransform'),
            `${tag} Firefox: every sender and receiver on an RTCRtpScriptTransform`, JSON.stringify(w2));
        const holds = await p.pages[2].evaluate(() => window.harness.holds(1));
        ck(holds.held === 0 && holds.own === holds.total && holds.total >= 2,
            `${tag} Firefox's senders, held on stand-ins until their transforms sealed, now carry its own microphone and camera`, JSON.stringify(holds));
        ck(!p.logs[2].some((l) => /sent nothing in 10 s/.test(l)), `${tag} ...let go by a sealed frame each, not by the valve (Firefox sends its stand-ins' silence and black)`);
        await bothHear(p, tag);
        await videoFlows(p, tag);

        // Wrong key on the Firefox side: its worker must take it, both ways.
        await p.pages[2].evaluate(() => window.harness.saveKey(1));
        await p.pages[2].evaluate((h) => window.harness.setKeyHex(1, h), randomBytes(32).toString('hex'));
        await sleep(2500);
        const wrong1 = await hears(p.pages[1], 2), wrong2 = await hears(p.pages[2], 1);
        ck(ABSENT(wrong2), `${tag} WRONG-KEY CONTROL: Firefox under another key hears nothing (its worker opens with the new key)`, fmt(wrong2));
        ck(ABSENT(wrong1), `${tag} WRONG-KEY CONTROL: and Chromium cannot open what Firefox now seals`, fmt(wrong1));
        const [wv2, wv1] = await Promise.all([moved(p.pages[2], 1, 'open', 'video', 1500), moved(p.pages[1], 2, 'open', 'video', 1500)]);
        ck(wv2.done === 0 && wv2.dropped > 5, `${tag} WRONG-KEY CONTROL: Firefox's worker opens no video under the wrong key, and drops it`, JSON.stringify(wv2));
        ck(wv1.done === 0 && wv1.dropped > 5, `${tag} WRONG-KEY CONTROL: nor does Chromium open the video Firefox seals under it`, JSON.stringify(wv1));
        const vBefore = await inbound(p.pages[2], 1); await sleep(1500); const vAfter = await inbound(p.pages[2], 1);
        ck(vAfter.framesDecoded - vBefore.framesDecoded <= 2, `${tag} WRONG-KEY CONTROL: no video decodes under the wrong key`, `${vAfter.framesDecoded - vBefore.framesDecoded} frames in 1.5 s`);
        const unproven = await statusOf(p.pages[2], 1);
        ck(!unproven?.encrypted, `${tag} WRONG-KEY CONTROL: Firefox no longer calls it encrypted (its frames are not opening)`, JSON.stringify(unproven));
        await p.pages[2].evaluate(() => window.harness.restoreKey(1));
        await sleep(2500);
        await bothHear(p, tag, 'the right key put back: each hears the other again');

        // Pass frames through unopened: the wire must carry no plaintext.
        await p.pages[2].evaluate(() => window.harness.setCrypto(1, { enabled: false, requireE2ee: false }));
        await sleep(2500);
        const pt2 = await hears(p.pages[2], 1), pt1 = await hears(p.pages[1], 2);
        ck(ABSENT(pt2), `${tag} CIPHERTEXT CONTROL: frames passed to the decoder unopened carry no tone (not plaintext on the wire)`, fmt(pt2));
        ck(ABSENT(pt1), `${tag} ENFORCEMENT: Chromium refuses the plaintext Firefox then sends`, fmt(pt1));
        await p.pages[2].evaluate(() => window.harness.setCrypto(1, { enabled: true, requireE2ee: true }));
        await sleep(2500);
        await bothHear(p, tag, 'opened again: each hears the other');

        // A new session key on both sides, mid-call.
        const fresh = randomBytes(32).toString('hex');
        await Promise.all([p.pages[1].evaluate((h) => window.harness.setKeyHex(2, h), fresh), p.pages[2].evaluate((h) => window.harness.setKeyHex(1, h), fresh)]);
        await sleep(2500);
        await bothHear(p, tag, 'KEY ROTATION: both on a new key mid-call, each hears the other');
        const st = [await statusOf(p.pages[1], 2), await statusOf(p.pages[2], 1)];
        ck(st.every((s) => s?.encrypted), `${tag} still reported encrypted after the rotation`, JSON.stringify(st.map((s) => s?.reason)));
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('firefox-firefox', async () => {
    const tag = `[${ff.name} <-> ${ff.name}]`;
    const p = await pair({ a: ff, b: ff });
    try {
        await enterCall(p);
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        ck(s1?.encrypted && s2?.encrypted, `${tag} encrypted both ways`, JSON.stringify([s1?.reason, s2?.reason]));
        await sleep(1500);
        await bothHear(p, tag);
        await videoFlows(p, tag);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('chromium-standard-path', async () => {
    const tag = `[${cr.name} on RTCRtpScriptTransform <-> ${cr.name} on createEncodedStreams]`;
    const probe = await (await cr.browser.newPage()).evaluate(() => typeof RTCRtpScriptTransform);
    if (probe !== 'function') { sk(tag, `this ${cr.name} has no RTCRtpScriptTransform (${probe})`); return; }
    const p = await pair({ a: cr, b: cr, initA: HIDE_ENCODED_STREAMS });
    try {
        const apis = [await p.pages[1].evaluate(() => window.harness.api()), await p.pages[2].evaluate(() => window.harness.api())];
        ck(apis[0] === 'script-transform' && apis[1] === 'encoded-streams', `${tag} paths`, JSON.stringify(apis));
        await enterCall(p);
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        ck(s1?.encrypted && s2?.encrypted, `${tag} encrypted both ways`, JSON.stringify([s1?.reason, s2?.reason]));
        await sleep(1500);
        await bothHear(p, tag);
        await videoFlows(p, tag);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('safari-shaped-offer', async () => {
    // Firefox and Chromium both offer VP8 first; Safari offers H.264 first.
    // Every offer here is rewritten to H.264-first on its way, both ways, so
    // the codec is whatever the ANSWERING side's VP8 pin makes it.
    const tag = `[${ff.name} <-> ${cr.name}, offers rewritten H.264-first]`;
    const p = await pair({ a: ff, b: cr, rewriteOffer: h264First });
    try {
        await enterCall(p);
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        ck(s1?.encrypted && s2?.encrypted, `${tag} encrypted both ways`, JSON.stringify([s1?.reason, s2?.reason]));
        await sleep(1500);
        await videoFlows(p, tag);
        await bothHear(p, tag);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('camera-mid-call', async () => {
    // Firefox, once a video transceiver's codecs were negotiated in the OTHER
    // side's payload numbers, writes its next offer for it with feedback lines
    // for those numbers if it was given codec preferences, and Chromium
    // refuses the whole offer (preferSealableVideoCodecs). This order shows
    // it: Edge's camera first (Edge's offer makes Firefox's video
    // transceiver), then Firefox's, on that same transceiver.
    const tag = `[${cr.name} <-> ${ff.name}, cameras turned on mid-call]`;
    const p = await pair({ a: cr, b: ff });
    try {
        await enterCall(p, { camera: false });
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        ck(s1?.encrypted && s2?.encrypted, `${tag} encrypted both ways`, JSON.stringify([s1?.reason, s2?.reason]));
        const decodes = async (page, peerId) => {
            const deadline = Date.now() + 20_000;
            let x = await inbound(page, peerId);
            while (Date.now() < deadline && x.framesDecoded <= 10) { await sleep(250); x = await inbound(page, peerId); }
            return x.framesDecoded;
        };
        await p.pages[1].evaluate(() => window.harness.cameraOn());
        ck(await decodes(p.pages[2], 1) > 10, `${tag} Firefox decodes the camera Edge turned on`);
        await p.pages[2].evaluate(() => window.harness.cameraOn());
        ck(await decodes(p.pages[1], 2) > 10, `${tag} Edge decodes the camera Firefox turned on`);
        const refused = [1, 2].flatMap((uid) => p.logs[uid].filter((l) => /setRemoteDescription\(|Failed to parse|rejects the offer|rebuilding/i.test(l)));
        ck(refused.length === 0, `${tag} no description was refused and nothing was rebuilt`, refused.slice(0, 2).join(' / '));
        await videoFlows(p, tag);
        await bothHear(p, tag);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('glare-then-renegotiate', async () => {
    // Both offer at once, cameras on, and Firefox is the polite one (user 2):
    // it rolls its own offer back and applies Edge's, which takes over the
    // video transceiver Firefox had just made. Firefox, given codec
    // preferences on that transceiver, then writes its NEXT offer (here an
    // ICE restart) with feedback lines Chromium refuses whole, and the call
    // stalls into a rebuild (preferSealableVideoCodecs).
    const tag = `[${cr.name} <-> ${ff.name}, glare, then Firefox renegotiates]`;
    const p = await pair({ a: cr, b: ff, glare: true });
    try {
        await p.pages[1].evaluate((o) => window.harness.join(1, 2, o), { required: true, tone: TONE[1], camera: true });
        await p.pages[2].evaluate((o) => window.harness.join(2, 1, o), { required: true, tone: TONE[2], camera: true });
        await Promise.all([p.pages[1].evaluate(() => window.harness.call(2)), p.pages[2].evaluate(() => window.harness.call(1))]);
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        ck(p.logs[1].some((l) => /Ignoring colliding offer from 2 \(impolite\)/.test(l)),
            `${tag} precondition: the offers collided, and Firefox (polite) gave way`, p.logs[1].filter((l) => /collid|offer ->/i.test(l)).slice(0, 3).join(' / '));
        ck(s1?.encrypted && s2?.encrypted, `${tag} encrypted both ways after the glare`, JSON.stringify([s1?.reason, s2?.reason]));
        const before = p.logs[1].length;
        const offersBefore = p.logs[2].filter((l) => /offer -> 1/.test(l)).length;
        await p.pages[2].evaluate(() => window.harness.restartIce(1));
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && p.logs[2].filter((l) => /offer -> 1/.test(l)).length <= offersBefore) await sleep(250);
        ck(p.logs[2].filter((l) => /offer -> 1/.test(l)).length > offersBefore, `${tag} precondition: Firefox sent another offer`);
        await sleep(4000);
        const refused = p.logs[1].slice(before).filter((l) => /setRemoteDescription\(|Failed to parse|rejects the offer|rebuilding|Incompatible offer/i.test(l));
        ck(refused.length === 0, `${tag} Edge applies Firefox's next offer: nothing refused, nothing rebuilt`, refused.slice(0, 2).join(' / '));
        await videoFlows(p, tag);
        await bothHear(p, tag);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('plaintext-refused-in-worker', async () => {
    // The worker's half of enforcement, in a real Firefox: Edge made to send
    // its frames PLAIN (as a modified client, or one whose own transform is
    // passed by, would). Firefox, requiring encryption, must drop them in its
    // worker — and its CONTROL, not requiring it, plays them, which shows the
    // plaintext really was on the wire.
    const tag = `[${cr.name} sends plaintext -> ${ff.name}]`;
    const p = await pair({ a: cr, b: ff });
    try {
        await enterCall(p);
        await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        await p.pages[1].evaluate(() => window.harness.setCrypto(2, { enabled: false, requireE2ee: false }));
        await sleep(2500);
        const heard = await hears(p.pages[2], 1);
        ck(ABSENT(heard), `${tag} SECURITY: Firefox, requiring encryption, plays none of it`, fmt(heard));
        const a = await moved(p.pages[2], 1, 'open', 'audio');
        ck(a.seen > 20 && a.done === 0 && a.clear === 0 && a.dropped === a.seen, `${tag} SECURITY: its worker saw every frame and dropped every one`, JSON.stringify(a));
        const v = await moved(p.pages[2], 1, 'open', 'video');
        ck(v.seen > 5 && v.done === 0 && v.clear === 0, `${tag} SECURITY: video too`, JSON.stringify(v));
        const st = await statusOf(p.pages[2], 1);
        ck(!st?.encrypted, `${tag} Firefox does not call it encrypted`, JSON.stringify(st));
        ck(await p.pages[2].evaluate(() => window.harness.api()) === 'script-transform', `${tag} and refusing a peer's plaintext is not taken for its own transforms failing`);
        await p.pages[2].evaluate(() => window.harness.setCrypto(1, { requireE2ee: false }));
        await sleep(2500);
        const control = await hears(p.pages[2], 1);
        ck(PRESENT(control), `${tag} CONTROL: not requiring it, Firefox plays the same frames (they were plaintext)`, fmt(control));
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

/** Spoil the DTLS pin of every description `fromUid` sends, as a relay that
 *  put its own connection in the middle would have to. */
const spoilPinFrom = (fromUid) => (_type, uid, sdp) => uid !== fromUid ? sdp
    : sdp.replace(/a=sovereign-dtls:([A-Za-z0-9+/=]+)/, (_m, t) => `a=sovereign-dtls:${t[0] === 'A' ? 'B' : 'A'}${t.slice(1)}`);

await run('pin-mismatch-holds', async () => {
    // Enforcement OFF on both sides: what used to carry on unencrypted over
    // the substituted connection must now carry nothing at all, either way,
    // whichever side finds the mismatch (Edge on the page, Firefox in the
    // worker). CONTROL first: the same pair, unspoiled, hears each other.
    const control = await pair({ a: cr, b: ff });
    try {
        await enterCall(control, { required: false });
        await until(control, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        await bothHear(control, `[pin CONTROL, enforcement off]`, 'an honest pin: each hears the other');
    } finally {
        await control.close();
    }
    for (const [finder, other] of [[1, 2], [2, 1]]) {
        const tag = `[${finder === 1 ? cr.name : ff.name} finds the pin spoiled, enforcement off]`;
        const p = await pair({ a: cr, b: ff, rewrite: spoilPinFrom(other) });
        try {
            await enterCall(p, { required: false });
            const st = await (async () => {
                const deadline = Date.now() + 20_000;
                let s = null;
                while (Date.now() < deadline) {
                    s = await statusOf(p.pages[finder], other);
                    if (s?.reason === 'fingerprint-mismatch') return s;
                    await sleep(250);
                }
                return s;
            })();
            ck(st?.reason === 'fingerprint-mismatch' && st.dtls === 'mismatch' && !st.encrypted, `${tag} the mismatch is found`, JSON.stringify(st));
            await sleep(2500);
            const sending = await p.pages[finder].evaluate((id) => window.harness.sending(id), other);
            ck(sending.length === 0, `${tag} SECURITY: no track of ours left on that connection`, JSON.stringify(sending));
            const playing = await p.pages[finder].evaluate((id) => window.harness.receiving(id), other);
            ck(playing.every((r) => !r.enabled), `${tag} SECURITY: nothing from it plays`, JSON.stringify(playing));
            const heardBy = await hears(p.pages[other], finder);
            ck(ABSENT(heardBy), `${tag} SECURITY: the other side hears nothing of us (no plaintext sent toward the substitution)`, fmt(heardBy));
            const heard = await hears(p.pages[finder], other);
            ck(ABSENT(heard), `${tag} SECURITY: and we hear nothing over it`, fmt(heard));
        } finally {
            dumpLogs(p, tag);
            await p.close();
        }
    }
});

await run('bypass-caught', async () => {
    // Chromium on the standard path IS the engine that passes frames by: a
    // transform set in the OFFERER's ontrack is ignored. The early wraps keep
    // it from happening; here they are switched off, so it does, and the
    // other side sends PLAINTEXT (an engine with neither API, not requiring
    // encryption). Requiring encryption, the offerer must play nothing of it
    // while its receivers are unproven, and give the path up once its audit
    // sees frames going by. CONTROL: the same with the early wraps on.
    const NONE = () => { delete RTCRtpSender.prototype.createEncodedStreams; delete RTCRtpReceiver.prototype.createEncodedStreams; delete window.RTCRtpScriptTransform; };
    const probe = await (await cr.browser.newPage()).evaluate(() => typeof RTCRtpScriptTransform);
    if (probe !== 'function') { sk('[bypass-caught]', `this ${cr.name} has no RTCRtpScriptTransform (${probe})`); return; }
    for (const early of [false, true]) {
        const tag = `[${cr.name} on the standard path${early ? ', CONTROL: early wraps on' : ', early wraps OFF'} <- plaintext]`;
        const p = await pair({ a: cr, b: cr, initA: HIDE_ENCODED_STREAMS, initB: NONE });
        try {
            if (!early) await p.pages[1].evaluate(() => window.harness.disableEarlyWraps());
            await p.pages[1].evaluate((o) => window.harness.join(1, 2, o), { required: true, tone: TONE[1], camera: true });
            await p.pages[2].evaluate((o) => window.harness.join(2, 1, o), { required: false, tone: TONE[2], camera: true });
            await p.pages[1].evaluate(() => window.harness.call(2)); // page 1 offers: its ontrack is the offerer's
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline && !(await p.pages[1].evaluate(() => window.harness.hasVoice(2)))) await sleep(100);
            ck(await p.pages[1].evaluate(() => window.harness.hasVoice(2)), `${tag} precondition: the plaintext track arrived`);
            const heard = await hears(p.pages[1], 2);
            ck(ABSENT(heard), `${tag} SECURITY: none of it is heard while nothing shows it went through a transform`, fmt(heard));
            if (!early) {
                const lost = await (async () => {
                    const until2 = Date.now() + 20_000;
                    while (Date.now() < until2) {
                        if (p.logs[1].some((l) => /(never went|mostly did not go|partly did not go) through its transform/.test(l))) return true;
                        await sleep(250);
                    }
                    return false;
                })();
                ck(lost, `${tag} SECURITY: the audit sees the frames going by, and gives the path up for the call`, p.logs[1].filter((l) => /media-e2ee/.test(l)).slice(-3).join(' / '));
                await sleep(1500);
                const s = await statusOf(p.pages[1], 2);
                ck(s?.reason === 'unconfirmed' && s.enforced && !s.encrypted && await p.pages[1].evaluate(() => window.harness.api()) === null,
                    `${tag} rebuilt as "could not be confirmed on this call": blocked`, JSON.stringify(s));
                const after = await hears(p.pages[1], 2);
                ck(ABSENT(after), `${tag} SECURITY: and still nothing is heard`, fmt(after));
                await p.pages[1].evaluate(() => window.harness.leave());
                ck(await p.pages[1].evaluate(() => window.harness.api()) === 'script-transform', `${tag} the call ended: the next one tries the path again`);
            } else {
                await sleep(8000);
                const gone = p.logs[1].some((l) => /frame-transform worker is unavailable|could not be confirmed/.test(l));
                ck(!gone && await p.pages[1].evaluate(() => window.harness.api()) === 'script-transform', `${tag} the path is kept: frames go through the transforms`, p.logs[1].filter((l) => /media-e2ee/.test(l)).slice(-2).join(' / '));
                const a = await moved(p.pages[1], 2, 'open', 'audio');
                ck(a.seen > 20 && a.dropped === a.seen, `${tag} and the worker drops the plaintext it sees`, JSON.stringify(a));
            }
        } finally {
            dumpLogs(p, tag);
            await p.close();
        }
    }
});

await run('no-false-alarms', async () => {
    // The audit must not give a good call up. On the audited engine
    // (Firefox): its microphone muted and unmuted, swapped through the
    // noise-mode path, its camera stopped; and a screen share at one frame a
    // second each way, a rate no window of the audit holds much of.
    const tag = `[${cr.name} <-> ${ff.name}, what a call does]`;
    const p = await pair({ a: cr, b: ff });
    try {
        await enterCall(p);
        await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
        await sleep(1500);
        await p.pages[2].evaluate(() => window.harness.muteMic(true));
        await sleep(6000);
        const muted = await hears(p.pages[1], 2);
        ck(ABSENT(muted), `${tag} precondition: muted, Edge hears nothing of Firefox`, fmt(muted));
        await p.pages[2].evaluate(() => window.harness.muteMic(false));
        ck(await p.pages[2].evaluate(() => window.harness.swapMic(1200)), `${tag} precondition: the microphone swapped through the noise-mode path`);
        await sleep(3000);
        const swapped = await p.pages[1].evaluate(([id, f]) => window.harness.tone(id, f), [2, 1200]);
        ck(PRESENT(swapped), `${tag} Edge hears the swapped microphone (its new tone), opened`, fmt(swapped));
        await p.pages[2].evaluate(() => window.harness.stopCamera());
        await p.pages[1].evaluate(() => window.harness.stopCamera());
        const ffShare = await p.pages[2].evaluate(() => window.harness.startShare(1));
        await p.pages[1].evaluate(([id, sid]) => window.harness.announceShare(id, sid), [2, ffShare]);
        await sleep(4000); // one offer at a time: this is about the audit, not glare
        const crShare = await p.pages[1].evaluate(() => window.harness.startShare(1));
        await p.pages[2].evaluate(([id, sid]) => window.harness.announceShare(id, sid), [1, crShare]);
        await sleep(16_000); // eight of the audit's looks
        const alarms = [...p.logs[1], ...p.logs[2]].filter((l) => /could not be confirmed|frame-transform worker is unavailable|sent nothing in 10 s/.test(l));
        ck(alarms.length === 0, `${tag} nothing given up (and no hold let go unproven) over a mute, a swap, cameras off and slow shares`, alarms.slice(0, 2).join(' / '));
        const shareHolds = await p.pages[2].evaluate(() => window.harness.holds(1));
        ck(shareHolds.held === 0, `${tag} Firefox's share sender, held until its transform sealed, carries the share`, JSON.stringify(shareHolds));
        const st = [await statusOf(p.pages[1], 2), await statusOf(p.pages[2], 1)];
        ck(st.every((s) => s?.encrypted), `${tag} still encrypted both ways`, JSON.stringify(st.map((s) => s?.reason)));
        const [atEdge, atFf] = await Promise.all([moved(p.pages[1], 2, 'open', 'video', 6000), moved(p.pages[2], 1, 'open', 'video', 6000)]);
        ck(atEdge.done >= 3 && atEdge.dropped === 0, `${tag} Edge opens Firefox's share at a frame a second`, JSON.stringify(atEdge));
        ck(atFf.done >= 3 && atFf.dropped === 0, `${tag} Firefox opens Edge's`, JSON.stringify(atFf));
        const ffHears = await hears(p.pages[2], 1);
        ck(PRESENT(ffHears), `${tag} Firefox still hears Edge`, fmt(ffHears));
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('slow-worker', async () => {
    // Firefox's worker chunk arrives 20 s late (a slow network, a busy self-
    // hosted server). Its silence meanwhile is not a missed answer: nothing
    // is given up, and encryption starts late. (Counted as misses, two would
    // have given the path up at ~14 s.) Nor does anything go out unsealed —
    // Edge here does NOT enforce, so it would play whatever came: Firefox's
    // senders stay on their stand-ins, and the valve does not open for a
    // worker that has said nothing (old valve: ~11 s in).
    const tag = `[${cr.name} (not enforcing) <-> ${ff.name}, its worker 20 s late]`;
    const p = await pair({ a: cr, b: ff, delayWorkerMs: 20_000 });
    try {
        await enterCall(p, { required: [false, true] });
        await sleep(14_000);
        const early = await hears(p.pages[1], 2);
        ck(ABSENT(early), `${tag} SECURITY: while the worker loads, nothing of Firefox's microphone reaches Edge`, fmt(early));
        const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted, 45_000);
        const alarms = p.logs[2].filter((l) => /could not be confirmed|frame-transform worker is unavailable/.test(l));
        ck(alarms.length === 0, `${tag} nothing given up while it loaded`, alarms.slice(0, 2).join(' / '));
        ck(s1?.encrypted && s2?.encrypted, `${tag} encrypted both ways once it started`, JSON.stringify([s1?.reason, s2?.reason]));
        await sleep(1500);
        await bothHear(p, tag);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('sender-bypass-held', async () => {
    // A sender transform the engine ignores — no engine measured does; this
    // is the defence in depth. Chromium on the standard path, its sender
    // transforms never attached, enforcement on, toward a peer that plays
    // plaintext (neither API, not enforced). Until its transform has sealed
    // a frame a sender carries a silent, black stand-in, so the peer hears
    // NOTHING; the audit sees the stand-in's frames go past the transform and
    // gives the path up for the call.
    const NO_SENDER_TRANSFORM = () => {
        delete RTCRtpSender.prototype.createEncodedStreams;
        delete RTCRtpReceiver.prototype.createEncodedStreams;
        Object.defineProperty(RTCRtpSender.prototype, 'transform', { configurable: true, get() { return null; }, set() { /* ignored: frames pass it by */ } });
    };
    const NONE = () => { delete RTCRtpSender.prototype.createEncodedStreams; delete RTCRtpReceiver.prototype.createEncodedStreams; delete window.RTCRtpScriptTransform; };
    const probePage = await cr.browser.newPage();
    const probe = await probePage.evaluate(() => typeof RTCRtpScriptTransform);
    await probePage.context().close();
    if (probe !== 'function') { sk('[sender-bypass-held]', `this ${cr.name} has no RTCRtpScriptTransform (${probe})`); return; }
    const tag = `[${cr.name}, its sender transforms ignored, enforced -> a peer that plays plaintext]`;
    const p = await pair({ a: cr, b: cr, initA: NO_SENDER_TRANSFORM, initB: NONE });
    try {
        await p.pages[1].evaluate((o) => window.harness.join(1, 2, o), { required: true, tone: TONE[1], camera: true });
        await p.pages[2].evaluate((o) => window.harness.join(2, 1, o), { required: false, tone: TONE[2], camera: true });
        await p.pages[1].evaluate(() => window.harness.call(2));
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !(await p.pages[2].evaluate(() => window.harness.hasVoice(1)))) await sleep(100);
        ck(await p.pages[2].evaluate(() => window.harness.hasVoice(1)), `${tag} precondition: its track reached the peer`);
        const early = await hears(p.pages[2], 1);
        ck(ABSENT(early), `${tag} SECURITY: the peer hears none of the microphone (a silent stand-in went past the transform, not the tone)`, fmt(early));
        const given = await (async () => {
            const until2 = Date.now() + 20_000;
            while (Date.now() < until2) {
                if (p.logs[1].some((l) => /a sender sent frames that (never went|mostly did not go|partly did not go) through its transform/.test(l))) return true;
                await sleep(250);
            }
            return false;
        })();
        ck(given, `${tag} SECURITY: the audit sees frames go past the sender transform, and gives the path up for the call`, p.logs[1].filter((l) => /media-e2ee/.test(l)).slice(-3).join(' / '));
        await sleep(1500);
        const s = await statusOf(p.pages[1], 2);
        ck(s?.reason === 'unconfirmed' && s.enforced && !s.encrypted, `${tag} said as "could not be confirmed on this call", blocked`, JSON.stringify(s));
        const later = await hears(p.pages[2], 1);
        ck(ABSENT(later), `${tag} SECURITY: and the peer still hears none of it`, fmt(later));
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('sender-bypass-midcall', async () => {
    // A camera turned on well into a call — encryption on for longer than
    // the hold's 10 s valve — on a sender whose transform the engine
    // ignores, toward a peer that shows what it gets (not enforcing). The
    // valve counts from the HOLD, and opens only for a sender that sent
    // nothing, so the peer is shown the stand-in's black, never the picture,
    // and the audit gives the path up. (A valve counted from when encryption
    // came on opened at the first sweep: the picture, unsealed.) CONTROL
    // first: the same camera with its transform working IS shown, so the
    // picture measure can tell.
    const NO_VIDEO_SENDER_TRANSFORM = () => {
        delete RTCRtpSender.prototype.createEncodedStreams;
        delete RTCRtpReceiver.prototype.createEncodedStreams;
        const d = Object.getOwnPropertyDescriptor(RTCRtpSender.prototype, 'transform');
        Object.defineProperty(RTCRtpSender.prototype, 'transform', {
            configurable: true,
            get() { return d.get.call(this); },
            set(v) { if (this.track?.kind === 'video') return; /* ignored: frames pass it by */ d.set.call(this, v); },
        });
    };
    const probePage = await cr.browser.newPage();
    const probe = await probePage.evaluate(() => typeof RTCRtpScriptTransform);
    await probePage.context().close();
    if (probe !== 'function') { sk('[sender-bypass-midcall]', `this ${cr.name} has no RTCRtpScriptTransform (${probe})`); return; }
    for (const attack of [false, true]) {
        const tag = attack
            ? `[${cr.name}, its video sender transforms ignored, a camera on mid-call -> a peer that shows what it gets]`
            : `[${cr.name} on the standard path, a camera on mid-call -> the same peer (CONTROL)]`;
        const p = await pair({ a: cr, b: cr, initA: attack ? NO_VIDEO_SENDER_TRANSFORM : HIDE_ENCODED_STREAMS });
        try {
            await enterCall(p, { required: [true, false], camera: false });
            const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
            ck(s1?.encrypted && s2?.encrypted, `${tag} precondition: the call is encrypted (the microphones' transforms work)`, JSON.stringify([s1?.reason, s2?.reason]));
            await sleep(11_000); // encryption on for longer than the valve
            await p.pages[1].evaluate(() => window.harness.cameraOn());
            let brightest = -1;
            const end = Date.now() + 16_000; // past the 10 s valve, should it open
            while (Date.now() < end) {
                const v = await p.pages[2].evaluate(() => window.harness.picture(1));
                if (v !== null) brightest = Math.max(brightest, v);
                await sleep(200);
            }
            if (!attack) {
                ck(brightest >= 60, `${tag} the peer is shown the camera`, `brightest ${brightest}`);
                continue;
            }
            ck(brightest < 40, `${tag} SECURITY: the peer is never shown the picture (the stand-in's black at most)`, `brightest ${brightest}`);
            const lines = p.logs[1].filter((l) => /media-e2ee/.test(l));
            ck(lines.some((l) => /a sender sent frames that (never went|mostly did not go|partly did not go) through its transform/.test(l)),
                `${tag} SECURITY: the audit gives the path up over the frames that went past`, lines.slice(-3).join(' / '));
            ck(!lines.some((l) => /sent nothing in 10 s/.test(l)), `${tag} the valve stayed shut (the stand-in's frames went out: that sender sent)`);
        } finally {
            dumpLogs(p, tag);
            await p.close();
        }
    }
});

await run('neither-api', async () => {
    const tag = `[${cr.name} <-> ${ff.name} with NEITHER API]`;
    const p = await pair({ a: cr, b: ff, initB: HIDE_SCRIPT_TRANSFORM });
    try {
        ck(await p.pages[2].evaluate(() => window.harness.api()) === null, `${tag} precondition: Firefox reports no path`);
        await enterCall(p);
        await sleep(6000);
        const s2 = await statusOf(p.pages[2], 1), s1 = await statusOf(p.pages[1], 2);
        ck(s2?.reason === 'local-unsupported' && s2?.enforced && !s2?.encrypted, `${tag} Firefox: local-unsupported, enforced`, JSON.stringify(s2));
        ck(s1?.reason === 'peer-unsupported' && !s1?.encrypted, `${tag} Chromium: the peer cannot encrypt`, JSON.stringify(s1));
        const w2 = await p.pages[2].evaluate(() => window.harness.wiring(1));
        ck(w2.senders.length === 0, `${tag} SECURITY: Firefox publishes nothing`, JSON.stringify(w2.senders));
        const h1 = await hears(p.pages[1], 2), h2 = await hears(p.pages[2], 1);
        ck(ABSENT(h1) && ABSENT(h2), `${tag} SECURITY: nothing is heard either way`, `1 hears 2: ${fmt(h1)} | 2 hears 1: ${fmt(h2)}`);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('csp', async () => {
    for (const [name, csp] of Object.entries(POLICIES)) {
        if (name === 'caddy') continue; // every scenario above ran under it
        const tag = `[CSP ${name}]`;
        const p = await pair({ a: cr, b: ff, csp });
        try {
            await enterCall(p);
            const [s1, s2] = await until(p, statusOf, (x, y) => x?.encrypted && y?.encrypted);
            ck(s1?.encrypted && s2?.encrypted, `${tag} the worker loads; encrypted both ways`, JSON.stringify([s1?.reason, s2?.reason]));
            await sleep(1500);
            await bothHear(p, tag);
        } finally {
            dumpLogs(p, tag);
            await p.close();
        }
    }
    // NEGATIVE CONTROL: a policy that forbids the worker. Firefox's worker
    // never runs; the path must be given up, the call rebuilt as "cannot
    // encrypt here" — blocked under enforcement, not silence called encrypted.
    const tag = '[CSP worker-src none]';
    const blocking = POLICIES.caddy.replace("worker-src 'self' blob:", "worker-src 'none'");
    if (!ck(blocking !== POLICIES.caddy, `${tag} precondition: the policy was changed`)) return;
    const p = await pair({ a: cr, b: ff, csp: blocking });
    try {
        await enterCall(p);
        const [, s2] = await until(p, statusOf, (_x, y) => y?.reason === 'local-unsupported', 20_000);
        ck(s2?.reason === 'local-unsupported' && s2?.enforced && !s2?.encrypted, `${tag} Firefox gives the path up: local-unsupported, enforced`, JSON.stringify(s2));
        ck(await p.pages[2].evaluate(() => window.harness.api()) === null, `${tag} and no longer claims it can encrypt`);
        const lost = p.logs[2].some((l) => /frame-transform worker is unavailable/.test(l));
        ck(lost, `${tag} the console says why`, p.logs[2].filter((l) => /media-e2ee|Content-Security|worker/i.test(l)).slice(0, 3).join(' / '));
        await sleep(2000);
        const h1 = await hears(p.pages[1], 2), h2 = await hears(p.pages[2], 1);
        ck(ABSENT(h1) && ABSENT(h2), `${tag} SECURITY: nothing is heard either way`, `1 hears 2: ${fmt(h1)} | 2 hears 1: ${fmt(h2)}`);
    } finally {
        dumpLogs(p, tag);
        await p.close();
    }
});

await run('webkit', async () => {
    const tag = '[WebKit]';
    try {
        const b = await webkit.launch({ headless: true });
        const page = await b.newPage();
        await page.goto(await serve(POLICIES.caddy));
        const probe = await page.evaluate(() => ({
            ua: navigator.userAgent,
            pc: typeof RTCPeerConnection,
            scriptTransform: typeof RTCRtpScriptTransform,
        }));
        await b.close();
        if (probe.pc !== 'function') sk(`${tag} Safari's engine`, `Playwright's WebKit here has no WebRTC (RTCPeerConnection: ${probe.pc}, RTCRtpScriptTransform: ${probe.scriptTransform}; ${probe.ua}) — Safari and iOS are unverified by this script`);
        else sk(`${tag} Safari's engine`, `WebRTC present (${probe.ua}); a WebKit pair is not wired into this script yet`);
    } catch (e) {
        sk(`${tag} Safari's engine`, `WebKit did not launch: ${e.message.split('\n')[0]}`);
    }
});

await cr.browser.close();
await ff.browser.close();
for (const s of servers) s.close();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
