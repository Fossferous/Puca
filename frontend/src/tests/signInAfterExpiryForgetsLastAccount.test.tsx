/**
 * A session that RAN OUT here, and then somebody else signing in on the same
 * running app (review of signout-left). A soft expiry (api/auth.ts
 * softExpireSession: the 401 path, a token aged out) runs no logout(), on
 * purpose: everything is kept for the same account signing back in. Nothing
 * reloads at the next sign-in either, so when the account that signs in is
 * somebody else, what the last one read and was told had to go then. Only the
 * lists did (App.tsx forgetAccountLists: the query cache and the voice
 * roster). Everything a sign-out forgets through its hooks
 * (api/logoutHooks.ts) was handed to the next account:
 *  - the clip approval request the global prompt draws (who asked, from which
 *    call, what it would show of you), on screen at once;
 *  - the server rail's unread counts;
 *  - the last ~500 parsed messages (decrypted words, an attachment's key in
 *    its link) and every address a link card was drawn for;
 *  - a tap on a notification an embedding host (Púca for Steam Deck) still
 *    shows, running the last account's Chat inside the next one's session;
 * and what App and sessionSync forget beside the hooks at the other ends of a
 * session: the blocked-user set (the next account's chat hid the people the
 * last one had blocked), the pictures fetched with the last account's
 * credentials, the unwrapped channel keys (and with them the hidden-recipient
 * notices the global banner draws) and the decrypted attachments.
 *
 * Púca Notes' page had the same boundary (its session gate's expire, then
 * its sign-in form) and forgot none of it either.
 *
 * Through the real App and the real Notes session gate and their real sign-in
 * paths, with what they draw reduced to a name as in
 * accountListsSessionEnds.test.tsx; the global prompts (ClipApprovalPrompt,
 * RecoveryCodeModal) are the real ones.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wsClient } from '../api/websocket';
import { apiClient } from '../api/client';
import { runLogoutCleanups } from '../api/logoutHooks';
import { parseMessage } from '../utils/messageParser';
import { fetchLinkPreview } from '../api/linkPreview';
import { getClipProposalState, refreshPendingClips } from '../api/clips/clipProposals';
import { bumpServerUnread, serverUnreadCount } from '../components/unreadStore';
import { activateHostNotification, notifyHost, resetEmbedHostForTest, EMBED_API_VERSION } from '../api/embedHost';
import { clearBlockedUsers, isBlocked, setBlockedLocal } from '../components/blockStore';
import { cachedFileUrl, clearFileCache, fetchFileUrl } from '../api/authedMedia';
import { consumePendingRecoveryCode, setPendingRecoveryCode } from '../api/recoveryPrompt';

const h = vi.hoisted(() => ({
    onLoginSuccess: null as null | (() => void),
    onNotesSignIn: null as null | (() => void),
    /** The shared caches sessionSync forgets, as they are emptied. */
    forgot: [] as string[],
}));
vi.mock('../components/Chat', () => ({ Chat: () => <div>the chat</div> }));
vi.mock('../components/Login', () => ({
    Login: ({ onLoginSuccess }: { onLoginSuccess: () => void }) => { h.onLoginSuccess = onLoginSuccess; return <div>the login form</div>; },
}));
vi.mock('../components/RcGlobals', () => ({ RcGlobals: () => null }));
vi.mock('../notes/components/NotesShell', () => ({ NotesShell: () => <div>the notes</div> }));
vi.mock('../notes/components/NotesLogin', () => ({
    NotesLogin: ({ onSuccess }: { onSuccess: () => void }) => { h.onNotesSignIn = onSuccess; return <div>the notes sign-in</div>; },
}));
// The real caches, with each emptying written down: what they hold takes the
// whole key and member-list exchange to fill (channelKeys*.test.ts and
// attachments' own tests show that emptying them forgets it).
vi.mock('../api/channelKeys', async (orig) => {
    const real = await orig<typeof import('../api/channelKeys')>();
    return { ...real, clearChannelKeyCache: () => { h.forgot.push('channel keys'); real.clearChannelKeyCache(); } };
});
vi.mock('../api/attachments', async (orig) => {
    const real = await orig<typeof import('../api/attachments')>();
    return { ...real, clearBlobCache: () => { h.forgot.push('decrypted attachments'); real.clearBlobCache(); } };
});

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url).includes('/files/')
    ? new Response(PNG.slice(), { status: 200, headers: { 'content-type': 'image/png' } })
    : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))));

