/**
 * The update gate's one invariant: it may DELAY the app, it may never HOLD it.
 *
 * Field report 2026-08-05: after the 0.8.35 OTA the app sat on the launch
 * screen until force-closed. Two of the gate's phases could hold it forever —
 * the check fetch had no timeout (and a HUNG primary base masked the
 * hardcoded fallback, defeating the 0.8.24/25 self-healing), and the download
 * had no stall detection. These tests reproduce both hangs deterministically;
 * the survival cases were verified to FAIL against the pre-fix gate.
 *
 * Mounted the way the repo's other component tests do it — raw
 * react-dom/client + act, no @testing-library (not a dependency here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    downloadResolve: null as null | ((v: { version: string; id?: string }) => void),
    downloadCalls: 0,
    setCalls: [] as unknown[],
    progressCb: null as null | ((info: { percent?: number }) => void),
}));

vi.mock('@capgo/capacitor-updater', () => ({
    CapacitorUpdater: {
        notifyAppReady: async () => ({}),
        current: async () => ({ bundle: { version: '0.8.35' } }),
        addListener: async (_evt: string, cb: (info: { percent?: number }) => void) => {
            h.progressCb = cb;
            return { remove: async () => {} };
        },
        download: (_opts: unknown) => {
            h.downloadCalls += 1;
            return new Promise<{ version: string }>(resolve => { h.downloadResolve = resolve; });
        },
        set: async (r: unknown) => { h.setCalls.push(r); },
    },
}));

import { UpdateGate } from '../components/UpdateGate';

/** A fetch that GENUINELY hangs — it settles only if the caller aborts. */
function hangingFetch(): typeof fetch {
    return ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted.', 'AbortError')));
        })) as unknown as typeof fetch;
}

function okJson(body: unknown): Response {
    return { ok: true, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement;
let root: Root;

async function mountGate(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
        root = createRoot(container);
        root.render(<UpdateGate><div data-testid="app">APP</div></UpdateGate>);
    });
}

