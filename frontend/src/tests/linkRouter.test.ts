/**
 * The link router (api/linkRouter.ts): what a click on a link does, per shell.
 *
 * The report that started it: an invite link to the server the desktop app
 * was signed in to did not open in the app. The desktop's old interceptor
 * handed every link to the system browser — invites included, so the person
 * landed on the web app in a browser tab — and Púca's Android app had no
 * interceptor at all, so a link in a message there did nothing.
 *
 * Driven through the REAL openExternalUrl, so "opens" means what the shell
 * would see: an `open_external` invoke on the desktop, a top-level
 * navigation on the phone, and on the web nothing but the anchor's own
 * default. A recorder at the window's bubble phase reads whether the default
 * was prevented (then prevents it, so jsdom navigates nowhere).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
    /** What GET /config answered; undefined = not arrived yet. */
    appUrl: 'https://app.example.com' as string | null | undefined,
    configFetches: 0,
}));

vi.mock('../api/platform', () => ({ isTauri: vi.fn(() => false), isMobile: vi.fn(() => false) }));
vi.mock('../api/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('../api/publicConfig', () => ({
    peekPublicConfig: () => (h.appUrl === undefined ? null : { appUrl: h.appUrl, registrationInviteRequired: null, srpVersion: null }),
    fetchPublicConfig: () => {
        h.configFetches++;
        return Promise.resolve({ appUrl: h.appUrl ?? null, registrationInviteRequired: null, srpVersion: null });
    },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args) }));

import { isMobile, isTauri } from '../api/platform';
import { navigateAway } from '../api/openExternal';
import { installLinkRouter, setInviteOpener, thisServerInviteCode } from '../api/linkRouter';
import { setMessageToastSink } from '../components/messageToastBus';

type Shell = 'desktop' | 'phone' | 'web';
const SHELLS: Shell[] = ['desktop', 'phone', 'web'];
function inShell(s: Shell) {
    vi.mocked(isTauri).mockReturnValue(s === 'desktop');
    vi.mocked(isMobile).mockReturnValue(s === 'phone');
}

let uninstall: () => void;
let unregister: () => void;
let invites: string[];
let go: ReturnType<typeof vi.spyOn>;
let winOpen: ReturnType<typeof vi.spyOn>;
/** defaultPrevented as the page's default action would see it, per click. */
let seen: boolean[];
const record = (e: Event) => { seen.push(e.defaultPrevented); e.preventDefault(); };

beforeEach(() => {
    h.invoke.mockReset();
    h.invoke.mockResolvedValue(null);
    h.appUrl = 'https://app.example.com';
    h.configFetches = 0;
    inShell('web');
    invites = [];
    seen = [];
    uninstall = installLinkRouter();
    unregister = setInviteOpener(code => { invites.push(code); });
    go = vi.spyOn(navigateAway, 'go').mockImplementation(() => {});
    winOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    window.addEventListener('click', record);
    window.addEventListener('auxclick', record);
});
afterEach(() => {
    window.removeEventListener('click', record);
    window.removeEventListener('auxclick', record);
    unregister();
    uninstall();
    go.mockRestore();
    winOpen.mockRestore();
    document.body.innerHTML = '';
});

const flush = () => new Promise(r => setTimeout(r, 0));

/** An anchor as the app renders them, clicked the way a person would. */
async function click(href: string, init: MouseEventInit & { type?: 'click' | 'auxclick'; on?: 'anchor' | 'child' } = {}) {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const inner = document.createElement('span');
    inner.textContent = href;
    a.append(inner);
    document.body.append(a);
    const { type = 'click', on = 'anchor', ...rest } = init;
    (on === 'child' ? inner : a).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'auxclick' ? 1 : 0, ...rest }));
    await flush();
    return { prevented: seen[seen.length - 1], anchor: a };
}

/** Everything that left the page, in one comparable shape. */
function opened() {
    return {
        shell: h.invoke.mock.calls.filter(c => c[0] === 'open_external').map(c => (c[1] as { url: string }).url),
        navigated: go.mock.calls.map((c: unknown[]) => c[0] as string),
        windows: winOpen.mock.calls.map((c: unknown[]) => c[0] as string),
        invites: [...invites],
    };
}
const NOTHING = { shell: [], navigated: [], windows: [], invites: [] };

