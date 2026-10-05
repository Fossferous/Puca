/**
 * Clip playback on the VIEWER side (every platform, including phones).
 *
 *  'mse'         MediaSource, WINDOWED: append the init part, then parts in
 *                order but only ~40 s AHEAD of the playhead (PLAY_AHEAD_S),
 *                evicting what is more than ~12 s BEHIND it (KEEP_BEHIND_S)
 *                without ever leaving an unplayable single-track remnant
 *                (evictBefore), holding decrypted copies only of the parts
 *                in that window (forgetOutsideWindow), and retrying a
 *                QuotaExceededError after freeing behind.
 *                `attach()` resolves as soon as the first media part is in
 *                (playable) — or, on a link under about twice the clip's
 *                bitrate, once enough more is in that the first ~40 s will
 *                not stall (the start-up gate, `startBytesNeeded`) — never
 *                after the whole clip. Why: a SourceBuffer
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
import { readBodyBytes, type BytesProgress } from '../readBody';
import { openPart, PART_HEADER_BYTES, PART_MAX_PLAINTEXT, PART_TAG_BYTES, type ClipSecrets, uuidToBytes } from './clipCrypto';
import { partIndexForTime, partStartMs, type ClipManifest } from './clipRef';

export type ClipPlaybackMode = 'mse' | 'blob' | 'unsupported';

/** Spike S10: no spill seen up to 512 MiB on a 32 GB desktop; keep the cap
 *  conservative for phones. */
export const BLOB_FALLBACK_CAP_BYTES = 32 * 1024 * 1024;
/** Download on desktop and the web builds the WHOLE plaintext in memory
 *  (chunks + Blob, and the desktop save path reads it once more for the
 *  native command) — three copies of the clip in the renderer. (The Android
 *  app streams it part by part instead: forEachClipPart.) A manifest can
 *  describe up to 64 × 24 MiB = 1.5 GiB; above this cap the button refuses
 *  rather than thrash. */
export const CLIP_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

