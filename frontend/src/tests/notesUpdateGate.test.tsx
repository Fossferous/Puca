/**
 * Púca Notes' Android app updates over the air on its OWN channel.
 *
 * The case this exists for: the server that predates the notes manifest
 * answers ?variant=notes with Púca's FULL manifest. A Notes gate that read an
 * untagged or "full" manifest as its own would download Púca into the Notes
 * app. Every refusal below has a positive control beside it (a correctly
 * tagged manifest IS applied), so a gate that refused everything would fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({
    current: { bundle: { id: 'builtin', version: 'builtin' }, native: '0.9.815' } as unknown,
    downloadCalls: [] as Record<string, unknown>[],
    downloadImpl: null as null | (() => Promise<{ version: string }>),
    setCalls: [] as unknown[],
    /** Every 'download' progress listener, in the order runs added them. */
    listeners: [] as Array<(info: { percent?: number; bundle?: { version?: string } }) => void>,
}));

vi.mock('@capgo/capacitor-updater', () => ({
    CapacitorUpdater: {
        notifyAppReady: async () => ({}),
        current: async () => h.current,
        addListener: async (_ev: string, cb: (info: { percent?: number; bundle?: { version?: string } }) => void) => {
            h.listeners.push(cb);
            return { remove: async () => {} };
        },
        download: (opts: Record<string, unknown>) => {
            h.downloadCalls.push(opts);
            return h.downloadImpl ? h.downloadImpl() : new Promise<{ version: string }>(() => { /* pending */ });
        },
        set: async (r: unknown) => { h.setCalls.push(r); },
    },
}));

import { NotesUpdateGate, NotesUpdateStripSlot } from '../notes/components/NotesUpdateGate';
import { CHECKING_DEADLINE_MS, DOWNLOAD_STALL_MS } from '../api/mobileOta';
import { checkNotesForUpdates, downloadPage, nativePromptFor, setNativePrompt } from '../notes/model/notesUpdate';
import { useState } from 'react';

const BASE = 'https://chat.example.com';
const BUNDLE = 'https://download.example.com/mobile/puca-notes-web-99.0.0.enc.zip';
const PAGE = 'https://download.example.com/#notes-app';
const SIGNED = { checksum: 'rsa-signed-sha256', sessionKey: 'rsa-wrapped-aes-key:iv' };

let container: HTMLDivElement;
let root: Root;
let fetched: string[];

function serve(body: unknown, status = 200): void {
    vi.stubGlobal('fetch', ((url: string) => {
        fetched.push(String(url));
        return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
    }) as unknown as typeof fetch);
}

/** A child with state, so a test can tell "still mounted" from "remounted".
 *  Laid out like NotesShell: a top bar, then the strip's slot, then content. */
function Counter() {
    const [n, setN] = useState(0);
    return (
        <div className="notes-app">
            <header data-testid="topbar" />
            <NotesUpdateStripSlot />
            <button type="button" data-testid="app" onClick={() => setN(n + 1)}>count {n}</button>
        </div>
    );
}

async function mountGate(native = true): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
        root = createRoot(container);
        root.render(<NotesUpdateGate native={native}><Counter /></NotesUpdateGate>);
    });
}

async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const app = () => container.querySelector('[data-testid="app"]') as HTMLButtonElement | null;
/** The buttons on the gate's own screen (the app may be mounted behind it). */
const gateButtons = () => [...container.querySelectorAll('[role="dialog"] button')].map(b => b.textContent?.trim());

