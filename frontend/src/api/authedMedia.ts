/**
 * Authenticated media fetching.
 *
 * `GET /files/:id` used to be a public route "for embedding in messages",
 * which meant anyone on the internet holding a UUID could pull any avatar,
 * emoji, server icon, sound clip or attachment with no account at all. It is
 * authenticated now — but a plain `<img src>` cannot send an Authorization
 * header, which is exactly why it was public in the first place.
 *
 * So: fetch the bytes with the header and hand `<img>` a URL made from them.
 * Chosen over the alternatives deliberately —
 *   - a token in the query string leaks a credential into access logs,
 *     Referer headers and browser history;
 *   - a cookie would need SameSite=None across three different shells (web,
 *     Tauri's custom origin, Capacitor) and adds CSRF surface;
 *   - a service worker cannot see the identity seed and none is registered.
 *
 * A `data:` URL, NOT a blob: URL (fetchFileUrl). These are kept for the whole
 * session (avatars, server icons, custom emoji: up to MAX_CACHED of them),
 * and a Blob kept that long keeps DECRYPTED ATTACHMENTS on disk: Chromium
 * writes the blobs it pages out several to a file in
 * `<profile>/Default/blob_storage` and deletes a file only once every blob
 * in it is gone (measured 2026-10-05: an avatar's blob written into the same
 * file as two pictures kept their plaintext there after they were let go,
 * on screen, in the background and after a kill, in the Android WebView and
 * in Edge under memory pressure; revoking the avatars removed it at once).
 * A data: URL is never a blob, so it is never in that folder at all: it lives
 * in the page's memory (as text, a third larger than the file; bounded by
 * MAX_CACHED_CHARS) and the image decoder's, and nowhere else. Every shell's
 * policy allows `img-src data:`. A data: URL is also inert as a document: a
 * top-level navigation to one is blocked, and one that loads gets an opaque
 * origin, never this app's.
 *
 * `<audio>` is the exception: the Android and web policies do not allow
 * `media-src data:`, so a sound is played from a blob: URL that lives only
 * while it plays (fetchFileObjectUrl).
 *
 * URLs are cached by file id, so a 50-message list showing the same avatar
 * fetches once, not fifty times.
 */
import { API_BASE_URL } from './config';
import { getToken } from './auth';
import { safeBlobType } from './attachments';
import { bytesToB64 } from './parkedMedia';

/** Resolved data: URLs, keyed by file id. */
const cache = new Map<string, string>();
/** Characters held by `cache` (a data: URL is about 4/3 of the file). */
let cachedChars = 0;
/** In-flight fetches, so concurrent renders of the same id share one request. */
const inflight = new Map<string, Promise<string | null>>();

/** Cap the number of cached URLs: a busy server has far more emoji and
 *  avatars than fit comfortably in a long session... */
const MAX_CACHED = 250;
/** ...and the text they take, which is page memory (32 MB of files). An
 *  avatar is cropped to 512 px on upload; an emoji or icon is usually far
 *  smaller. The newest one is kept even if it alone is larger. */
const MAX_CACHED_CHARS = 44 * 1024 * 1024;

function remember(fileId: string, url: string): void {
    // Oldest-first eviction (Map preserves insertion order).
    while (cache.size > 0 && (cache.size >= MAX_CACHED || cachedChars + url.length > MAX_CACHED_CHARS)) {
        const oldest = cache.keys().next().value as string;
        cachedChars -= cache.get(oldest)?.length ?? 0;
        cache.delete(oldest);
    }
    cache.set(fileId, url);
    cachedChars += url.length;
}

/** Already-resolved URL for this id, if we have one. Synchronous. */
export function cachedFileUrl(fileId: string): string | null {
    return cache.get(fileId) ?? null;
}

/** The file's bytes and its (normalised) type, or null when it cannot be had. */
async function fetchFile(fileId: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
    const token = getToken();
    if (!token) return null;
    const res = await fetch(`${API_BASE_URL}/files/${fileId}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    // Re-type the bytes before they become a URL. The response Content-Type
    // is chosen by whoever uploaded the file — `src/upload_handlers.rs`
    // stores the multipart part's content_type verbatim and echoes it back. A
    // `blob:` document inherits THIS app's origin, so a `text/html` sound is
    // one careless consumer (an <a href> or window.open) away from script
    // execution beside the JWT and the E2EE seed. `safeBlobType` is the same
    // normalisation the decrypted-attachment path applies; every type these
    // callers actually render survives it unchanged.
    // Bytes, not `res.blob()`: wrapping one runtime's Blob in another's
    // constructor (undici's Response inside jsdom's Blob, on Node 20)
    // stringifies it to "[object Blob]" — 13 bytes of nothing. The browser
    // never hits that, but CI did, and bytes are the same everywhere (and a
    // Blob is what fetchFileUrl must not make). The type comes from the
    // header, parameters dropped.
    const bytes = await res.arrayBuffer();
    const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    return { bytes, type: safeBlobType(declared) };
}

/**
 * Fetch a file with the caller's credentials and return a `data:` URL for an
 * `<img>` (never a Blob: see the top of this file), or null when it cannot be
 * had (unauthenticated, deleted, network down). Callers render their
 * fallback on null rather than a broken image.
 */
export function fetchFileUrl(fileId: string): Promise<string | null> {
    const hit = cache.get(fileId);
    if (hit) return Promise.resolve(hit);

    const running = inflight.get(fileId);
    if (running) return running;

    const job = (async (): Promise<string | null> => {
        try {
            const f = await fetchFile(fileId);
            if (!f) return null;
            const url = `data:${f.type};base64,${bytesToB64(new Uint8Array(f.bytes))}`;
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
 * A file for a one-off `<audio>` (a sound's preview): a blob: URL, because
 * `media-src` allows no `data:` on Android or the web. Not cached: call
 * `release()` once it has played (or failed), so its Blob is not kept for the
 * session (see the top of this file). Null when it cannot be had.
 */
export async function fetchFileObjectUrl(fileId: string): Promise<{ url: string; release: () => void } | null> {
    try {
        const f = await fetchFile(fileId);
        if (!f) return null;
        const url = URL.createObjectURL(new Blob([f.bytes], { type: f.type }));
        let held = true;
        return { url, release: () => { if (held) { held = false; URL.revokeObjectURL(url); } } };
    } catch {
        return null;
    }
}

/**
 * Forget every cached URL. MUST run on logout: the next account signing in
 * on the same running app must not inherit the previous one's media.
 */
export function clearFileCache(): void {
    cache.clear();
    cachedChars = 0;
    inflight.clear();
}