describe('an ordinary link', () => {
    const URL = 'https://example.org/page?x=1';

    it('desktop: opens ONCE through the shell\'s open_external, with the URL', async () => {
        inShell('desktop');
        const r = await click(URL);
        expect(opened()).toEqual({ ...NOTHING, shell: [URL] });
        expect(r.prevented).toBe(true);
    });

    it('phone: a top-level navigation (the bridge hands it to the browser), never window.open', async () => {
        inShell('phone');
        const r = await click(URL);
        expect(opened()).toEqual({ ...NOTHING, navigated: [URL] });
        expect(r.prevented).toBe(true);
    });

    it('web: left alone — the anchor\'s own target=_blank already works', async () => {
        inShell('web');
        const r = await click(URL);
        expect(opened()).toEqual(NOTHING);
        expect(r.prevented).toBe(false);
    });

    it('mailto: goes to the shell too', async () => {
        inShell('desktop');
        await click('mailto:someone@example.org');
        expect(opened().shell).toEqual(['mailto:someone@example.org']);
    });

    it('a click on something INSIDE the anchor is a click on the link', async () => {
        inShell('desktop');
        await click(URL, { on: 'child' });
        expect(opened().shell).toEqual([URL]);
    });

    it('a component that stops the click on its way up cannot make the link dead (capture phase)', async () => {
        // NoteLinkText stops propagation so a tap on a link does not also
        // edit its row. A bubble-phase router never saw those clicks.
        inShell('desktop');
        const row = document.createElement('div');
        row.addEventListener('click', e => e.stopPropagation());
        document.body.append(row);
        const a = document.createElement('a');
        a.href = URL;
        a.addEventListener('click', e => e.stopPropagation());
        row.append(a);
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flush();
        expect(opened().shell).toEqual([URL]);
    });

    it('an anchor with NO target in a shell is opened outside too — never a navigation of the app itself', async () => {
        inShell('desktop');
        const a = document.createElement('a');
        a.href = URL;
        document.body.append(a);
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flush();
        expect(opened().shell).toEqual([URL]);
        expect(seen).toEqual([true]);
    });
});

