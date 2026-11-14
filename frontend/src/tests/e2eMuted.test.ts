// @vitest-environment jsdom
/**
 * Every browser an e2e/ script starts makes no sound (scripts/check-e2e-muted.mjs, which
 * `npm run lint` runs), and WebKit's stand-in for a mute flag (e2e/muted.mjs) really mutes.
 *
 * The owner's rule: nothing a session runs plays audio on this machine. Playwright mutes a
 * HEADLESS Chromium by itself and nothing else: a headed or PWDEBUG run, Firefox and WebKit
 * get no mute unless the script asks. Before the check, 36 Chromium launches relied on that
 * default and six WebKit launches had nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { muteWebkit, silencePage } from '../../e2e/muted.mjs';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(FRONTEND, 'scripts', 'check-e2e-muted.mjs');
const check = (dir?: string) => spawnSync(process.execPath, dir ? [SCRIPT, dir] : [SCRIPT], { cwd: FRONTEND, encoding: 'utf8' });

/** The check run over these files; which of them it named, and how often. */
function flagged(files: Record<string, string>): { named: Record<string, number>; status: number | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'puca-e2e-muted-'));
    try {
        for (const [name, text] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, name)), { recursive: true });
            writeFileSync(join(dir, name), text);
        }
        const run = check(dir);
        const named: Record<string, number> = {};
        for (const line of run.stderr.split(/\r?\n/)) {
            const file = line.match(/^(.+?\.(?:mjs|ts)):\d+:\d+ {2}/)?.[1];
            if (file) named[file] = (named[file] ?? 0) + 1;
        }
        return { named, status: run.status, output: run.stdout + run.stderr };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const IMPORT_MUTE = "import { muteWebkit } from './muted.mjs';\n";

