/**
 * Signing in from an embedding host's own panel (Púca for Steam Deck;
 * docs/EMBEDDING.md, signIn).
 *
 * The sign-in form registers its own path here while it is on screen, so a
 * host's sign-in runs exactly the form's code: the same SRP exchange, socket
 * and success hand-off, and the same answers. A module of its own so the form
 * can register without pulling in the rest of the embedding API.
 */
import { identityRestoreFailed, identityRestoreReason } from './auth';
import { embedHost } from './embedHost';

/**
 * The account's encryption keys on this device, as the full app's banner
 * (IdentityBanner) sees them, for a host that shows only a panel:
 * - 'ok': in use (nothing says otherwise);
 * - 'refused': unlocked, but not the key this server publishes for the
 *   account, so Púca did not use it (auth.ts, checkPublishedOwnKey);
 * - 'unavailable': not restored on this device.
 * Until they are put right in the full app, messages cannot be sent or read
 * here, and calls may not be end-to-end encrypted.
 */
export type EmbedKeys = 'ok' | 'refused' | 'unavailable';

export function embedKeys(): EmbedKeys {
    if (!identityRestoreFailed()) return 'ok';
    return identityRestoreReason() === 'key-mismatch' ? 'refused' : 'unavailable';
}

/**
 * What a host's sign-in answers. Signed in: `{ ok: true }`, with `keys` when
 * the account's encryption keys did not come back with it (EmbedKeys): the
 * person is signed in all the same, and the full app says what to do.
 * The errors a host can act on:
 * - 'invalid': wrong username or password;
 * - 'reset-required': the account needs the security update the form shows,
 *   finished in the full app;
 * - 'unavailable': no sign-in form on this page (signed in, or still loading);
 * - 'busy': a sign-in, reset or recovery is already running, here or in the form;
 * - 'missing': no username or password.
 * Anything else is a message, as the form would show it.
 */
export type EmbedSignInResult = { ok: true; keys?: Exclude<EmbedKeys, 'ok'> } | { ok: false; error: string };
/** The sign-in form's own path. */
export type EmbedSignInHandler = (username: string, password: string, staySignedIn: boolean) => Promise<EmbedSignInResult>;

let handler: EmbedSignInHandler | null = null;
let running = false;

/** Login registers while it is on screen; the returned function unregisters.
 *  A no-op on a page no host declared. */
export function registerEmbedSignIn(fn: EmbedSignInHandler): () => void {
    if (!embedHost()) return () => {};
    handler = fn;
    return () => {
        if (handler === fn) handler = null;
    };
}

/** Longer than any real username or password; anything past it is refused. */
const MAX_CREDENTIAL = 1024;

/** `staySignedIn` left out means yes, as the form starts on a host; anything
 *  but `true` means no (0, 'false' and null never ask for a year-long session). */
export async function signInFromHost(username: unknown, password: unknown, staySignedIn: unknown): Promise<EmbedSignInResult> {
    if (typeof username !== 'string' || typeof password !== 'string') return { ok: false, error: 'missing' };
    const name = username.trim();
    if (!name || !password || name.length > MAX_CREDENTIAL || password.length > MAX_CREDENTIAL) return { ok: false, error: 'missing' };
    if (!handler) return { ok: false, error: 'unavailable' };
    if (running) return { ok: false, error: 'busy' };
    running = true;
    try {
        return await handler(name, password, staySignedIn === undefined || staySignedIn === true);
    } catch (e) {
        return { ok: false, error: e instanceof Error && e.message ? e.message.slice(0, 200) : 'failed' };
    } finally {
        running = false;
    }
}
