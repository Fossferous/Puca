/**
 * Kept apart from api/client.ts so a module that only needs this (api/authedMedia.ts)
 * does not pull in the whole API client and its sign-in state. client.ts re-exports it.
 */

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
