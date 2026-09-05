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

import { wireSessionDmKeyPublish, currentSessionId } from '../api/dmKeys';
import { MAX_READABLE_ENVELOPE_VERSION } from '../api/e2ee';

// The global setup replaces localStorage with inert vi.fn()s; back them with a
// real store so the token and the minted key actually persist between calls.
const store = new Map<string, string>();
beforeAll(() => {
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
        const [url, body] = patch.mock.calls[0] as [string, { dm_pubkey: string; reads_up_to: number }];
        expect(url).toBe('/keys/session-dm');
        expect(body.reads_up_to).toBe(MAX_READABLE_ENVELOPE_VERSION);
        expect(body.dm_pubkey.length).toBeGreaterThan(30);
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
