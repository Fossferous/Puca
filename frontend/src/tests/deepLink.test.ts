/**
 * `puca://` invite links, the webview's half (api/deepLink.ts): the parser,
 * the "is this our server?" check, and how a link from the desktop shell —
 * the warm-start event or the cold-start link taken at boot — becomes a
 * pending invite and never anything more.
 *
 * The parser must agree with the shell's (src-tauri/src/deep_link.rs) about
 * EVERY link, so both suites assert one table (fixtures/deep-link-cases.json).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const h = vi.hoisted(() => ({
    tauri: false,
    appUrl: null as string | null,
    configCalls: 0,
    listeners: new Map<string, (e: { payload: unknown }) => void>(),
    takes: [] as unknown[],
    takeCalls: 0,
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
    isMobile: () => false,
}));
vi.mock('../api/publicConfig', () => ({
    fetchPublicConfig: async () => {
        h.configCalls += 1;
        return { appUrl: h.appUrl, registrationInviteRequired: null, srpVersion: null };
    },
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
        h.listeners.set(event, cb);
        return () => { h.listeners.delete(event); };
    },
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string) => {
        if (cmd !== 'deep_link_take') throw new Error(`unexpected command ${cmd}`);
        h.takeCalls += 1;
        return h.takes.length ? h.takes.shift() : null;
    },
}));

const {
    parseDeepLink, appInviteLink, isPlainHostname, handleDeepLink, installDeepLinks, isThisServerHost,
    getDeepLinkNotice, subscribeDeepLinkNotice, dismissDeepLinkNotice, DEEP_LINK_EVENT, __resetDeepLinksForTest,
} = await import('../api/deepLink');
const { peekPendingInvite, onPendingInviteAnnounced, consumePendingInvite } = await import('../api/pendingInvite');
const { API_BASE_URL } = await import('../api/config');

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'deep-link-cases.json'), 'utf8')) as {
    cases: { url: string; canonical: string | null }[];
};
/** What the shell's to_url() builds from a parsed link. */
const canonical = (raw: string) => {
    const l = parseDeepLink(raw);
    return l ? `puca://invite/${l.code}${l.host ? `?host=${l.host}` : ''}` : null;
};
/** This build's API host: the one a link may name without GET /config. */
const API_HOST = new URL(API_BASE_URL).hostname;
const settle = () => new Promise(r => setTimeout(r, 0));

let announced = 0;
let stopHearing: () => void = () => {};
beforeEach(() => {
    __resetDeepLinksForTest();
    sessionStorage.clear();
    h.tauri = false;
    h.appUrl = null;
    h.configCalls = 0;
    h.listeners.clear();
    h.takes = [];
    h.takeCalls = 0;
    announced = 0;
    stopHearing = onPendingInviteAnnounced(() => { announced += 1; });
});
afterEach(() => { stopHearing(); vi.restoreAllMocks(); });

describe('parseDeepLink: the same verdict as the desktop shell', () => {
    it('agrees with every case in the shared table', () => {
        expect(TABLE.cases.length).toBeGreaterThanOrEqual(20);
        for (const c of TABLE.cases) expect(canonical(c.url), c.url).toBe(c.canonical);
        // Both verdicts exercised, or a parser refusing everything would pass.
        expect(TABLE.cases.filter(c => c.canonical !== null).length).toBeGreaterThanOrEqual(3);
        expect(TABLE.cases.filter(c => c.canonical === null).length).toBeGreaterThanOrEqual(10);
    });

    it('keeps the code exactly and lowercases the host', () => {
        expect(parseDeepLink('PUCA://Invite/aBc123Xy?host=App.Example.COM')).toEqual({ code: 'aBc123Xy', host: 'app.example.com' });
        expect(parseDeepLink('puca://invite/aBc123Xy')).toEqual({ code: 'aBc123Xy', host: null });
    });

    it('refuses anything that is not a string, and very long input', () => {
        for (const v of [null, undefined, 42, {}, ['puca://invite/abcd'], { url: 'puca://invite/abcd' }]) {
            expect(parseDeepLink(v)).toBeNull();
        }
        expect(parseDeepLink(`puca://invite/abcd1234?host=${'a.'.repeat(50_000)}com`)).toBeNull();
        expect(parseDeepLink(`puca://invite/abcd1234?host=${'a'.repeat(600)}`)).toBeNull();
    });

    it('a look-alike letter is not an ASCII one', () => {
        expect(parseDeepLink('puca://İnvite/abcd1234')).toBeNull();   // İ
        expect(parseDeepLink('puca://ınvite/abcd1234')).toBeNull();   // ı
        expect(parseDeepLink('pucа://invite/abcd1234')).toBeNull();   // Cyrillic а
    });
});

describe('appInviteLink: what the web invite page offers', () => {
    it('builds the link for a code and a plain host', () => {
        expect(appInviteLink('aBc123Xy', 'app.example.com')).toBe('puca://invite/aBc123Xy?host=app.example.com');
    });

    it('offers nothing it would itself refuse', () => {
        expect(appInviteLink('aBc123Xy', '[::1]')).toBeNull();
        expect(appInviteLink('aBc123Xy', 'app.example.com:8443')).toBeNull();
        expect(appInviteLink('abc', 'app.example.com')).toBeNull();
        expect(isPlainHostname('localhost')).toBe(true);
        expect(isPlainHostname('')).toBe(false);
    });
});

