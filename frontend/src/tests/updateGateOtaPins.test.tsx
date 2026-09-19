/**
 * Púca's mobile OTA, pinned end to end BEFORE its engine moved into
 * api/mobileOta.ts (so Púca Notes could share it). Every assertion here was
 * written against, and passed on, the gate as it stood with the engine inline
 * in UpdateGate.tsx — the point is that the extraction changed nothing a phone
 * can observe:
 *
 *  - which URL is asked (full: no query; lite: ?variant=lite),
 *  - which manifests are refused (wrong variant, not newer, unsigned, foreign
 *    bundle host) and which are handed to the plugin, with exactly which
 *    arguments,
 *  - the builtin-bundle same-version rule and the OTA-bundle strictly-newer
 *    rule,
 *  - the mislabelled-bundle diagnostic, the failure text, and Continue Anyway.
 *
 * The existing updateGate*.test.tsx files pin the hang, fallback and trust
 * behaviour; this file covers what they did not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    rc: true,
    current: { bundle: { id: 'builtin', version: 'builtin' } } as unknown,
    notifyCalls: 0,
    downloadCalls: [] as Record<string, unknown>[],
    downloadImpl: null as null | (() => Promise<{ version: string }>),
    setCalls: [] as unknown[],
}));

vi.mock('../api/platform', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../api/platform')>();
    return {
        ...orig,
        // A getter, so each test can pick the build variant: UpdateGate reads
        // the binding at call time.
        get RC_ENABLED() { return h.rc; },
    };
});

vi.mock('@capgo/capacitor-updater', () => ({
    CapacitorUpdater: {
        notifyAppReady: async () => { h.notifyCalls += 1; return {}; },
        current: async () => h.current,
        addListener: async () => ({ remove: async () => {} }),
        download: (opts: Record<string, unknown>) => {
            h.downloadCalls.push(opts);
            return h.downloadImpl ? h.downloadImpl() : new Promise<{ version: string }>(() => { /* pending */ });
        },
        set: async (r: unknown) => { h.setCalls.push(r); },
    },
}));

import { UpdateGate } from '../components/UpdateGate';

const BASE = 'https://chat.example.com';
const BUNDLE = 'https://download.example.com/mobile/puca-web-99.0.0.enc.zip';
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

const appShown = () => !!container.querySelector('[data-testid="app"]');

