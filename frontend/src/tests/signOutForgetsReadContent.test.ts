// @vitest-environment jsdom
/**
 * A sign-out forgets what the account READ, not only its keys.
 *
 * A sign-out reloads nothing (api/auth.ts logout, App.tsx handleLogout), so a
 * module-level cache outlives the account that filled it unless something
 * empties it. Two did (review of fix-signout-left):
 *  - utils/messageParser.ts keeps the last ~500 parsed messages, keyed by
 *    their decrypted text, and an attachment's link in a tree carries the
 *    file's key;
 *  - api/linkPreview.ts keeps every address a link card was drawn for.
 * And what else the account was told: a recovery code waiting for
 * RecoveryCodeModal (api/recoveryPrompt.ts), the server rail's unread counts
 * (components/unreadStore.ts) and the clip approval requests the global prompt
 * draws (api/clips/clipProposals.ts).
 * All now register a sign-out cleanup (api/logoutHooks.ts), which logout()
 * runs. And a sign-out in ANOTHER tab runs this tab's cleanups too
 * (api/sessionSync.ts clearSharedSessionCaches): they are registered per
 * document, and only a document's own logout() used to run them.
 *
 * Each cache is observed the way its callers see it: a kept tree is the SAME
 * frozen object, a kept card the same object; a forgotten one is built again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logout } from '../api/auth';
import { parseMessage } from '../utils/messageParser';
import { fetchLinkPreview } from '../api/linkPreview';
import { installSessionSync } from '../api/sessionSync';
import { consumePendingRecoveryCode, showRecoveryCode } from '../api/recoveryPrompt';
import { apiClient } from '../api/client';
import { bumpServerUnread, hydrateServerUnread, serverUnreadCount, snapshotServerUnread } from '../components/unreadStore';
import { getClipProposalState, refreshPendingClips } from '../api/clips/clipProposals';

const ATTACHMENT_MESSAGE = 'the scan of my passport ![passport.png](sovereign-enc:42#k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8)';
const PRIVATE_LINK = 'https://example.org/invoices/2026-11/acme-ltd?view=private';

let store: Record<string, string>;
beforeEach(() => {
    store = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
});
afterEach(() => {
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

const token = (sub: number) => `h.${btoa(JSON.stringify({ sub, username: 'me', exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;

describe('a sign-out forgets what the account read', () => {
    it('the parsed messages: the next account on this running app is not handed the last one\'s trees', () => {
        const tree = parseMessage(ATTACHMENT_MESSAGE);
        // POSITIVE CONTROL: kept, so the check below can see the cache at all.
        expect(parseMessage(ATTACHMENT_MESSAGE)).toBe(tree);
        expect(JSON.stringify(tree)).toContain('sovereign-enc:42');
        logout();
        const after = parseMessage(ATTACHMENT_MESSAGE);
        expect(after).not.toBe(tree);
        // Read again, the same reading: nothing about parsing changed.
        expect(after).toEqual(tree);
    });

    it('the link cards: every address a card was drawn for', async () => {
        const card = await fetchLinkPreview(PRIVATE_LINK);
        expect(card?.url).toBe(PRIVATE_LINK);
        expect(await fetchLinkPreview(PRIVATE_LINK), 'positive control: kept').toBe(card);
        logout();
        const after = await fetchLinkPreview(PRIVATE_LINK);
        expect(after).not.toBe(card);
        expect(after).toEqual(card);
    });

    it('a recovery code still waiting to be shown (Settings\' Regenerate, signed out before the modal took it)', () => {
        showRecoveryCode('harbor velvet ostrich granite lunar maple ember quartz nimble tundra cobalt saffron', 'me');
        logout();
        expect(consumePendingRecoveryCode('me')).toBeNull();
        // CONTROL: without the sign-out its account is handed it.
        showRecoveryCode('harbor velvet ostrich granite lunar maple ember quartz nimble tundra cobalt saffron', 'me');
        expect(consumePendingRecoveryCode('me')).toMatch(/^harbor/);
    });

    it("the server rail's unread counts, and an answer still on its way for the last account", async () => {
        bumpServerUnread('s-lads', 31);
        expect(serverUnreadCount('s-lads'), 'positive control: counted').toBe(1);
        let answer!: (v: unknown) => void;
        const get = vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(r => { answer = r; }));
        const asked = hydrateServerUnread();
        logout();
        expect(serverUnreadCount('s-lads')).toBe(0);
        answer({ servers: [{ server_id: 's-lads', unread_count: 12, channels: [{ channel_id: 31, unread_count: 12 }] }] });
        await asked;
        expect(serverUnreadCount('s-lads')).toBe(0);
        expect(snapshotServerUnread()).toBeNull();
        get.mockRestore();
    });

    it('a clip approval request the account was asked, and its own proposal', async () => {
        const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ proposals: [{
            clip_id: 'c1', proposer: { id: 7, username: 'ann' }, server_id: 's', voice_channel_id: 5, voice_channel_name: 'General Voice',
            target_channel_id: 9, target_channel_name: 'clips', duration_ms: 64_000, ended_ago_ms: 120_000, expires_in_ms: 1_800_000,
            approver_count: 3, approved_count: 0, solo: false, resolved: false, approved: false,
            my_vote: 'pending', you: { had_camera: false, had_share: true, still_in_call: true },
        }] });
        await refreshPendingClips();
        expect(getClipProposalState().incoming.map(p => p.proposer.username), 'positive control: asked').toEqual(['ann']);
        logout();
        expect(getClipProposalState()).toEqual({ outgoing: null, incoming: [], notice: null });
        get.mockRestore();
    });

    it('a sign-out in another tab forgets them in this one', async () => {
        store.auth_token = token(7);
        const onSignedOut = vi.fn();
        const uninstall = installSessionSync({ onSignedOut, onAccountChanged: vi.fn() });
        try {
            const tree = parseMessage(ATTACHMENT_MESSAGE);
            const card = await fetchLinkPreview(PRIVATE_LINK);
            expect(parseMessage(ATTACHMENT_MESSAGE), 'positive control: kept').toBe(tree);
            // The other tab's logout(): the token and the seed go (a real sign-out).
            delete store.auth_token;
            window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: null }));
            expect(onSignedOut).toHaveBeenCalledWith('logout');
            expect(parseMessage(ATTACHMENT_MESSAGE)).not.toBe(tree);
            expect(await fetchLinkPreview(PRIVATE_LINK)).not.toBe(card);
        } finally {
            uninstall();
        }
    });

    it('CONTROL: a session running out in another tab (the seed kept) keeps them for the same account', async () => {
        store.auth_token = token(7);
        store.e2ee_seed_v2 = 'kept';
        const onSignedOut = vi.fn();
        const uninstall = installSessionSync({ onSignedOut, onAccountChanged: vi.fn() });
        try {
            const tree = parseMessage(ATTACHMENT_MESSAGE);
            delete store.auth_token;
            window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: null }));
            expect(onSignedOut).toHaveBeenCalledWith('expired');
            expect(parseMessage(ATTACHMENT_MESSAGE)).toBe(tree);
        } finally {
            uninstall();
        }
    });
});
