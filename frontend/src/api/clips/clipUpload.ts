/**
 * Clip part uploader — runs INSIDE the replay worker so ciphertext parts never
 * cross to the main thread. Plain `fetch`, no apiClient (workers have no window).
 *
 * Wire contract with POST /upload (src/upload_handlers.rs, Phase 2):
 *   multipart fields IN THIS ORDER: kind=clip, clip_id, part_index, then file.
 *   The server reads the scalars first and runs the consent gate ("is this
 *   proposal approved, and yours?") BEFORE it reads a single body byte. Putting
 *   `file` first would let a modified client stream 24 MiB into server RAM per
 *   request before being refused, which is the exact thing the gate exists for.
 *
 * Idempotent by (clip_id, part_index): a retry after a lost response returns
 * the SAME row instead of a duplicate, so the consent stamp (which lists the
 * parts under this clip_id) stays a superset of the manifest.
 */

export interface UploadPartInput {
    index: number;
    /** Sealed wire bytes (SVCP header + ciphertext). */
    wire: Uint8Array;
}

export interface UploadOptions {
    baseUrl: string;
    token: string;
    clipId: string;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, bytesDone: number) => void;
    /** Ids already known from an earlier attempt (index → file id); those parts are skipped. */
    already?: ReadonlyMap<number, string>;
    /** Test seam. */
    fetchImpl?: typeof fetch;
    /** Test seam: retry delays in ms. */
    retryDelaysMs?: number[];
}

export class ClipUploadError extends Error {
    readonly failedIdx: number[];
    readonly status?: number;
    /** Ids that DID land (so the caller can keep them for a retry, or discard them). */
    readonly uploaded: ReadonlyMap<number, string>;
    constructor(message: string, failedIdx: number[], uploaded: ReadonlyMap<number, string>, status?: number) {
        super(message);
        this.name = 'ClipUploadError';
        this.failedIdx = failedIdx;
        this.uploaded = uploaded;
        this.status = status;
    }
}

/** Statuses that must NOT be retried: quota, our own sizing bug, auth, consent refusal. */
const NO_RETRY = new Set([400, 401, 403, 404, 409, 413, 507]);
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 9000];

async function uploadOne(p: UploadPartInput, o: UploadOptions, fetchImpl: typeof fetch): Promise<string> {
    const delays = o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        try {
            const fd = new FormData();
            fd.append('kind', 'clip');
            fd.append('clip_id', o.clipId);
            fd.append('part_index', String(p.index));
            fd.append('file', new Blob([p.wire as BlobPart], { type: 'application/octet-stream' }), 'clip.part');
            const res = await fetchImpl(`${o.baseUrl}/upload`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${o.token}` }, signal: o.signal });
            if (res.ok) {
                const j = await res.json() as { id?: string };
                if (!j || typeof j.id !== 'string') throw new Error('upload response had no id');
                return j.id;
            }
            const err = Object.assign(new Error(`upload of part ${p.index} failed: HTTP ${res.status}`), { status: res.status });
            if (NO_RETRY.has(res.status)) throw err;
            lastErr = err;
        } catch (e) {
            if ((e as { name?: string }).name === 'AbortError') throw e;
            const status = (e as { status?: number }).status;
            if (status !== undefined && NO_RETRY.has(status)) throw e;
            lastErr = e;
        }
        if (attempt < delays.length) await new Promise(r => setTimeout(r, delays[attempt]));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Upload every part not in `already`, `concurrency` at a time. Resolves with
 * the full index → id map. Rejects with ClipUploadError carrying what DID land.
 */
export async function uploadParts(parts: readonly UploadPartInput[], o: UploadOptions): Promise<Map<number, string>> {
    const fetchImpl = o.fetchImpl ?? fetch;
    const done = new Map<number, string>(o.already ?? []);
    const todo = parts.filter(p => !done.has(p.index));
    const total = parts.length;
    let bytesDone = 0;
    for (const p of parts) if (done.has(p.index)) bytesDone += p.wire.byteLength;
    o.onProgress?.(done.size, total, bytesDone);
    const failed: { index: number; status?: number; message: string }[] = [];
    let cursor = 0;
    let stop = false;
    const worker = async () => {
        while (!stop && cursor < todo.length) {
            const p = todo[cursor++];
            try {
                const id = await uploadOne(p, o, fetchImpl);
                done.set(p.index, id);
                bytesDone += p.wire.byteLength;
                o.onProgress?.(done.size, total, bytesDone);
            } catch (e) {
                const status = (e as { status?: number }).status;
                failed.push({ index: p.index, status, message: e instanceof Error ? e.message : String(e) });
                // A refusal (consent/quota/auth) will refuse every part — stop early.
                if ((e as { name?: string }).name === 'AbortError' || (status !== undefined && NO_RETRY.has(status))) stop = true;
            }
        }
    };
    const n = Math.max(1, Math.min(o.concurrency ?? 2, todo.length || 1));
    await Promise.all(Array.from({ length: n }, worker));
    if (failed.length) {
        const first = failed[0];
        throw new ClipUploadError(first.message, failed.map(f => f.index).sort((a, b) => a - b), done, first.status);
    }
    return done;
}

/** Fire-and-forget DELETE of parts we are not going to reference. */
export function discardParts(ids: Iterable<string>, o: Pick<UploadOptions, 'baseUrl' | 'token' | 'fetchImpl'>): void {
    const fetchImpl = o.fetchImpl ?? fetch;
    for (const id of ids) {
        void fetchImpl(`${o.baseUrl}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${o.token}` } }).catch(() => { /* best effort */ });
    }
}

export interface ClipUsage {
    usedBytes: number;
    quotaBytes: number;
}

/**
 * How much of this account's clip storage is used — `GET /clips/usage`,
 * wire shape `{used_bytes, quota_bytes}` (upload_handlers::clip_usage; the
 * snake_case names are the Rust side's serde output, pinned there).
 *
 * `null` on ANY failure. On a server predating the route the path does not
 * even miss cleanly — axum matches it into `GET /clips/:clip_id` with
 * clip_id "usage", whose proposal lookup 404s — but every non-2xx lands in
 * the same null, so the readout renders nothing rather than an error and
 * this ships order-independently of the server release that adds the
 * endpoint. (Server side: axum's router gives the static segment priority
 * over `/clips/:clip_id` regardless of registration order.)
 */
export async function getClipUsage(
    o: Pick<UploadOptions, 'baseUrl' | 'token' | 'fetchImpl'>,
): Promise<ClipUsage | null> {
    const fetchImpl = o.fetchImpl ?? fetch;
    try {
        const res = await fetchImpl(`${o.baseUrl}/clips/usage`, {
            headers: { Authorization: `Bearer ${o.token}` },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { used_bytes?: unknown; quota_bytes?: unknown };
        if (typeof body.used_bytes !== 'number' || typeof body.quota_bytes !== 'number') return null;
        return { usedBytes: body.used_bytes, quotaBytes: body.quota_bytes };
    } catch {
        return null;
    }
}
