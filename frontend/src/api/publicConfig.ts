/**
 * `GET /config` — the deployment facts a client needs BEFORE it has an
 * account: the web app's public URL (for invite links) and whether sign-up
 * needs an invite code. Unauthenticated, and answered by servers from 0.9.2.
 *
 * Fetched once per page load and cached, because both consumers (the invite
 * modals, the sign-up form) can ask several times in quick succession and
 * the answer cannot change under a running client. A failed fetch — an older
 * server answering 404, or the network being down — resolves to the
 * "unknown" shape rather than throwing, so every caller degrades: no URL ⇒
 * hand out the bare code; unknown gate ⇒ show the field (a wrongly hidden
 * field makes registration impossible, a wrongly shown one is only noise).
 */
import { API_BASE_URL } from './config';

export interface PublicConfig {
    /** Public base URL of the web app, no trailing slash — or null when
     *  the operator has not set APP_URL, or the server predates /config. */
    appUrl: string | null;
    /** true/false from the server; null when the probe failed (old server,
     *  offline) and the client must fail closed on its own. */
    registrationInviteRequired: boolean | null;
    /** The newest SRP verifier derivation the server records (2 = Argon2id),
     *  or null for a server too old to say — which auth.ts treats as "do not
     *  write a verifier here". */
    srpVersion: number | null;
}

const UNKNOWN: PublicConfig = { appUrl: null, registrationInviteRequired: null, srpVersion: null };

let cached: Promise<PublicConfig> | null = null;

/** Parse the wire shape defensively: a server that answers 200 with
 *  something else (a proxy's HTML error page, say) is "unknown", not a throw. */
export function parsePublicConfig(body: unknown): PublicConfig {
    if (!body || typeof body !== 'object') return UNKNOWN;
    const b = body as { app_url?: unknown; registration_invite_required?: unknown; srp_version?: unknown };
    const appUrl = typeof b.app_url === 'string' && /^https?:\/\//i.test(b.app_url)
        ? b.app_url.replace(/\/+$/, '')
        : null;
    const gate = typeof b.registration_invite_required === 'boolean'
        ? b.registration_invite_required
        : null;
    const srpVersion = typeof b.srp_version === 'number' && Number.isInteger(b.srp_version) ? b.srp_version : null;
    return { appUrl, registrationInviteRequired: gate, srpVersion };
}

export function fetchPublicConfig(): Promise<PublicConfig> {
    if (cached) return cached;
    cached = (async () => {
        try {
            // Plain fetch, not apiClient: this must work signed out, must not
            // count as an "authenticated request" for the 401 expiry signal,
            // and an old server's 404 is expected rather than an error worth
            // logging.
            const res = await fetch(`${API_BASE_URL}/config`, { cache: 'no-store' });
            if (!res.ok) return UNKNOWN;
            return parsePublicConfig(await res.json());
        } catch {
            return UNKNOWN;
        }
    })();
    // A failed probe is not remembered forever: the next caller re-asks, so a
    // server that was briefly unreachable at boot is not "unknown" all day.
    void cached.then(c => { if (c === UNKNOWN) cached = null; });
    return cached;
}

/** Test seam: forget the cached answer. */
export function __resetPublicConfigForTest(): void {
    cached = null;
}
