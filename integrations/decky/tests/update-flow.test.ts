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

// Above the waits below (10 s, for signature checks on a busy machine), so a
// failing wait reports what it waited for instead of a timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
// Steam's components as plain names, and React as far as the panel needs it to
// be called as a function: the Update section is rendered by calling it.
vi.mock('@decky/ui', () => ({
    Navigation: { Navigate() {}, CloseSideMenus() {} }, Router: {},
    ButtonItem: 'ButtonItem', DialogButton: 'DialogButton', DropdownItem: 'DropdownItem', Field: 'Field',
    Focusable: 'Focusable', PanelSection: 'PanelSection', PanelSectionRow: 'PanelSectionRow',
    SteamSpinner: 'SteamSpinner', TextField: 'TextField', ToggleField: 'ToggleField',
    useQuickAccessVisible: () => true,
}));
vi.mock('react', () => ({
    createElement: () => null,
    Fragment: (p: { children?: unknown }) => p.children ?? null,
    useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useRef: (v: unknown) => ({ current: v }),
}));
vi.mock('react/jsx-runtime', () => ({
    jsx: (type: unknown, props: unknown) => ({ type, props }),
    jsxs: (type: unknown, props: unknown) => ({ type, props }),
    Fragment: (p: { children?: unknown }) => p.children ?? null,
}));
vi.mock('react/jsx-dev-runtime', () => ({
    jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
    Fragment: (p: { children?: unknown }) => p.children ?? null,
}));
vi.mock('../src/browserView', () => ({
    PucaBrowserView: class {
        create() { return true; }
        destroy() {}
        show() {}
        hide() {}
        activate() {}
    },
}));
vi.mock('../src/components/icons', () => ({
    PucaIcon: () => null, PucaGlyph: () => null, MicIcon: () => null, MicOffIcon: () => null, NoMicIcon: () => null,
    HeadphonesIcon: () => null, HeadphonesOffIcon: () => null, LeaveIcon: () => null, SpeakingDot: () => null,
}));

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
/** The look in flight, if any, has finished: for one whose answer must change nothing. */
const lookDone = () => vi.waitFor(
    () => expect((controller as unknown as { updateLooking: boolean }).updateLooking).toBe(false), { timeout: 10_000 },
);
/** An answer from the backend that the test hands over when it chooses. */
function later<T>() {
    let give!: (value: T) => void;
    const answer = new Promise<T>(resolve => { give = resolve; });
    return { answer, give };
}
const STATE = { apiVersion: 1, appVersion: '0.9.851', signedIn: true, user: { id: 1, username: 'deck' }, servers: [], call: null };
const IN_A_CALL = { ...STATE, call: { serverId: 's1', channelId: 42, channelName: 'Lounge', connected: true, members: [] } };

/** Text the panel shows: function components called, every label, title, description and child collected. */
function texts(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { node.forEach(n => texts(n, out)); return out; }
    const el = node as { type: unknown; props?: Record<string, unknown> };
    if (typeof el.type === 'function') return texts((el.type as (p: unknown) => unknown)(el.props ?? {}), out);
    for (const k of ['title', 'label', 'description', 'children']) texts(el.props?.[k], out);
    return out;
}

