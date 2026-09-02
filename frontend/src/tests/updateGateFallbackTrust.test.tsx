/**
 * Mobile OTA: the fallback base must be able to DELIVER a bundle, not only
 * fetch a manifest — and a wrong answer from the configured base must not
 * end the search.
 *
 * Two defects, both in the exact scenario the fallback exists for (a build
 * made without .env.production points at localhost:3000 and would otherwise
 * never see the fixed release):
 *
 *  1. The manifest was fetched via VITE_UPDATE_FALLBACK_API, but the bundle
 *     URL was then held against `VITE_API_URL || ''` — the ORIGINAL, absent
 *     value. isTrustedBundleUrl fails closed on an empty base, so the
 *     recovery path fetched a manifest and refused its bundle every time.
 *  2. The check loop broke on the FIRST response of any status, so a 502
 *     from a proxy (or anything listening on localhost:3000) masked the
 *     fallback exactly as a hung primary once did.
 *
 * Every "download IS called" case here was verified to FAIL against the
 * pre-fix gate; the positive controls prove the trust check still refuses
 * a foreign host and that 404 is still final.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    downloadCalls: [] as { url: string }[],
    downloadImpl: null as null | (() => Promise<{ version: string }>),
}));

vi.mock('@capgo/capacitor-updater', () => ({
    CapacitorUpdater: {
        notifyAppReady: async () => ({}),
        current: async () => ({ bundle: { version: '0.9.0' } }),
        addListener: async () => ({ remove: async () => {} }),
        download: (opts: { url: string }) => {
            h.downloadCalls.push({ url: opts.url });
            return h.downloadImpl ? h.downloadImpl() : new Promise<{ version: string }>(() => { /* pending */ });
        },
        set: async () => {},
    },
}));

import { UpdateGate } from '../components/UpdateGate';

const FALLBACK = 'https://chat.example.com';
const SIGNED = { version: '99.0.0', checksum: 'rsa-signed-sha256', sessionKey: 'rsa-wrapped-aes-key:iv' };

function response(status: number, body?: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** Route fetches by host: the localhost primary and the fallback answer
 *  independently, and every URL fetched is recorded. */
function routedFetch(routes: Record<string, () => Promise<Response>>, calls: string[]): typeof fetch {
    return ((url: string) => {
        calls.push(String(url));
        for (const [prefix, answer] of Object.entries(routes)) {
            if (String(url).startsWith(prefix)) return answer();
        }
        return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;
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
    h.downloadCalls = [];
    h.downloadImpl = null;
    (window as unknown as Record<string, unknown>).Capacitor = { isNativePlatform: () => true };
    // The mis-build: no API base baked in, so the gate falls back to
    // localhost:3000 — and a fallback base IS configured.
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('VITE_UPDATE_FALLBACK_API', FALLBACK);
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove();
    delete (window as unknown as Record<string, unknown>).Capacitor;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('the OTA fallback base can deliver a bundle', () => {
    it('trusts a bundle on the same site as the base that ANSWERED (the fallback), not the absent configured one', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', routedFetch({
            [FALLBACK]: () => Promise.resolve(response(200, {
                ...SIGNED, url: 'https://download.example.com/mobile/puca-web-99.0.0.enc.zip',
            })),
        }, calls));

        await mountGate();
        await advance(500);

        expect(calls.some(u => u.startsWith('http://localhost:3000')), 'the mis-built primary is tried first').toBe(true);
        expect(calls.some(u => u.startsWith(FALLBACK)), 'the fallback must actually be TRIED').toBe(true);
        expect(h.downloadCalls, 'the manifest the fallback served must be APPLIED, not refused').toHaveLength(1);
        expect(h.downloadCalls[0].url).toBe('https://download.example.com/mobile/puca-web-99.0.0.enc.zip');
    });

    it('positive control: a manifest pointing at a foreign host is still refused, and the refusal names the answering base', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', routedFetch({
            // attacker.test: an IANA-reserved TLD, guaranteed not to share a
            // registrable site with chat.example.com.
            [FALLBACK]: () => Promise.resolve(response(200, { ...SIGNED, url: 'https://evil.attacker.test/b.enc.zip' })),
        }, []));

        await mountGate();
        await advance(500);

        expect(h.downloadCalls, 'a foreign bundle host must never be downloaded').toHaveLength(0);
        expect(container.querySelector('[data-testid="app"]'), 'the app runs on its current bundle').toBeTruthy();
        const refusal = err.mock.calls.map(c => String(c[0])).find(m => m.includes('Refusing untrusted bundle URL'));
        expect(refusal, 'the refusal must be logged').toBeTruthy();
        expect(refusal, 'and say which base served the manifest, so the next one is diagnosable').toContain(FALLBACK);
    });
});

describe('a wrong answer from the primary does not end the search', () => {
    it('a 502 from the configured base advances to the fallback', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', routedFetch({
            'http://localhost:3000': () => Promise.resolve(response(502)),
            [FALLBACK]: () => Promise.resolve(response(200, {
                ...SIGNED, url: 'https://download.example.com/mobile/puca-web-99.0.0.enc.zip',
            })),
        }, calls));

        await mountGate();
        await advance(500);

        expect(calls, 'both bases must be consulted').toHaveLength(2);
        expect(h.downloadCalls, 'the fallback manifest must be applied').toHaveLength(1);
    });

    it('positive control: a 404 from the configured base is FINAL — nothing published, no second round-trip', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', routedFetch({
            'http://localhost:3000': () => Promise.resolve(response(404)),
            [FALLBACK]: () => Promise.resolve(response(200, {
                ...SIGNED, url: 'https://download.example.com/mobile/puca-web-99.0.0.enc.zip',
            })),
        }, calls));

        await mountGate();
        await advance(500);

        expect(calls, 'the fallback must NOT be tried after a definitive 404').toHaveLength(1);
        expect(h.downloadCalls).toHaveLength(0);
        expect(container.querySelector('[data-testid="app"]')).toBeTruthy();
    });
});

describe('a bundle that fails verification says what actually helps', () => {
    it('names a signing-key mismatch instead of advising a reinstall that reinstalls the same key', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.downloadImpl = () => Promise.reject(new Error('checksum verification failed'));
        vi.stubGlobal('fetch', routedFetch({
            [FALLBACK]: () => Promise.resolve(response(200, {
                ...SIGNED, url: 'https://download.example.com/mobile/puca-web-99.0.0.enc.zip',
            })),
        }, []));

        await mountGate();
        await advance(500);

        const text = container.textContent ?? '';
        expect(text, 'the failure must surface Retry / Continue').toContain('Continue Anyway');
        expect(text).toMatch(/different key/);
        expect(text, 'the old advice — reinstall to get "the latest signed version" — cannot help and must be gone')
            .not.toContain('latest signed version');
    });
});
