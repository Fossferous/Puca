// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, type Mock } from 'vitest';

/**
 * The session DM key reaches the server on EVERY socket open, no matter who
 * opened the socket. The sign-in form connects it itself (Login.tsx), and a
 * publish that only ran inside App's own connect attempt left a freshly
 * signed-in device keyless until its next start - the partner then stayed on
 * v3 for the whole first session. This pins the event-driven owner.
 */

const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
vi.mock('../api/client', () => ({
    apiClient: {
        patch: (url: string, body: unknown) => patch(url, body),
        get: vi.fn(async () => ({})),
    },
}));

import { wireSessionDmKeyPublish, currentSessionId, dmKeyRecord, storePendingHistoryKey, adoptPendingHistoryKey, getHistoryKey } from '../api/dmKeys';
import { setActiveIdentity, clearActiveIdentity, makeIdentity, generateIdentitySeed, deriveAccountSigningKey, verifyWithAccountKey } from '../api/e2ee';
import { MAX_READABLE_ENVELOPE_VERSION } from '../api/e2ee';

// The global setup replaces localStorage with inert vi.fn()s; back them with a
// real store so the token and the minted key actually persist between calls.
const store = new Map<string, string>();
const identity = makeIdentity(generateIdentitySeed());
beforeAll(() => {
    setActiveIdentity(identity); // the key is signed with the account signing key derived from it
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { store.delete(k); });
    (localStorage.clear as Mock).mockImplementation(() => store.clear());
});

const tokenWith = (claims: Record<string, unknown>) =>
    `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`;
const open = async () => {
    window.dispatchEvent(new CustomEvent('wsConnected'));
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
};

describe('the session DM key is published on socket open', () => {
    it('a socket opened by the sign-in form (no App connect attempt) publishes once, even when wired twice', async () => {
        localStorage.clear();
        localStorage.setItem('auth_token', tokenWith({ sub: 1, sid: 'sid-one' }));
        expect(currentSessionId()).toBe('sid-one');
        wireSessionDmKeyPublish();
        wireSessionDmKeyPublish();
        await open();
        expect(patch).toHaveBeenCalledTimes(1);
        const [url, body] = patch.mock.calls[0] as [string, { dm_pubkey: string; dm_pubkey_sig: string; account_sign_pub: string; reads_up_to: number }];
        expect(url).toBe('/keys/session-dm');
        expect(body.reads_up_to).toBe(MAX_READABLE_ENVELOPE_VERSION);
        expect(body.dm_pubkey.length).toBeGreaterThan(30);
        // Signed by the account signing key, and the key it names is the one derived here.
        const signer = deriveAccountSigningKey(identity);
        expect(body.account_sign_pub).toBe(signer.publicKeyEncoded);
        expect(verifyWithAccountKey(signer.publicKeyEncoded, dmKeyRecord('session', body.dm_pubkey), body.dm_pubkey_sig)).toBe(true);
    });

    it('a reconnect of the same session is free', async () => {
        const before = patch.mock.calls.length;
        await open();
        expect(patch.mock.calls.length).toBe(before);
    });

    it('a new session id (sign-out, sign-in) publishes its own, different key', async () => {
        const first = (patch.mock.calls[0] as [string, { dm_pubkey: string }])[1].dm_pubkey;
        const before = patch.mock.calls.length;
        localStorage.setItem('auth_token', tokenWith({ sub: 1, sid: 'sid-two' }));
        await open();
        expect(patch.mock.calls.length).toBe(before + 1);
        const second = (patch.mock.calls[before] as [string, { dm_pubkey: string }])[1].dm_pubkey;
        expect(second).not.toBe(first);
    });

    it('a token without a session id publishes nothing (its next renewal mints one)', async () => {
        const before = patch.mock.calls.length;
        localStorage.setItem('auth_token', tokenWith({ sub: 1 }));
        expect(currentSessionId()).toBe('');
        await open();
        expect(patch.mock.calls.length).toBe(before);
    });

    it('a failed publish is retried on the next open, a successful one is not', async () => {
        const before = patch.mock.calls.length;
        localStorage.setItem('auth_token', tokenWith({ sub: 1, sid: 'sid-three' }));
        patch.mockRejectedValueOnce(new Error('503'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await open();
        expect(patch.mock.calls.length).toBe(before + 1);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
        await open();
        expect(patch.mock.calls.length).toBe(before + 2);
        await open();
        expect(patch.mock.calls.length).toBe(before + 2);
    });
});

describe('without an unlocked identity nothing is published', () => {
    it('waits for the next open instead of publishing an unsigned key', async () => {
        const before = patch.mock.calls.length;
        clearActiveIdentity();
        localStorage.setItem('auth_token', tokenWith({ sub: 1, sid: 'sid-four' }));
        await open();
        expect(patch.mock.calls.length).toBe(before);
        setActiveIdentity(identity);
        await open();
        expect(patch.mock.calls.length).toBe(before + 1);
    });
});

describe('the history key minted at registration reaches the account that registered (re-review C1)', () => {
    it('is parked under the username, adopted by that username’s sign-in, and never by another account', () => {
        const priv = new Uint8Array(32).fill(9);
        localStorage.removeItem('auth_token');
        storePendingHistoryKey('Erin', priv);
        expect(getHistoryKey()).toBeNull(); // no account yet: nothing is scoped
        // Some other account signs in on this machine first: it must not inherit Erin's key.
        localStorage.setItem('auth_token', tokenWith({ sub: 7, sid: 'sid-other' }));
        adoptPendingHistoryKey('frank');
        expect(getHistoryKey()).toBeNull();
        // Erin signs in: the parked key becomes hers, under her account id.
        localStorage.setItem('auth_token', tokenWith({ sub: 3, sid: 'sid-erin' }));
        adoptPendingHistoryKey('erin');
        expect(getHistoryKey()?.privateKey).toEqual(priv);
        // …and the parking slot is gone, so a later sign-in of anyone finds nothing there.
        localStorage.setItem('auth_token', tokenWith({ sub: 7, sid: 'sid-other-2' }));
        expect(getHistoryKey()).toBeNull();
        adoptPendingHistoryKey('erin');
        expect(getHistoryKey()).toBeNull();
    });
});
