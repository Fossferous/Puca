// Does a REAL browser accept the ICE servers this backend emits?
//
// WHY THIS EXISTS. Three consecutive security-review rounds shipped an ICE
// defect straight past `cargo test`, `vitest`, `tsc -b` and `eslint`:
//
//   * a stun: URL derived from TURN_SERVER without splitting on ',' or
//     stripping '?transport=', so the value deploy/migrate/provision.sh writes
//     produced ONE malformed URL;
//   * the sibling TURN branch splitting on ',' with no empty filter, so a
//     stray comma put "" into urls[];
//   * a scheme matched case-sensitively in one of the two helpers.
//
// Every one of them is invisible to the existing gates, because nothing in this
// repository ever constructs a real RTCPeerConnection: all 25 RTC test files
// mock ../api/iceConfig, and vitest runs under jsdom, which has no WebRTC at
// all. A malformed or empty ICE URL is not a degraded server — the CONSTRUCTOR
// throws SyntaxError, so the failure takes out mesh voice, screen share, both
// My Devices paths and peer-to-peer file transfer at once, including for two
// peers on the same LAN who need no STUN.
//
// So: take the shapes the server can emit, hand each to a real Chromium
// RTCPeerConnection, and assert it does not throw. Five lines of assertion
// retire the entire class.
//
//   cd frontend && node e2e/ice-url-real-browser.mjs
//
// No server and no build needed — it drives the browser directly. Add it to the
// gate list beside the other e2e scripts.
import { chromium } from '@playwright/test';

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

/**
 * The Rust helpers, ported faithfully from src/server_handlers.rs.
 *
 * Kept in step by the assertions at the end, which pin the exact strings the
 * Rust unit tests pin. If someone changes the Rust and not this, the shared
 * expectations below go red rather than this file silently testing fiction.
 */
function stunUrlsFromTurn(turnServer) {
    const seen = new Set();
    for (const raw of turnServer.split(',')) {
        const entry = raw.trim();
        const lower = entry.toLowerCase();
        if (!lower.startsWith('turn:')) continue;           // turns: is the TLS port
        const rest = lower.slice('turn:'.length);
        const host = (rest.split('?')[0] ?? rest).trim();
        if (!host || host.split(':')[0] === '') continue;   // must name a host
        seen.add(`stun:${host}`);
    }
    return [...seen].sort();
}

function turnUrlsFromEnv(turnServer) {
    return turnServer
        .split(',')
        .map((u) => u.trim())
        .filter((u) => {
            // VALIDATE, not merely trim — `turn:` and `turn::` are non-empty and
            // still make the constructor throw. Mirrors the Rust filter_map.
            const i = u.indexOf(':');
            if (i === -1) return false;
            const scheme = u.slice(0, i).toLowerCase();
            if (scheme !== 'turn' && scheme !== 'turns') return false;
            const rest = u.slice(i + 1);
            const host = rest.split('?')[0] ?? rest;
            return (host.split(':')[0] ?? '') !== '';
        })
        .map((u) => {
            const i = u.indexOf(':');
            return `${u.slice(0, i).toLowerCase()}${u.slice(i)}`;
        });
}

/** Every TURN_SERVER value this repo produces, documents, or might be handed. */
const TURN_SERVER_CASES = [
    // deploy/migrate/provision.sh:299 and deploy/turn/README.md:50 — THE default.
    'turn:turn.example.com:3479?transport=udp,turn:turn.example.com:3479?transport=tcp',
    // .env.example / deploy/README.md — the plain documented form.
    'turn:turn.example.com:3478',
    // A single query-bearing URL: the '?' alone was enough to throw.
    'turn:turn.example.com:3478?transport=udp',
    // TLS-only: yields no STUN by design, and must still give a usable TURN.
    'turns:turn.example.com:5349',
    'turns:turn.example.com:5349,turn:turn.example.com:3478',
    // Operator typos and sloppiness.
    'turn:turn.example.com:3478,',
    ',turn:turn.example.com:3478',
    'turn:a.example:3478,,turn:b.example:3478',
    '  turn:a.example:3478  ,   ,  turn:b.example:3478 ',
    'TURN:UPPER.example.com:3478?transport=udp',
    'TuRnS:h.example:5349',
    // Degenerate: must produce NO ice server rather than a broken one.
    ',',
    '   ',
    'turn:',
    'turn::',
];

const browser = await chromium.launch();
const page = await browser.newPage();
// about:blank is enough — RTCPeerConnection needs no origin, no network and no
// permissions to validate its configuration.
await page.goto('about:blank');

/** Ask a real browser whether this configuration is constructible. */
const construct = (iceServers) =>
    page.evaluate((servers) => {
        try {
            const pc = new RTCPeerConnection({ iceServers: servers });
            pc.close();
            return { ok: true };
        } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
        }
    }, iceServers);

console.log('--- the shapes this backend can emit ---');
for (const turnServer of TURN_SERVER_CASES) {
    const stun = stunUrlsFromTurn(turnServer);
    const turn = turnUrlsFromEnv(turnServer);

    // Mirror get_ice_config: an empty urls[] is never emitted on either side.
    const iceServers = [];
    if (turn.length) iceServers.push({ urls: turn, username: 'u', credential: 'c' });
    if (stun.length) iceServers.push({ urls: stun });

    const label = `TURN_SERVER=${JSON.stringify(turnServer)}`;
    if (iceServers.length === 0) {
        ck(true, label, '-> no ICE server (correct for a degenerate value)');
        continue;
    }
    const r = await construct(iceServers);
    ck(r.ok, label, r.ok ? `-> ${JSON.stringify(iceServers.flatMap((s) => s.urls))}` : `-> THREW: ${r.error}`);
}

// The negative controls. If these do NOT throw, this test proves nothing: it
// would mean the browser accepts anything and every PASS above is vacuous.
console.log('--- negative controls (these MUST throw) ---');
for (const [label, servers] of [
    ['the round-4 Critical: comma+query left in one URL', [{ urls: ['stun:h:3479?transport=udp,turn:h:3479?transport=tcp'] }]],
    ['the round-5 Critical: an empty URL from a stray comma', [{ urls: ['turn:h:3478', ''], username: 'u', credential: 'c' }]],
    ['a scheme with no host', [{ urls: ['stun::'] }]],
    ['no scheme at all', [{ urls: ['turn.example.com:3478'] }]],
]) {
    const r = await construct(servers);
    ck(!r.ok, `rejects ${label}`, r.ok ? '-> ACCEPTED, so this test is vacuous' : `-> ${r.error}`);
}

// Keep the port in step with the Rust. These are the exact expectations the
// unit tests in mod stun_derivation_tests assert.
console.log('--- the JS port still matches the Rust ---');
ck(
    JSON.stringify(stunUrlsFromTurn('turn:turn.example.com:3479?transport=udp,turn:turn.example.com:3479?transport=tcp'))
        === JSON.stringify(['stun:turn.example.com:3479']),
    'the provisioner pair collapses to one clean stun: URL',
);
ck(stunUrlsFromTurn('turns:h:5349').length === 0, 'turns: yields no stun:');
ck(
    JSON.stringify(turnUrlsFromEnv('TURN:H.example:3478')) === JSON.stringify(['turn:H.example:3478']),
    'the scheme is lowercased and the host is not',
);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