beforeEach(() => {
    vi.useFakeTimers();
    h.rc = true;
    h.current = { bundle: { id: 'builtin', version: 'builtin' }, native: '0.9.815' };
    h.notifyCalls = 0;
    h.downloadCalls = [];
    h.downloadImpl = null;
    h.setCalls = [];
    fetched = [];
    (window as unknown as Record<string, unknown>).Capacitor = { isNativePlatform: () => true };
    vi.stubEnv('VITE_API_URL', BASE);
    vi.stubEnv('VITE_UPDATE_FALLBACK_API', '');
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

describe('Púca full build', () => {
    it('asks the plain endpoint, blesses the bundle, and hands a signed newer manifest to the plugin verbatim', async () => {
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(fetched).toEqual([`${BASE}/api/mobile-updates/check`]);
        expect(h.notifyCalls, 'notifyAppReady runs on the check path too').toBeGreaterThanOrEqual(1);
        expect(h.downloadCalls).toEqual([{ url: BUNDLE, version: '99.0.0', ...SIGNED }]);
        expect(container.textContent).toContain('Updating to v99.0.0');
    });

    it('an untagged manifest is a full one (every pre-lite manifest omits the field)', async () => {
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(1);
    });

    it.each(['lite', 'notes', 'Full', ''])('refuses a manifest tagged %j', async (variant) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(0);
        expect(appShown()).toBe(true);
        expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes('Refusing a'))).toBe(true);
    });

    it('a manifest tagged "full" is accepted', async () => {
        serve({ version: '99.0.0', url: BUNDLE, variant: 'full', ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(1);
    });
});

describe('Púca lite build', () => {
    beforeEach(() => { h.rc = false; });

    it('asks ?variant=lite and applies only a manifest tagged lite', async () => {
        serve({ version: '99.0.0', url: BUNDLE, variant: 'lite', ...SIGNED });
        await mountGate();
        await advance(100);
        expect(fetched).toEqual([`${BASE}/api/mobile-updates/check?variant=lite`]);
        expect(h.downloadCalls).toHaveLength(1);
    });

    it.each([undefined, 'full', 'notes'])('refuses a manifest tagged %j (an old server answers ?variant=lite with the full one)', async (variant) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve({ version: '99.0.0', url: BUNDLE, variant, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(0);
        expect(appShown()).toBe(true);
    });
});

describe('anti-rollback against the running bytes', () => {
    it('the APK builtin bundle accepts the SAME version', async () => {
        serve({ version: __APP_VERSION__, url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(1);
    });

    it('an OTA bundle refuses the same version', async () => {
        h.current = { bundle: { id: 'abc123', version: __APP_VERSION__ } };
        serve({ version: __APP_VERSION__, url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(0);
        expect(appShown()).toBe(true);
    });

    it('an older version is refused even on the builtin bundle', async () => {
        serve({ version: '0.0.1', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(0);
        expect(appShown()).toBe(true);
    });

    it('a mislabelled running bundle is reported, and compared by its bytes', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        h.current = { bundle: { id: 'abc123', version: '98.0.0' } };
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(err.mock.calls.map(c => String(c[0])).some(m => m.includes('MISLABELLED OTA'))).toBe(true);
        expect(h.downloadCalls, 'still newer than the real bytes, so it applies').toHaveLength(1);
    });
});

describe('the manifest must be complete', () => {
    it.each([
        ['no url', { version: '99.0.0', ...SIGNED }],
        ['no version', { url: BUNDLE, ...SIGNED }],
        ['no sessionKey', { version: '99.0.0', url: BUNDLE, checksum: 'x' }],
        ['no checksum', { version: '99.0.0', url: BUNDLE, sessionKey: 'x' }],
        ['http bundle', { version: '99.0.0', url: 'http://download.example.com/b.zip', ...SIGNED }],
    ])('%s: nothing downloads, the app runs', async (_name, body) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        serve(body);
        await mountGate();
        await advance(100);
        expect(h.downloadCalls).toHaveLength(0);
        expect(appShown()).toBe(true);
    });

    it('a 204 is a final "nothing published"', async () => {
        serve(undefined, 204);
        await mountGate();
        await advance(100);
        expect(fetched).toHaveLength(1);
        expect(appShown()).toBe(true);
    });
});

describe('apply and failure', () => {
    it('a finished download is set() and says Restarting', async () => {
        h.downloadImpl = () => Promise.resolve({ version: '99.0.0' });
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.setCalls).toEqual([{ version: '99.0.0' }]);
        expect(container.textContent).toContain('Restarting with v99.0.0');
    });

    it('a download that resolves without a version is not set()', async () => {
        h.downloadImpl = () => Promise.resolve({} as { version: string });
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(h.setCalls).toHaveLength(0);
        expect(appShown()).toBe(true);
    });

    it('a failed verification names Púca and the key, and Continue Anyway runs the app', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.downloadImpl = () => Promise.reject(new Error('checksum verification failed'));
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        expect(container.textContent).toContain('Update Check Failed');
        expect(container.textContent).toContain('Púca only applies updates signed with the key built into this app');
        const cont = [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue Anyway')!;
        await act(async () => { cont.click(); });
        expect(appShown()).toBe(true);
    });

    it('Retry runs the check again', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.downloadImpl = () => Promise.reject(new Error('boom'));
        serve({ version: '99.0.0', url: BUNDLE, ...SIGNED });
        await mountGate();
        await advance(100);
        const retry = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')!;
        await act(async () => { retry.click(); });
        await advance(100);
        expect(fetched).toHaveLength(2);
        expect(h.downloadCalls).toHaveLength(2);
    });
});