const { default: App } = await import('../App');
const { NotesApp } = await import('../notes/NotesApp');

const SEED_KEY = 'e2ee_seed_v2';
const token = (sub: number, username: string) =>
    `h.${btoa(JSON.stringify({ sub, username, exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;
const ALICE = { sub: 7, name: 'alice' };
const BOB = { sub: 8, name: 'bob' };
const BOBS_CODE = 'copper meadow falcon orbit willow thistle garnet beacon lilac summit quiver dune';

/** What Alice read and was told, each the way its callers see it. */
const ALICES_MESSAGE = 'my new address is 4 Elm Row ![lease.pdf](sovereign-enc:42#k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8)';
const ALICES_LINK = 'https://example.org/clinic/appointments/2026-12-01?patient=alice';
const ALICES_SERVER = 's-shared';
const ALICES_BLOCKED = 71;
const ALICES_PICTURE = 'f-alice-avatar';
const annAsks = {
    clip_id: 'c-ann', proposer: { id: 70, username: 'ann' }, server_id: ALICES_SERVER, voice_channel_id: 5,
    voice_channel_name: 'Alices Lounge', target_channel_id: 9, target_channel_name: 'clips', duration_ms: 64_000,
    ended_ago_ms: 120_000, expires_in_ms: 1_800_000, approver_count: 3, approved_count: 0, solo: false,
    resolved: false, approved: false, my_vote: 'pending',
    you: { had_camera: true, had_share: false, still_in_call: true },
};

let store: Record<string, string>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let shownByHost: { id: string; title: string }[] = [];

beforeEach(() => {
    store = { auth_token: token(ALICE.sub, ALICE.name), [SEED_KEY]: 'kept' };
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    vi.spyOn(wsClient, 'connect').mockImplementation(async () => {});
    // Nothing of the test before this one.
    runLogoutCleanups();
    clearBlockedUsers();
    clearFileCache();
    h.onLoginSuccess = null;
    h.onNotesSignIn = null;
    h.forgot = [];
    window.location.hash = '';
    shownByHost = [];
    (window as unknown as { __PUCA_EMBED_HOST__?: unknown }).__PUCA_EMBED_HOST__ = {
        apiVersion: EMBED_API_VERSION, name: 'a test host', notify: (n: { id: string; title: string }) => { shownByHost.push(n); },
    };
    resetEmbedHostForTest();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    delete (window as unknown as { __PUCA_EMBED_HOST__?: unknown }).__PUCA_EMBED_HOST__;
    resetEmbedHostForTest();
    vi.restoreAllMocks();
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

const settle = (ms = 10) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
async function mountApp() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<MemoryRouter initialEntries={['/chat']}><App /></MemoryRouter>); });
    await settle();
    expect(document.body.textContent).toContain('the chat');
}

interface AlicesRun {
    tree: ReturnType<typeof parseMessage>;
    card: Awaited<ReturnType<typeof fetchLinkPreview>>;
    tapOpensAlicesChat: ReturnType<typeof vi.fn>;
}
/** Alice, signed in at /chat, reads and is told things. */
async function alicesRun(): Promise<AlicesRun> {
    await mountApp();
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => (url === '/clips/pending' ? { proposals: [annAsks] } : {}) as never);
    await act(async () => { await refreshPendingClips(); });
    get.mockRestore();
    bumpServerUnread(ALICES_SERVER, 31);
    const tree = parseMessage(ALICES_MESSAGE);
    const card = await fetchLinkPreview(ALICES_LINK);
    const tapOpensAlicesChat = vi.fn();
    expect(notifyHost({ title: 'dee sent you a message', body: 'New message', key: 'dm:c-dee', kind: 'message' }, tapOpensAlicesChat)).toBe(true);
    setBlockedLocal(ALICES_BLOCKED, true);
    expect(await fetchFileUrl(ALICES_PICTURE)).toMatch(/^data:image\/png;base64,/);
    // POSITIVE CONTROLS: each is held, so the checks after can see it at all.
    expect(document.body.textContent, "the prompt draws Ann's request").toContain('ann wants to post a clip of this call');
    expect(serverUnreadCount(ALICES_SERVER)).toBe(1);
    expect(parseMessage(ALICES_MESSAGE)).toBe(tree);
    expect(await fetchLinkPreview(ALICES_LINK)).toBe(card);
    expect(isBlocked(ALICES_BLOCKED)).toBe(true);
    expect(cachedFileUrl(ALICES_PICTURE)).not.toBeNull();
    expect(shownByHost.map(n => n.title)).toEqual(['dee sent you a message']);
    return { tree, card, tapOpensAlicesChat };
}

/** The API's 401: App's expireSession, softExpireSession, the sign-in form. */
async function alicesSessionRunsOut() {
    await act(async () => { window.dispatchEvent(new Event('auth-expired')); });
    await settle();
    expect(store.auth_token).toBeUndefined();
    expect(store[SEED_KEY], 'a soft expiry, not a sign-out').toBe('kept');
    expect(document.body.textContent).toContain('the login form');
}
async function signInHereAs(who: { sub: number; name: string }) {
    store.auth_token = token(who.sub, who.name);
    expect(h.onLoginSuccess, 'the login form is up').toBeTruthy();
    await act(async () => { h.onLoginSuccess!(); });
    await settle();
    expect(document.body.textContent).toContain('the chat');
}
/** Another tab signs in (its login() writes the token this tab hears). */
async function signInInAnotherTabAs(who: { sub: number; name: string }) {
    const next = token(who.sub, who.name);
    store.auth_token = next;
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: next })); });
    await settle();
}

async function expectNothingOfAlices(run: AlicesRun) {
    expect.soft(document.body.textContent).not.toContain('wants to post a clip');
    expect.soft(document.body.textContent).not.toContain('Alices Lounge');
    expect.soft(getClipProposalState().incoming).toEqual([]);
    expect.soft(serverUnreadCount(ALICES_SERVER)).toBe(0);
    const tree = parseMessage(ALICES_MESSAGE);
    expect.soft(tree).not.toBe(run.tree);
    expect.soft(tree, 'read again, the same reading').toEqual(run.tree);
    expect.soft(await fetchLinkPreview(ALICES_LINK)).not.toBe(run.card);
    expect.soft(activateHostNotification(shownByHost[0].id), "a tap on Alice's toast opens nothing").toBe(false);
    expect.soft(run.tapOpensAlicesChat).not.toHaveBeenCalled();
    expect.soft(isBlocked(ALICES_BLOCKED), "the people Alice blocked are not hidden from Bob").toBe(false);
    expect.soft(cachedFileUrl(ALICES_PICTURE)).toBeNull();
    expect.soft(h.forgot).toEqual(expect.arrayContaining(['channel keys', 'decrypted attachments']));
}

describe('a sign-in as somebody else after a session ran out', () => {
    it('here: is shown and handed nothing of what the last account read or was told', async () => {
        const run = await alicesRun();
        await alicesSessionRunsOut();
        await signInHereAs(BOB);
        await expectNothingOfAlices(run);
    });

    it('in ANOTHER tab: this tab forgets it too', async () => {
        const run = await alicesRun();
        await alicesSessionRunsOut();
        await signInInAnotherTabAs(BOB);
        await expectNothingOfAlices(run);
    });

    it('CONTROL: the same account signing back in here keeps all of it', async () => {
        const run = await alicesRun();
        await alicesSessionRunsOut();
        await signInHereAs(ALICE);
        expect(document.body.textContent).toContain('ann wants to post a clip of this call');
        expect(serverUnreadCount(ALICES_SERVER)).toBe(1);
        expect(parseMessage(ALICES_MESSAGE)).toBe(run.tree);
        expect(await fetchLinkPreview(ALICES_LINK)).toBe(run.card);
        expect(isBlocked(ALICES_BLOCKED)).toBe(true);
        expect(cachedFileUrl(ALICES_PICTURE)).not.toBeNull();
        expect(h.forgot).toEqual([]);
        expect(activateHostNotification(shownByHost[0].id)).toBe(true);
        expect(run.tapOpensAlicesChat).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: the same account signing back in in another tab keeps all of it', async () => {
        const run = await alicesRun();
        await alicesSessionRunsOut();
        await signInInAnotherTabAs(ALICE);
        expect(parseMessage(ALICES_MESSAGE)).toBe(run.tree);
        expect(serverUnreadCount(ALICES_SERVER)).toBe(1);
        expect(getClipProposalState().incoming.map(p => p.proposer.username)).toEqual(['ann']);
        expect(h.forgot).toEqual([]);
    });

    it('CONTROL: somebody who has just registered on that form is still shown THEIR recovery code', async () => {
        await alicesRun();
        await alicesSessionRunsOut();
        // What register('bob', …) leaves for the sign-in that follows it (api/auth.ts).
        setPendingRecoveryCode(BOBS_CODE, BOB.name);
        await signInHereAs(BOB);
        await settle(50);
        expect(document.body.textContent).toContain('Save your recovery code');
        expect(document.body.textContent).toContain('copper');
        expect(document.body.textContent).toContain('dune');
    });
});

describe("Púca Notes' page, the same", () => {
    async function mountNotes() {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<QueryClientProvider client={new QueryClient()}><NotesApp /></QueryClientProvider>); });
        await settle();
        expect(document.body.textContent).toContain('the notes');
    }
    async function alicesNotesRun() {
        await mountNotes();
        const tree = parseMessage(ALICES_MESSAGE);
        const card = await fetchLinkPreview(ALICES_LINK);
        expect(parseMessage(ALICES_MESSAGE), 'positive control: kept').toBe(tree);
        await act(async () => { window.dispatchEvent(new Event('auth-expired')); });
        await settle();
        expect(store.auth_token).toBeUndefined();
        expect(store[SEED_KEY], 'a soft expiry, not a sign-out').toBe('kept');
        expect(document.body.textContent).toContain('the notes sign-in');
        expect(parseMessage(ALICES_MESSAGE), 'kept through the expiry').toBe(tree);
        return { tree, card };
    }
    async function signInOnNotesAs(who: { sub: number; name: string }) {
        store.auth_token = token(who.sub, who.name);
        expect(h.onNotesSignIn, 'the sign-in form is up').toBeTruthy();
        await act(async () => { h.onNotesSignIn!(); });
        await settle();
        expect(document.body.textContent).toContain('the notes');
    }

    it('a sign-in there as somebody else forgets what the last account read', async () => {
        const run = await alicesNotesRun();
        await signInOnNotesAs(BOB);
        expect.soft(parseMessage(ALICES_MESSAGE)).not.toBe(run.tree);
        expect.soft(await fetchLinkPreview(ALICES_LINK)).not.toBe(run.card);
        expect.soft(h.forgot).toEqual(expect.arrayContaining(['channel keys', 'decrypted attachments']));
    });

    it('and so does somebody else signing in in another tab', async () => {
        const run = await alicesNotesRun();
        await signInInAnotherTabAs(BOB);
        expect.soft(parseMessage(ALICES_MESSAGE)).not.toBe(run.tree);
        expect.soft(await fetchLinkPreview(ALICES_LINK)).not.toBe(run.card);
        expect.soft(h.forgot).toEqual(expect.arrayContaining(['channel keys', 'decrypted attachments']));
    });

    it('CONTROL: the same account signing back in there keeps it', async () => {
        const run = await alicesNotesRun();
        await signInOnNotesAs(ALICE);
        expect(parseMessage(ALICES_MESSAGE)).toBe(run.tree);
        expect(await fetchLinkPreview(ALICES_LINK)).toBe(run.card);
        expect(h.forgot).toEqual([]);
    });
});

describe('the recovery code across a sign-in as somebody else', () => {
    it('one bound to an account stays for that account; one bound to none, made in the last session, goes', () => {
        setPendingRecoveryCode(BOBS_CODE, BOB.name);
        runLogoutCleanups('account-change');
        expect(consumePendingRecoveryCode(BOB.name)).toBe(BOBS_CODE);
        setPendingRecoveryCode(BOBS_CODE);
        runLogoutCleanups('account-change');
        expect(consumePendingRecoveryCode(BOB.name)).toBeNull();
        // CONTROL: a sign-out takes even one bound to an account.
        setPendingRecoveryCode(BOBS_CODE, BOB.name);
        runLogoutCleanups('sign-out');
        expect(consumePendingRecoveryCode(BOB.name)).toBeNull();
    });
});
