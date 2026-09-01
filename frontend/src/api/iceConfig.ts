import { API_BASE_URL } from './config';
import { getToken, decodeJwtPayload } from './auth';
import { loadSettings } from '../components/settingsStore';

// ICE Configuration types matching RTCConfiguration
interface IceServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface IceConfiguration {
    iceServers: IceServer[];
    iceTransportPolicy: RTCIceTransportPolicy;
}

// Cache for ICE config. Refresh every 2 hours — comfortably inside the server's
// TURN-credential lifetime, so a cached credential always has validity left.
// (Deliberately well under the server TTL: the client cache must shrink and
// propagate BEFORE any server-side TTL reduction, or a cached credential could
// outlive the server's shortened TTL mid-call. This is the safe first step.)
let cachedIceConfig: IceConfiguration | null = null;
let cacheTimestamp: number = 0;
// The user id the cached config's TURN credentials belong to (from the token's
// `sub`), so a config minted for user A is never reused for user B or after
// logout. null = anonymous/legacy fetch.
let cachedForUser: number | null = null;
// 2 hours — comfortably inside the server's 4-hour TURN-credential TTL, so a
// cached credential always has validity left (a 6h cache could outlive the
// creds and serve dead TURN entries for ~2h each cycle). (audit M7)
const CACHE_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const FETCH_TIMEOUT_MS = 6000; // don't let a black-holed backend stall call setup

/**
 * Used ONLY when /ice-config could not be reached and nothing is cached.
 *
 * Deliberately EMPTY. It used to hard-code Google's STUN servers, which meant an
 * operator who set STUN_SERVERS (or who relies on the new default of deriving
 * STUN from their own TURN) still had every client fall back to contacting
 * Google the moment their own backend was briefly unreachable — the exact
 * disclosure the server-side change was made to remove, reintroduced by a client
 * default the operator cannot see or configure.
 *
 * With no ICE servers, host candidates still work (same LAN, or any peer
 * reachable directly). A NAT-traversed call will fail instead — which is the
 * honest outcome when we could not ask the user's own server what to use, and
 * is recoverable as soon as it answers again.
 */
const STUN_ONLY_FALLBACK: IceConfiguration = {
    iceServers: [],
    iceTransportPolicy: 'all',
};

/** The user id a JWT is for, or null if absent/unparseable. */
function tokenUserId(token: string | null): number | null {
    if (!token) return null;
    try {
        const payload = decodeJwtPayload(token);
        return typeof payload?.sub === 'number' ? payload.sub : null;
    } catch {
        return null;
    }
}

/** Drop any cached ICE config. Call on logout so the next user (or the
 *  logged-out session) never reuses the previous user's TURN credentials. */
/**
 * Apply the user's "Hide my IP in calls (relay only)" choice to an RTC config.
 *
 * ONE place, used by every path that opens a peer connection. The policy used to
 * live inline in the mesh voice manager alone, so ticking the box hid the user's
 * IP from a voice peer while a My Devices session and a peer-to-peer file
 * transfer still handed it straight over — three RTCPeerConnection call sites
 * that never consulted the setting. A privacy control that covers some of the
 * connections is worse than none, because the user believes it covers all.
 *
 * Only takes effect when a TURN server is actually present: with
 * `iceTransportPolicy: 'relay'` and no relay to use, there is no viable
 * candidate pair and the connection simply never establishes. Failing to
 * connect is not a privacy win, so the honest behaviour is to leave the policy
 * alone and let the per-peer indicator report what actually happened.
 */
export function withRelayOnlyIfRequested(config: IceConfiguration | RTCConfiguration): RTCConfiguration {
    const servers = (config.iceServers ?? []) as RTCIceServer[];
    const hasTurn = servers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some(
            (u) => typeof u === 'string' && u.startsWith('turn:'),
        ),
    );
    return loadSettings().forceRelayOnly && hasTurn
        ? ({ ...config, iceTransportPolicy: 'relay' } as RTCConfiguration)
        : (config as RTCConfiguration);
}

export function resetIceConfigCache(): void {
    cachedIceConfig = null;
    cacheTimestamp = 0;
    cachedForUser = null;
}

/**
 * Fetch ICE configuration from the backend.
 * Caches the result to avoid repeated requests. Sends the auth token when we
 * have one — the backend only hands out self-hosted TURN credentials to
 * authenticated callers. The cache is keyed to the token's user id, so it's
 * refetched when the identity changes (login, switch user) and never serves
 * one user's TURN credentials to another.
 */
export async function fetchIceConfig(): Promise<IceConfiguration> {
    const now = Date.now();
    const token = getToken();
    const userId = tokenUserId(token);

    // Serve the cache only if fresh AND minted for the current identity.
    const cacheFresh = cachedIceConfig && (now - cacheTimestamp) < CACHE_DURATION_MS;
    if (cacheFresh && cachedForUser === userId) {
        return cachedIceConfig!;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(`${API_BASE_URL}/ice-config`, {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch ICE config: ${response.status}`);
        }

        cachedIceConfig = await response.json();
        cacheTimestamp = now;
        cachedForUser = userId;

        console.log('[ICE] Fetched ICE configuration:', cachedIceConfig);
        return cachedIceConfig!;
    } catch (error) {
        console.error('[ICE] Failed to fetch ICE config:', error);
        // Prefer the last known-good config (its TURN creds outlive the 2h cache,
        // so an entry that's merely stale still has live creds) — only drop to
        // STUN-only when we have nothing cached at all.
        return cachedIceConfig ?? STUN_ONLY_FALLBACK;
    } finally {
        clearTimeout(timer);
    }
}

