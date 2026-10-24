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
//   - Firefox <-> Firefox, and Chromium forced onto the standard path <->
//     Chromium on createEncodedStreams.
//   - A Safari-shaped offer (H.264 first, as Safari's default is): the answer
//     still picks VP8, the codec whose header the frame format leaves clear.
//   - Fail-closed: Firefox with NEITHER API, under enforcement, sends and
//     plays nothing (the F-1 guards), while its control above does.
//   - The worker loads under every CSP the app ships (deploy/Caddyfile
//     example, deploy/ops/add-webapp-csp.py, the Android and iOS shells'
//     <meta> from scripts/cap-index-csp.mjs — served AS a meta —,
//     tauri.conf.json, tauri.lite.conf.json); a policy WITHOUT worker-src
//     'self' must stop it, and the call must then fall back to "this browser
//     cannot encrypt" (blocked) rather than to silence that claims to be
//     encrypted.
//   - The worker chunk on its own in Chromium, Firefox AND WebKit (whose CSP
//     engine is the iPhone's, WebRTC or not): it starts under the web header
//     and the shells' <meta>, and worker-src 'none' stops it both ways.
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
import { readdirSync, readFileSync } from 'node:fs';
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
const { buildPolicy, injectCsp } = await import(pathToFileURL(join(HERE, 'scripts', 'cap-index-csp.mjs')).href);
// One policy for BOTH Capacitor shells (Android and iOS), delivered the way
// they deliver it: a <meta> in index.html, not a header.
POLICIES.capacitorMeta = buildPolicy({ apiUrl: 'http://127.0.0.1:9' });
const META_DELIVERED = new Set(['capacitorMeta']);
for (const [name, p] of Object.entries(POLICIES)) {
    if (!ck(typeof p === 'string' && p.includes('worker-src'), `policy ${name} found in the repo`, p ? '' : '(missing)')) process.exit(1);
}

