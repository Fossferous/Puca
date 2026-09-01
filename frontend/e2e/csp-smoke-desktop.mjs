/**
 * Desktop CSP smoke test: launch the REAL release-built Tauri binary and prove
 * the Content-Security-Policy in tauri.conf.json does not break the app at
 * runtime.
 *
 * WHY. `csp: null` shipped for the app's whole history; the security pass set
 * a real policy, and a too-tight CSP fails at RUNTIME only — the build, the
 * typecheck and every unit test pass a white-screened app. The failure modes
 * this catches: script-src blocking the bundle or wasm, connect-src blocking
 * the API/IPC, style-src blocking the sheet, img/font-src blocking assets.
 *
 * HOW. WebView2 honours --remote-debugging-port via
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so drive the real window over CDP
 * with the Playwright already in devDependencies: collect console output,
 * assert the app actually RENDERED something interactive, and fail on any
 * CSP violation. Positive control included: a deliberate inline-script
 * injection must be REFUSED, proving violations are actually observable in
 * this rig (a run that saw no violations because it can't see any would
 * otherwise pass vacuously).
 *
 * Run (opens a real window briefly — see the repo rule about asking first):
 *   cd frontend && node e2e/csp-smoke-desktop.mjs [path\to\app.exe]
 * Default binary: src-tauri/target/release/app.exe (build with
 *   npx tauri build --no-bundle — no signing key needed).
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const EXE = process.argv[2] || path.resolve('src-tauri/target/release/app.exe');
const PORT = 9333;
const SETTLE_MS = 12_000;

if (!existsSync(EXE)) {
    console.error(`FAIL binary not found: ${EXE}`);
    process.exit(1);
}

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

// Launch the real binary with the debugging port. PID captured so teardown
// kills exactly this process tree — never `taskkill /IM app.exe`, which
// matches every process of that very common name machine-wide.
const child = spawn(EXE, [], {
    env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    detached: false,
    stdio: 'ignore',
});
const kill = () => {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
};
process.on('exit', kill);

// Wait for the devtools endpoint.
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
}
ck(ready, 'WebView2 devtools endpoint came up');
if (!ready) { kill(); process.exit(1); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
let page = ctx.pages()[0];
for (let i = 0; !page && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    page = ctx.pages()[0];
}
ck(!!page, 'app page reachable over CDP', page ? page.url() : '');
if (!page) { kill(); process.exit(1); }

const consoleLines = [];
const pageErrors = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => pageErrors.push(String(e)));

// Let the app boot, paint, and make its startup requests.
await new Promise((r) => setTimeout(r, SETTLE_MS));

// 1. The app actually rendered: the React root has real content.
const rootInfo = await page.evaluate(() => {
    const root = document.getElementById('root');
    return {
        children: root ? root.children.length : -1,
        textSample: (document.body.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
        title: document.title,
    };
});
ck(rootInfo.children > 0, 'React root rendered content', `title=${JSON.stringify(rootInfo.title)}`);
ck(rootInfo.textSample.length > 0, 'visible text present', JSON.stringify(rootInfo.textSample.slice(0, 80)));

// 2. No CSP violations during startup.
const cspHits = [...consoleLines, ...pageErrors].filter((l) =>
    /content security policy|refused to (load|execute|connect|apply|frame)/i.test(l));
ck(cspHits.length === 0, 'no CSP violations during startup',
    cspHits.length ? `\n  ${cspHits.slice(0, 8).join('\n  ')}` : '');

// 3. Positive control: the policy is real and violations ARE observable here.
// Inject an inline script; script-src 'self' must refuse it and say so.
const before = consoleLines.length;
await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__cspProbeRan = true;';
    document.head.appendChild(s);
});
await new Promise((r) => setTimeout(r, 1000));
const probeRan = await page.evaluate(() => window.__cspProbeRan === true);
const sawRefusal = consoleLines.slice(before).some((l) =>
    /content security policy|refused to execute/i.test(l));
ck(!probeRan, 'inline script was blocked (script-src holds)');
ck(sawRefusal, 'the block produced an observable violation (rig is not blind)');

// 4. connect-src allows an https API fetch. The build bakes VITE_API_URL into
// the bundle, not onto window, so probe a representative https origin the
// same way the app's own login call would go out. A CSP block surfaces as a
// TypeError mentioning Content Security Policy — DNS/network errors are fine
// here (the probe only proves the POLICY does not intercept the request).
// NOTE: import.meta is not usable inside page.evaluate (not serializable).
const apiProbe = await page.evaluate(async () => {
    try {
        await fetch('https://chat.example.invalid/', { method: 'GET', mode: 'cors' });
        return { ok: true };
    } catch (e) {
        return { ok: !/content security policy/i.test(String(e)), error: String(e) };
    }
});
ck(apiProbe.ok, 'https fetch not blocked by connect-src',
    apiProbe.error ? `(non-CSP error, expected: ${apiProbe.error.slice(0, 60)})` : '');

// Evidence for the log.
mkdirSync('e2e-artifacts', { recursive: true });
const shot = path.join('e2e-artifacts', 'csp-smoke-desktop.png');
await page.screenshot({ path: shot }).catch(() => {});
console.log(`screenshot: ${shot}`);
console.log(`console lines captured: ${consoleLines.length}`);
for (const l of consoleLines.slice(0, 15)) console.log('  ', l.slice(0, 160));

await browser.close().catch(() => {});
kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
