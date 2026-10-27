/**
 * The plugin's own updates through the real controller (src/controller.ts),
 * with Decky, Steam and the backend stood in for: what Update installs when
 * the panel's offer is days old, and when the plugin looks again.
 *
 * The owner's Deck (October 2026) slept for days after its last look had
 * offered 0.3.0. 0.4.0 came out meanwhile, and Update said "the download site
 * no longer offers that version": it insisted on the version the panel
 * showed, and the panel had not looked again, because a timer's clock stops
 * while the Deck sleeps.
 *
 * The backend here answers as main.py does (tests/test_update.py,
 * DownloadTests, checks main.py itself); signatures are real, made with the
 * release script's own signer.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNewer, UPDATE_EVERY_MS, UPDATE_FIRST_CHECK_MS, UPDATE_STALE_MS, UPDATE_TICK_MS, UpdateClock } from '../src/update';
import { publicJwk, signRelease } from '../scripts/signing.mjs';

type Handler = (payload: unknown) => void;
type Route = (...args: unknown[]) => unknown;

const deck = vi.hoisted(() => ({
    handlers: new Map<string, (payload: unknown) => void>(),
    routes: {} as Record<string, (...args: unknown[]) => unknown>,
    calls: [] as { route: string; args: unknown[] }[],
}));

vi.mock('@decky/api', () => ({
    call: async (route: string, ...args: unknown[]) => {
        deck.calls.push({ route, args });
        return deck.routes[route]?.(...args) ?? null;
    },
    addEventListener: (event: string, fn: Handler) => { deck.handlers.set(event, fn); },
    removeEventListener: (event: string) => { deck.handlers.delete(event); },
    toaster: { toast: () => ({ dismiss() {} }) },
}));
vi.mock('@decky/ui', () => ({ Navigation: { Navigate() {}, CloseSideMenus() {} }, Router: {} }));
vi.mock('react', () => ({ createElement: () => null }));
vi.mock('../src/browserView', () => ({
    PucaBrowserView: class {
        create() { return true; }
        destroy() {}
        show() {}
        hide() {}
        activate() {}
    },
}));
vi.mock('../src/components/icons', () => ({ PucaIcon: () => null }));

const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const RELEASE = pem();
const STRANGER = pem();
const KEY = publicJwk(RELEASE);
const INSTALLED = '0.2.0';
const SITE = 'https://download.example.com';
const UPDATES = '/home/deck/homebrew/data/puca/updates';
const zipOf = (version: string) => Buffer.from(`the bytes of puca-decky-${version}.zip`);
/** A release as `npm run release` makes its manifest. */
const signed = (version: string, key = RELEASE) => signRelease(zipOf(version), `puca-decky-${version}.zip`, version, key);
type Manifest = ReturnType<typeof signed>;

/** What the download site publishes right now. */
let published: Manifest | null = null;
/** What Decky's installer was asked for. */
let installs: unknown[][] = [];

/** main.py's download_update: what the site offers now, if it is newer than this version. */
const downloadAsMainPyDoes: Route = () => {
    const offer = published;
    if (!offer || !isNewer(offer.version, INSTALLED)) return { ok: true, value: { current: INSTALLED, offer, path: null } };
    return { ok: true, value: { current: INSTALLED, offer, path: `${UPDATES}/${offer.file}` } };
};

let controller: (typeof import('../src/controller'))['controller'];
/** When the plugin started: it reads the wall clock every UPDATE_TICK_MS from then. */
const STARTED = Date.parse('2026-10-20T18:00:00Z');
const untilNextReading = () => UPDATE_TICK_MS - ((Date.now() - STARTED) % UPDATE_TICK_MS);

const looks = () => deck.calls.filter(c => c.route === 'check_update').length;
const shownVersion = () => controller.getSnapshot().update?.version ?? null;
/** The panel comes to offer `version`. A look checks a real signature, which
 *  WebCrypto answers off the main thread: wait in real time, with room for a
 *  busy machine. */
