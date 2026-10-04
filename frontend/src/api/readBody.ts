/**
 * A fetch body as bytes, reporting how many have arrived as they arrive.
 *
 * `Response.arrayBuffer()` says nothing until the last byte is in, so a 24 MB
 * clip part or a 20 MB video looked frozen for as long as the link took to
 * carry it (6-26 s on a phone, measured 2026-10-04). Reading the body stream
 * instead lets the UI show bytes moving.
 *
 * `total` is the response's Content-Length when the server sends one. GET
 * /files streams chunked today and sends none, so callers that want a
 * fraction must supply their own estimate; the number of bytes received is
 * always exact.
 *
 * Memory: the chunks and the one buffer they are joined into exist together
 * for a moment, so a body costs about twice its size at its peak (the same
 * as decrypting it, which holds the sealed and the opened copy at once).
 *
 * DevTools — and CDP, so Playwright's `requestfailed` — may list a request
 * read this way as FAILED, `net::ERR_ABORTED`, although every byte arrived.
 * It is not an abort: a probe (2026-10-04) saw it come and go with response
 * headers alone (never with arrayBuffer()), every body complete, and the next
 * request reuse the same keep-alive connection; and a clip part that lost a
 * byte would fail its AES-GCM check, not play. Do not chase it.
 */
export type BytesProgress = (received: number, total: number | null) => void;

/** The declared body length, or null when there is none (or it is nonsense). */
export function contentLength(resp: Response): number | null {
    const raw = resp.headers.get('content-length');
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The whole body. With no `onBytes` (or a body the platform cannot stream)
 *  this is exactly `resp.arrayBuffer()`. */
export async function readBodyBytes(resp: Response, onBytes?: BytesProgress): Promise<Uint8Array> {
    const total = contentLength(resp);
    if (!onBytes || !resp.body) {
        const all = new Uint8Array(await resp.arrayBuffer());
        onBytes?.(all.byteLength, total);
        return all;
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        chunks.push(value);
        received += value.byteLength;
        onBytes(received, total);
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}
