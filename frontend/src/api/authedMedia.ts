/**
 * Authenticated media fetching.
 *
 * `GET /files/:id` used to be a public route "for embedding in messages",
 * which meant anyone on the internet holding a UUID could pull any avatar,
 * emoji, server icon, sound clip or attachment with no account at all. It is
 * authenticated now — but a plain `<img src>` cannot send an Authorization
 * header, which is exactly why it was public in the first place.
 *
 * So: fetch the bytes with the header, wrap them in an object URL, and hand
 * THAT to `<img>` / `Audio`. Chosen over the alternatives deliberately —
 *   - a token in the query string leaks a credential into access logs,
 *     Referer headers and browser history;
 *   - a cookie would need SameSite=None across three different shells (web,
 *     Tauri's custom origin, Capacitor) and adds CSRF surface;
 *   - a service worker cannot see the identity seed and none is registered.
 * An object URL behaves identically in all three shells.
 *
 * Blobs are cached by file id, so a 50-message list showing the same avatar
 * fetches once, not fifty times.
 */
import { API_BASE_URL } from './config';
import { getToken } from './auth';
import { safeBlobType } from './attachments';

/** Resolved object URLs, keyed by file id. */
const cache = new Map<string, string>();
/** In-flight fetches, so concurrent renders of the same id share one request. */
const inflight = new Map<string, Promise<string | null>>();

/**
 * Cap the number of live object URLs. Each pins its blob in memory for the
 * life of the document, so an unbounded cache is a slow leak in a long
 * session — a busy server has far more emoji and avatars than fit comfortably.
 */
const MAX_CACHED = 250;

function remember(fileId: string, url: string): void {
    if (cache.size >= MAX_CACHED) {
        // Oldest-first eviction (Map preserves insertion order). Revoke as we
        // drop, or the blob survives the cache entry that pointed at it.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
            const stale = cache.get(oldest);
            if (stale) URL.revokeObjectURL(stale);
            cache.delete(oldest);
        }
    }
    cache.set(fileId, url);
}

/** Already-resolved URL for this id, if we have one. Synchronous. */
export function cachedFileUrl(fileId: string): string | null {
    return cache.get(fileId) ?? null;
}

/**
 * Fetch a file with the caller's credentials and return an object URL, or
 * null when it cannot be had (unauthenticated, deleted, network down). Callers
 * render their fallback on null rather than a broken image.
 */
export function fetchFileUrl(fileId: string): Promise<string | null> {
    const hit = cache.get(fileId);
    if (hit) return Promise.resolve(hit);

    const running = inflight.get(fileId);
    if (running) return running;

    const job = (async (): Promise<string | null> => {
        try {
            const token = getToken();
            if (!token) return null;
            const res = await fetch(`${API_BASE_URL}/files/${fileId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            // Re-type the blob before it becomes an object URL. `res.blob()`
            // inherits the response Content-Type, and that value is chosen by
            // whoever uploaded the file — `src/upload_handlers.rs` stores the
            // multipart part's content_type verbatim and echoes it back. A
            // `blob:` document inherits THIS app's origin, so a `text/html`
            // avatar is one careless consumer (an <a href> or window.open)
            // away from script execution beside the JWT and the E2EE seed.
            // `safeBlobType` is the same normalisation the decrypted-attachment
            // path applies; every type these callers actually render survives
            // it unchanged.
            // Bytes, not `res.blob()`: wrapping one runtime's Blob in another's
            // constructor (undici's Response inside jsdom's Blob, on Node 20)
            // stringifies it to "[object Blob]" — 13 bytes of nothing. The
            // browser never hits that, but CI did, and bytes are the same
            // everywhere. The type comes from the header, parameters dropped.
            const bytes = await res.arrayBuffer();
            const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
            const url = URL.createObjectURL(new Blob([bytes], { type: safeBlobType(declared) }));
            remember(fileId, url);
            return url;
        } catch {
            return null;   // offline / aborted — the caller shows its fallback
        } finally {
            inflight.delete(fileId);
        }
    })();

    inflight.set(fileId, job);
    return job;
}

/**
 * Drop every cached blob. MUST run on logout: the URLs are readable by
 * anything left holding them, and the next account signing in on the same
 * running app must not inherit the previous one's media.
 */
export function clearFileCache(): void {
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
    inflight.clear();
}