const shows = (version: string) => vi.waitFor(() => expect(shownVersion()).toBe(version), { timeout: 10_000 });
/** Real turns of the event loop, for a look that should NOT have started. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

beforeEach(async () => {
    // setImmediate stays real: settle() needs it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(STARTED);
    deck.handlers.clear();
    deck.calls = [];
    published = signed('0.3.0');
    installs = [];
    deck.routes = {
        get_settings: () => ({ appUrl: 'https://chat.example.com/' }),
        plugin_version: () => INSTALLED,
        attach: () => ({ ok: true, value: null }),
        page_call: (method: unknown) => {
            if (method === 'getState') {
                return { ok: true, value: { apiVersion: 1, appVersion: '0.9.851', signedIn: true, user: { id: 1, username: 'deck' }, servers: [], call: null } };
            }
            if (method === 'downloadSite') return { ok: true, value: SITE };
            return { ok: true, value: null };
        },
        check_update: () => ({ ok: true, value: { current: INSTALLED, key: KEY, offer: published } }),
        download_update: downloadAsMainPyDoes,
    };
    vi.stubGlobal('window', {
        DeckyBackend: { call: async (...args: unknown[]) => { installs.push(args); return null; } },
    });
    vi.resetModules();
    controller = (await import('../src/controller')).controller;
    // The plugin starts, Púca comes up, and the first look follows.
    await controller.start();
    deck.handlers.get('puca_page')!({ type: 'ready', apiVersion: 1, appVersion: '0.9.851' });
    await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS);
    await shows('0.3.0');
    expect(looks()).toBe(1);
});

afterEach(() => {
    controller.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Update installs what the download site offers when it is pressed', () => {
    it('the newest, though the panel still offers an older one', async () => {
        // 0.4.1 replaces 0.3.0 on the site; the panel has not looked since.
        published = signed('0.4.1');
        await controller.installUpdate();
        expect(installs).toEqual([
            ['utilities/install_plugin', `file://${UPDATES}/puca-decky-0.4.1.zip`, 'Púca', '0.4.1', published.sha256, 2],
        ]);
        // The panel names the version being installed, not the one it offered.
        expect(controller.getSnapshot().update).toEqual({ version: '0.4.1', busy: false, error: null });
        // POSITIVE CONTROL: the backend was asked by the site, not for 0.4.1 by name.
        expect(deck.calls.find(c => c.route === 'download_update')?.args).toEqual([SITE, '0.3.0']);
    });

    it('never one the release key did not sign', async () => {
        const genuine = signed('0.4.1');
        const forgeries: [string, Manifest][] = [
            ['signed with another key', signed('0.4.1', STRANGER)],
            ['with no real signature', { ...genuine, signature: 'AAAA' }],
            ["with 0.3.0's genuine signature", { ...genuine, signature: signed('0.3.0').signature }],
            ['with the signed version but other bytes', { ...genuine, sha256: createHash('sha256').update('other bytes').digest('hex') }],
        ];
        for (const [what, forged] of forgeries) {
            published = forged;
            await controller.installUpdate();
            expect(installs, what).toEqual([]);
            expect(controller.getSnapshot().update, what).toMatchObject({ busy: false, error: expect.stringContaining('not signed') });
        }
        // POSITIVE CONTROL: the genuine one, through the same steps.
        published = genuine;
        await controller.installUpdate();
        expect(installs.map(a => a[3])).toEqual(['0.4.1']);
    });

    it.each([
        ['the version installed', INSTALLED, false],
        ['an older one', '0.1.0', false],
        ['the version installed, downloaded anyway', INSTALLED, true],
        ['an older one, downloaded anyway', '0.1.0', true],
    ])('never %s: the panel says it is up to date instead', async (_, version, anyway) => {
        // The site went back (a release withdrawn) after the panel offered 0.3.0.
        published = signed(version);
        if (anyway) {
            // A backend that downloaded it regardless: the frontend checks too.
            deck.routes.download_update = () => ({ ok: true, value: { current: INSTALLED, offer: published, path: `${UPDATES}/${published!.file}` } });
        }
        await controller.installUpdate();
        expect(installs).toEqual([]);
        expect(controller.getSnapshot().update, 'no Update section').toBeNull();
        expect(controller.getSnapshot().upToDate).toBe(INSTALLED);
        // Closing the menu puts the note away.
        controller.panelShown(false);
        expect(controller.getSnapshot().upToDate).toBeNull();
    });
});

describe('the panel looks again when its offer may be stale', () => {
    it('when the menu opens and the last answer is more than ten minutes old', async () => {
        published = signed('0.4.1');
        await vi.advanceTimersByTimeAsync(UPDATE_STALE_MS - 60_000);
        controller.panelShown(true);
        await settle();
        expect(looks(), 'nine minutes on: fresh enough').toBe(1);
        controller.panelShown(false);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        controller.panelShown(true);
        await shows('0.4.1');
        expect(looks()).toBe(2);
    });

    it('after the Deck wakes: the wall clock jumped between two readings', async () => {
        // An hour awake reads the clock every minute, and looks at nothing.
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(looks()).toBe(1);
        // Three days asleep: the wall clock moves, the timers' clock does not.
        published = signed('0.4.1');
        vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60_000);
        await vi.advanceTimersByTimeAsync(untilNextReading());
        expect(looks(), 'the reading after the sleep gives the Wi-Fi a moment first').toBe(1);
        await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_MS);
        await shows('0.4.1');
        expect(looks()).toBe(2);
    });

    it('and otherwise every six hours, one look each', async () => {
        await vi.advanceTimersByTimeAsync(UPDATE_EVERY_MS - UPDATE_FIRST_CHECK_MS - UPDATE_TICK_MS);
        expect(looks()).toBe(1);
        published = signed('0.4.1');
        await vi.advanceTimersByTimeAsync(2 * UPDATE_TICK_MS);
        await shows('0.4.1');
        expect(looks()).toBe(2);
        await vi.advanceTimersByTimeAsync(UPDATE_EVERY_MS - 2 * UPDATE_TICK_MS);
        expect(looks()).toBe(2);
    });

    it('a menu opened again and again looks once', async () => {
        await vi.advanceTimersByTimeAsync(UPDATE_STALE_MS + 60_000);
        for (let i = 0; i < 5; i++) {
            controller.panelShown(true);
            controller.panelShown(false);
        }
        await settle();
        expect(looks()).toBe(2);
    });
});

describe('when to look, on the wall clock (UpdateClock)', () => {
    const t0 = Date.parse('2026-10-20T18:00:00Z');
    const looked = () => {
        const c = new UpdateClock();
        c.tick(t0);
        c.tried(t0);
        c.answered(t0);
        return c;
    };

    it('a nap right after a look is no reason for another', () => {
        const c = looked();
        expect(c.tick(t0 + 5 * 60_000)).toBeNull();
        // POSITIVE CONTROL: the same nap once the answer is stale.
        expect(c.tick(t0 + 15 * 60_000)).toBe('woke');
    });

    it('a clock set back counts as a jump', () => {
        const c = looked();
        expect(c.tick(t0 - 60 * 60_000)).toBe('woke');
    });

    it('the clock asks for nothing before the first look, which is the start\'s; an opened panel may', () => {
        const c = new UpdateClock();
        c.tick(t0);
        expect(c.tick(t0 + 3 * 24 * 60 * 60_000)).toBeNull();
        expect(c.panelOpened(t0)).toBe(true);
    });
});

describe('the panel tells the controller when the menu opens and closes', () => {
    it('QuickAccess hands useQuickAccessVisible to controller.panelShown, and closes on leaving', () => {
        const src = readFileSync(new URL('../src/components/QuickAccess.tsx', import.meta.url), 'utf8');
        const body = src.slice(src.indexOf('export function QuickAccess()'), src.indexOf('function Update('));
        expect(body).toContain('const shown = useQuickAccessVisible();');
        expect(body).toMatch(/useEffect\(\(\) => \{\s*controller\.panelShown\(shown\);\s*return \(\) => controller\.panelShown\(false\);\s*\}, \[shown\]\);/);
    });
});