async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
    vi.useFakeTimers();
    h.downloadResolve = null;
    h.downloadCalls = 0;
    h.setCalls = [];
    h.progressCb = null;
    (window as unknown as Record<string, unknown>).Capacitor = {
        isNativePlatform: () => true,
    };
    vi.stubEnv('VITE_API_URL', 'https://chat.example.com');
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove();
    delete (window as unknown as Record<string, unknown>).Capacitor;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('the update gate can no longer hold the app', () => {
    it('a HUNG check fetch waves the app through at the deadline', async () => {
        vi.stubGlobal('fetch', hangingFetch());
        await mountGate();
        expect(container.textContent).toContain('Checking for updates');

        // Both bases hang; the per-fetch timeout burns 8s each, and the
        // 15s phase deadline fires before the second one resolves anything.
        await advance(16_000);
        expect(
            container.querySelector('[data-testid="app"]'),
            'the invariant: past the deadline the app RUNS, on the current bundle',
        ).toBeTruthy();
    });

    it('a hung PRIMARY no longer masks the CONFIGURED fallback base', async () => {
        const calls: string[] = [];
        const fetchMock = ((url: string, init?: RequestInit) => {
            calls.push(String(url));
            if (String(url).startsWith('https://chat.example.com')) {
                return Promise.resolve(okJson({})); // reachable, no update
            }
            return (hangingFetch())(url as never, init as never);
        }) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fetchMock);
        // Primary differs from the fallback so there are two candidates.
        // The fallback is build-time config now, not a hardcoded domain, so it
        // has to be stubbed for this scenario to exist at all — a build with
        // none configured correctly has only ONE candidate to try.
        vi.stubEnv('VITE_API_URL', 'https://misbuilt.example.com');
        vi.stubEnv('VITE_UPDATE_FALLBACK_API', 'https://chat.example.com');

        await mountGate();
        await advance(9_000); // 8s per-fetch timeout aborts the primary
        expect(calls.length, 'the fallback must actually be TRIED').toBe(2);
        expect(calls[1]).toContain('chat.example.com');
        expect(
            container.querySelector('[data-testid="app"]'),
            'a healthy fallback answers well inside the deadline',
        ).toBeTruthy();
    });

    it('a STALLED download surfaces Retry/Continue instead of pinning the bar', async () => {
        vi.stubGlobal('fetch', ((_u: string) => Promise.resolve(okJson({
            version: '99.0.0',
            url: 'https://download.example.com/mobile/sovereign-web-99.0.0.enc.zip',
            // Signed manifest: the gate now REFUSES a bundle lacking either
            // field (an unsigned bundle would skip RSA verification in the
            // plugin), so every fixture that expects a download to proceed must
            // carry both.
            checksum: 'rsa-signed-sha256',
            sessionKey: 'rsa-wrapped-aes-key:iv',
        }))) as unknown as typeof fetch);

        await mountGate();
        await advance(100);
        expect(container.textContent).toContain('Updating to v99.0.0');

        // Progress arrives once, then the transfer goes silent.
        await act(async () => { h.progressCb?.({ percent: 10 }); });
        await advance(50_000);
        expect(container.textContent).toContain('stalled');
        expect(
            [...container.querySelectorAll('button')].map(b => b.textContent),
            'the user gets control back: Retry and Continue Anyway',
        ).toEqual(expect.arrayContaining(['Retry', 'Continue Anyway']));

        // A LATE completion must not yank the user into a surprise reload.
        await act(async () => { h.downloadResolve?.({ version: '99.0.0' }); });
        expect(h.setCalls.length, 'set() must NOT run after the stall verdict').toBe(0);
    });

    /** POSITIVE CONTROL: bounding the failure paths must not break the
     *  success path — a live download still applies and reloads. */
    it('a healthy download still applies: progress, ready, set()', async () => {
        vi.stubGlobal('fetch', ((_u: string) => Promise.resolve(okJson({
            version: '99.0.0',
            url: 'https://download.example.com/mobile/sovereign-web-99.0.0.enc.zip',
            checksum: 'rsa-signed-sha256',
            sessionKey: 'rsa-wrapped-aes-key:iv',
        }))) as unknown as typeof fetch);

        await mountGate();
        await advance(100);
        await act(async () => { h.progressCb?.({ percent: 50 }); });
        expect(container.textContent).toContain('50%');

        await act(async () => { h.downloadResolve?.({ version: '99.0.0' }); });
        expect(h.setCalls.length, 'the update applies').toBe(1);
        expect(container.textContent).toContain('Restarting with v99.0.0');
    });

    /** SECURITY POSITIVE CONTROL: an UNSIGNED manifest (missing sessionKey or
     *  checksum) must be refused BEFORE download — never handed to the plugin,
     *  which would install it with no RSA signature verification. The app must
     *  fall through to the current bundle. Fails against the pre-fix gate, which
     *  forwarded sessionKey/checksum only when present and downloaded regardless. */
    it('REFUSES an unsigned OTA manifest (no sessionKey/checksum) before download', async () => {
        vi.stubGlobal('fetch', ((_u: string) => Promise.resolve(okJson({
            version: '99.0.0',
            url: 'https://download.example.com/mobile/sovereign-web-99.0.0.enc.zip',
            // no checksum, no sessionKey → unsigned
        }))) as unknown as typeof fetch);

        await mountGate();
        await advance(100);

        expect(h.downloadCalls, 'an unsigned bundle must never reach the plugin').toBe(0);
        expect(h.setCalls.length, 'and must never be applied').toBe(0);
        expect(
            container.querySelector('[data-testid="app"]'),
            'the app runs on the current bundle instead',
        ).toBeTruthy();
    });

    /** Half-signed is still unsigned: a checksum WITHOUT the RSA-wrapped session
     *  key is exactly the shape that skips verification in the plugin. */
    it('REFUSES a manifest with checksum but no sessionKey', async () => {
        vi.stubGlobal('fetch', ((_u: string) => Promise.resolve(okJson({
            version: '99.0.0',
            url: 'https://download.example.com/mobile/sovereign-web-99.0.0.enc.zip',
            checksum: 'plain-sha256-no-signature',
        }))) as unknown as typeof fetch);

        await mountGate();
        await advance(100);

        expect(h.downloadCalls).toBe(0);
        expect(h.setCalls.length).toBe(0);
    });
});