/** The Update section of the Quick Access panel as it is rendered now. */
async function updateSection(): Promise<string[]> {
    const { QuickAccess } = await import('../src/components/QuickAccess');
    const sections = (QuickAccess() as unknown as { props: { children: { type: { name?: string } }[] } }).props.children;
    expect(sections[0].type.name, 'the Update section comes first').toBe('Update');
    return texts(sections[0]);
}

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
            if (method === 'getState') return { ok: true, value: STATE };
            if (method === 'downloadSite') return { ok: true, value: SITE };
            return { ok: true, value: null };
        },
        // What a call asks of the backend (the controls, the Deck's microphone).
        watch_input: () => ({ ok: true, value: null }),
        mic_for_call: () => ({ ok: true, value: { changed: false } }),
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

    it('never a download whose offer cannot be read, and that is no "up to date" either', async () => {
        deck.routes.download_update = () => ({ ok: true, value: { current: INSTALLED, offer: { version: '0.4.1' }, path: `${UPDATES}/x.zip` } });
        await controller.installUpdate();
        expect(installs).toEqual([]);
        expect(controller.getSnapshot().upToDate).toBeNull();
        expect(controller.getSnapshot().update).toMatchObject({ busy: false, error: expect.stringContaining('could not be read') });
    });

    it('never a download that names no file', async () => {
        published = signed('0.4.1');
        deck.routes.download_update = () => ({ ok: true, value: { current: INSTALLED, offer: published, path: 42 } });
        await controller.installUpdate();
        expect(installs).toEqual([]);
        expect(controller.getSnapshot().update).toMatchObject({ busy: false, error: expect.stringContaining('could not be downloaded') });
    });

    it('never during a call, though the call started while the update downloaded', async () => {
        published = signed('0.4.1');
        const download = later<unknown>();
        deck.routes.download_update = () => download.answer;
        const pressed = controller.installUpdate();
        await settle();
        deck.handlers.get('puca_page')!({ type: 'state', state: IN_A_CALL });
        expect(controller.getSnapshot().state?.call, 'in a call now').toBeTruthy();
        download.give(downloadAsMainPyDoes());
        await pressed;
        // Decky's prompt would have come up in the call, and confirming it restarts Púca.
        expect(installs).toEqual([]);
        expect(controller.getSnapshot().update).toEqual({ version: '0.4.1', busy: false, error: 'Leave the call first: updating restarts Púca.' });
    });
});