// ---- Serving the harness, one origin per policy ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const servers = [];
async function serve(csp, { asMeta = false } = {}) {
    const server = http.createServer(async (req, res) => {
        const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
        if (rel.includes('..')) { res.writeHead(403); return res.end(); }
        for (const candidate of [join(ROOT, rel), join(ROOT, 'index.html')]) {
            try {
                let body = await readFile(candidate);
                const type = TYPES[extname(candidate)] || 'application/octet-stream';
                if (csp && asMeta) {
                    // The Capacitor shells: the policy is a <meta> that
                    // cap-index-csp.mjs writes into index.html, and no response
                    // carries a header.
                    if (type === 'text/html') body = injectCsp(body.toString('utf8'), csp);
                    res.writeHead(200, { 'content-type': type });
                    return res.end(body);
                }
                // Caddy sets the header on every response of the vhost — the
                // worker script's own response carries it too.
                res.writeHead(200, { 'content-type': type, ...(csp ? { 'content-security-policy': csp } : {}) });
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
 * with a real identity, signalling relayed through here (and rewritten by
 * `rewriteOffer` on the way, as a server could).
 */
async function pair({ a, b, csp = POLICIES.caddy, cspAsMeta = false, initA, initB, rewriteOffer }) {
    const origin = await serve(csp, { asMeta: cspAsMeta });
    const pages = {};
    const logs = { 1: [], 2: [] };
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
            if (type === 'Offer' && rewriteOffer) {
                const env = JSON.parse(data);
                env.sdp = rewriteOffer(env.sdp);
                body = JSON.stringify(env);
            }
            const payload = type === 'IceCandidate' ? { from_user: uid, candidate: body } : { from_user: uid, sdp: body };
            await target.evaluate(([t, p]) => window.__deliver(t, p), [type, payload]).catch(() => {});
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
 *  reaches a page that has no manager to take it. */
async function enterCall(p, { required = true, camera = true } = {}) {
    await p.pages[1].evaluate((o) => window.harness.join(1, 2, o), { required, tone: TONE[1], camera });
    await p.pages[2].evaluate((o) => window.harness.join(2, 1, o), { required, tone: TONE[2], camera });
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
const PRESENT = (t) => t.present >= 9;
const ABSENT = (t) => t.present <= 2;
const fmt = (t) => `${t.present}/${t.of} margins=${t.marginDb.join(',')}`;

async function bothHear(p, tag, label = 'each hears the other') {
    const h1 = await hears(p.pages[1], 2), h2 = await hears(p.pages[2], 1);
    ck(PRESENT(h1) && PRESENT(h2), `${tag} ${label}`, `1 hears 2: ${fmt(h1)} | 2 hears 1: ${fmt(h2)}`);
}

async function videoFlows(p, tag) {
    const before = [await inbound(p.pages[1], 2), await inbound(p.pages[2], 1)];
    await sleep(2000);
    const after = [await inbound(p.pages[1], 2), await inbound(p.pages[2], 1)];
    const d1 = after[0].framesDecoded - before[0].framesDecoded, d2 = after[1].framesDecoded - before[1].framesDecoded;
    const decodes = ck(d1 > 10 && d2 > 10, `${tag} video decodes both ways`, `frames in 2 s: 1<-2 ${d1}, 2<-1 ${d2}`);
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
        await bothHear(p, tag);
        await videoFlows(p, tag);

        // Wrong key on the Firefox side: its worker must take it, both ways.
        await p.pages[2].evaluate(() => window.harness.saveKey(1));
        await p.pages[2].evaluate((h) => window.harness.setKeyHex(1, h), randomBytes(32).toString('hex'));
        await sleep(2500);
        const wrong1 = await hears(p.pages[1], 2), wrong2 = await hears(p.pages[2], 1);
        ck(ABSENT(wrong2), `${tag} WRONG-KEY CONTROL: Firefox under another key hears nothing (its worker opens with the new key)`, fmt(wrong2));
        ck(ABSENT(wrong1), `${tag} WRONG-KEY CONTROL: and Chromium cannot open what Firefox now seals`, fmt(wrong1));
        const vBefore = await inbound(p.pages[2], 1); await sleep(1500); const vAfter = await inbound(p.pages[2], 1);
        ck(vAfter.framesDecoded - vBefore.framesDecoded <= 2, `${tag} WRONG-KEY CONTROL: no video decodes under the wrong key`, `${vAfter.framesDecoded - vBefore.framesDecoded} frames in 1.5 s`);
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
        const tag = `[CSP ${name}${META_DELIVERED.has(name) ? ' as <meta>' : ''}]`;
        const p = await pair({ a: cr, b: ff, csp, cspAsMeta: META_DELIVERED.has(name) });
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

// The frame-transform worker itself, started straight from the chunk Vite
// emitted, in all three engines: WebKit has no WebRTC in Playwright's Windows
// build, but its CSP engine is the iPhone's — the iOS shell's <meta> policy and
// the header the Home Screen web app gets must both let the worker run, and
// worker-src 'none' (by <meta> and by header) must stop it, or a pass above
// could be a policy the engine never applied.
await run('worker-csp', async () => {
    const chunk = readdirSync(join(ROOT, 'assets')).find((f) => /^scriptTransform\.worker[-.][\w-]*\.js$/.test(f));
    if (!ck(!!chunk, '[worker CSP] the harness build emitted the transform worker chunk', chunk ?? readdirSync(join(ROOT, 'assets')).join(' '))) return;
    const startWorker = (url) => new Promise((resolve) => {
        let w;
        const done = (r) => { try { w?.terminate(); } catch { /* gone */ } resolve({ ...r, violations: window.__cspv.slice() }); };
        try {
            w = new Worker(url, { type: 'module' });
        } catch (e) {
            return done({ thrown: String(e?.name || e) });
        }
        w.onmessage = (ev) => done({ message: ev.data?.type ?? null });
        w.onerror = () => done({ error: true });
        setTimeout(() => done({ timeout: true }), 8000);
    });
    const recordViolations = () => {
        window.__cspv = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__cspv.push(`${e.effectiveDirective || e.violatedDirective} ${e.blockedURI}`));
    };
    const noWorker = (p) => p.replace("worker-src 'self' blob:", "worker-src 'none'");
    const cases = [
        ...['caddy', 'tool', 'capacitorMeta'].map((name) => ({ name, csp: POLICIES[name], asMeta: META_DELIVERED.has(name), want: true })),
        { name: "worker-src 'none' as <meta>", csp: noWorker(POLICIES.capacitorMeta), asMeta: true, want: false },
        { name: "worker-src 'none' as header", csp: noWorker(POLICIES.caddy), asMeta: false, want: false },
    ];
    for (const c of cases.filter((x) => !x.want)) {
        if (!ck(c.csp.includes("worker-src 'none'"), `[worker CSP] ${c.name}: precondition, the policy was changed`)) return;
    }
    let wk = null;
    try {
        wk = await webkit.launch({ headless: true });
    } catch (e) {
        sk('[worker CSP WebKit]', `WebKit did not launch: ${e.message.split('\n')[0]}`);
    }
    const engines = [['Chromium', cr.browser], ['Firefox', ff.browser], ...(wk ? [['WebKit', wk]] : [])];
    try {
        for (const c of cases) {
            const origin = await serve(c.csp, { asMeta: c.asMeta });
            for (const [eng, browser] of engines) {
                const tag = `[worker CSP ${eng}] ${c.name}${c.asMeta && c.want ? ' as <meta>' : ''}`;
                const ctx = await browser.newContext();
                try {
                    const page = await ctx.newPage();
                    await page.addInitScript(recordViolations);
                    await page.goto(origin);
                    const r = await page.evaluate(startWorker, `${origin}assets/${chunk}`);
                    const workerViolation = r.violations.some((v) => /worker-src|script-src|child-src/.test(v));
                    if (c.want) ck(r.message === 'ready' && !workerViolation, `${tag}: the worker starts and says ready`, JSON.stringify(r));
                    else ck(r.message !== 'ready' && (workerViolation || r.thrown || r.error), `${tag}: the worker is refused, not started`, JSON.stringify(r));
                } finally {
                    await ctx.close();
                }
            }
        }
    } finally {
        await wk?.close();
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
