#!/usr/bin/env node
/**
 * Give the Android WebView a Content-Security-Policy.
 *
 * Every other surface has one: the web app gets it from the server's headers
 * (deploy/ops/add-webapp-csp.py), the desktop shell from tauri.conf.json
 * `app.security.csp`. The Capacitor app had none — nothing sends headers for
 * `https://localhost`, and index.html carries no <meta>. This script puts the
 * policy into the index.html that `cap sync` copied into the native project
 * (android/app/src/main/assets/public/, gitignored), and ONLY there: the web
 * `dist/` is never touched, because the server's header is the policy there
 * and two sources for one policy is how they drift apart.
 *
 * Wired into `npm run cap:build:android` and `build-lite.mjs --sync android`,
 * after the sync — running before it would be overwritten by the copy.
 *
 * NOT covered here, deliberately visible: the OTA bundle. deploy/mobile/
 * README.md zips the plaintext bundle straight from `dist/`, so the FIRST
 * over-the-air update replaces this index.html with the web copy and the
 * policy is gone until the next APK. The OTA staging step has to run this
 * script against its own copy (`--index <path>`) before zipping; see the
 * note in the README.
 *
 * WHY THE META WORKS WITH CAPACITOR'S BRIDGE: on Android the bridge is an
 * INLINE script that JSInjector splices in at serve time, immediately after
 * the literal `<head>` (falling back to just before `</head>` when that exact
 * string is absent). A meta policy governs only what the parser meets AFTER
 * it, so the bridge — inserted before our tag — stays exempt while the app's
 * own module script, styles, workers and fetches are all bound. That ordering
 * is the whole mechanism, which is why this script REFUSES an index.html
 * without a literal `<head>`: Capacitor would then inject before `</head>`,
 * i.e. after the meta, and `script-src 'self'` would kill the bridge and with
 * it every plugin (notifications, OTA, keep-alive) on first launch.
 *
 * THE POLICY mirrors the web app's header, tightened or loosened only where
 * the Android app is provably different:
 *   - connect-src names the API origin (https + wss forms) from
 *     VITE_API_URL — the same build-time value that check-api-url.mjs guards —
 *     plus VITE_UPDATE_FALLBACK_API when set. The SFU cannot be named: its
 *     URL is a per-call grant from the server (sfuManager.ts: room.connect(
 *     grant.url)), so the scheme `wss:` is allowed wholesale. `blob:` is for
 *     copyImage.ts: ImageLightbox's Copy Image fetch()es the lightbox's `src`,
 *     an object URL minted by authedMedia.ts, to build the clipboard PNG.
 *     (saveAttachment.ts also fetch()es a blob URL, but only inside its
 *     isTauri() branch — the Android WebView takes the `<a download>` path
 *     and never fetches.) An http:// API (a LAN box — check-api-url.mjs
 *     accepts one) adds the http/ws forms; note Capacitor's default
 *     allowMixedContent=false blocks that from an https://localhost page
 *     before CSP is consulted.
 *   - STUN/TURN need no entry: ICE is neither fetch nor WebSocket and CSP
 *     does not govern it. WebRTC media likewise.
 *   - The OTA download is native (CapacitorUpdater.download → OkHttp); only
 *     the manifest check is a WebView fetch, and that goes to the API origin.
 *     FCM never touches the WebView.
 *   - frame-ancestors is omitted: the spec ignores it in a <meta>, and a
 *     WebView cannot be framed anyway. Everything else is in the header too.
 *
 * Usage:
 *   node scripts/cap-index-csp.mjs --platform android      # the synced copy
 *   node scripts/cap-index-csp.mjs --index <path/to/index.html>
 *   add --dry-run to print the policy and the target without writing.
 *
 * Fails closed: no usable VITE_API_URL (same rules as check-api-url.mjs), a
 * target inside dist/, a missing `<head>`, or more than one CSP meta already
 * present all exit non-zero. It never guesses a policy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDotenvValue, verdict } from './check-api-url.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..');
const ENV_FILE = path.join(FRONTEND, '.env.production');
export const WEB_DIST = path.join(FRONTEND, 'dist');
export const ANDROID_INDEX = path.join(FRONTEND, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html');

const META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi;

/** `https://host[:port]` → { https: 'https://host', ws: 'wss://host' } (http → http/ws). */
function originForms(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        throw new Error(`not an absolute URL: "${url}"`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error(`API URL must be http(s), got "${url}"`);
    }
    const secure = u.protocol === 'https:';
    return {
        secure,
        http: `${u.protocol}//${u.host}`,
        ws: `${secure ? 'wss' : 'ws'}://${u.host}`,
    };
}

/**
 * The policy string for a build that talks to `apiUrl` (VITE_API_URL) and,
 * optionally, `fallbackApiUrl` (VITE_UPDATE_FALLBACK_API). Pure; throws on a
 * URL it cannot turn into an origin.
 */
export function buildPolicy({ apiUrl, fallbackApiUrl } = {}) {
    if (typeof apiUrl !== 'string' || !apiUrl.trim()) throw new Error('apiUrl is required');
    const connect = ["'self'"];
    let anyInsecure = false;
    const seen = new Set();
    for (const raw of [apiUrl, fallbackApiUrl]) {
        if (!raw || !raw.trim()) continue;
        const o = originForms(raw.trim());
        anyInsecure ||= !o.secure;
        for (const token of [o.http, o.ws]) {
            if (seen.has(token)) continue;
            seen.add(token);
            connect.push(token);
        }
    }
    // The SFU: a runtime grant, not a build-time value (see header).
    connect.push('wss:');
    if (anyInsecure) connect.push('ws:');
    // saveAttachment.ts fetch()es an object URL on the way to the filesystem.
    connect.push('blob:');

    const policy = [
        "default-src 'self'",
        `connect-src ${connect.join(' ')}`,
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
    ].join('; ');
    if (policy.includes('"')) throw new Error('policy must not contain a double quote (it is an attribute value)');
    return policy;
}