beforeEach(() => {
    vi.useFakeTimers();
    h.current = { bundle: { id: 'builtin', version: 'builtin' }, native: '0.9.815' };
    h.downloadCalls = [];
    h.downloadImpl = null;
    h.setCalls = [];
    h.listeners = [];
    fetched = [];
    setNativePrompt(null);
    // setup.ts replaces localStorage with vi.fn()s: getItem answers undefined.
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockClear();
    vi.stubEnv('VITE_API_URL', BASE);
    vi.stubEnv('VITE_UPDATE_FALLBACK_API', '');
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('in the browser', () => {
    it('renders the app at once and never asks the server', async () => {
        const f = vi.fn();
        vi.stubGlobal('fetch', f);
        await mountGate(false);
        expect(app()).toBeTruthy();
        await advance(100);
        expect(f).not.toHaveBeenCalled();
        expect(await checkNotesForUpdates(), 'no runner is registered off-device').toBe('unavailable');
    });
});

describe('the notes channel', () => {
    it('asks ?variant=notes and applies a manifest tagged "notes" (positive control)', async () => {
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(100);
        expect(fetched).toEqual([`${BASE}/api/mobile-updates/check?variant=notes`]);
        expect(h.downloadCalls).toEqual([{ url: BUNDLE, version: '99.0.0', ...SIGNED }]);
        expect(container.textContent).toContain('Updating to v99.0.0');
    });

    it.each([undefined, 'full', 'lite', 'Notes'])('REFUSES a manifest tagged %j — the old server answers with Púca\'s', async (variant) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls, 'Púca\'s bundle must never reach the Notes plugin').toHaveLength(0);
        expect(app(), 'and the app runs on what it has').toBeTruthy();
    });

    it('a finished download is applied', async () => {
        h.downloadImpl = () => Promise.resolve({ version: '99.0.0' });
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.setCalls).toEqual([{ version: '99.0.0' }]);
        expect(container.textContent).toContain('Restarting with v99.0.0');
    });

    it('a failed verification says so in Notes\' words, and Continue anyway runs the app', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.downloadImpl = () => Promise.reject(new Error('checksum verification failed'));
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(100);
        expect(container.textContent).toContain('Púca Notes only applies updates signed with the key built into this app');
        expect(app(), 'a failed apply does not mount the app behind the error').toBeNull();
        const cont = [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue anyway')!;
        await act(async () => { cont.click(); });
        expect(app()).toBeTruthy();
    });

    it('a hung server never holds the app (deadline)', async () => {
        vi.stubGlobal('fetch', ((_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })) as unknown as typeof fetch);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mountGate();
        expect(container.textContent).toContain('Checking for updates');
        expect(app(), 'the app waits for the check, as Púca does').toBeNull();
        await advance(16_000);
        expect(app()).toBeTruthy();
    });

    it('the plugin failing to answer at all still shows the app', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        h.current = Promise.reject(new Error('"CapacitorUpdater" plugin is not implemented on android'));
        (h.current as Promise<unknown>).catch(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(100);
        expect(app()).toBeTruthy();
        expect(h.downloadCalls).toHaveLength(0);
    });
});