describe('an invite link to THIS server opens the join flow, in every shell', () => {
    for (const shell of SHELLS) {
        it(`${shell}: the code goes to the join flow; nothing opens outside`, async () => {
            inShell(shell);
            const r = await click('https://app.example.com/invite/aBc123Xy');
            expect(opened()).toEqual({ ...NOTHING, invites: ['aBc123Xy'] });
            expect(r.prevented).toBe(true);
        });
    }

    it('every address that is this server\'s: APP_URL, the API base, this page, and the legacy client origins', () => {
        expect(thisServerInviteCode('https://app.example.com/invite/abcd')).toBe('abcd');
        expect(thisServerInviteCode('https://api.example.com/invite/abcd')).toBe('abcd');
        expect(thisServerInviteCode(`${window.location.origin}/invite/abcd`)).toBe('abcd');
        // Pre-0.9.2 desktops and Android apps copied their own webview origin.
        expect(thisServerInviteCode('http://tauri.localhost/invite/abcd')).toBe('abcd');
        expect(thisServerInviteCode('https://tauri.localhost/invite/abcd')).toBe('abcd');
        expect(thisServerInviteCode('https://localhost/invite/abcd')).toBe('abcd');
    });

    it('what chat apps and phones add is tolerated: a trailing slash, a query, a fragment, host case', () => {
        expect(thisServerInviteCode('https://app.example.com/invite/abcd/')).toBe('abcd');
        expect(thisServerInviteCode('https://app.example.com/invite/abcd?utm=x')).toBe('abcd');
        expect(thisServerInviteCode('https://app.example.com/invite/abcd#top')).toBe('abcd');
        expect(thisServerInviteCode('HTTPS://APP.EXAMPLE.COM/invite/abcd')).toBe('abcd');
        expect(thisServerInviteCode('https://app.example.com:443/invite/abcd')).toBe('abcd');
    });

    it('a deployment under a sub-path claims only its own /invite/', () => {
        h.appUrl = 'https://example.net/puca';
        expect(thisServerInviteCode('https://example.net/puca/invite/abcd')).toBe('abcd');
        expect(thisServerInviteCode('https://example.net/invite/abcd')).toBeNull();
        expect(thisServerInviteCode('https://example.net/pucaX/invite/abcd')).toBeNull();
    });

    it('while GET /config has not answered, the APP_URL host is not known yet — its link opens in the browser, the rest still work', async () => {
        h.appUrl = undefined;
        inShell('desktop');
        await click('https://app.example.com/invite/abcd');
        await click('http://tauri.localhost/invite/efgh');
        expect(opened()).toEqual({ ...NOTHING, shell: ['https://app.example.com/invite/abcd'], invites: ['efgh'] });
    });

    it('a click while GET /config has no answer asks for it again, so the next click can know', async () => {
        h.appUrl = undefined;
        inShell('desktop');
        const before = h.configFetches;
        await click('https://example.org/page');
        expect(h.configFetches).toBe(before + 1);
        // POSITIVE CONTROL: with the answer in, a click asks nothing.
        h.appUrl = 'https://app.example.com';
        await click('https://example.org/page');
        expect(h.configFetches).toBe(before + 1);
    });

    it('a page with NO join flow (Notes\' own page, the sign-in screen) treats it as any other link', async () => {
        unregister();
        inShell('desktop');
        await click('https://app.example.com/invite/abcd');
        inShell('web');
        const web = await click('https://app.example.com/invite/wxyz');
        expect(opened()).toEqual({ ...NOTHING, shell: ['https://app.example.com/invite/abcd'] });
        // On the web, the anchor's own new tab — which lands on the web app's
        // invite page, the join flow of THAT tab.
        expect(web.prevented).toBe(false);
    });

    it('a second invite while the flow is open is handed over too (the dialog swaps the code)', async () => {
        inShell('desktop');
        await click('https://app.example.com/invite/first1');
        await click('https://app.example.com/invite/second2');
        expect(invites).toEqual(['first1', 'second2']);
    });
});

describe('never another site\'s invite', () => {
    const FOREIGN = [
        'https://example.org/invite/abcd',                       // another site's /invite/
        'https://chat.example.net/invite/abcd',
        'https://app.example.com.evil.test/invite/abcd',         // a look-alike host
        'https://app.example.com@evil.test/invite/abcd',         // userinfo before a foreign host
        'https://evil.test/https://app.example.com/invite/abcd', // our URL inside another's path
        'https://app.example.com:8443/invite/abcd',              // another port
        'http://app.example.com/invite/abcd',                    // another scheme is another origin
        'https://sub.app.example.com/invite/abcd',               // a subdomain is another host
    ];

    it('none of them is taken for an invite to this server', () => {
        for (const href of FOREIGN) expect(thisServerInviteCode(href), href).toBeNull();
    });

    it('desktop: each opens in the browser, exactly once, and the join flow is never shown', async () => {
        inShell('desktop');
        for (const href of FOREIGN) await click(href);
        expect(opened()).toEqual({ ...NOTHING, shell: FOREIGN });
    });

    it('web: each is left to the browser', async () => {
        inShell('web');
        for (const href of FOREIGN) expect((await click(href)).prevented, href).toBe(false);
        expect(opened()).toEqual(NOTHING);
    });

    it('on this server, a path that is not exactly /invite/<code> is not an invite', () => {
        for (const href of [
            'https://app.example.com/invite/',
            'https://app.example.com/invite/ab',             // shorter than any server-issued code
            'https://app.example.com/invite/abcd/extra',
            'https://app.example.com/invite/x/invite/abcd',  // parseInviteCode alone would read `abcd` out of it
            'https://app.example.com/x/invite/abcd',
            'https://app.example.com/invites/abcd',
            'https://app.example.com/invite/bad%20code',
            'https://app.example.com/invite/abc%2Fdef',
            'https://app.example.com/chat',
        ]) expect(thisServerInviteCode(href), href).toBeNull();
    });
});

