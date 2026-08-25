/**
 * Clip playback on the VIEWER side (every platform, including phones).
 *
 *  'mse'         MediaSource, WINDOWED: append the init part, then parts in
 *                order but only ~40 s AHEAD of the playhead (PLAY_AHEAD_S),
 *                evicting what is more than ~12 s BEHIND it (KEEP_BEHIND_S)
 *                and retrying a QuotaExceededError after freeing behind.
 *                `attach()` resolves as soon as the first media part is in
 *                (playable), not after the whole clip. Why: a SourceBuffer
 *                has a browser quota (~150 MB video on desktop Chromium,
 *                less on phones) and the first version appended EVERYTHING
 *                up front — a 257 MB 1440p clip failed for every viewer with
 *                "The SourceBuffer is full, and cannot free space" because
 *                nothing was behind a playhead still at 0. Seek = pick the
 *                part containing the target (partDurMs), abort, re-append
 *                init (cached) and continue from that part.
 *                `timestampOffset` stays 0 — fragments carry absolute tfdt.
 *  'blob'        No MediaSource (iOS WKWebView) AND the whole clip is under
 *                the blob cap: fetch+decrypt everything, `new Blob(parts)`.
 *                Valid because parts concatenate to the muxer's exact output.
 *                Chromium's blob storage may spill large blobs to the VIEWER's
 *                disk — the same exposure every attachment already accepts —
 *                which is why the cap is small.
 *  'unsupported' Otherwise: "open it on desktop".
 *
 * Never cache clip blobs in attachments.ts's blobCache (unbounded, ≤25 MB
 * assumption). Fetch parts through GET /files/:id with the auth token.
 */
import { API_BASE_URL } from '../config';
import { getToken } from '../auth';
import { openPart, type ClipSecrets, uuidToBytes } from './clipCrypto';
import { partIndexForTime, type ClipManifest } from './clipRef';

export type ClipPlaybackMode = 'mse' | 'blob' | 'unsupported';

/** Spike S10: no spill seen up to 512 MiB on a 32 GB desktop; keep the cap
 *  conservative for phones. */
export const BLOB_FALLBACK_CAP_BYTES = 32 * 1024 * 1024;
/** Download builds the WHOLE plaintext in memory (chunks + Blob, and the
 *  desktop save path reads it once more for the native command) — three
 *  copies of the clip in the renderer. A manifest can describe up to 64 × 24
 *  MiB = 1.5 GiB; above this cap the button refuses rather than thrash. */
export const CLIP_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

export interface PlaybackEnv {
    hasMediaSource: boolean;
    isTypeSupported: (type: string) => boolean;
    blobCapBytes?: number;
}

export function mseType(m: ClipManifest, videoCodec: string): string {
    return `video/mp4; codecs="${videoCodec}, ${m.audioCodec}"`;
}

/** The manifest's own (actual) codec first; a generic ladder as a fallback for
 *  a UA that rejects an unusual level string but plays the family fine. */
const AVC_FALLBACKS = ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028', 'avc1.42E028'];

export function pickMseType(m: ClipManifest, isTypeSupported: (t: string) => boolean): string | null {
    for (const c of [m.videoCodec, ...AVC_FALLBACKS]) {
        const t = mseType(m, c);
        if (isTypeSupported(t)) return t;
    }
    return null;
}

export function clipPlaybackMode(m: ClipManifest, env: PlaybackEnv = defaultEnv()): ClipPlaybackMode {
    if (env.hasMediaSource && pickMseType(m, env.isTypeSupported)) return 'mse';
    if (m.totalCipherBytes <= (env.blobCapBytes ?? BLOB_FALLBACK_CAP_BYTES)) return 'blob';
    return 'unsupported';
}

function defaultEnv(): PlaybackEnv {
    const has = typeof MediaSource !== 'undefined';
    return { hasMediaSource: has, isTypeSupported: (t) => has && MediaSource.isTypeSupported(t) };
}

