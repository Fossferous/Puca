import { API_BASE_URL } from './config';
import { getToken, storeRenewedToken } from './auth';

/** Response header carrying a slid-forward session token (see api/auth). */
const RENEWED_TOKEN_HEADER = 'x-renewed-token';

/**
 * An error the SERVER produced, carrying its status. Callers need this to tell
 * "the server said no" from "we never reached the server" — a distinction that
 * decides whether saved credentials are wrong or the device is merely offline.
 * Subclasses Error, so existing `err.message` handling is unaffected.
 */
export class ApiError extends Error {
    readonly status: number;
    /** How long the server asked us to wait before retrying (a 429's
     *  Retry-After / x-ratelimit-after header, or a `retry_after_ms` body),
     *  in ms. Undefined when it did not say. */
    readonly retryAfterMs?: number;
    /** The refusal's body, verbatim. `message` is the readable part of it,
     *  which is all most callers want; a refusal that carries STRUCTURE —
     *  a note's current copy alongside a 409 (api/listConflict.ts) — needs
     *  the whole thing, and re-reading the response is not possible by then. */
    readonly body?: string;

    constructor(message: string, status: number, retryAfterMs?: number, body?: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
        if (body !== undefined) this.body = body;
    }
}

/**
 * The wait a refusal asks for, in ms: `Retry-After` (delta-seconds or an
 * HTTP-date), else the API limiter's `x-ratelimit-after` (seconds — what
 * tower_governor sends), else a JSON body's `retry_after_ms`. Undefined when
 * none is usable. Cross-origin, the headers are readable only because the
 * server's CORS layer exposes them (main.rs).
 */
export function retryAfterMsOf(headers: { get(name: string): string | null } | null | undefined, bodyText: string, nowMs: number = Date.now()): number | undefined {
    const secs = (v: string | null | undefined): number | undefined => {
        if (v == null) return undefined;
        const t = v.trim();
        if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
        const at = Date.parse(t);
        return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
    };
    const fromHeader = secs(headers?.get('retry-after')) ?? secs(headers?.get('x-ratelimit-after'));
    if (fromHeader !== undefined) return fromHeader;
    try {
        const b = JSON.parse(bodyText) as { retry_after_ms?: unknown };
        if (typeof b?.retry_after_ms === 'number' && Number.isFinite(b.retry_after_ms) && b.retry_after_ms >= 0) return b.retry_after_ms;
    } catch { /* not JSON */ }
    return undefined;
}

/**
 * The HTTP status a thrown error carries, or undefined for anything that is
 * not a server refusal. THE one way to branch on a status: two call sites
 * (channelKeys' 409 epoch-race adoption, FriendsPanel's "already friends")
 * read `err.response.status` — the axios shape — from errors this client
 * never throws, so both branches were dead and every 409 fell through to a
 * generic failure.
 */
export function statusOf(err: unknown): number | undefined {
    return err instanceof ApiError ? err.status : undefined;
}

/**
 * The message a server error body carries. Handlers answer with either a
 * plain-text body or `{"message": "..."}` / `{"error": "..."}`; callers that
 * print `err.message` verbatim (SettingsModal's e-mail hint, Login) were
 * showing the braces to users. Falls back to the raw text, then to a status
 * line, so no caller sees an empty string.
 */
export function errorMessageFromBody(text: string, status: number): string {
    const raw = text.trim();
    if (raw.startsWith('{')) {
        try {
            const j = JSON.parse(raw) as { message?: unknown; error?: unknown };
            if (typeof j.message === 'string' && j.message.trim()) return j.message;
            if (typeof j.error === 'string' && j.error.trim()) return j.error;
        } catch { /* not JSON after all — show it as text */ }
    }
    return raw || `Request failed with status ${status}`;
}

/** True when the request never got a response at all (offline, DNS, refused). */
export function isNetworkError(err: unknown): boolean {
    if (err instanceof ApiError) return false;
    if (err instanceof TypeError) return true; // how fetch() reports no response
    const msg = err instanceof Error ? err.message : String(err);
    return /failed to fetch|networkerror|network request failed|load failed/i.test(msg);
}