describe('a press of Update and a look at the same time', () => {
    beforeEach(async () => {
        // The last answer is stale: opening the menu looks again.
        await vi.advanceTimersByTimeAsync(UPDATE_STALE_MS + 60_000);
    });

    it('a slow look that read the site before a press does not undo its "up to date"', async () => {
        const site = later<unknown>();
        deck.routes.check_update = () => site.answer;
        controller.panelShown(true);
        await settle();
        expect(looks()).toBe(2);
        // The site goes back to the version installed, and a press reads that.
        published = signed(INSTALLED);
        await controller.installUpdate();
        expect(controller.getSnapshot()).toMatchObject({ update: null, upToDate: INSTALLED });
        // The look's answer lands only now: what the site offered before, 0.4.2.
        site.give({ ok: true, value: { current: INSTALLED, key: KEY, offer: signed('0.4.2') } });
        await lookDone();
        expect(controller.getSnapshot()).toMatchObject({ update: null, upToDate: INSTALLED });
    });

    it('nor does its "nothing newer" take Update away while Decky asks', async () => {
        const site = later<unknown>();
        deck.routes.check_update = () => site.answer;
        controller.panelShown(true);
        await settle();
        published = signed('0.4.1');
        await controller.installUpdate();
        expect(installs.map(a => a[3]), "Decky's prompt is up").toEqual(['0.4.1']);
        // The look read the site before 0.4.1 was on it.
        site.give({ ok: true, value: { current: INSTALLED, key: KEY, offer: signed(INSTALLED) } });
        await lookDone();
        // A cancelled prompt must find the button where it was.
        expect(controller.getSnapshot().update).toEqual({ version: '0.4.1', busy: false, error: null });
    });

    it('a look that lands while Update is under way leaves the panel to it', async () => {
        published = signed('0.4.1');
        const download = later<unknown>();
        deck.routes.download_update = () => download.answer;
        const pressed = controller.installUpdate();
        await settle();
        expect(controller.getSnapshot().update).toMatchObject({ busy: true });
        // The menu opens while it downloads: a look that starts after the press.
        controller.panelShown(true);
        await lookDone();
        expect(looks()).toBe(2);
        expect(controller.getSnapshot().update).toEqual({ version: '0.3.0', busy: true, error: null });
        download.give(downloadAsMainPyDoes());
        await pressed;
        expect(installs.map(a => a[3])).toEqual(['0.4.1']);
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

    it('and at most once a minute while the site does not answer, opened a few seconds apart', async () => {
        // No answer, so every opening finds the last one stale.
        deck.routes.check_update = () => ({ ok: false, error: 'could not reach the download site (ClientConnectorError)' });
        await vi.advanceTimersByTimeAsync(UPDATE_STALE_MS + 60_000);
        for (let i = 0; i < 5; i++) {
            controller.panelShown(true);
            await lookDone();
            controller.panelShown(false);
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(looks(), 'five openings in 50 seconds').toBe(2);
        await vi.advanceTimersByTimeAsync(10_000);
        controller.panelShown(true);
        await lookDone();
        expect(looks(), 'a minute after the last look').toBe(3);
    });

    it('a look that finds the site offering an unsigned version takes the older offer away too', async () => {
        // Update installs what the site offers now, so the 0.3.0 shown could not be had.
        published = signed('0.4.1', STRANGER);
        // The six-hour look (the reading after six hours since the last one).
        await vi.advanceTimersByTimeAsync(UPDATE_EVERY_MS + UPDATE_TICK_MS);
        await vi.waitFor(() => expect(controller.getSnapshot().update).toBeNull(), { timeout: 10_000 });
        expect(looks()).toBe(2);
    });

    it('a look that finds a signed offer again puts away what a failed press said', async () => {
        published = { ...signed('0.4.1'), signature: 'AAAA' };
        await controller.installUpdate();
        expect(controller.getSnapshot().update).toMatchObject({ version: '0.3.0', error: expect.stringContaining('not signed') });
        // The site goes back to the signed 0.3.0.
        published = signed('0.3.0');
        await vi.advanceTimersByTimeAsync(UPDATE_STALE_MS + 60_000);
        controller.panelShown(true);
        await vi.waitFor(() => expect(controller.getSnapshot().update).toEqual({ version: '0.3.0', busy: false, error: null }), { timeout: 10_000 });
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

    it('a clock set back behind the last look, though not behind the last reading, makes a look due', () => {
        const c = new UpdateClock();
        c.tick(t0);
        c.tried(t0 + 30_000);
        c.answered(t0 + 31_000);
        // Ten seconds after the last reading by the clock, but before the look:
        // six hours since it can no longer be measured.
        expect(c.tick(t0 + 10_000)).toBe('due');
        // POSITIVE CONTROL: a minute on, as the clock should go, nothing is due.
        const d = new UpdateClock();
        d.tick(t0);
        d.tried(t0 + 30_000);
        d.answered(t0 + 31_000);
        expect(d.tick(t0 + 60_000)).toBeNull();
    });

    it('the clock asks for nothing before the first look, which is the start\'s; an opened panel may', () => {
        const c = new UpdateClock();
        c.tick(t0);
        expect(c.tick(t0 + 3 * 24 * 60 * 60_000)).toBeNull();
        expect(c.panelOpened(t0)).toBe(true);
    });
});

describe('the Update section, rendered', () => {
    it('names what is available, and the button says only "Update"', async () => {
        const shown = await updateSection();
        expect(shown).toContain('Update available: Púca for Steam Deck 0.3.0');
        expect(shown.filter(t => t === 'Update'), 'the section title and the button').toHaveLength(2);
        expect(shown.some(t => /up to date/.test(t))).toBe(false);
    });

    it('says the plugin is up to date when Update found nothing newer, until the menu closes', async () => {
        published = signed(INSTALLED);
        await controller.installUpdate();
        expect(await updateSection()).toEqual([
            'Púca for Steam Deck is up to date',
            `You have ${INSTALLED}, and your Púca server offers nothing newer.`,
        ]);
        controller.panelShown(false);
        expect(await updateSection()).toEqual([]);
    });

    it('shows nothing during a call', async () => {
        deck.handlers.get('puca_page')!({ type: 'state', state: IN_A_CALL });
        expect(await updateSection()).toEqual([]);
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