describe('scripts/check-e2e-muted.mjs', () => {
    it('e2e/ and playwright.config.ts pass', () => {
        const run = check();
        expect(run.stdout + run.stderr).toMatch(/every browser started muted/);
        expect(run.status).toBe(0);
    }, 60_000);

    it('every shape of an unmuted launch fails', () => {
        const bad: Record<string, string> = {
            // As 36 scripts had it.
            'bare.mjs': 'const b = await chromium.launch();',
            'headless.mjs': 'const b = await chromium.launch({ headless: true });',
            'other-flags.mjs': "const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });",
            'near-miss.mjs': "const b = await chromium.launch({ args: ['--mute'] });",
            // Followed through names, and found wanting.
            'named.mjs': "const args = ['--use-fake-ui-for-media-stream']; const b = await chromium.launch({ args });",
            'spread.mjs': "const base = ['--x']; const b = await chromium.launch({ args: [...base, '--y'] });",
            'one-side.mjs': "const b = await chromium.launch({ args: process.env.Q ? ['--mute-audio'] : [] });",
            'written-over.mjs': "const o = { args: ['--mute-audio'] }; const b = await chromium.launch({ ...o, args: ['--x'] });",
            'spread-over.mjs': "const o = { args: ['--x'] }; const b = await chromium.launch({ args: ['--mute-audio'], ...o });",
            'maybe-over.mjs': "const b = await chromium.launch({ args: ['--mute-audio'], ...(process.env.Q ? { args: [] } : {}) });",
            'built.mjs': 'const opts = () => ({ headless: true }); const b = await chromium.launch(opts());',
            // What cannot be followed is a no.
            'param.mjs': 'export async function go(args) { return chromium.launch({ args }); }',
            'let.mjs': "let args = ['--mute-audio']; args = []; const b = await chromium.launch({ args });",
            'imported.mjs': "import { ARGS } from './args.mjs';\nconst b = await chromium.launch({ args: ARGS });",
            // The other launches.
            'persistent.mjs': "const c = await chromium.launchPersistentContext('dir', { args: ['--x'] });",
            'persistent-first.mjs': "const c = await chromium.launchPersistentContext({ args: ['--mute-audio'] });",
            'server.mjs': 'const s = await chromium.launchServer();',
            'firefox.mjs': 'const f = await firefox.launch({ headless: true });',
            'firefox-loud.mjs': "const f = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '1.0' } });",
            'firefox-other.mjs': "const prefs = { 'media.autoplay.default': 0 }; const f = await firefox.launch({ firefoxUserPrefs: prefs });",
            // A number: the pref is a string pref, and Firefox refuses to start (setIntPref).
            'firefox-number.mjs': "const f = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': 0 } });",
            // A spread nobody can read could set anything, after the flag or inside the prefs.
            'helper-spread.mjs': "const launchFirefox = (opts) => firefox.launch({ headless: true, firefoxUserPrefs: { 'media.volume_scale': '0.0' }, ...opts });",
            'prefs-spread.mjs': "const f = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0', ...EXTRA } });",
            'args-then-spread.mjs': "export const go = (opts) => chromium.launch({ args: ['--mute-audio'], ...opts });",
            'spread-could-ignore.mjs': "export const go = (opts) => chromium.launch({ ...opts, args: ['--mute-audio'] });",
            // Playwright takes ignoreDefaultArgs out of the user's args too.
            'ignored.mjs': "const b = await chromium.launch({ args: ['--mute-audio'], ignoreDefaultArgs: ['--mute-audio'] });",
            'ignored-unknown.mjs': "const b = await chromium.launch({ args: ['--mute-audio'], ignoreDefaultArgs: IGNORE });",
            // A const changed after it is made is not what its initializer says.
            'changed.mjs': "const opts = { args: ['--mute-audio'] }; opts.args = []; const b = await chromium.launch(opts);",
            'emptied.mjs': "const args = ['--mute-audio']; args.length = 0; const b = await chromium.launch({ args });",
            'spliced.mjs': "const args = ['--mute-audio']; args.splice(0); const b = await chromium.launch({ args });",
            'object-assigned.mjs': "const opts = { args: ['--mute-audio'] }; Object.assign(opts, { args: [] }); const b = await chromium.launch(opts);",
            'deleted.mjs': "function make() { const o = { args: ['--mute-audio'] }; delete o.args; return o; }\nconst b = await chromium.launch(make());",
            'hoisted.mjs': "const args = ['--mute-audio'];\nexport async function go(x) { if (x) { var args = []; } return chromium.launch({ args }); }",
            // A launch taken without being called where it can be read.
            'indexed.mjs': "const b = await chromium['launch']({ args: ['--mute-audio'] });",
            'bound.mjs': 'const launch = chromium.launch.bind(chromium); const b = await launch();',
            'destructured.mjs': 'const { launch } = chromium; const b = await launch();',
            'webkit-unawaited.mjs': `${IMPORT_MUTE}const w = muteWebkit(webkit.launch());`,
            'webkit.mjs': 'const w = await webkit.launch();',
            'webkit-local.mjs': 'const muteWebkit = (b) => b;\nconst w = muteWebkit(await webkit.launch());',
            'webkit-then.mjs': `${IMPORT_MUTE}const w = await webkit.launch().then(muteWebkit);`,
            'webkit-persistent.mjs': `${IMPORT_MUTE}const w = muteWebkit(await webkit.launchPersistentContext('dir', {}));`,
            'which.mjs': "for (const t of [chromium]) await t.launch({ args: ['--mute-audio'] });",
            // A browser it did not start, with nobody having said where its sound goes.
            'attach.mjs': "const b = await chromium.connectOverCDP('http://127.0.0.1:9222');",
            'e2e/android-share-live.mjs': "await chromium.connectOverCDP('a'); await chromium.connectOverCDP('b');",
            'webview2.mjs': "spawn(exe, [], { env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } });",
            'webview2-assigned.mjs': "process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222';",
            'config.ts': "export default { use: { launchOptions: { args: ['--use-fake-ui-for-media-stream'] } } };",
            'config-firefox.ts': "export default defineConfig({ use: { launchOptions: { args: ['--mute-audio'] } }, projects: [{ name: 'f', use: { browserName: 'firefox' } }] });",
            'config-iphone.ts': "export default defineConfig({ use: { launchOptions: { args: ['--mute-audio'] } }, projects: [{ name: 'p', use: { ...devices['iPhone 13'] } }] });",
            // What the OS plays, which a muted browser does not stop.
            'spoken.mjs': "const b = await chromium.launch({ args: ['--mute-audio'] });\nsave({ voiceTTS: true });",
            'spoken-maybe.mjs': 'save({ voiceTTS: process.env.TTS === "1" });',
            'spoken-assigned.mjs': 's.voiceTTS = true;',
            'toasts.mjs': "const b = await chromium.launch({ args: ['--mute-audio'] });\nawait (await b.newContext()).grantPermissions(['notifications']);",
            'toasts-named.mjs': "const PERMS = ['notifications'];\nconst b = await chromium.launch({ args: ['--mute-audio'] });\nawait (await b.newContext()).grantPermissions(PERMS);",
            // Chromium keeps only the LAST --disable-features=, so a second one turns toasts back on.
            'toasts-overridden.mjs': "const b = await chromium.launch({ args: ['--mute-audio', '--disable-features=NativeNotifications,SystemNotifications', '--disable-features=WebRtcHideLocalIpsWithMdns'] });\nawait (await b.newContext()).grantPermissions(['notifications']);",
            'toasts-pushed.mjs': "const args = ['--mute-audio', '--disable-features=NativeNotifications'];\nargs.push('--disable-features=Translate');\nconst b = await chromium.launch({ args });\nawait (await b.newContext()).grantPermissions(['notifications']);",
            // Adding to ignoreDefaultArgs is how the flag is lost.
            'ignore-grown.mjs': "const ignore = []; ignore.push('--mute-audio');\nconst b = await chromium.launch({ args: ['--mute-audio'], ignoreDefaultArgs: ignore });",
            'ignore-grown-inside.mjs': "const opts = { args: ['--mute-audio'], ignoreDefaultArgs: [] }; opts.ignoreDefaultArgs.push('--mute-audio');\nconst b = await chromium.launch(opts);",
            // A path that gives nothing back.
            'falls-through.mjs': "function opts() { if (process.env.MUTE !== '0') return { args: ['--mute-audio'] }; }\nconst b = await chromium.launch(opts());",
            // Which browser it is goes by what was imported, not by the name.
            'renamed.mjs': "import { firefox as chromium } from '@playwright/test';\nconst b = await chromium.launch({ args: ['--mute-audio'] });",
            'local-engine.mjs': "const chromium = globalThis.firefoxLike;\nconst b = await chromium.launch({ args: ['--mute-audio'] });",
            'through-object.mjs': "import { firefox } from '@playwright/test';\nconst pw = { chromium: firefox };\nconst b = await pw.chromium.launch({ args: ['--mute-audio'] });",
            'nested-destructure.mjs': "const { chromium: { launch } } = await import('playwright');\nconst b = await launch();",
            'webkit-stand-in.mjs': `${IMPORT_MUTE}async function go() { const muteWebkit = (b) => b; return muteWebkit(await webkit.launch()); }`,
            'webkit-other-helper.mjs': "import { muteWebkit } from './lib/muted.mjs';\nconst w = muteWebkit(await webkit.launch());",
            // Playwright Test, switched to a browser launchOptions' flag does not reach.
            'iphone.spec.ts': "import { test, devices } from '@playwright/test';\ntest.use({ ...devices['iPhone 13'] });\ntest('x', async () => {});",
            'webkit.spec.ts': "import { test } from '@playwright/test';\ntest.use({ browserName: 'webkit' });",
            'config-default-browser.ts': "export default defineConfig({ use: { launchOptions: { args: ['--mute-audio'] } }, projects: [{ name: 'w', use: { defaultBrowserType: 'webkit' } }] });",
            // The spoken join/leave reached another way.
            'spoken-setting.mjs': "await page.evaluate(() => store.updateSetting('voiceTTS', true));",
            'spoken-checkbox.mjs': "await page.getByLabel('Speak Join/Leave (TTS)').check();",
        };
        const { named, status, output } = flagged(bad);
        expect(status, output).toBe(1);
        expect(Object.keys(bad).filter((file) => !named[file]), output).toEqual([]);
        // A reviewed file that gains an attach fails at each, not just the new one.
        expect(named['e2e/android-share-live.mjs'], output).toBe(2);
    }, 60_000);

    it('CONTROL: what is muted passes, or the failures above prove nothing', () => {
        const { named, status, output } = flagged({
            'literal.mjs': "const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });",
            'named.mjs': "const args = ['--use-fake-ui-for-media-stream', '--mute-audio'];\nconst b = await chromium.launch({ channel: 'msedge', args });",
            'spread.mjs': "const base = ['--mute-audio']; const extra = [`--use-adapter-luid=${x}`];\nconst b = await chromium.launch({ args: [...base, ...extra] });",
            'concat.mjs': "const base = ['--mute-audio']; const b = await chromium.launch({ args: base.concat(['--x']) });",
            'filtered.mjs': "const b = await chromium.launch({ args: ['--mute-audio', process.env.X].filter(Boolean) });",
            'both-sides.mjs': "const b = await chromium.launch({ args: process.env.Q ? ['--mute-audio', '--q'] : ['--mute-audio'] });",
            'channel.mjs': "const b = await chromium.launch({ headless: true, ...(C === 'bundled' ? {} : { channel: C }), args: ['--mute-audio'] });",
            'built.mjs': "const opts = () => ({ headless: true, args: ['--mute-audio'] });\nfunction more() { return { args: ['--mute-audio'] }; }\nawait chromium.launch(opts()); await chromium.launch(more());",
            'extra.mjs': "const launch = (extra = []) => chromium.launch({ args: ['--mute-audio', ...extra] });",
            'scoped.mjs': "const args = ['--loud'];\nasync function go() { const args = ['--mute-audio']; return chromium.launch({ args }); }",
            'persistent.mjs': "const c = await chromium.launchPersistentContext('dir', { args: ['--mute-audio'] });",
            'firefox.mjs': "const P = { 'media.volume_scale': '0.0' }; await firefox.launch({ firefoxUserPrefs: P }); await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0' } });",
            'pushed.mjs': "const args = ['--mute-audio']; if (process.env.SFU) args.push('--allow-loopback-in-peer-connection');\nconst b = await chromium.launch({ args });",
            'ignore-other.mjs': "await chromium.launch({ args: ['--mute-audio'], ignoreDefaultArgs: ['--hide-scrollbars'] }); await chromium.launch({ args: ['--mute-audio'], ignoreDefaultArgs: true });",
            'spread-then-said.mjs': "export const go = (opts) => chromium.launch({ ...opts, args: ['--mute-audio'], ignoreDefaultArgs: false });",
            'config-chrome.ts': "export default defineConfig({ use: { launchOptions: { args: ['--mute-audio'] } }, projects: [{ name: 'c', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } }] });",
            'webview2-assigned.mjs': "process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222 --mute-audio';",
            'imported.mjs': "import { chromium, firefox } from '@playwright/test';\nawait chromium.launch({ args: ['--mute-audio'] }); await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });",
            'required.mjs': "const { chromium } = require('@playwright/test');\nawait chromium.launch({ args: ['--mute-audio'] });",
            'both-branches-return.mjs': "function opts(x) { if (x) { return { args: ['--mute-audio', '--x'] }; } else { return { args: ['--mute-audio'] }; } }\nawait chromium.launch(opts(1));",
            'config-pixel.ts': "export default defineConfig({ use: { launchOptions: { args: ['--mute-audio'] } }, projects: [{ name: 'p', use: { ...devices['Pixel 5'] } }] });",
            'toasts-one-switch.mjs': "const args = ['--mute-audio', '--disable-features=NativeNotifications,WebRtcHideLocalIpsWithMdns'];\nconst b = await chromium.launch({ args });\nawait (await b.newContext()).grantPermissions(['notifications']);",
            'webkit.mjs': `${IMPORT_MUTE}let w;\ntry { w = muteWebkit(await webkit.launch()); } catch { w = null; }\nconst x = muteWebkit(await webkit.launch({ headless: true }));`,
            'config.ts': "export default { use: { launchOptions: { args: ['--mute-audio', '--use-fake-ui-for-media-stream'] } } };",
            'webview2.mjs': "spawn(exe, [], { env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --mute-audio` } });",
            'spoken.mjs': "await page.addInitScript(() => { Object.defineProperty(window, 'speechSynthesis', { value: fake }); });\nsave({ voiceTTS: true }); save({ voiceTTS: false });",
            'toasts.mjs': "const b = await chromium.launch({ args: ['--mute-audio', '--disable-features=NativeNotifications,SystemNotifications'] });\nawait (await b.newContext()).grantPermissions(['notifications']);",
            'e2e/android-share-live.mjs': "await chromium.connectOverCDP('a');",
            // Not launches: Web Audio's connect, a comment, a string.
            'words.mjs': "// chromium.launch() and webkit.launch()\nconst s = 'firefox.launch()'; osc.connect(gain).connect(ctx.destination);",
        });
        expect(status, output).toBe(0);
        expect(named, output).toEqual({});
    }, 60_000);
});

