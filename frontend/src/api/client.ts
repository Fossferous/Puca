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

    constructor(message: string, status: number) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

/** True when the request never got a response at all (offline, DNS, refused). */
export function isNetworkError(err: unknown): boolean {
    if (err instanceof ApiError) return false;
    if (err instanceof TypeError) return true; // how fetch() reports no response
    const msg = err instanceof Error ? err.message : String(err);
    return /failed to fetch|networkerror|network request failed|load failed/i.test(msg);
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
                // are permission denials, not expiry.)
                if (response.status === 401 && hadToken) {
                    signalAuthExpired();
                }
                const errorText = await response.text();
                throw new ApiError(
                    errorText || `Request failed with status ${response.status}`,
                    response.status,
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
