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

const h = vi.hoisted(() => ({
    current: { bundle: { id: 'builtin', version: 'builtin' }, native: '0.9.815' } as unknown,
    downloadCalls: [] as Record<string, unknown>[],
    downloadImpl: null as null | (() => Promise<{ version: string }>),
    setCalls: [] as unknown[],
}));

vi.mock('@capgo/capacitor-updater', () => ({
    CapacitorUpdater: {
        notifyAppReady: async () => ({}),
        current: async () => h.current,
        addListener: async () => ({ remove: async () => {} }),
        download: (opts: Record<string, unknown>) => {
            h.downloadCalls.push(opts);
            return h.downloadImpl ? h.downloadImpl() : new Promise<{ version: string }>(() => { /* pending */ });
        },
        set: async (r: unknown) => { h.setCalls.push(r); },
    },
}));

import { NotesUpdateGate } from '../notes/components/NotesUpdateGate';
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

/** A child with state, so a test can tell "still mounted" from "remounted". */
function Counter() {
    const [n, setN] = useState(0);
    return <button type="button" data-testid="app" onClick={() => setN(n + 1)}>count {n}</button>;
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