async function fetchPartBytes(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const token = getToken();
    const resp = await fetch(`${API_BASE_URL}/files/${fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal });
    if (!resp.ok) throw Object.assign(new Error(`part ${fileId}: HTTP ${resp.status}`), { status: resp.status });
    return new Uint8Array(await resp.arrayBuffer());
}

function secretsOf(m: ClipManifest): ClipSecrets {
    return { key: m.key, noncePrefix: m.noncePrefix, clipId: uuidToBytes(m.clipId) };
}

export interface ClipDownloadProgress { done: number; total: number; bytesDone: number; totalBytes: number }

/**
 * Fetch + decrypt every part IN ORDER and concatenate them. Parts are exactly
 * the muxer's original output, cut only at fragment boundaries (fmp4Split.ts),
 * so this reconstructs the recorded file byte-for-byte — not a re-encode, the
 * same bytes that were sealed. Used only from ClipAttachment, after a clip has
 * been posted (every required approver already agreed to release it).
 */
export async function downloadClipBytes(
    m: ClipManifest,
    onProgress?: (p: ClipDownloadProgress) => void,
    fetchPart: (id: string, signal?: AbortSignal) => Promise<Uint8Array> = fetchPartBytes,
): Promise<Blob> {
    if (m.totalCipherBytes > CLIP_DOWNLOAD_MAX_BYTES) throw new Error(`this clip is ${Math.round(m.totalCipherBytes / (1024 * 1024))} MB — too large to download in the app`);
    const secrets = secretsOf(m);
    const chunks: Uint8Array[] = [];
    let bytesDone = 0;
    for (let i = 0; i < m.parts.length; i++) {
        const wire = await fetchPart(m.parts[i]);
        const plain = await openPart(secrets, i, wire);
        chunks.push(plain);
        bytesDone += plain.byteLength;
        onProgress?.({ done: i + 1, total: m.parts.length, bytesDone, totalBytes: m.totalCipherBytes });
    }
    return new Blob(chunks as BlobPart[], { type: 'video/mp4' });
}

export interface ClipPlayerHandle {
    mode: ClipPlaybackMode;
    /** Resolves once the clip is PLAYABLE (init + first media part appended),
     *  not once it is fully loaded; later parts stream in behind the playhead. */
    attach(el: HTMLVideoElement): Promise<void>;
    destroy(): void;
    /** A failure AFTER attach() resolved (a later part 404s, an unrecoverable
     *  quota error). Set before calling attach(). */
    onError?: (e: Error) => void;
}

/** Keep at most this much media buffered past the playhead before pausing
 *  appends — comfortably under any browser's SourceBuffer quota at the
 *  highest preset (20 Mbps ≈ 100 MB for 40 s) while never letting the
 *  playhead run dry on a slow fetch. */
export const PLAY_AHEAD_S = 40;
/** Evict media older than this behind the playhead. */
export const KEEP_BEHIND_S = 12;

export function createClipPlayer(m: ClipManifest, env: PlaybackEnv = defaultEnv(), fetchPart: (id: string, signal?: AbortSignal) => Promise<Uint8Array> = fetchPartBytes): ClipPlayerHandle {
    const mode = clipPlaybackMode(m, env);
    const secrets = secretsOf(m);
    const abort = new AbortController();
    let el: HTMLVideoElement | null = null;
    let objectUrl: string | null = null;
    let ms: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    let initBytes: Uint8Array | null = null;
    let destroyed = false;
    const decrypted = new Map<number, Promise<Uint8Array>>();
    const handle: ClipPlayerHandle = { mode, attach, destroy };

    const getPart = (i: number): Promise<Uint8Array> => {
        let p = decrypted.get(i);
        if (!p) {
            p = fetchPart(m.parts[i], abort.signal).then(wire => openPart(secrets, i, wire));
            decrypted.set(i, p);
            p.catch(() => decrypted.delete(i));
        }
        return p;
    };

    const sbOp = (run: () => void): Promise<void> => new Promise((resolve, reject) => {
        if (!sb || destroyed) return reject(new Error('player destroyed'));
        const buf = sb;
        const onEnd = () => { buf.removeEventListener('error', onErr); resolve(); };
        const onErr = () => { buf.removeEventListener('updateend', onEnd); reject(new Error('append failed')); };
        buf.addEventListener('updateend', onEnd, { once: true });
        buf.addEventListener('error', onErr, { once: true });
        try { run(); } catch (e) { buf.removeEventListener('updateend', onEnd); buf.removeEventListener('error', onErr); reject(e); }
    });
    const append = (bytes: Uint8Array) => sbOp(() => sb!.appendBuffer(bytes as BufferSource));
    const remove = (a: number, b: number) => sbOp(() => sb!.remove(a, b));

    /** End of the buffered range that contains `t` (±0.5 s slack), or -1. */
    const bufferedEndAt = (t: number): number => {
        if (!sb) return -1;
        for (let i = 0; i < sb.buffered.length; i++) {
            if (sb.buffered.start(i) - 0.5 <= t && t <= sb.buffered.end(i) + 0.5) return sb.buffered.end(i);
        }
        return -1;
    };

    /** Append, and on QuotaExceededError free what the playhead no longer
     *  needs (behind it first, then anything far ahead left by a seek) and
     *  retry. Only gives up when nothing can be freed — i.e. a single part
     *  does not fit at all. */
    const appendWithQuota = async (bytes: Uint8Array): Promise<void> => {
        for (let attempt = 0; attempt < 8; attempt++) {
            try { await append(bytes); return; }
            catch (e) {
                const name = (e as { name?: string } | null)?.name;
                if (name !== 'QuotaExceededError' || !sb || !el) throw e;
                const cur = el.currentTime;
                // Free progressively more each retry: first everything strictly
                // behind the playhead (keep a 1 s cushion so we do not evict the
                // frame being shown), then trim the far-ahead tail a seek left,
                // then — last resort — narrow to a tight window right around the
                // playhead. If even that leaves no room, the single part is
                // genuinely larger than the buffer quota.
                let freed = false;
                const behindCut = Math.max(0, cur - 1);
                if (sb.buffered.length && sb.buffered.start(0) < behindCut - 0.01) { await remove(0, behindCut); freed = true; }
                const last = sb.buffered.length - 1;
                if (!freed && last >= 0 && sb.buffered.end(last) > cur + Math.max(4, PLAY_AHEAD_S - attempt * 8) + 0.01) {
                    await remove(cur + Math.max(4, PLAY_AHEAD_S - attempt * 8), sb.buffered.end(last)); freed = true;
                }
                if (!freed) throw new Error("this clip's parts are too large for the browser's playback buffer — use Download");
            }
        }
        throw new Error("this clip's parts are too large for the browser's playback buffer — use Download");
    };

    // ---- the windowed pump -------------------------------------------------
    let nextIdx = 1;          // next part to append, contiguous from the last (re)start
    let needInit = false;     // re-append the init segment first (after a seek's abort)
    let loadGen = 0;          // bumped by seeks so an in-flight append is discarded
    let wakeFn: (() => void) | null = null;
    let wakePending = false;
    const wake = () => { if (wakeFn) { const w = wakeFn; wakeFn = null; w(); } else wakePending = true; };
    const waitForWake = (): Promise<void> => {
        if (wakePending) { wakePending = false; return Promise.resolve(); }
        return new Promise<void>(r => { wakeFn = r; });
    };
    let firstRes: (() => void) | null = null;
    let firstRej: ((e: Error) => void) | null = null;
    const firstPlayable = new Promise<void>((res, rej) => { firstRes = res; firstRej = rej; });
    const fail = (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        firstRej?.(err); firstRej = null; firstRes = null;
        handle.onError?.(err);
    };

    const pump = async (): Promise<void> => {
        while (!destroyed) {
            if (!sb || !el || nextIdx >= m.parts.length) { await waitForWake(); continue; }
            const cur = el.currentTime;
            const end = bufferedEndAt(cur);
            // Enough runway, and the first part is already in: wait for the
            // playhead to move (timeupdate / seeking wake us).
            if (end >= 0 && end - cur >= PLAY_AHEAD_S && nextIdx > 1 && !needInit) { await waitForWake(); continue; }
            const gen = loadGen;
            const idx = nextIdx;
            void getPart(idx + 1).catch(() => { /* prefetch failure surfaces on its own turn */ });
            let bytes: Uint8Array;
            try { bytes = await getPart(idx); } catch (e) { if (destroyed) return; fail(e); return; }
            if (destroyed) return;
            if (gen !== loadGen) continue; // a seek moved nextIdx while we fetched — re-evaluate
            try {
                if (needInit) { needInit = false; await append(initBytes!); }
                const cut = cur - KEEP_BEHIND_S;
                if (cut > 0 && sb.buffered.length && sb.buffered.start(0) < cut) await remove(0, cut).catch(() => { /* eviction is best effort */ });
                if (destroyed || gen !== loadGen) continue;
                await appendWithQuota(bytes);
            } catch (e) {
                if (destroyed) return;
                if (gen !== loadGen) continue; // aborted by a seek — expected
                fail(e);
                return;
            }
            if (gen !== loadGen) continue;
            nextIdx = idx + 1;
            if (firstRes) { firstRes(); firstRes = null; firstRej = null; }
            if (nextIdx >= m.parts.length && ms && ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* ignore */ } }
        }
    };

    async function attach(video: HTMLVideoElement): Promise<void> {
        el = video;
        if (mode === 'unsupported') throw new Error('unsupported');
        if (mode === 'blob') {
            const chunks: Uint8Array[] = [];
            for (let i = 0; i < m.parts.length; i++) chunks.push(await getPart(i));
            objectUrl = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'video/mp4' }));
            video.src = objectUrl;
            return;
        }
        const type = pickMseType(m, env.isTypeSupported)!;
        ms = new MediaSource();
        const opened = new Promise<void>(r => ms!.addEventListener('sourceopen', () => r(), { once: true }));
        objectUrl = URL.createObjectURL(ms);
        video.src = objectUrl;
        await opened;
        if (destroyed) return;
        sb = ms.addSourceBuffer(type);
        ms.duration = m.durationMs / 1000;
        initBytes = await getPart(0);
        await append(initBytes);
        // The playhead drives the window; a seek outside the buffered ranges
        // restarts the contiguous run from the part that contains the target
        // (GET /files has no Range support, so a part is the seek granularity).
        video.addEventListener('timeupdate', wake);
        video.addEventListener('seeking', () => {
            if (!sb || destroyed) return;
            const t = video.currentTime * 1000;
            for (let i = 0; i < sb.buffered.length; i++) {
                if (sb.buffered.start(i) * 1000 <= t && t <= sb.buffered.end(i) * 1000) { wake(); return; } // buffered — just keep pumping ahead
            }
            loadGen++;
            try { if (sb.updating) sb.abort(); } catch { /* ignore */ }
            nextIdx = partIndexForTime(m, t);
            needInit = true;
            wake();
        });
        void pump();
        await firstPlayable;
    }

    function destroy(): void {
        destroyed = true;
        abort.abort();
        wake();
        if (el) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ } }
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        decrypted.clear();
        initBytes = null;
        sb = null; ms = null; el = null;
    }

    return handle;
}
