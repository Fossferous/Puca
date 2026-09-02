/**
 * Desktop update check: the fallback base is consulted when the configured
 * base answers WRONGLY, not only when it is unreachable.
 *
 * `checkForNewVersion` used to return on ANY non-2xx from the first base
 * ("reached a server; 404 = nothing published"), which also swallowed a
 * proxy's 502, an origin lock's 403, and — in the mis-build the fallback
 * exists for — whatever answers on localhost:3000. Only 404 and 204 are
 * "nothing published"; everything else advances to the next base.
 *
 * The first case FAILS against the pre-fix code (it returned null after the
 * 502); the 404 case is the positive control that a definitive answer is
 * still final and does not cost a second round-trip on every check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PRIMARY = 'https://misbuilt.example.com';
const FALLBACK = 'https://chat.example.com';

vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false, RC_ENABLED: true }));
// Literal, not PRIMARY: vi.mock factories are hoisted above the const.
vi.mock('../api/config', () => ({ API_BASE_URL: 'https://misbuilt.example.com', WS_URL: 'wss://misbuilt.example.com/ws' }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.9.0' }));

import { checkForNewVersion } from '../api/appVersion';

function response(status: number, body?: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function routedFetch(routes: Record<string, () => Promise<Response>>, calls: string[]): typeof fetch {
    return ((url: string) => {
        calls.push(String(url));
        for (const [prefix, answer] of Object.entries(routes)) {
            if (String(url).startsWith(prefix)) return answer();
        }
        return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;
}

const NEWER = { version: '99.0.0', download_url: 'https://download.example.com/' };

beforeEach(() => {
    vi.stubEnv('VITE_UPDATE_FALLBACK_API', FALLBACK);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('checkForNewVersion and the fallback base', () => {
    it('a 502 from the configured base advances to the fallback, which answers the release', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', routedFetch({
            [PRIMARY]: () => Promise.resolve(response(502)),
            [FALLBACK]: () => Promise.resolve(response(200, NEWER)),
        }, calls));

        const info = await checkForNewVersion();

        expect(calls).toEqual([`${PRIMARY}/app-version`, `${FALLBACK}/app-version`]);
        expect(info?.version, 'the fallback answer must be returned').toBe('99.0.0');
    });

    it('positive control: a 404 from the configured base is final — the fallback is NOT consulted', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', routedFetch({
            [PRIMARY]: () => Promise.resolve(response(404)),
            [FALLBACK]: () => Promise.resolve(response(200, NEWER)),
        }, calls));

        const info = await checkForNewVersion();

        expect(info).toBeNull();
        expect(calls, '"nothing published" must not become a second round-trip on every check').toHaveLength(1);
    });

    it('an unreachable configured base still advances to the fallback (the pre-existing behaviour survives)', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', routedFetch({
            [FALLBACK]: () => Promise.resolve(response(200, NEWER)),
        }, calls));

        const info = await checkForNewVersion();

        expect(calls).toHaveLength(2);
        expect(info?.version).toBe('99.0.0');
    });
});