describe('schemes that never open', () => {
    const REFUSED = ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'blob:https://app.example.com/1234', 'sovereign-enc:abc', '//evil.test/x'];
    for (const shell of SHELLS) {
        it(`${shell}: nothing is opened, navigated or joined`, async () => {
            inShell(shell);
            for (const href of REFUSED) await click(href);
            expect(opened()).toEqual(NOTHING);
            for (const href of REFUSED) expect(thisServerInviteCode(href), href).toBeNull();
        });
    }
});

describe('modified and middle clicks', () => {
    const URL = 'https://example.org/page';
    const INVITE = 'https://app.example.com/invite/abcd';
    const MODS: MouseEventInit[] = [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }];

    it('web: a modified or middle click on an invite is someone asking for a new tab — and gets one', async () => {
        inShell('web');
        for (const m of MODS) expect((await click(INVITE, m)).prevented).toBe(false);
        expect((await click(INVITE, { type: 'auxclick' })).prevented).toBe(false);
        expect(opened()).toEqual(NOTHING);
    });

    it('web: modified clicks on an ordinary link are the browser\'s', async () => {
        inShell('web');
        for (const m of MODS) expect((await click(URL, m)).prevented).toBe(false);
        expect(opened()).toEqual(NOTHING);
    });

    it('desktop: a shell has no tabs, so Ctrl/Shift/middle clicks open like a plain one', async () => {
        inShell('desktop');
        await click(URL, { ctrlKey: true });
        await click(URL, { shiftKey: true });
        await click(URL, { type: 'auxclick' });
        await click(INVITE, { ctrlKey: true });
        await click(INVITE, { type: 'auxclick' });
        expect(opened()).toEqual({ ...NOTHING, shell: [URL, URL, URL], invites: ['abcd', 'abcd'] });
    });

    it('phone: the same', async () => {
        inShell('phone');
        await click(URL, { ctrlKey: true });
        expect(opened().navigated).toEqual([URL]);
    });

    it('the right button, and the back/forward buttons, are never a visit', async () => {
        inShell('desktop');
        for (const button of [2, 3, 4]) {
            const r = await click(URL, { type: 'auxclick', button });
            expect(r.prevented).toBe(false);
        }
        expect(opened()).toEqual(NOTHING);
    });

    it('a click an earlier listener already claimed (a drag\'s trailing click, a push-to-talk button) is left alone', async () => {
        inShell('desktop');
        const claim = (e: Event) => e.preventDefault();
        window.addEventListener('click', claim, true);
        window.addEventListener('auxclick', claim, true);
        try {
            await click(URL);
            await click(INVITE);
            await click(URL, { type: 'auxclick' });
        } finally {
            window.removeEventListener('click', claim, true);
            window.removeEventListener('auxclick', claim, true);
        }
        expect(opened()).toEqual(NOTHING);
    });
});

describe('links that stay in the app', () => {
    it('relative hrefs — react-router links, #, a relative /invite/ — are never touched, in any shell', async () => {
        for (const shell of SHELLS) {
            inShell(shell);
            for (const href of ['/chat', '#/', '#', '/invite/abcd', '?tab=1', '']) {
                expect((await click(href)).prevented, `${shell} ${href}`).toBe(false);
            }
        }
        expect(opened()).toEqual(NOTHING);
    });

    it('an anchor with `download` keeps its download', async () => {
        inShell('desktop');
        const a = document.createElement('a');
        a.href = 'https://app.example.com/files/1';
        a.setAttribute('download', 'x.txt');
        document.body.append(a);
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flush();
        expect(opened()).toEqual(NOTHING);
        expect(seen).toEqual([false]);
    });

    it('a link inside text being edited is a caret position, not a visit', async () => {
        inShell('desktop');
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        const a = document.createElement('a');
        a.href = 'https://example.org/page';
        editor.append(a);
        // POSITIVE CONTROL: the same anchor under contenteditable="false" IS a link.
        const frozen = document.createElement('div');
        frozen.setAttribute('contenteditable', 'false');
        const b = document.createElement('a');
        b.href = 'https://example.org/other';
        frozen.append(b);
        document.body.append(editor, frozen);
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await flush();
        expect(opened()).toEqual({ ...NOTHING, shell: ['https://example.org/other'] });
    });
});