export interface PlaybackEnv {
    hasMediaSource: boolean;
    isTypeSupported: (type: string) => boolean;
    blobCapBytes?: number;
    /** Milliseconds, for the start-up gate's throughput (default performance.now). */
    now?: () => number;
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

/** Fetches one part's sealed bytes; `onBytes` hears them arrive. */
export type PartFetcher = (id: string, signal?: AbortSignal, onBytes?: BytesProgress) => Promise<Uint8Array>;

const fetchPartBytes: PartFetcher = async (fileId, signal, onBytes) => {
    const token = getToken();
    const resp = await fetch(`${API_BASE_URL}/files/${fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal });
    if (!resp.ok) throw Object.assign(new Error(`part ${fileId}: HTTP ${resp.status}`), { status: resp.status });
    return readBodyBytes(resp, onBytes);
};

/** What the init part is assumed to weigh before it arrives (it is ~1 KB). */
const INIT_PART_ESTIMATE_BYTES = 4096;

/**
 * About how many sealed bytes part `index` is. The manifest carries only the
 * clip's total (GET /files sends no Content-Length), so a media part gets the
 * share of it that its duration is of the clip's — the encoder runs at a
 * roughly constant rate. Only ever used for a progress readout.
 */
export function estimatePartBytes(m: ClipManifest, index: number): number {
    if (index === 0) return Math.min(INIT_PART_ESTIMATE_BYTES, m.totalCipherBytes);
    const media = Math.max(0, m.totalCipherBytes - INIT_PART_ESTIMATE_BYTES);
    const mediaParts = m.parts.length - 1;
    if (mediaParts <= 0) return 0;
    const totalDur = m.partDurMs.slice(1).reduce((a, d) => a + d, 0);
    const share = totalDur > 0 ? (m.partDurMs[index] ?? 0) / totalDur : 1 / mediaParts;
    return Math.round(media * share);
}

/**
 * THE START-UP GATE: how many sealed bytes, counted from the first byte of
 * the part the playhead starts in, must be in hand before playback starts, so
 * that no part within `horizonMs` of the start arrives after the playhead
 * needs it.
 *
 * Parts download one after another (the pump fetches the next only once the
 * previous is in), so with `inHand` bytes received and the link carrying
 * `bytesPerMs`, part k is complete after (cum_k - inHand) / bytesPerMs, and
 * the playhead reaches it after the media before it has played. Playback can
 * start once inHand >= cum_k - bytesPerMs * before_k for every k in the
 * horizon; the k = 0 term is the whole first part, which is all the old
 * player ever waited for.
 *
 * Why it exists: new clips are sealed with a RAMP of small first parts
 * (fmp4Split PART_RAMP_FRAGMENTS, each twice as long as the last), and part
 * k+1 must then download within part k's play time — a link of at least
 * TWICE the clip's bitrate. Between one and two times, starting on the first
 * part alone froze a 1440p clip (8.9 Mbit/s) on a 12 Mbit/s link at 0:02,
 * 0:06, 0:14 and 0:30 (measured 2026-10-04). The gate turns those stalls into
 * one shorter wait up front (~8 s there, against ~17 s for the same footage
 * cut flat), and costs nothing on a link of twice the bitrate or more, nor
 * for a clip cut flat on a link at least as fast as its bitrate.
 *
 * `capBytes` bounds it: on a link SLOWER than the clip's bitrate no start
 * avoids stalls, and the gate never waits for more than one FULL part (the
 * cap the player passes: 24 MiB plus the seal) — about what a flat cut's
 * first part made the viewer wait for, not exactly: a clip that IS cut flat
 * has a first part up to one fragment under the cap, so on such a link it can
 * wait for that much of its second part too (~0.8 MB of a 1440p clip,
 * measured 2026-10-04), and the stall that follows anyway is that much
 * shorter. `bytesPerMs` null (nothing measured yet) asks for the first part
 * only. `offsetMs` is how far into the first part the playhead starts (a
 * scrub before the first play).
 */
export function startBytesNeeded(
    sizes: readonly number[],
    durMs: readonly number[],
    bytesPerMs: number | null,
    horizonMs: number,
    capBytes: number,
    offsetMs = 0,
): number {
    const first = sizes[0] ?? 0;
    // Nothing measured yet, or a link too fast to time: the first part only.
    if (bytesPerMs === null || !Number.isFinite(bytesPerMs) || bytesPerMs <= 0) return first;
    let cum = 0;
    let before = 0; // media (ms) the playhead plays before reaching part k
    let need = first;
    for (let k = 0; k < sizes.length && before < horizonMs; k++) {
        cum += sizes[k];
        need = Math.max(need, cum - bytesPerMs * before);
        before = Math.max(0, before + (durMs[k] ?? 0) - (k === 0 ? offsetMs : 0));
    }
    return Math.max(first, Math.min(need, capBytes));
}

function secretsOf(m: ClipManifest): ClipSecrets {
    return { key: m.key, noncePrefix: m.noncePrefix, clipId: uuidToBytes(m.clipId) };
}

export interface ClipDownloadProgress {
    /** Parts handed over in full (written to the device, on a phone). */
    done: number;
    total: number;
    /** Sealed bytes RECEIVED so far, across every part — moves while a part
     *  is still downloading, not once per part. */
    bytesDone: number;
    /** The manifest's totalCipherBytes. */
    totalBytes: number;
}

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
    fetchPart: PartFetcher = fetchPartBytes,
): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    await forEachClipPart(m, async (plain) => { chunks.push(plain); }, onProgress, fetchPart);
    return new Blob(chunks as BlobPart[], { type: 'video/mp4' });
}

/**
 * The same bytes as downloadClipBytes, handed over ONE PART AT A TIME, in
 * order, never more than TWO parts in hand: while `onPart` handles part i,
 * part i+1 is fetched and decrypted, and part i+2 is not requested until
 * `onPart(i)` has returned. So the caller holds at most two parts (≤ 48 MiB
 * plaintext), never the whole clip — the phone's Download uses this
 * (api/clipDownload.ts), where building a whole clip and pushing it through
 * the Capacitor bridge in one piece killed the app.
 *
 * The transient peak is higher than the plaintext: while part i is written,
 * part i+1 briefly exists twice — its chunks and their joined copy
 * (readBodyBytes), then its sealed and opened copies (openPart) — so about
 * three parts, ~72 MiB plus the ≤ 4 MiB bridge slice, against ~48 MiB when
 * the next part waited for the write (estimated from the code, not
 * measured). Still bounded whatever the clip's length, and it is renderer
 * memory: the 0.9.831 crash was the bridge's whole-clip string on the Java
 * side, and each bridge message stays ≤ 4 MiB.
 *
 * Why one part ahead and not zero: on a phone `onPart` is the bridge write
 * (base64 + JSON + a file append, ~10 MB/s on the measured emulator), and
 * fetching only after it returned made the total network time PLUS write
 * time — the link idle for 4-5 s after every 24 MiB part (2026-10-04: 51.5 s
 * for a 129 MB clip). With the next part on its way, the two overlap.
 *
 * A failure anywhere stops the run and cancels the part in flight. Hands
 * bytes to a callback only — it writes nothing itself.
 */
export async function forEachClipPart(
    m: ClipManifest,
    onPart: (plain: Uint8Array, index: number) => Promise<void>,
    onProgress?: (p: ClipDownloadProgress) => void,
    fetchPart: PartFetcher = fetchPartBytes,
): Promise<void> {
    if (m.totalCipherBytes > CLIP_DOWNLOAD_MAX_BYTES) throw new Error(`this clip is ${Math.round(m.totalCipherBytes / (1024 * 1024))} MB — too large to download in the app`);
    const secrets = secretsOf(m);
    const abort = new AbortController();
    const got = new Array<number>(m.parts.length).fill(0);
    let bytesDone = 0;
    let done = 0;
    const report = () => onProgress?.({ done, total: m.parts.length, bytesDone, totalBytes: m.totalCipherBytes });
    const heard = (i: number, n: number) => { bytesDone += n - got[i]; got[i] = n; };
    const load = (i: number): Promise<Uint8Array> =>
        fetchPart(m.parts[i], abort.signal, (n) => { heard(i, n); report(); })
            .then((wire) => { heard(i, wire.byteLength); report(); return openPart(secrets, i, wire); });
    try {
        let next = load(0);
        for (let i = 0; i < m.parts.length; i++) {
            const plain = await next;
            if (i + 1 < m.parts.length) {
                next = load(i + 1);
                next.catch(() => { /* surfaces when awaited — or was cancelled by the failure that ended the run */ });
            }
            await onPart(plain, i);
            done = i + 1;
            report();
        }
    } finally {
        abort.abort();
    }
}

/** Bytes received toward the first playable moment, and about how many that
 *  takes (`needed` is an estimate until each part's real size is known, and
 *  includes what the start-up gate asks for at the throughput measured so
 *  far, so it moves as that does; it never falls below `loaded`). `needed` is
 *  null until there IS a throughput: a figure before that would be the first
 *  part alone — on a ramped clip ~2 MB — and the gate's real one, a second
 *  later, up to six times larger ("1.4 / 2.1 MB", then "1.4 / 13 MB": the
 *  readout looked restarted, review 2026-10-04). */
export interface ClipLoadProgress { loaded: number; needed: number | null }

export interface ClipPlayerHandle {
    mode: ClipPlaybackMode;
    /** Resolves once the clip is PLAYABLE (init + first media part appended,
     *  and the start-up gate met: startBytesNeeded), not once it is fully
     *  loaded; later parts stream in behind the playhead. */
    attach(el: HTMLVideoElement): Promise<void>;
    destroy(): void;
    /** A failure AFTER attach() resolved (a later part 404s, an unrecoverable
     *  quota error). Set before calling attach(). */
    onError?: (e: Error) => void;
    /** Download progress until attach() resolves — what a viewer waits for is
     *  bytes on the wire, not decryption. Set before calling attach(). */
    onLoadProgress?: (p: ClipLoadProgress) => void;
}

/** Keep at most this much media buffered past the playhead before pausing
 *  appends — comfortably under any browser's SourceBuffer quota at the
 *  highest preset (20 Mbps ≈ 100 MB for 40 s) while never letting the
 *  playhead run dry on a slow fetch. */
export const PLAY_AHEAD_S = 40;
/** Evict media older than this behind the playhead. */
export const KEEP_BEHIND_S = 12;

export function createClipPlayer(m: ClipManifest, env: PlaybackEnv = defaultEnv(), fetchPart: PartFetcher = fetchPartBytes): ClipPlayerHandle {
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

    // ---- load progress and the start-up gate, until the clip is playable -----
    // MSE plays once the init part and enough of the run that starts at the
    // part the playhead is waiting for are in (startBytesNeeded: the first
    // media part, or more on a link under twice the clip's bitrate); the blob
    // fallback needs every part.
    const now = env.now ?? (() => performance.now());
    const received = new Map<number, number>();
    const knownSize = new Map<number, number>();
    const sizeOf = (i: number) => Math.max(received.get(i) ?? 0, knownSize.get(i) ?? estimatePartBytes(m, i));
    let playable = false;
    /** When the first media part was requested: the throughput the gate
     *  predicts with is every media byte received since, over the time since
     *  (so it includes each part's request round trip and decryption). */
    let mediaT0: number | null = null;
    /** Until the run's first part is in, a rate over less than this is mostly
     *  the request's round trip, and the readout asked for the 24 MiB cap
     *  ("0.1 / 24 MB") before settling (measured 2026-10-04). */
    const RATE_SAMPLE_MS = 1000;
    const mediaBytesPerMs = (firstPartIn: boolean): number | null => {
        if (mediaT0 === null) return null;
        let got = 0;
        for (const [i, n] of received) if (i > 0) got += n;
        if (got <= 0) return null;
        const ms = now() - mediaT0;
        if (ms < RATE_SAMPLE_MS && !firstPartIn) return null;
        return ms > 0 ? got / ms : Infinity;
    };
    /** The run the playhead will play from: its first part, and how far into
     *  that part the playhead stands (a scrub before the first play). */
    let runStart = 1;
    let runOffsetMs = 0;
    /** runStart's part is appended: the clip COULD play now. */
    let runReady = false;
    const runGate = (): { inHand: number; needed: number; measured: boolean } => {
        const sizes: number[] = [];
        const durs: number[] = [];
        let inHand = 0;
        let contiguous = true; // every part before this one is entirely in
        let firstPartIn = false;
        for (let i = runStart; i < m.parts.length; i++) {
            sizes.push(sizeOf(i));
            durs.push(m.partDurMs[i] ?? 0);
            const got = received.get(i) ?? 0;
            if (contiguous) inHand += got;
            const known = knownSize.get(i);
            contiguous = contiguous && known !== undefined && got >= known;
            if (i === runStart) firstPartIn = contiguous;
        }
        const rate = mediaBytesPerMs(firstPartIn);
        const needed = startBytesNeeded(sizes, durs, rate, PLAY_AHEAD_S * 1000, PART_MAX_PLAINTEXT + PART_HEADER_BYTES + PART_TAG_BYTES, runOffsetMs);
        return { inHand, needed: Math.max(needed, inHand), measured: rate !== null };
    };
    const reportLoad = () => {
        if (playable || !handle.onLoadProgress) return;
        let loaded = 0;
        let needed: number | null = 0;
        if (mode === 'blob') {
            for (let i = 0; i < m.parts.length; i++) { loaded += received.get(i) ?? 0; needed += sizeOf(i); }
        } else {
            const gate = runGate();
            loaded = (received.get(0) ?? 0) + gate.inHand;
            needed = gate.measured ? sizeOf(0) + gate.needed : null;
        }
        handle.onLoadProgress({ loaded, needed });
    };

    const getPart = (i: number): Promise<Uint8Array> => {
        let p = decrypted.get(i);
        if (!p) {
            if (i > 0 && mediaT0 === null) mediaT0 = now();
            p = fetchPart(m.parts[i], abort.signal, (n, total) => {
                received.set(i, n);
                if (total !== null) knownSize.set(i, total);
                reportLoad();
                maybePlayable();
            }).then(wire => {
                received.set(i, wire.byteLength);
                knownSize.set(i, wire.byteLength);
                reportLoad();
                return openPart(secrets, i, wire);
            });
            decrypted.set(i, p);
            const mine = p;
            mine.catch(() => { if (decrypted.get(i) === mine) decrypted.delete(i); });
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

    /** Evict everything before `t` — and then, if no moment is left where
     *  BOTH tracks are buffered, whatever remains. A cut inside a video GOP
     *  removes the rest of that GOP's video too (frames cannot decode without
     *  their keyframe — MSE's coded frame removal) while the audio beside it,
     *  every frame of it a keyframe, stays. So a cut in the LAST GOP of the
     *  buffered range leaves an audio-only sliver: `buffered`, the tracks'
     *  intersection, reads empty, and Chromium charges the next append to the
     *  tracks in proportion to what each holds — a whole 17-24 MB part
     *  against audio's ~12 MB limit — and refuses it with QuotaExceededError.
     *  A seek ~10-12 s past the buffered end did exactly that and killed the
     *  clip ("this clip's parts are too large...", reproduced in Edge
     *  2026-10-04). Nothing in such a remnant can play: clearing it is free. */
    const evictBefore = async (t: number): Promise<void> => {
        await remove(0, t);
        if (sb && !destroyed && sb.buffered.length === 0) await remove(0, Infinity);
    };

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
        let clearedRemnant = false;
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
                if (sb.buffered.length && sb.buffered.start(0) < behindCut - 0.01) { await evictBefore(behindCut); freed = true; }
                const last = sb.buffered.length - 1;
                if (!freed && last >= 0 && sb.buffered.end(last) > cur + Math.max(4, PLAY_AHEAD_S - attempt * 8) + 0.01) {
                    await remove(cur + Math.max(4, PLAY_AHEAD_S - attempt * 8), sb.buffered.end(last)); freed = true;
                }
                // Nothing playable is buffered and there is still no room: a
                // single-track remnant (evictBefore's case, left by anything
                // else) can be all that holds the quota. Clearing it costs
                // nothing; once, so a part that does not fit even an empty
                // buffer still ends here.
                if (!freed && sb.buffered.length === 0 && !clearedRemnant) { clearedRemnant = true; await remove(0, Infinity); freed = true; }
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
    /** Stop holding the plaintext of every part outside the window around
     *  the playhead at `cur` (s): ending KEEP_BEHIND_S or more behind it
     *  (what the pump has evicted from the SourceBuffer), or starting
     *  PLAY_AHEAD_S or more ahead of it (left there by a seek back) unless it
     *  is the part the pump fetches next or the one after (its prefetch).
     *  Holding every part kept the whole clip in the renderer next to the
     *  SourceBuffer's own copy: the page's ArrayBuffers went from 21 MB to
     *  144 MB over a 123 MB clip played through (Edge, 2026-10-04; 75 MB
     *  with this), and a long 4K clip would hold ~1 GB, on a phone; a
     *  scrub backwards through it held every part it passed (144 MB again
     *  when dropping only the parts behind; 90 MB with the window, both
     *  ends, 2026-10-05). What stays is about one window — ~40 s of parts
     *  plus the first — however long the clip. The cost: a seek
     *  back to a part, or playing on into one dropped ahead, fetches it again.
     *  The first part stays — "watch it again" is the seek back people make,
     *  and on a ramped clip it is ~2 MB. */
    const forgetOutsideWindow = (cur: number) => {
        const behindMs = (cur - KEEP_BEHIND_S) * 1000;
        const aheadMs = (cur + PLAY_AHEAD_S) * 1000;
        for (const i of decrypted.keys()) {
            if (i <= 1 || i === nextIdx || i === nextIdx + 1) continue;
            const start = partStartMs(m, i);
            if (start + (m.partDurMs[i] ?? 0) <= behindMs || start >= aheadMs) decrypted.delete(i);
        }
    };
    let firstRes: (() => void) | null = null;
    let firstRej: ((e: Error) => void) | null = null;
    const firstPlayable = new Promise<void>((res, rej) => { firstRes = res; firstRej = rej; });
    const fail = (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        firstRej?.(err); firstRej = null; firstRes = null;
        handle.onError?.(err);
    };
    const becomePlayable = () => {
        if (!firstRes) return;
        playable = true; firstRes(); firstRes = null; firstRej = null;
    };
    /** Resolve attach() once the start-up gate (startBytesNeeded) is met —
     *  or at once if the viewer already pressed the video's own play. */
    const maybePlayable = () => {
        if (!firstRes || !runReady || destroyed) return;
        if (el?.paused === false) { becomePlayable(); return; }
        const gate = runGate();
        if (gate.inHand >= gate.needed) becomePlayable();
    };

    const pump = async (): Promise<void> => {
        while (!destroyed) {
            // Every wake (the playhead moving included): let go of the parts
            // outside the window.
            if (el) forgetOutsideWindow(el.currentTime);
            // Whenever the pump stops fetching, the gate opens: everything it
            // would wait for is already in (it never asks for media more than
            // PLAY_AHEAD_S ahead, which is also the gate's horizon).
            if (!sb || !el || nextIdx >= m.parts.length) { if (runReady) becomePlayable(); await waitForWake(); continue; }
            const cur = el.currentTime;
            const end = bufferedEndAt(cur);
            // Enough runway, and the first part is already in: wait for the
            // playhead to move (timeupdate / seeking wake us).
            if (end >= 0 && end - cur >= PLAY_AHEAD_S && nextIdx > 1 && !needInit) { if (runReady) becomePlayable(); await waitForWake(); continue; }
            const gen = loadGen;
            const idx = nextIdx;
            let bytes: Uint8Array;
            try { bytes = await getPart(idx); } catch (e) { if (destroyed) return; fail(e); return; }
            if (destroyed) return;
            if (gen !== loadGen) continue; // a seek moved nextIdx while we fetched — re-evaluate
            // Only NOW start on the next part. Requesting it alongside the one
            // the playhead is waiting for split the link between the two: the
            // first frame waited for ~48 MB instead of ~24 MB (8.2 s instead
            // of 4.3 s at 50 Mbit/s, measured 2026-10-04).
            if (idx + 1 < m.parts.length) void getPart(idx + 1).catch(() => { /* prefetch failure surfaces on its own turn */ });
            try {
                if (needInit) { needInit = false; await append(initBytes!); }
                const cut = cur - KEEP_BEHIND_S;
                if (cut > 0 && sb.buffered.length && sb.buffered.start(0) < cut) await evictBefore(cut).catch(() => { /* eviction is best effort */ });
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
            if (idx === runStart) runReady = true;
            maybePlayable();
            if (nextIdx >= m.parts.length && ms && ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* ignore */ } }
        }
    };

    async function attach(video: HTMLVideoElement): Promise<void> {
        el = video;
        if (mode === 'unsupported') throw new Error('unsupported');
        if (mode === 'blob') {
            const chunks: Uint8Array[] = [];
            for (let i = 0; i < m.parts.length; i++) chunks.push(await getPart(i));
            playable = true;
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
        // The viewer pressed the video's own play while the gate held: theirs.
        video.addEventListener('play', maybePlayable);
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
            // A scrub before the first play: the gate measures from here.
            runStart = nextIdx; runReady = false;
            runOffsetMs = Math.max(0, t - partStartMs(m, nextIdx));
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