/** Errors raised BEFORE any request left this device (sealing, a read that
 *  had to come first). A WeakSet, not a wrapper class: the error keeps its
 *  identity and type, so every other check (`instanceof ApiError`, a 401, a
 *  5xx retry) still sees exactly what was thrown. */
const notSent = new WeakSet<object>();

/** Tag `err` as raised before anything was sent; returns it, so a caller can
 *  write `throw markNotSent(err)`. */
export function markNotSent<T>(err: T): T {
    if (typeof err === 'object' && err !== null) notSent.add(err);
    return err;
}

/**
 * Whether a failed write was DEFINITELY not carried out, so what was uploaded
 * for it may be deleted again.
 *
 * The server commits a create or a sidecar write BEFORE it answers, and it
 * cannot tell which uploads a sealed sidecar names — so deleting "our"
 * uploads after a write whose answer was merely LOST breaks a note that was
 * in fact written. Only these are definite:
 *  - an error raised before any request left (`markNotSent`), or a local
 *    error that is not a network failure at all;
 *  - an ApiError with a 4xx status, other than 408 (the request timed out
 *    somewhere in between) and 429 (not "no" but "come back later": a retry
 *    follows, and it should find the uploads still there).
 * A fetch TypeError, a 5xx (a gateway's 502/504/524 included) and a timeout
 * are "it may have landed": keep the uploads. An orphan costs quota; a
 * deleted file a committed note names is a broken picture for good.
 */
export function isDefiniteRefusal(err: unknown): boolean {
    if (typeof err === 'object' && err !== null && notSent.has(err)) return true;
    if (err instanceof ApiError) return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) return false;
    return !isNetworkError(err);
}

interface RequestOptions extends RequestInit {
    headers?: Record<string, string>;
}

// Session-expiry signal. When an AUTHENTICATED request comes back 401 the
// token is dead (fixed-exp 24h JWT, no refresh endpoint) — every screen was
// failing SILENTLY (empty lists, looping 401 polls) with no re-login prompt
// until a manual refresh. Dispatch ONE 'auth-expired' event (the polls would
// otherwise fire dozens); App.tsx listens and soft-expires to the login
// screen. Reset on successful login so a later expiry signals again.
let authExpiredSignalled = false;
export function resetAuthExpiredFlag(): void {
    authExpiredSignalled = false;
}
export function signalAuthExpired(): void {
    if (authExpiredSignalled) return;
    authExpiredSignalled = true;
    try { window.dispatchEvent(new CustomEvent('auth-expired')); } catch { /* non-DOM env */ }
}

/** Why a session probe failed — see {@link probeSession}. */
export type SessionProbe = 'ok' | 'rejected' | 'unreachable';

/**
 * Ask the server whether OUR TOKEN is still good, over plain HTTP.
 *
 * This exists because a failed WebSocket tells us nothing: the browser's
 * WebSocket API deliberately hides the HTTP status of a refused upgrade, so a
 * 401 (expired/revoked token) and a dead server both surface as a bare `error`
 * Event — the useless `{isTrusted:true}` we used to log and the reason "Failed
 * to connect to server" was shown for a problem that retrying can never fix.
 * An authenticated GET exposes the status code, which separates the two:
 *
 *  - `rejected`    → the server answered and refused our token. Re-authenticate.
 *  - `unreachable` → no answer at all (offline, DNS, server down). Retry is valid.
 *  - `ok`          → token is fine and the server is up; the fault is the socket.
 *
 * Does NOT tear the session down and does NOT fire `auth-expired`: the caller
 * owns that decision, and double-handling one expiry stacks duplicate
 * navigations. A caller that gets `rejected` must re-authenticate.
 */