export function metaTag(policy) {
    return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

/**
 * Return `html` with exactly one CSP meta carrying `policy`, placed
 * immediately after the literal `<head>`. Pure and idempotent: a second pass
 * over its own output returns identical bytes; an existing single CSP meta
 * (any placement) is replaced in place; anything else it cannot make sense of
 * throws rather than guessing.
 */
export function injectCsp(html, policy) {
    if (typeof html !== 'string') throw new Error('html must be a string');
    const tag = metaTag(policy);
    const existing = html.match(META_RE) ?? [];
    if (existing.length > 1) {
        throw new Error(`refusing: ${existing.length} Content-Security-Policy metas already present`);
    }
    if (existing.length === 1) {
        return html.replace(META_RE, () => tag);
    }
    const headAt = html.indexOf('<head>');
    if (headAt === -1) {
        throw new Error("refusing: no literal <head> — Capacitor's bridge would land AFTER the policy and be blocked");
    }
    // Keep the file's own line ending and indentation so the diff is one line.
    const after = headAt + '<head>'.length;
    const eol = html.includes('\r\n') ? '\r\n' : '\n';
    const nextLine = html.slice(after).replace(/^\r?\n/, '');
    const indent = (nextLine.match(/^[ \t]*/) ?? [''])[0];
    return html.slice(0, after) + eol + indent + tag + html.slice(after);
}

/**
 * Inject into the file at `target`, refusing anything under `webDist`.
 * Returns { changed, policy }. Writes only when the bytes would differ.
 */
export function applyToFile(target, policy, { webDist = WEB_DIST, dryRun = false } = {}) {
    const abs = path.resolve(target);
    const dist = path.resolve(webDist);
    if (abs === dist || abs.startsWith(dist + path.sep)) {
        throw new Error(`refusing to touch the web dist (${abs}); its policy is the server header`);
    }
    const before = fs.readFileSync(abs, 'utf8');
    const afterHtml = injectCsp(before, policy);
    if (afterHtml === before) return { changed: false, policy };
    if (!dryRun) {
        fs.writeFileSync(abs, afterHtml);
        // Re-read: the file on disk must carry exactly one tag, ahead of the
        // app's own script, or the policy is decoration.
        const check = fs.readFileSync(abs, 'utf8');
        const tags = check.match(META_RE) ?? [];
        const firstScript = check.search(/<script[\s>]/i);
        if (tags.length !== 1 || (firstScript !== -1 && check.indexOf(tags[0]) > firstScript)) {
            throw new Error(`post-write check failed on ${abs}: ${tags.length} tag(s), script order wrong`);
        }
    }
    return { changed: true, policy };
}

function envValue(key) {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, source: 'environment' };
    try {
        return {
            value: readDotenvValue(fs.readFileSync(ENV_FILE, 'utf8'), key),
            source: path.relative(process.cwd(), ENV_FILE),
        };
    } catch {
        return { value: undefined, source: `${path.relative(process.cwd(), ENV_FILE)} (missing)` };
    }
}

function main(argv) {
    const dryRun = argv.includes('--dry-run');
    let target;
    const idx = argv.indexOf('--index');
    const plat = argv.indexOf('--platform');
    if (idx !== -1) {
        target = argv[idx + 1];
    } else if (plat !== -1) {
        const platform = argv[plat + 1];
        if (platform === 'android') target = ANDROID_INDEX;
        else {
            console.error(`cap-csp: --platform ${platform ?? '<none>'} is not supported (only android: iOS's WKWebView injects the bridge differently and has not been assessed)`);
            return 2;
        }
    }
    if (!target) {
        console.error('usage: cap-index-csp.mjs (--platform android | --index <index.html>) [--dry-run]');
        return 2;
    }

    const api = envValue('VITE_API_URL');
    const why = verdict(api.value, { allowLocal: process.env.PUCA_ALLOW_LOCAL_BUILD === '1' });
    if (why !== null) {
        console.error(`cap-csp: ${why} (from ${api.source}); refusing to write a policy that names the wrong server`);
        return 1;
    }
    const fallback = envValue('VITE_UPDATE_FALLBACK_API');

    let policy;
    try {
        policy = buildPolicy({ apiUrl: api.value, fallbackApiUrl: fallback.value });
    } catch (e) {
        console.error(`cap-csp: ${e.message}`);
        return 1;
    }
    if (!fs.existsSync(target)) {
        console.error(`cap-csp: ${target} does not exist — run \`npx cap sync android\` first`);
        return 1;
    }
    try {
        const { changed } = applyToFile(target, policy, { dryRun });
        const rel = path.relative(process.cwd(), target);
        console.log(`cap-csp: ${dryRun ? 'would write' : changed ? 'wrote' : 'already present in'} ${rel}`);
        console.log(`cap-csp: ${policy}`);
        return 0;
    } catch (e) {
        console.error(`cap-csp: ${e.message}`);
        return 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
