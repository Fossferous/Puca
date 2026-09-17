/**
 * Cross-document session sync.
 *
 * The web app's origin can hold more than one document of this codebase at
 * once: Púca in one tab and Púca Notes (/notes/) in another, or two Púca tabs.
 * They share localStorage — the auth token, the E2EE seed, the settings — but
 * NOT the module-level state each document builds from it: getToken()
 * re-reads storage on every call, while the unwrapped channel keys, the DM
 * keys and the decrypted-attachment blob URLs live in caches that only that
 * document's own logout() clears (App.tsx says so in as many words). So a
 * sign-out or an account switch in one tab used to leave the other tab
 * signed in in memory with the old secrets, and a soft-expiry in one tab
 * left the other making tokenless requests that fail without a signal.
 *
 * The `storage` event is the fix: the browser fires it in every OTHER
 * document on the origin when a key changes. This module watches the three
 * keys that define a session and tells the app what happened:
 *
 *   - the token disappeared          → onSignedOut('logout' | 'expired')
 *     'logout' when the E2EE seed went with it (a real sign-out), 'expired'
 *     when the seed stayed (the other tab soft-expired an aged token, keeping
 *     the keys on purpose — see softExpireSession). On 'logout' the shared
 *     per-account caches are cleared HERE, before the handler runs, so no
 *     entry point can forget one.
 *   - the token's `sub` changed      → onAccountChanged
 *     A different account signed in elsewhere. Everything this document
 *     holds belongs to the previous one; the caller reloads.
 *   - a token appeared               → onSignedIn (optional)
 *     The user signed in from another tab while this one sat on its login
 *     screen.
 *   - the settings changed           → applyAppearance()
 *     A theme picked in the Púca tab lands in the open Notes tab.
 *
 * Renewals (the sliding token) rewrite the key with the SAME sub and are
 * ignored. Same-document changes never fire `storage` at all — those go
 * through logout()/login() in this document and are handled there.
 */
import { decodeJwtPayload } from './auth';
import { clearChannelKeyCache } from './channelKeys';
import { clearBlobCache } from './attachments';
import { clearDmKeys } from './dmKeys';
import { applyAppearance, loadSettings } from '../components/settingsStore';

const TOKEN_KEY = 'auth_token';
const SEED_KEY = 'e2ee_seed_v2';
const SETTINGS_KEY = 'sovereign_settings';

export type SignedOutReason = 'logout' | 'expired';

export interface SessionSyncHandlers {
    onSignedOut: (reason: SignedOutReason) => void;
    onAccountChanged: () => void;
    onSignedIn?: () => void;
    /** The stored E2EE seed appeared (true) or went (false) in another
     *  document. login() stores the token FIRST and the seed only after the
     *  /keys/wrap round trip, so a document that acts on the token alone
     *  reads every note as "locked" until this fires. */
    onSeedChanged?: (present: boolean) => void;
}

/** Whether the E2EE seed is in storage right now. */
export function seedPresent(): boolean {
    try {
        return localStorage.getItem(SEED_KEY) !== null;
    } catch {
        return false;
    }
}

function subOf(token: string | null): number | null {
    if (!token) return null;
    const sub = decodeJwtPayload(token)?.sub;
    return typeof sub === 'number' ? sub : null;
}

function readToken(): string | null {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

/** Drop the per-account secrets this module knows about: the unwrapped
 *  channel keys, the DM keys, the decrypted-attachment blob URLs. Idempotent;
 *  the identity memo re-validates itself against storage (api/e2ee.ts).
 *  Entry points with more per-account state (App.tsx: the authed-media file
 *  cache, the blocked-user set, the reconnect baselines) clear theirs on top. */
export function clearSharedSessionCaches(): void {
    clearChannelKeyCache();
    clearDmKeys();
    clearBlobCache();
}

/**
 * Pure transition, exported for the unit test: what one storage change means
 * given the sub this document last knew about.
 */
export function classifyTokenChange(
    knownSub: number | null,
    newToken: string | null,
    seedStillPresent: boolean,
): { kind: 'none' } | { kind: 'signed-out'; reason: SignedOutReason } | { kind: 'account-changed' } | { kind: 'signed-in' } {
    const next = subOf(newToken);
    if (next === null) {
        return knownSub === null ? { kind: 'none' } : { kind: 'signed-out', reason: seedStillPresent ? 'expired' : 'logout' };
    }
    if (knownSub === null) return { kind: 'signed-in' };
    return next === knownSub ? { kind: 'none' } : { kind: 'account-changed' };
}

/**
 * Start watching. Returns the uninstall function (for an effect cleanup).
 * No-op outside a DOM.
 */
export function installSessionSync(handlers: SessionSyncHandlers): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    let knownSub = subOf(readToken());
    const onStorage = (e: StorageEvent) => {
        // localStorage.clear() elsewhere reports key === null: treat it as the
        // token going away (it did).
        if (e.key === null || e.key === TOKEN_KEY) {
            const newToken = e.key === null ? null : e.newValue;
            const verdict = classifyTokenChange(knownSub, newToken, e.key === null ? false : seedPresent());
            switch (verdict.kind) {
                case 'signed-out':
                    knownSub = null;
                    if (verdict.reason === 'logout') clearSharedSessionCaches();
                    handlers.onSignedOut(verdict.reason);
                    break;
                case 'account-changed':
                    knownSub = subOf(newToken);
                    clearSharedSessionCaches();
                    handlers.onAccountChanged();
                    break;
                case 'signed-in':
                    knownSub = subOf(newToken);
                    handlers.onSignedIn?.();
                    break;
                case 'none':
                    break;
            }
            return;
        }
        if (e.key === SEED_KEY) {
            handlers.onSeedChanged?.(e.newValue !== null);
            return;
        }
        if (e.key === SETTINGS_KEY) applyAppearance(loadSettings());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
}