describe('e2e/muted.mjs: WebKit, muted', () => {
    const P = HTMLMediaElement.prototype;
    const native = Object.getOwnPropertyDescriptor(P, 'muted')!;
    const isMuted = (el: HTMLMediaElement) => native.get!.call(el) as boolean;
    const played: HTMLMediaElement[] = [];

    // Web Audio as far as silencePage() touches it: jsdom has none.
    const calls: Array<[string, unknown, unknown]> = [];
    class FakeNode {
        readonly context: unknown;
        constructor(context: unknown) { this.context = context; }
        connect(target: unknown) { calls.push(['connect', this, target]); return target; }
        disconnect(target?: unknown) { calls.push(['disconnect', this, target]); }
    }
    class FakeGain extends FakeNode { gain = { value: 1 }; }
    class FakeDestination extends FakeNode {}
    class FakeContext {
        destination = new FakeDestination(this);
        createGain() { return new FakeGain(this); }
    }
    class FakeOffline extends FakeContext {}
    const g = globalThis as Record<string, unknown>;

    let before: HTMLAudioElement;
    beforeAll(() => {
        // jsdom implements no play(); this stands in for it, after silencePage() it is wrapped.
        P.play = function (this: HTMLMediaElement) { played.push(this); return Promise.resolve(); };
        // NEGATIVE CONTROL, before silencePage(): the element takes the page's word.
        before = document.createElement('audio');
        before.muted = false;
        Object.assign(g, { AudioNode: FakeNode, AudioDestinationNode: FakeDestination, OfflineAudioContext: FakeOffline });
        silencePage();
    });

    it('CONTROL: before it, an element told muted = false is not muted', () => {
        expect(isMuted(before)).toBe(false);
    });

    it('an element the page unmutes stays muted underneath and reads back what the page set', () => {
        const el = document.createElement('video');
        el.muted = false;
        expect(isMuted(el)).toBe(true);
        expect(el.muted).toBe(false);
        el.muted = true;
        expect(el.muted).toBe(true);
        expect(isMuted(el)).toBe(true);
    });

    it('play() mutes first, and still plays', async () => {
        const el = document.createElement('audio');
        expect(isMuted(el)).toBe(false);
        await el.play();
        expect(played).toContain(el);
        expect(isMuted(el)).toBe(true);
        expect(el.muted).toBe(false);
    });

    it('loading, or playing on its own (autoplay), mutes an element in the page', () => {
        for (const type of ['loadstart', 'playing']) {
            const el = document.createElement('audio');
            document.body.append(el);
            expect(isMuted(el)).toBe(false);
            el.dispatchEvent(new Event(type));
            expect(isMuted(el)).toBe(true);
            expect(el.muted).toBe(false);
        }
    });

    it('given something to play, it is muted first: src, autoplay, load(), setAttribute', () => {
        const viaSrc = document.createElement('audio');
        viaSrc.src = 'data:audio/wav;base64,';
        const viaAutoplay = document.createElement('video');
        viaAutoplay.autoplay = true;
        const viaLoad = document.createElement('audio');
        viaLoad.load();
        const viaAttribute = document.createElement('audio');
        viaAttribute.setAttribute('src', 'data:audio/wav;base64,');
        for (const el of [viaSrc, viaAutoplay, viaLoad, viaAttribute]) {
            expect(isMuted(el)).toBe(true);
            expect(el.muted).toBe(false);
        }
        // Not a media element: setAttribute is left as it was.
        const div = document.createElement('div');
        div.setAttribute('data-x', '1');
        expect(div.getAttribute('data-x')).toBe('1');
    });

    it('new Audio(url) and toggleAttribute are muted first, and Audio is still the constructor', () => {
        const a = new Audio('data:audio/wav;base64,');
        expect(isMuted(a)).toBe(true);
        expect(a.muted).toBe(false);
        expect(a).toBeInstanceOf(Audio);
        expect(a).toBeInstanceOf(HTMLAudioElement);
        const t = document.createElement('video');
        expect(isMuted(t)).toBe(false); // CONTROL
        t.toggleAttribute('autoplay');
        expect(isMuted(t)).toBe(true);
        expect(t.hasAttribute('autoplay')).toBe(true);
    });

    it("what the parser puts in the page (autoplay in the page's own HTML) is muted as it lands", async () => {
        const host = document.createElement('div');
        host.innerHTML = '<p><video autoplay></video></p><audio></audio>';
        const media = [...host.querySelectorAll<HTMLMediaElement>('audio, video')];
        expect(media.map(isMuted)).toEqual([false, false]); // CONTROL: not in the page yet
        document.body.append(host);
        await new Promise((r) => setTimeout(r, 0));
        expect(media.map(isMuted)).toEqual([true, true]);
        expect(media.map((el) => el.muted)).toEqual([false, false]);
    });

    it('unmuted by its own controls (not script): reads unmuted, as it would, and is muted again underneath', () => {
        const el = document.createElement('audio');
        el.muted = true;
        expect(isMuted(el)).toBe(true);
        native.set!.call(el, false); // what the element's own mute button does
        expect(el.muted).toBe(false); // the truth, so an app that re-mutes on volumechange sees it
        el.dispatchEvent(new Event('volumechange'));
        expect(isMuted(el)).toBe(true);
        expect(el.muted).toBe(false);
        el.muted = true; // the app re-mutes, and reads it back
        expect(el.muted).toBe(true);
    });

    it('what the parser puts in a shadow root is muted too', async () => {
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = '<video autoplay></video>';
        document.body.append(host);
        await new Promise((r) => setTimeout(r, 0));
        const video = root.querySelector('video')!;
        expect(isMuted(video)).toBe(true);
        expect(video.muted).toBe(false);
    });

    it('Web Audio reaches a real destination only through a gain at 0', () => {
        const ctx = new FakeContext();
        const a = new FakeNode(ctx) as unknown as AudioNode;
        const b = new FakeNode(ctx) as unknown as AudioNode;
        const dest = ctx.destination as unknown as AudioDestinationNode;
        calls.length = 0;
        expect(a.connect(dest)).toBe(dest);
        b.connect(dest);
        const toDest = calls.filter(([, , t]) => t === dest);
        expect(toDest).toHaveLength(1); // only the stand-in is wired to the speakers
        const standIn = toDest[0][1] as FakeGain;
        expect(standIn).toBeInstanceOf(FakeGain);
        expect(standIn.gain.value).toBe(0);
        expect(calls.filter(([op, from, t]) => op === 'connect' && (from === a || from === b) && t === standIn)).toHaveLength(2);
        a.disconnect(dest);
        expect(calls.at(-1)).toEqual(['disconnect', a, standIn]);
        // Anything else connects as it would.
        a.connect(b);
        expect(calls.at(-1)).toEqual(['connect', a, b]);
    });

    it('an OfflineAudioContext renders to a buffer, so it is left alone', () => {
        const ctx = new FakeOffline();
        const a = new FakeNode(ctx) as unknown as AudioNode;
        calls.length = 0;
        a.connect(ctx.destination as unknown as AudioDestinationNode);
        expect(calls).toEqual([['connect', a, ctx.destination]]);
    });

    it('muteWebkit: every context and page gets silencePage() before the page has run', async () => {
        const log: string[] = [];
        const fakeContext = () => ({
            addInitScript: async (fn: unknown) => { log.push(fn === silencePage ? 'init' : 'other'); },
            newPage: async () => { log.push('page'); return { close: async () => { log.push('page closed'); } }; },
            close: async () => { log.push('context closed'); },
        });
        const browser = {
            newContext: async () => { log.push('context'); return fakeContext(); },
            newPage: async () => { throw new Error('the unwrapped newPage would skip the init script'); },
        };
        expect(muteWebkit(browser)).toBe(browser);
        await browser.newContext();
        expect(log).toEqual(['context', 'init']);
        log.length = 0;
        const page = await browser.newPage() as unknown as { close(): Promise<void> };
        expect(log).toEqual(['context', 'init', 'page']);
        await page.close();
        expect(log.slice(-2)).toEqual(['page closed', 'context closed']);
    });
});