describe('isThisServerHost', () => {
    it('the API host is this server', async () => {
        expect(await isThisServerHost(API_HOST)).toBe(true);
        expect(await isThisServerHost(API_HOST.toUpperCase())).toBe(true);
    });

    it('the web app address from GET /config is this server', async () => {
        h.appUrl = 'https://app.example.com';
        expect(await isThisServerHost('app.example.com')).toBe(true);
    });

    it('anything else is not — including when /config cannot say', async () => {
        h.appUrl = 'https://app.example.com';
        expect(await isThisServerHost('other.example.com')).toBe(false);
        h.appUrl = null;
        expect(await isThisServerHost('app.example.com')).toBe(false);
    });
});

describe('handleDeepLink: a link becomes a pending invite, never more', () => {
    it('a valid link for this server: stashed and announced for Chat', async () => {
        await handleDeepLink(`puca://invite/aBc123Xy?host=${API_HOST}`);
        expect(peekPendingInvite()).toBe('aBc123Xy');
        expect(announced).toBe(1);
        expect(getDeepLinkNotice()).toBeNull();
    });

    it('a link naming no host: stashed (a hand-made link, looked up on this server)', async () => {
        await handleDeepLink('puca://invite/aBc123Xy');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('a link for ANOTHER server: nothing stashed, and the notice names that server', async () => {
        h.appUrl = 'https://app.example.com';
        const seen: unknown[] = [];
        const stop = subscribeDeepLinkNotice(() => seen.push(getDeepLinkNotice()));
        await handleDeepLink('puca://invite/aBc123Xy?host=other.example.com');
        stop();
        expect(peekPendingInvite()).toBeNull();
        expect(announced).toBe(0);
        expect(getDeepLinkNotice()).toEqual({ host: 'other.example.com' });
        expect(seen).toEqual([{ host: 'other.example.com' }]);
        dismissDeepLinkNotice();
        expect(getDeepLinkNotice()).toBeNull();
    });

    it('a refused link: nothing stashed, no notice, and its text is not logged', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const bad of ['puca://invite/abc', 'javascript:alert(1)', 'puca://settings', 'https://app.example.com/invite/abcd1234', 17]) {
            await handleDeepLink(bad);
        }
        expect(peekPendingInvite()).toBeNull();
        expect(announced).toBe(0);
        expect(getDeepLinkNotice()).toBeNull();
        expect(warn).toHaveBeenCalledTimes(5);
        for (const call of warn.mock.calls) {
            expect(call.join(' ')).not.toMatch(/javascript|settings|abcd1234|example/);
        }
    });

    it('links are handled in the order they arrived, even when the first waits on /config', async () => {
        h.appUrl = 'https://app.example.com';
        const order: string[] = [];
        const stop = onPendingInviteAnnounced(() => { order.push(consumePendingInvite() ?? '?'); });
        // The first needs GET /config (a web host), the second does not.
        const a = handleDeepLink('puca://invite/first111?host=app.example.com');
        const b = handleDeepLink('puca://invite/second22');
        await Promise.all([a, b]);
        stop();
        expect(order).toEqual(['first111', 'second22']);
    });

    it('a later good link clears an earlier "another server" notice', async () => {
        await handleDeepLink('puca://invite/aBc123Xy?host=other.example.com');
        expect(getDeepLinkNotice()).not.toBeNull();
        await handleDeepLink('puca://invite/aBc123Xy');
        expect(getDeepLinkNotice()).toBeNull();
    });
});

describe('installDeepLinks: the desktop shell\'s two roads in', () => {
    it('outside the desktop app it does nothing at all', async () => {
        installDeepLinks();
        await settle();
        expect(h.listeners.size).toBe(0);
        expect(h.takeCalls).toBe(0);
    });

    it('COLD start: the link this launch carried is taken once and stashed', async () => {
        h.tauri = true;
        h.takes = ['puca://invite/cold1234'];
        installDeepLinks();
        await vi.waitFor(() => expect(peekPendingInvite()).toBe('cold1234'));
        expect(h.takeCalls).toBe(1);
        expect(h.listeners.has(DEEP_LINK_EVENT)).toBe(true);
    });

    it('WARM start: the event\'s link is stashed, and the parked copy is emptied', async () => {
        h.tauri = true;
        installDeepLinks();
        await vi.waitFor(() => expect(h.listeners.has(DEEP_LINK_EVENT)).toBe(true));
        await vi.waitFor(() => expect(h.takeCalls).toBe(1)); // the boot take: nothing waiting
        h.listeners.get(DEEP_LINK_EVENT)!({ payload: 'puca://invite/warm1234' });
        await vi.waitFor(() => expect(peekPendingInvite()).toBe('warm1234'));
        expect(announced).toBe(1);
        await vi.waitFor(() => expect(h.takeCalls).toBe(2));
    });

    it('WARM start with a refused payload: nothing', async () => {
        h.tauri = true;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        installDeepLinks();
        await vi.waitFor(() => expect(h.listeners.has(DEEP_LINK_EVENT)).toBe(true));
        h.listeners.get(DEEP_LINK_EVENT)!({ payload: 'puca://invite/../../etc' });
        h.listeners.get(DEEP_LINK_EVENT)!({ payload: { code: 'abcd1234' } });
        await settle();
        await settle();
        expect(peekPendingInvite()).toBeNull();
        expect(announced).toBe(0);
    });

    it('installs once: a second call adds no second listener', async () => {
        h.tauri = true;
        installDeepLinks();
        installDeepLinks();
        await vi.waitFor(() => expect(h.takeCalls).toBe(1));
        await settle();
        expect(h.takeCalls).toBe(1);
    });
});