/**
 * The Android apps are served from https://localhost, and Capacitor keeps a
 * navigation to that host (any path, any port) inside the app's WebView. A
 * message saying "caddy is at https://localhost:8443/" must not let a tap
 * reboot Púca in place — dropping its socket and any call — or replace it
 * with an error page.
 */
describe('the phone: a link to the app\'s own host never navigates the app', () => {
    const OWN = ['https://localhost/chat', 'https://localhost/', 'https://localhost:8443/', 'https://localhost/login?x=1'];
    let page: ReturnType<typeof vi.spyOn>;
    let toasts: string[];
    beforeEach(() => {
        page = vi.spyOn(navigateAway, 'pageHref').mockReturnValue('https://localhost/chat');
        toasts = [];
        setMessageToastSink(t => { toasts.push(t.title); });
    });
    afterEach(() => { page.mockRestore(); setMessageToastSink(null); });

    it('each is prevented and refused with a word, never navigated — and a foreign host on the same page still is', async () => {
        inShell('phone');
        for (const href of OWN) expect((await click(href)).prevented, href).toBe(true);
        expect(opened()).toEqual(NOTHING);
        expect(toasts).toHaveLength(OWN.length);
        // POSITIVE CONTROL, same page: the bridge hands these to the browser.
        await click('https://example.org/page');
        await click('http://localhost/other-scheme');
        expect(opened().navigated).toEqual(['https://example.org/page', 'http://localhost/other-scheme']);
    });

    it('a pre-0.9.2 invite (https://localhost/invite/…) still opens the join flow where there is one', async () => {
        inShell('phone');
        await click('https://localhost/invite/abcd');
        expect(opened()).toEqual({ ...NOTHING, invites: ['abcd'] });
        expect(toasts).toEqual([]);
    });

    it('and where there is none (Púca Notes\' own Android app) it is refused, not a reload of Notes', async () => {
        unregister();
        inShell('phone');
        expect((await click('https://localhost/invite/abcd')).prevented).toBe(true);
        expect(opened()).toEqual(NOTHING);
        expect(toasts).toHaveLength(1);
    });

    it('the desktop is not the bridge: the same link goes to the system browser as any other', async () => {
        inShell('desktop');
        await click('https://localhost:8443/');
        expect(opened()).toEqual({ ...NOTHING, shell: ['https://localhost:8443/'] });
        expect(toasts).toEqual([]);
    });
});

describe('installation and the join-flow registration', () => {
    it('installing twice routes a click ONCE (a second listener would open every link twice)', async () => {
        const again = installLinkRouter();
        expect(again).toBe(uninstall);
        inShell('desktop');
        await click('https://example.org/once');
        expect(opened().shell).toEqual(['https://example.org/once']);
    });

    it('uninstalled, nothing is routed — the control for every "opens" above', async () => {
        uninstall();
        inShell('desktop');
        await click('https://example.org/page');
        await click('https://app.example.com/invite/abcd');
        expect(opened()).toEqual(NOTHING);
    });

    it('the newest join flow wins, and a stale unregister leaves it in place', async () => {
        const later: string[] = [];
        const unregisterLater = setInviteOpener(code => { later.push(code); });
        unregister();   // the FIRST registration going away (a remount's cleanup)
        inShell('desktop');
        await click('https://app.example.com/invite/abcd');
        expect(later).toEqual(['abcd']);
        expect(invites).toEqual([]);
        unregisterLater();
    });

    it('registering a join flow asks GET /config for the web app\'s address at once', () => {
        const before = h.configFetches;
        const off = setInviteOpener(() => {});
        expect(h.configFetches).toBe(before + 1);
        off();
    });
});