/** Past the stall watchdog: it samples every 5 s, so one extra period. */
const STALLED = DOWNLOAD_STALL_MS + 6_000;
const STALL_TEXT = 'The update download stalled';
const clickGate = async (label: string) => {
    const b = [...container.querySelectorAll('[role="dialog"] button')].find(x => x.textContent === label) as HTMLButtonElement | undefined;
    expect(b, `the gate shows a "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
};

describe('a stalled download never holds the app — including after Retry', () => {
    // The review's case: the first run stalls (status 'error', Retry shown)
    // but its download promise is still pending. Retry used to hand back THAT
    // run (the one-at-a-time dedupe), so the gate sat on "Checking for
    // updates…" with no control, for good.
    it('Retry after a stall starts a fresh check, and the app appears within the check deadline', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        expect(container.textContent).toContain(STALL_TEXT);
        serve(undefined, 404); // the server now has nothing for us
        await clickGate('Retry');
        await advance(CHECKING_DEADLINE_MS);
        expect(fetched, 'Retry asked the server again').toHaveLength(2);
        expect(app(), 'the app is shown, not a spinner with no control').toBeTruthy();
        expect(container.textContent).not.toContain('Checking for updates');
    });

    it('Retry into a server that still stalls ends in a control again, never a bare spinner', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        await clickGate('Retry');
        await advance(STALLED);
        expect(h.downloadCalls, 'the retry downloaded again').toHaveLength(2);
        expect(gateButtons()).toEqual(['Retry', 'Continue anyway']);
    });

    // What the next two prove, and what they do not: this mock gives each run
    // its own listener, but on a device Capacitor delivers every download's
    // events to every listener. The first is about the abandoned run's OWN
    // listener (its state writes are dead). The second is the engine dropping
    // an event labelled with another version. An abandoned download of the
    // SAME version still reaches the retried run's listener on a device and
    // cannot be filtered (its bundle id is only known once download()
    // resolves) — that is on the device-check list in docs/NOTES.md.
    it('the abandoned run’s own listener no longer moves the bar after Retry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        await clickGate('Retry');
        await advance(100);
        expect(h.listeners).toHaveLength(2);
        await act(async () => { h.listeners[1]({ percent: 20 }); });
        expect(container.textContent, 'positive control: the live run moves the bar').toContain('20% downloaded');
        await act(async () => { h.listeners[0]({ percent: 90 }); });
        expect(container.textContent).toContain('20% downloaded');
    });

    it('a progress event labelled with another version does not move the retried run’s bar', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        serve({ version: '99.0.1', url: BUNDLE.replace('99.0.0', '99.0.1'), variant: 'notes', ...SIGNED });
        await clickGate('Retry');
        await advance(100);
        expect(h.downloadCalls.map(c => c.version)).toEqual(['99.0.0', '99.0.1']);
        const live = h.listeners[1];
        await act(async () => { live({ percent: 20, bundle: { version: '99.0.1' } }); });
        expect(container.textContent, 'positive control: its own version moves the bar').toContain('20% downloaded');
        // What a device delivers to this listener from the abandoned 99.0.0 download.
        await act(async () => { live({ percent: 90, bundle: { version: '99.0.0' } }); });
        expect(container.textContent).toContain('20% downloaded');
        expect(container.textContent).not.toContain('90% downloaded');
        // The plugin labels a bundle with no stored version 'builtin': not a
        // reason to drop it, or this run's own progress could fake a stall.
        await act(async () => { live({ percent: 40, bundle: { version: 'builtin' } }); });
        expect(container.textContent).toContain('40% downloaded');
    });

    it('after Retry, the new run is still the only one: a menu check shares it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        await clickGate('Retry');
        await advance(100);
        expect(fetched).toHaveLength(2);
        await act(async () => { void checkNotesForUpdates(); });
        await advance(100);
        expect(fetched, 'no second, concurrent check').toHaveLength(2);
        expect(h.downloadCalls).toHaveLength(2);
    });

    it('the first, stalled download finishing late does not yank the retried run into a reload', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const late: Array<(v: { version: string }) => void> = [];
        h.downloadImpl = () => new Promise(r => { late.push(r); });
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        serve(undefined, 404);
        await clickGate('Retry');
        await advance(100);
        expect(app()).toBeTruthy();
        await act(async () => { late[0]({ version: '99.0.0' }); });
        await advance(100);
        expect(h.setCalls, 'an abandoned run never applies').toEqual([]);
        expect(app()).toBeTruthy();
        expect(container.textContent).not.toContain('Update failed');
    });

    it('Continue anyway after a stall leaves "Check for updates" working', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await mountGate();
        await advance(STALLED);
        await clickGate('Continue anyway');
        expect(app()).toBeTruthy();
        serve(undefined, 404);
        let outcome: unknown = 'pending';
        await act(async () => { void checkNotesForUpdates().then(o => { outcome = o; }); });
        await advance(100);
        expect(outcome, 'a fresh check ran, instead of handing back the stalled one').toBe('nothing');
    });

    it('a manual check whose download stalls reports an outcome once the user moves on', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve(undefined, 404);
        await mountGate();
        await advance(100);
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        let outcome: unknown = 'pending';
        await act(async () => { void checkNotesForUpdates().then(o => { outcome = o; }); });
        await advance(STALLED);
        expect(container.textContent).toContain(STALL_TEXT);
        await clickGate('Continue anyway');
        await advance(10);
        expect(outcome, 'the menu is not left on "Checking…" forever').toBe('failed');
    });
});

describe('the APK prompts (the manifest\'s native block)', () => {
    it('native.min newer than the installed APK: the bundle is NOT applied, the install prompt shows', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const assign = vi.spyOn(downloadPage, 'open').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', native: { min: '99.0.0', version: '99.0.0', download_url: PAGE }, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls, 'a bundle that needs a plugin this APK lacks must not apply').toHaveLength(0);
        expect(container.textContent).toContain('Install the new Púca Notes app');
        expect(container.textContent).toContain('this one is 0.9.815');
        const dl = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Download'))!;
        await act(async () => { dl.click(); });
        expect(assign).toHaveBeenCalledWith(PAGE);
        const cont = [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue')!;
        await act(async () => { cont.click(); });
        expect(app(), 'dismissable: the app runs on its current bundle').toBeTruthy();
        expect(container.textContent, 'and the strip keeps saying why').toContain('needs Púca Notes 99.0.0');
    });

    it('positive control: native.min at or below the installed APK applies the bundle', async () => {
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', native: { min: '0.9.815', version: '0.9.815', download_url: PAGE }, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(1);
        expect(container.textContent).not.toContain('Install the new Púca Notes app');
    });

    it('an off-site download_url is never offered', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', native: { min: '99.0.0', download_url: 'https://evil.attacker.test/notes.apk' }, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(container.textContent).toContain('Install the new Púca Notes app');
        expect(gateButtons(), 'no Download button for a foreign host').toEqual(['Continue']);
    });

    it('a newer APK alone is a dismissable strip, remembered per version', async () => {
        // An OTA bundle at the same version: nothing to apply.
        h.current = { bundle: { id: 'abc', version: __APP_VERSION__ }, native: '0.9.815' };
        serve({ version: __APP_VERSION__, url: BUNDLE, variant: 'notes', native: { version: '99.1.0', download_url: PAGE }, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(app()).toBeTruthy();
        expect(container.textContent).toContain('A new Púca Notes app (99.1.0) is available');
        const close = container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement;
        await act(async () => { close.click(); });
        expect(container.textContent).not.toContain('is available');
        expect(localStorage.setItem).toHaveBeenCalledWith('pucaNotesNativeNudgeDismissed', '99.1.0');
    });

    it('the strip is its own row BELOW the top bar, not laid over it', async () => {
        // It was position:fixed over the top of the app and covered the top
        // bar's account button. Now the gate renders it only through the
        // slot the shell places after its top bar.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', native: { min: '99.0.0', download_url: PAGE }, ...SIGNED });
        await mountGate();
        await advance(100);
        await clickGate('Continue');
        const strips = container.querySelectorAll('.notes-update-strip');
        expect(strips, 'exactly one strip, from the slot').toHaveLength(1);
        expect(strips[0].previousElementSibling?.getAttribute('data-testid')).toBe('topbar');
        expect(strips[0].parentElement?.className).toBe('notes-app');
    });

    it('a gate with no slot in its tree shows no strip (it never floats over the app)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', native: { min: '99.0.0', download_url: PAGE }, ...SIGNED });
        container = document.createElement('div');
        document.body.appendChild(container);
        await act(async () => {
            root = createRoot(container);
            root.render(<NotesUpdateGate native><p data-testid="bare">app</p></NotesUpdateGate>);
        });
        await advance(100);
        await clickGate('Continue');
        expect(container.querySelector('[data-testid="bare"]')).toBeTruthy();
        expect(container.querySelector('.notes-update-strip')).toBeNull();
    });

    it('the stylesheet keeps the strip in flow (no fixed or absolute positioning)', () => {
        const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'notes', 'components', 'NotesUpdateGate.css'), 'utf8');
        const rule = /\.notes-update-strip\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
        expect(rule, 'the rule exists').toMatch(/display:\s*flex/);
        expect(rule).not.toMatch(/position:\s*(fixed|absolute|sticky)/);
    });
});

describe('a dismissed nudge stays dismissed for that version only', () => {
    it.each([
        ['99.1.0', false],
        ['99.0.9', true],
    ])('dismissed for %s: strip shown = %s', async (dismissed, shown) => {
        vi.mocked(localStorage.getItem).mockImplementation(k => (k === 'pucaNotesNativeNudgeDismissed' ? dismissed : null));
        h.current = { bundle: { id: 'abc', version: __APP_VERSION__ }, native: '0.9.815' };
        serve({ version: __APP_VERSION__, url: BUNDLE, variant: 'notes', native: { version: '99.1.0', download_url: PAGE }, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(container.textContent?.includes('is available')).toBe(shown);
    });
});

describe('Check for updates (the account menu)', () => {
    it('re-runs the check without remounting the app, and reports the outcome', async () => {
        serve(undefined, 404);
        await mountGate();
        await advance(100);
        await act(async () => { app()!.click(); });
        expect(app()!.textContent).toBe('count 1');

        let outcome: unknown;
        await act(async () => { outcome = await checkNotesForUpdates(); });
        expect(outcome).toBe('nothing');
        expect(fetched).toHaveLength(2);
        expect(app()!.textContent, 'the app kept its state: it was never unmounted').toBe('count 1');
    });

    it('a manual check that finds an update covers the app instead of replacing it', async () => {
        serve(undefined, 404);
        await mountGate();
        await advance(100);
        await act(async () => { app()!.click(); });
        serve({ version: '99.0.0', url: BUNDLE, variant: 'notes', ...SIGNED });
        await act(async () => { void checkNotesForUpdates(); });
        await advance(100);
        expect(container.textContent).toContain('Updating to v99.0.0');
        expect(app()!.textContent).toBe('count 1');
    });
});

describe('nativePromptFor', () => {
    it('unknown APK version + a minimum = required (capability not proved)', () => {
        expect(nativePromptFor({ min: '0.9.816' }, null, BASE)).toMatchObject({ kind: 'required', need: '0.9.816', have: null });
    });
    it('no native block, or nothing newer = no prompt', () => {
        expect(nativePromptFor(undefined, '0.9.815', BASE)).toBeNull();
        expect(nativePromptFor({ min: '0.9.815', version: '0.9.815' }, '0.9.815', BASE)).toBeNull();
    });
    it('http or foreign download pages are dropped, the prompt still stands', () => {
        expect(nativePromptFor({ version: '1.0.0', download_url: 'http://download.example.com/' }, '0.9.815', BASE))
            .toMatchObject({ kind: 'available', downloadUrl: null });
    });
});

describe('the account menu rows', () => {
    it('show the running version and report a manual check', async () => {
        const { NotesUpdateMenu } = await import('../notes/components/NotesUpdateMenu');
        serve(undefined, 404);
        await mountGate();
        await advance(100);
        const menu = document.createElement('div');
        document.body.appendChild(menu);
        const menuRoot = createRoot(menu);
        await act(async () => { menuRoot.render(<NotesUpdateMenu />); });
        await advance(10);
        expect(menu.querySelector('[data-testid="notes-app-version"]')?.textContent).toBe(__APP_VERSION__); // jsdom is not native: the web answer
        const btn = [...menu.querySelectorAll('button')].find(b => b.textContent?.includes('Check for updates'))!;
        await act(async () => { btn.click(); });
        await advance(10);
        expect(menu.textContent).toContain('Púca Notes is up to date.');
        await act(async () => { menuRoot.unmount(); });
        menu.remove();
    });
});