export async function probeSession(): Promise<SessionProbe> {
    const token = getToken();
    if (!token) return 'rejected';
    try {
        const res = await fetch(`${API_BASE_URL}/profile`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        });
        const renewed = res.headers.get(RENEWED_TOKEN_HEADER);
        if (renewed) storeRenewedToken(token, renewed);
        if (res.status === 401) {
            // The CALLER tears the session down (App.tsx). Don't also fire the
            // one-shot auth-expired signal here, or the same expiry is handled
            // twice and stacks two /login history entries.
            return 'rejected';
        }
        // ANY other answer means the server is reachable and our token wasn't
        // refused — a 5xx/429/403 is a server-side fault, not an offline
        // device, and telling the user to check their connection would point
        // them at the wrong remedy.
        return 'ok';
    } catch {
        return 'unreachable'; // network-level failure: never reached the server
    }
}

class ApiClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /** `token` is captured ONCE by the caller so the renewal compare-and-swap
     *  can check against the exact credential this request carried. */
    private getHeaders(token: string | null, options?: RequestOptions, isFormData: boolean = false): HeadersInit {
        const headers: Record<string, string> = {
            ...options?.headers,
        };

        // Only set JSON content type if NOT FormData
        if (!isFormData) {
            headers['Content-Type'] = 'application/json';
        }

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        return headers;
    }

    private async request<T>(endpoint: string, options?: RequestOptions, isFormData: boolean = false): Promise<T> {
        const url = `${this.baseUrl}${endpoint}`;
        const sentToken = getToken();
        const headers = this.getHeaders(sentToken, options, isFormData);
        const hadToken = 'Authorization' in (headers as Record<string, string>);

        try {
            const response = await fetch(url, {
                ...options,
                headers,
            });

            // Sliding session: the server re-issues a token once the current
            // one is past halfway, so ordinary use keeps the session alive.
            const renewed = response.headers.get(RENEWED_TOKEN_HEADER);
            if (renewed && sentToken) storeRenewedToken(sentToken, renewed);

            if (!response.ok) {
                // A 401 on a request that CARRIED a token means the session is
                // dead — surface it once app-wide. (Tokenless 401s — e.g. a
                // wrong password on /auth/* — are ordinary errors, and 403s
                // are permission denials, not expiry.) Only for the token
                // still CURRENT: a 401 for one that has since been replaced
                // (a renewal adopted from Púca Notes' background job while
                // this request was out, a sign-in in another tab) refused the
                // old credential, not this session — signalling it would sign
                // the user out and delete the good token with it.
                if (response.status === 401 && hadToken && getToken() === sentToken) {
                    signalAuthExpired();
                }
                const errorText = await response.text();
                throw new ApiError(
                    errorMessageFromBody(errorText, response.status), response.status,
                    response.status === 429 || response.status === 503 ? retryAfterMsOf(response.headers, errorText) : undefined,
                    errorText,
                );
            }

            // For DELETE or empty responses, return generic success or null
            if (response.status === 204) {
                return {} as T;
            }

            // Sometimes APIs return empty body for 200 OK without info
            const text = await response.text();
            if (!text) return {} as T;

            try {
                return JSON.parse(text);
            } catch {
                // Return text if not JSON
                return text as unknown as T;
            }
        } catch (error) {
            console.error(`API Error [${options?.method || 'GET'} ${url}]:`, error);
            throw error;
        }
    }

    public get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
        return this.request<T>(endpoint, { ...options, method: 'GET' });
    }

    public post<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
        const isFormData = body instanceof FormData;
        return this.request<T>(endpoint, {
            ...options,
            method: 'POST',
            body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
        }, isFormData);
    }

    public put<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
        const isFormData = body instanceof FormData;
        return this.request<T>(endpoint, {
            ...options,
            method: 'PUT',
            body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
        }, isFormData);
    }

    public patch<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
        const isFormData = body instanceof FormData;
        return this.request<T>(endpoint, {
            ...options,
            method: 'PATCH',
            body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
        }, isFormData);
    }

    public delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
        return this.request<T>(endpoint, { ...options, method: 'DELETE' });
    }
}

export const apiClient = new ApiClient(API_BASE_URL);
