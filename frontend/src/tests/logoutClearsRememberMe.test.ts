/**
 * Sign-out has to actually sign out.
 *
 * "Remember me" stores a base64 `{u,p}` blob under `sovereign_remember`, and
 * Login's mount effect replays it unconditionally on every mount. `logout()`
 * cleared `auth_token` but not that blob, so the whole sign-out flow was:
 *
 *   Log Out -> token removed -> redirect to /login -> Login mounts ->
 *   reads the blob -> logs straight back in -> Chat.
 *
 * The user could not get out from inside the app either: the blob is only
 * cleared by signing in again with the box unticked, which requires being
 * signed out. On a shared browser profile the next person was already inside
 * the previous user's account, E2EE identity restored.
 *
 * The stored value is the account password, which is both the SRP credential
 * and the KEK that unwraps the E2EE identity seed — so this is the one secret
 * that most needed clearing, and it was the one left behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logout, softExpireSession, REMEMBER_ME_KEY } from '../api/auth';

// setup.ts replaces localStorage with vi.fn() stubs; track a real backing store
// so we can assert on what survived each call.
function useBackingStore(initial: Record<string, string>) {
    const store: Record<string, string> = { ...initial };
    vi.mocked(window.localStorage.getItem).mockImplementation(
        (k: string) => (k in store ? store[k] : null),
    );
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => {
        store[k] = v;
    });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => {
        delete store[k];
    });
    return store;
}

describe('logout clears the remember-me credentials', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('removes the stored credential blob, not just the token', () => {
        const store = useBackingStore({
            auth_token: 'jwt-here',
            [REMEMBER_ME_KEY]: btoa(JSON.stringify({ u: 'alice', p: 'hunter2' })),
        });

        logout();

        expect(store.auth_token).toBeUndefined();
        // The assertion that fails against the old logout().
        expect(store[REMEMBER_ME_KEY]).toBeUndefined();
    });

    /**
     * The password is recoverable from the blob by anyone who reads storage
     * later, so "it is still there but encoded" is not a defence. Prove the
     * plaintext is genuinely gone rather than merely re-encoded.
     */
    it('leaves nothing in storage from which the password can be read back', () => {
        const store = useBackingStore({
            auth_token: 'jwt-here',
            [REMEMBER_ME_KEY]: btoa(JSON.stringify({ u: 'alice', p: 'hunter2' })),
        });

        logout();

        const remaining = Object.values(store).join('|');
        expect(remaining).not.toContain('hunter2');
        expect(remaining).not.toContain(btoa(JSON.stringify({ u: 'alice', p: 'hunter2' })));
    });

    /**
     * The counterpart, and the reason this is not simply "clear it everywhere":
     * a soft expiry is the case remember-me exists for. Clearing the blob there
     * would turn every routine token expiry into a permanent sign-out.
     */
    it('a soft session expiry KEEPS the blob so silent re-auth still works', () => {
        const blob = btoa(JSON.stringify({ u: 'alice', p: 'hunter2' }));
        const store = useBackingStore({ auth_token: 'jwt-here', [REMEMBER_ME_KEY]: blob });

        softExpireSession();

        expect(store.auth_token).toBeUndefined();
        expect(store[REMEMBER_ME_KEY]).toBe(blob);
    });

    it('is harmless when the user never ticked remember me', () => {
        const store = useBackingStore({ auth_token: 'jwt-here' });
        expect(() => logout()).not.toThrow();
        expect(store.auth_token).toBeUndefined();
        expect(store[REMEMBER_ME_KEY]).toBeUndefined();
    });
});
