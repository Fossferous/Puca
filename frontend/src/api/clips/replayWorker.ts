/// <reference lib="webworker" />
/**
 * Replay-buffer worker — owns the encoders, the encrypted GOP ring, the seal
 * (mux → parts), the post-approval preview/trim and the upload. Nothing
 * plaintext leaves this worker (not even to its own main thread) UNTIL every
 * call participant has approved: before that, the composer can show only
 * metadata (duration, resolution, size) — decoding a single frame anywhere
 * outside this worker before consent is exactly the gap the consent model
 * exists to close (docs/CLIPS.md). The worker itself does not know whether a
 * clip has been approved; `t:'preview'`/`t:'trim'` are capabilities the
 * composer is responsible for only reaching after `outgoing.status ===
 * 'approved'` — see clipNoPreview.test.ts, which pins that call-site gate.
 *
 * Trim narrows the ALREADY-APPROVED window; it can only remove footage, never
 * add anything outside what was described to approvers, so posting a trimmed
 * clip needs no new consent. It RE-MUXES the kept range (clipTrim.ts) so the
 * result is a self-consistent file whose timeline starts at 0.
 *
 * Privacy contract (docs/CLIPS.md): no MediaRecorder, no Blob for the buffer,
 * no IndexedDB/localStorage/File; every closed GOP is AES-GCM ciphertext under
 * a non-extractable key; plaintext exists only in flight (the open GOP, the
 * seal's transient mux buffers, a preview/trim part while it is being
 * processed) and is zero-filled after use.
 */
import { evictionPlan, selectWindow, trimLeadingAudio, type ChunkIndexEntry, type GopUnit } from './clipRing';
import { newRingKey, sealGop, openGop, newClipSecrets, sealPart, openPart, PART_MAX_PLAINTEXT, type ClipSecrets } from './clipCrypto';
import { Fmp4Splitter, type SplitPart } from './fmp4Split';
import { encodeClipRef, MAX_CLIP_PARTS, type ClipAudioCodec, type ClipManifest } from './clipRef';
import { trimSealedParts, TRIM_MAX_CIPHER_BYTES } from './clipTrim';
import { uploadParts, discardParts, ClipUploadError } from './clipUpload';
import type { ArmConfig, FromWorker, ToWorker, WorkerStatus, SealedInfo } from './clipTypes';
// Static import on purpose: a dynamic import() inside a worker forces vite to
// code-split the worker bundle, which its default IIFE worker format cannot
// do. The muxer only ships in THIS worker's bundle, which loads on arm.
import * as mb from 'mediabunny';

const post = (m: FromWorker, transfer?: Transferable[]) => (transfer ? self.postMessage(m, transfer) : self.postMessage(m));
const nowMs = () => performance.now();

// ---- video codec ladder -------------------------------------------------------
const AVC_LADDER = ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028', 'avc1.42E028'];
/** GOP length: every unit starts with a forced keyframe this far apart. */
const GOP_US = 2_000_000;
/** Drop frames rather than let the encoder queue grow (realtime, not offline). */
const MAX_ENCODE_QUEUE = 4;
/** If GOP sealing (crypto) falls this far behind, something is wrong — bail. */
const MAX_PENDING_CLOSES = 4;
const STATUS_INTERVAL_MS = 1000;

interface OpenGop {
    startUs: number;
    endUs: number;
    configId: number;
    videoParts: Uint8Array[]; videoIdx: ChunkIndexEntry[];
    audioParts: Uint8Array[]; audioIdx: ChunkIndexEntry[];
    bytes: number;
}

interface SealedClip {
    clipId: string;
    secrets: ClipSecrets;
    parts: { index: number; wire: Uint8Array; isInit: boolean; startS: number | null; durMs: number }[];
    info: SealedInfo;
    videoCodec: string;
    audioCodec: ClipAudioCodec | null;
    uploadedIds: Map<number, string>;
    /** Which proposal the ids above were uploaded under (a retry must match). */
    uploadedFor?: string;
    /** Preview state (worker-side MediaSource) — post-approval only, see the file header. */
    ms?: MediaSource;
}

class Ring {
    cfg!: ArmConfig;
    key!: CryptoKey;
    gops: GopUnit[] = [];
    open: OpenGop | null = null;
    seq = 0;
    counter = 0;
    configId = 1;
    ringBytes = 0;
    pendingCloses = 0;
    closing: Promise<void> = Promise.resolve();
    // encoders + config
    venc: VideoEncoder | null = null;
    aenc: AudioEncoder | null = null;
    videoCodec: string | null = null;
    audioCodec: ClipAudioCodec | null = null;
    vDecoderConfig: VideoDecoderConfig | null = null;
    aDecoderConfig: AudioDecoderConfig | null = null;
    width = 0; height = 0;
    // timing
    firstVideoTs: number | null = null; wallV = 0;
    firstAudioTs: number | null = null; wallA = 0;
    lastKeyUs = -Infinity;
    forceKeyNext = true;
    // pumps
    videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
    audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
    /** Native chunks that arrived while arm() was still awaiting (onmessage is
     *  async and unserialized — a nativeVideoChunk handler can run to
     *  completion in the middle of arm()'s awaits). Drained at the end of
     *  arm(); bounded, dropping the OLDEST (the codec re-rides every
     *  keyframe, so old chunks are the safe ones to lose). */
    pendingNative: Parameters<Ring['ingestNativeVideoChunk']>[0][] = [];
    audioGen = 0;
    running = false;
    // stats
    dropped = 0; encodedFrames = 0; framesThisSec = 0; bytesThisSec = 0; fps = 0; kbps = 0;
    statusTimer: ReturnType<typeof setInterval> | null = null;
    fatal = false;

    /** `video === null` only for a native (no-picker) capture: chunks arrive
     *  pre-encoded via `ingestNativeVideoChunk`, so no `VideoEncoder` is
     *  created and `pumpVideo` never starts — see the file header and
     *  clip_capture.rs. Audio is unaffected either way: even a native capture
     *  still mixes through the normal Web Audio graph and arrives here as a
     *  real `ReadableStream<AudioData>` (replayBuffer.ts's header explains why
     *  that trick works for audio but not for video). */
    async arm(cfg: ArmConfig, video: ReadableStream<VideoFrame> | null, audio: ReadableStream<AudioData> | null): Promise<void> {
        this.cfg = cfg;
        this.width = cfg.width; this.height = cfg.height;
        this.key = await newRingKey();
        if (cfg.nativeVideo) {
            // The codec string arrives on the first real chunk (its SPS) —
            // ingestNativeVideoChunk fills this in; a placeholder here would
            // be wrong and nothing reads it before then.
            this.videoCodec = null;
            this.firstVideoTs = 0; // native timestamps are already capture-relative
        } else {
            this.videoCodec = await this.pickVideoCodec(cfg.width, cfg.height, cfg.preset.fps, cfg.preset.videoBitrate);
            if (!this.videoCodec) throw new Error('no supported H.264 encoder configuration for this geometry');
            this.configureVideo(cfg.width, cfg.height);
        }
        if (audio) {
            this.audioCodec = await this.pickAudioCodec(cfg.audioCodec, cfg.preset.audioBitrate);
            if (this.audioCodec) this.configureAudio(cfg.preset.audioBitrate);
        }
        this.running = true;
        if (video) {
            this.videoReader = video.getReader();
            void this.pumpVideo();
        }
        if (audio && this.audioCodec) this.bindAudio(audio);
        this.statusTimer = setInterval(() => this.emitStatus(), STATUS_INTERVAL_MS);
        // A native arm isn't really "armed" until the first chunk lands and
        // sets a real videoCodec — ingestNativeVideoChunk posts 'armed' then.
        if (!cfg.nativeVideo && this.videoCodec) post({ t: 'armed', videoCodec: this.videoCodec, audioCodec: this.audioCodec, width: this.width, height: this.height });
        // Chunks that raced in during the awaits above were parked — ingest
        // them now, in arrival order, so the lead-in (and possibly the
        // codec-bearing first keyframe) is kept rather than dropped.
        const parked = this.pendingNative;
        this.pendingNative = [];
        for (const c of parked) this.ingestNativeVideoChunk(c);
    }

    /** Feed one pre-encoded Annex-B access unit from a native capture
     *  directly into the SAME GOP-closing logic the WebCodecs path uses
     *  (`onVideoChunk`) — constructing a real `EncodedVideoChunk` is exactly
     *  as valid an input to it as one `VideoEncoder`'s own `output` callback
     *  produces; nothing downstream can tell the difference. */
    ingestNativeVideoChunk(m: { keyframe: boolean; tsUs: number; durUs: number; bytes: ArrayBuffer; codec?: string; codedWidth?: number; codedHeight?: number }): void {
        if (!this.cfg?.nativeVideo || this.fatal) return;
        if (!this.running) {
            // arm() has set cfg but is still awaiting (key/codec probes) —
            // park the chunk; arm()'s tail drains this in order. 600 FRAMES:
            // 20 s at 30 fps, 10 s at the 60 fps presets; dropping the oldest
            // is safe because the codec re-rides every keyframe.
            this.pendingNative.push(m);
            if (this.pendingNative.length > 600) this.pendingNative.shift();
            return;
        }
        const firstChunk = this.videoCodec === null;
        if (firstChunk) {
            if (!m.codec) return; // the first chunk MUST carry the SPS-derived codec string
            this.videoCodec = m.codec;
            post({ t: 'armed', videoCodec: this.videoCodec, audioCodec: this.audioCodec, width: this.width, height: this.height });
        }
        this.bytesThisSec += m.bytes.byteLength;
        this.encodedFrames++; this.framesThisSec++;
        const chunk = new EncodedVideoChunk({ type: m.keyframe ? 'key' : 'delta', timestamp: m.tsUs, duration: m.durUs, data: m.bytes });
        this.onVideoChunk(chunk, firstChunk ? { decoderConfig: { codec: m.codec!, codedWidth: m.codedWidth ?? this.width, codedHeight: m.codedHeight ?? this.height } } : undefined);
    }

    private async pickVideoCodec(w: number, h: number, fps: number, bitrate: number): Promise<string | null> {
        for (const codec of AVC_LADDER) {
            try {
                const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: fps, bitrate, hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' } });
                if (r.supported) return codec;
            } catch { /* try next */ }
        }
        return null;
    }

    private async pickAudioCodec(preferred: ClipAudioCodec, bitrate: number): Promise<ClipAudioCodec | null> {
        const order: ClipAudioCodec[] = preferred === 'opus' ? ['opus', 'mp4a.40.2'] : ['mp4a.40.2', 'opus'];
        for (const codec of order) {
            try {
                const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate });
                if (r.supported) return codec;
            } catch { /* try next */ }
        }
        return null;
    }

    private configureVideo(w: number, h: number): void {
        const p = this.cfg.preset;
        if (this.venc) { try { this.venc.close(); } catch { /* ignore */ } }
        this.venc = new VideoEncoder({
            output: (chunk, meta) => this.onVideoChunk(chunk, meta),
            error: (e) => this.fail('video', e.message),
        });
        this.venc.configure({
            codec: this.videoCodec!, width: w, height: h, framerate: p.fps, bitrate: p.videoBitrate,
            bitrateMode: 'variable', hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime',
            avc: { format: 'avc' }, contentHint: 'motion',
        } as VideoEncoderConfig);
        this.width = w; this.height = h;
        this.forceKeyNext = true;
    }

    private configureAudio(bitrate: number): void {
        if (this.aenc) { try { this.aenc.close(); } catch { /* ignore */ } }
        this.aenc = new AudioEncoder({
            output: (chunk, meta) => this.onAudioChunk(chunk, meta),
            error: (e) => this.fail('audio', e.message),
        });
        this.aenc.configure({ codec: this.audioCodec!, sampleRate: 48000, numberOfChannels: 2, bitrate });
    }

    bindAudio(audio: ReadableStream<AudioData> | null): void {
        const gen = ++this.audioGen;
        const old = this.audioReader;
        this.audioReader = null;
        if (old) void old.cancel().catch(() => { /* ignore */ });
        if (!audio || !this.audioCodec) return;
        this.audioReader = audio.getReader();
        void this.pumpAudio(gen);
    }

    // ---- pumps ---------------------------------------------------------------
    private async pumpVideo(): Promise<void> {
        const reader = this.videoReader!;
        for (;;) {
            let res: ReadableStreamReadResult<VideoFrame>;
            try { res = await reader.read(); } catch { break; }
            if (res.done || !this.running) { res.value?.close(); break; }
            const frame = res.value;
            try {
                if (this.fatal) continue;
                if (frame.codedWidth !== this.width || frame.codedHeight !== this.height) this.reconfigure(frame.codedWidth, frame.codedHeight);
                if (this.firstVideoTs === null) { this.firstVideoTs = frame.timestamp; this.wallV = nowMs(); }
                const venc = this.venc!;
                if (venc.state !== 'configured') continue;
                if (venc.encodeQueueSize > MAX_ENCODE_QUEUE) { this.dropped++; continue; }
                const tsUs = frame.timestamp - this.firstVideoTs;
                const key = this.forceKeyNext || tsUs - this.lastKeyUs >= GOP_US;
                venc.encode(frame, { keyFrame: key });
                if (key) { this.lastKeyUs = tsUs; this.forceKeyNext = false; }
                this.encodedFrames++; this.framesThisSec++;
            } catch (e) {
                this.fail('video', e instanceof Error ? e.message : String(e));
            } finally {
                frame.close(); // ALWAYS — a leaked VideoFrame starves the capture pool and the track stops
            }
        }
    }

    private async pumpAudio(gen: number): Promise<void> {
        const reader = this.audioReader!;
        for (;;) {
            let res: ReadableStreamReadResult<AudioData>;
            try { res = await reader.read(); } catch { break; }
            if (res.done || !this.running || gen !== this.audioGen) { res.value?.close(); break; }
            const data = res.value;
            try {
                if (this.fatal || !this.aenc || this.aenc.state !== 'configured') continue;
                if (this.firstAudioTs === null) { this.firstAudioTs = data.timestamp; this.wallA = nowMs(); }
                this.aenc.encode(data);
            } catch (e) {
                this.fail('audio', e instanceof Error ? e.message : String(e));
            } finally {
                data.close();
            }
        }
    }

    private reconfigure(w: number, h: number): void {
        // Close whatever GOP is open under the OLD config, then start a new
        // config generation. Older units stay in the ring; selectWindow clamps
        // to the newest configId and reports how much footage that costs.
        this.closeOpenGop();
        this.configId++;
        this.vDecoderConfig = null;
        this.configureVideo(w, h);
        const lostUs = this.gops.length ? this.gops[this.gops.length - 1].endUs - this.gops[0].startUs : 0;
        post({ t: 'reconfigured', width: w, height: h, lostMs: Math.round(lostUs / 1000) });
    }

    // ---- ring assembly ---------------------------------------------------------
    /** Audio timestamps live on a different clock than video frames (measured:
     *  video ~75 s, audio ~30 h at first sample). Rebase each by its own first
     *  sample, add the wall-clock skew between those first samples, and the
     *  spike-measured constant offset. */
    private audioTsUs(raw: number): number {
        return raw - (this.firstAudioTs ?? raw) + Math.round((this.wallA - this.wallV) * 1000) + this.cfg.audioOffsetUs;
    }

    private onVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
        if (meta?.decoderConfig && !this.vDecoderConfig) {
            // Keep our own copy — the description (avcC) is what a playable MP4 needs.
            const d = meta.decoderConfig;
            this.vDecoderConfig = { ...d, description: d.description ? copyBytes(d.description) : undefined };
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        const tsUs = chunk.timestamp - (this.firstVideoTs ?? chunk.timestamp);
        const durUs = chunk.duration ?? Math.round(1e6 / this.cfg.preset.fps);
        this.bytesThisSec += buf.byteLength;
        if (chunk.type === 'key') {
            this.closeOpenGop();
            this.open = { startUs: tsUs, endUs: tsUs + durUs, configId: this.configId, videoParts: [], videoIdx: [], audioParts: [], audioIdx: [], bytes: 0 };
        }
        const g = this.open;
        if (!g) return; // delta before the first keyframe (cannot happen after forceKeyNext, but be safe)
        g.videoParts.push(buf);
        g.videoIdx.push({ tsUs, durUs, len: buf.byteLength, key: chunk.type === 'key' });
        g.bytes += buf.byteLength;
        g.endUs = Math.max(g.endUs, tsUs + durUs);
        // GOPs only close (and eviction only runs) on the NEXT keyframe. A
        // stream whose keyframes stopped therefore grows this open unit
        // without bound and no cap ever engages — fail loudly instead: the
        // ring cannot rotate and nothing sealed from it could be packaged.
        if (g.bytes > this.cfg.maxRingBytes) {
            this.fail('video', 'the encoder stopped producing keyframes — the buffer cannot rotate');
        }
    }

    private onAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
        if (meta?.decoderConfig && !this.aDecoderConfig) {
            const d = meta.decoderConfig;
            this.aDecoderConfig = { ...d, description: d.description ? copyBytes(d.description) : undefined };
        }
        const g = this.open;
        if (!g) return; // before the first video keyframe: nothing to attach to
        const tsUs = this.audioTsUs(chunk.timestamp);
        if (tsUs < 0) return; // predates the first video frame
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        g.audioParts.push(buf);
        g.audioIdx.push({ tsUs, durUs: chunk.duration ?? 21_333, len: buf.byteLength, key: false });
        g.bytes += buf.byteLength;
        this.bytesThisSec += buf.byteLength;
    }

    private closeOpenGop(): void {
        const g = this.open;
        this.open = null;
        if (!g || g.videoIdx.length === 0) return;
        const plain = new Uint8Array(g.bytes);
        let o = 0;
        for (const p of g.videoParts) { plain.set(p, o); o += p.byteLength; }
        for (const p of g.audioParts) { plain.set(p, o); o += p.byteLength; }
        g.videoParts.length = 0; g.audioParts.length = 0;
        const counter = this.counter++;
        const seq = this.seq++;
        this.pendingCloses++;
        if (this.pendingCloses > MAX_PENDING_CLOSES) {
            this.fail('crypto', `GOP sealing fell ${this.pendingCloses} units behind`);
            return;
        }
        this.closing = this.closing.then(async () => {
            try {
                const blob = await sealGop(this.key, counter, plain);
                plain.fill(0);
                if (!this.running) { blob.fill(0); return; }
                this.gops.push({ seq, configId: g.configId, startUs: g.startUs, endUs: g.endUs, video: g.videoIdx, audio: g.audioIdx, counter, blob, plainLen: g.bytes });
                this.ringBytes += blob.byteLength;
                for (const ev of evictionPlan(this.gops, { maxDurationUs: this.cfg.ringMs * 1000, maxBytes: this.cfg.maxRingBytes })) {
                    const i = this.gops.indexOf(ev);
                    if (i >= 0) this.gops.splice(i, 1);
                    this.ringBytes -= ev.blob.byteLength;
                    ev.blob.fill(0);
                }
            } catch (e) {
                plain.fill(0);
                this.fail('crypto', e instanceof Error ? e.message : String(e));
            } finally {
                this.pendingCloses--;
            }
        });
    }

    bufferedUs(): number {
        const first = this.gops[0]?.startUs ?? this.open?.startUs ?? 0;
        const last = this.open?.endUs ?? this.gops[this.gops.length - 1]?.endUs ?? first;
        return Math.max(0, last - first);
    }

    private emitStatus(): void {
        this.fps = this.framesThisSec; this.kbps = (this.bytesThisSec * 8) / 1000;
        this.framesThisSec = 0; this.bytesThisSec = 0;
        const s: WorkerStatus = {
            bufferedMs: Math.round(this.bufferedUs() / 1000), ringBytes: this.ringBytes + (this.open?.bytes ?? 0), gops: this.gops.length,
            droppedFrames: this.dropped, fps: this.fps, kbps: this.kbps, encodedFrames: this.encodedFrames,
            hasAudio: !!this.audioReader, videoCodec: this.videoCodec, audioCodec: this.audioCodec, width: this.width, height: this.height,
        };
        post({ t: 'status', s });
    }

    fail(stage: 'video' | 'audio' | 'crypto' | 'mux' | 'upload' | 'arm', message: string): void {
        if (this.fatal) return;
        this.fatal = true;
        post({ t: 'error', stage, message, fatal: true });
        void this.wipe();
    }

    // ---- seal ------------------------------------------------------------------
    async seal(clipId: string, requestedMs: number, maxMs?: number): Promise<SealedClip> {
        // Bring every pending frame out of the encoders and close the open unit
        // so "Clip" captures right up to now. The next frame MUST be a keyframe:
        // the unit that starts after this seal has no keyframe of its own otherwise.
        try { await this.venc?.flush(); } catch { /* ignore */ }
        try { await this.aenc?.flush(); } catch { /* ignore */ }
        this.closeOpenGop();
        this.forceKeyNext = true;
        await this.closing;
        if (!this.vDecoderConfig || !this.videoCodec) throw new Error('no video decoder configuration yet');
        const win = selectWindow(this.gops, requestedMs * 1000, maxMs !== undefined ? maxMs * 1000 : undefined);
        if (!win) throw new Error('the buffer is empty');
        const secrets = newClipSecrets(clipId);
        const audioCodec = this.audioCodec;
        const hasAudio = !!audioCodec && !!this.aDecoderConfig && this.gops.slice(win.from, win.to + 1).some(g => g.audio.length > 0);

        // Mux with mediabunny (statically imported above; worker-only bundle).
        const parts: SplitPart[] = [];
        const splitter = new Fmp4Splitter(PART_MAX_PLAINTEXT, p => parts.push(p));
        const writable = new WritableStream<Uint8Array | { data: Uint8Array }>({
            write(c) { splitter.push(c instanceof Uint8Array ? c : c.data); },
        });
        const output = new mb.Output({
            format: new mb.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
            target: new mb.AppendOnlyStreamTarget(writable as WritableStream<Uint8Array>),
        });
        const vsrc = new mb.EncodedVideoPacketSource('avc');
        output.addVideoTrack(vsrc);
        const asrc = hasAudio ? new mb.EncodedAudioPacketSource(audioCodec === 'opus' ? 'opus' : 'aac') : null;
        if (asrc) output.addAudioTrack(asrc);
        await output.start();

        let firstV = true, firstA = true;
        for (let i = win.from; i <= win.to; i++) {
            const g = this.gops[i];
            const plain = await openGop(this.key, g.counter, g.blob);
            try {
                let off = 0;
                for (const v of g.video) {
                    const bytes = plain.slice(off, off + v.len); off += v.len;
                    const pkt = new mb.EncodedPacket(bytes, v.key ? 'key' : 'delta', (v.tsUs - win.startUs) / 1e6, v.durUs / 1e6);
                    await vsrc.add(pkt, firstV ? { decoderConfig: this.vDecoderConfig } : undefined);
                    firstV = false;
                }
                const audioEntries = i === win.from ? trimLeadingAudio(g.audio, win.startUs) : g.audio;
                // audio bytes follow the video bytes; walk the FULL index to keep offsets right
                let aoff = off;
                const keep = new Set(audioEntries);
                for (const a of g.audio) {
                    const bytes = plain.slice(aoff, aoff + a.len); aoff += a.len;
                    if (!asrc || !keep.has(a)) continue;
                    const ts = Math.max(0, (a.tsUs - win.startUs) / 1e6);
                    const pkt = new mb.EncodedPacket(bytes, 'key', ts, a.durUs / 1e6);
                    await asrc.add(pkt, firstA ? { decoderConfig: this.aDecoderConfig! } : undefined);
                    firstA = false;
                }
            } finally {
                plain.fill(0);
            }
        }
        await output.finalize();
        splitter.end();
        if (parts.length < 2) throw new Error('mux produced no fragments');
        if (parts.length > MAX_CLIP_PARTS) throw new Error(`clip needs ${parts.length} parts; the maximum is ${MAX_CLIP_PARTS} — shorten it`);
        // A part can only exceed the budget when ONE moof/mdat fragment does —
        // i.e. the stream ran that long without a keyframe (the 0.8.108 field
        // failure: the native encoder's force-key was inert, one IDR ever, the
        // whole clip became a single fragment). sealPart would reject it with
        // a bare constant name; say what actually happened instead.
        const over = parts.find(pt => pt.overBudget);
        if (over) throw new Error(`the recording ran too long without a keyframe to package (part ${over.index} spans ${Math.round(over.bytes.byteLength / (1024 * 1024))} MB) — disarm and re-arm the buffer`);

        // Durations per part from fragment starts; the last part runs to the end.
        const totalS = (win.endUs - win.startUs) / 1e6;
        const sealedParts: SealedClip['parts'] = [];
        let totalCipher = 0;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            const next = parts[i + 1];
            const durMs = p.isInit ? 0 : Math.max(0, Math.round(((next?.startS ?? totalS) - (p.startS ?? 0)) * 1000));
            const wire = await sealPart(secrets, p.index, p.bytes);
            p.bytes.fill(0);
            totalCipher += wire.byteLength;
            sealedParts.push({ index: p.index, wire, isInit: p.isInit, startS: p.startS, durMs });
        }
        const info: SealedInfo = {
            clipId, durationMs: Math.round(totalS * 1000), leadInMs: Math.round(win.leadInUs / 1000), lostMs: Math.round(win.lostUs / 1000),
            width: this.width, height: this.height, partCount: sealedParts.length, totalCipherBytes: totalCipher,
            videoCodec: this.vDecoderConfig.codec, audioCodec: hasAudio ? audioCodec : null, partDurMs: sealedParts.map(p => p.durMs),
        };
        return { clipId, secrets, parts: sealedParts, info, videoCodec: this.vDecoderConfig.codec, audioCodec: hasAudio ? audioCodec : null, uploadedIds: new Map() };
    }

    async wipe(): Promise<void> {
        this.running = false;
        if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
        const vr = this.videoReader, ar = this.audioReader;
        this.videoReader = null; this.audioReader = null;
        if (vr) await vr.cancel().catch(() => { /* ignore */ });
        if (ar) await ar.cancel().catch(() => { /* ignore */ });
        try { this.venc?.close(); } catch { /* ignore */ }
        try { this.aenc?.close(); } catch { /* ignore */ }
        this.venc = null; this.aenc = null;
        await this.closing.catch(() => { /* ignore */ });
        for (const g of this.gops) g.blob.fill(0);
        this.gops.length = 0;
        this.ringBytes = 0;
        if (this.open) { for (const p of this.open.videoParts) p.fill(0); for (const p of this.open.audioParts) p.fill(0); this.open = null; }
        // The CryptoKey is non-extractable; dropping the reference is all we can do.
        this.key = undefined as unknown as CryptoKey;
    }
}

function copyBytes(src: AllowSharedBufferSource): Uint8Array {
    const u8 = src instanceof ArrayBuffer || src instanceof SharedArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    return u8.slice();
}

// ---- worker state machine ---------------------------------------------------
let ring: Ring | null = null;
let sealed: SealedClip | null = null;

/** Bumped by every preview start, discard and trim so a preview that is still
 *  streaming notices it has been superseded and stops (posting previewFailed
 *  so the main thread's pending promise settles rather than hanging). */
let previewGen = 0;
/** The in-flight preview, if any — trim waits for it to settle first so it
 *  never zero-fills a part the preview is about to decrypt. */
let previewRun: Promise<void> | null = null;
/** The in-flight upload, if any — trim waits for it too (it reads the wires trim retires). */
let uploadRun: Promise<void> | null = null;
const PREVIEW_SOURCEOPEN_TIMEOUT_MS = 10_000;

/** Release a worker-side MediaSource: drop its buffered (decrypted) media and
 *  end the stream. `endOfStream()` alone keeps the SourceBuffers' data resident
 *  — only removing them frees it. */
function releaseMediaSource(ms: MediaSource | undefined): void {
    if (!ms) return;
    try {
        if (ms.readyState === 'open') {
            for (const sb of Array.from(ms.sourceBuffers)) {
                try { if (sb.updating) sb.abort(); } catch { /* ignore */ }
                try { ms.removeSourceBuffer(sb); } catch { /* ignore */ }
            }
            ms.endOfStream();
        }
    } catch { /* ignore */ }
}

function discardSealed(): void {
    if (!sealed) return;
    previewGen++; // any in-flight preview stops at its next step
    for (const p of sealed.parts) p.wire.fill(0);
    sealed.parts.length = 0;
    sealed.secrets.key.fill(0); sealed.secrets.noncePrefix.fill(0);
    releaseMediaSource(sealed.ms);
    sealed.ms = undefined;
    sealed = null;
}

/** Stream the CURRENT sealed clip into a worker-side MediaSource and hand the
 *  handle to the main thread. Only ever invoked once the composer has already
 *  confirmed every participant approved (see the file header) — the worker
 *  has no notion of approval itself, same as before consent existed. */
async function preview(seq: number): Promise<void> {
    const s = sealed;
    if (!s) throw new Error('nothing sealed');
    const MS = (self as unknown as { MediaSource?: typeof MediaSource & { canConstructInDedicatedWorker?: boolean } }).MediaSource;
    if (!MS || !MS.canConstructInDedicatedWorker) throw new Error('MSE is not available in this worker');
    const gen = ++previewGen;
    // A previous preview of this seal (StrictMode double-effect, a re-attach)
    // must not keep its decrypted buffers alive.
    releaseMediaSource(s.ms);
    const ms = new MS();
    s.ms = ms;
    // MediaSource.handle (Chromium ≥ 108) is not in lib.dom yet.
    const handle = (ms as unknown as { handle: MediaSourceHandle }).handle;
    post({ t: 'previewHandle', seq, handle }, [handle]);
    const opened = await new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), PREVIEW_SOURCEOPEN_TIMEOUT_MS);
        ms.addEventListener('sourceopen', () => { clearTimeout(t); res(true); }, { once: true });
    });
    if (gen !== previewGen || sealed !== s) throw new Error('preview superseded');
    if (!opened) throw new Error('the preview element never opened the stream');
    const codecs = s.audioCodec ? `${s.videoCodec}, ${s.audioCodec}` : s.videoCodec;
    const type = `video/mp4; codecs="${codecs}"`;
    if (!MediaSource.isTypeSupported(type)) throw new Error(`MSE cannot play ${type}`);
    const sb = ms.addSourceBuffer(type);
    ms.duration = s.info.durationMs / 1000;
    for (const p of s.parts) {
        if (gen !== previewGen || sealed !== s) throw new Error('preview superseded'); // discarded or trimmed mid-preview
        const plain = await openPart(s.secrets, p.index, p.wire);
        try {
            await new Promise<void>((res, rej) => {
                const onEnd = () => { sb.removeEventListener('error', onErr); res(); };
                const onErr = () => { sb.removeEventListener('updateend', onEnd); rej(new Error('SourceBuffer append failed')); };
                sb.addEventListener('updateend', onEnd, { once: true });
                sb.addEventListener('error', onErr, { once: true });
                sb.appendBuffer(plain as BufferSource);
            });
        } finally {
            plain.fill(0);
        }
    }
    if (gen !== previewGen || sealed !== s) throw new Error('preview superseded');
    if (ms.readyState === 'open') ms.endOfStream();
    post({ t: 'previewReady', seq, durationMs: s.info.durationMs });
}

/**
 * Narrow `s` to [startMs, endMs] of ITS OWN timeline. The work — decrypt,
 * RE-MUX the kept range into a fresh fMP4 starting at 0 (clipTrim.ts explains
 * why relisting a subset of the parts is wrong: fragments carry absolute
 * tfdt), seal under FRESH secrets (re-using the key would repeat AES-GCM
 * nonces across indices), all-or-nothing rollback, zero-fill — lives in
 * clipTrim.ts `trimSealedParts` so it is testable outside the worker. This
 * wrapper only maps SealedClip in and out and retires the old MediaSource.
 * Peak memory is ~3× the clip on top of the ring, which is why the composer
 * refuses trim above TRIM_MAX_CIPHER_BYTES.
 */
async function trimSealed(s: SealedClip, startMs: number, endMs: number): Promise<SealedClip> {
    if (s.info.totalCipherBytes > TRIM_MAX_CIPHER_BYTES) throw new Error('this clip is too large to trim in memory — post it as-is');
    const r = await trimSealedParts(s.secrets, s.clipId, s.parts, s.info.durationMs, startMs, endMs, MAX_CLIP_PARTS, PART_MAX_PLAINTEXT);
    if (!r) return s; // nothing to trim
    releaseMediaSource(s.ms);
    const info: SealedInfo = {
        ...s.info, durationMs: r.durationMs, leadInMs: 0, lostMs: 0,
        partCount: r.parts.length, totalCipherBytes: r.totalCipherBytes, partDurMs: r.parts.map(p => p.durMs),
        audioCodec: r.hasAudio ? s.info.audioCodec : null,
    };
    return { ...s, secrets: r.secrets, parts: r.parts, info, audioCodec: r.hasAudio ? s.audioCodec : null, uploadedIds: new Map(), uploadedFor: undefined, ms: undefined };
}

async function upload(token: string, baseUrl: string, proposalId: string, onlyMissing: boolean): Promise<void> {
    if (!sealed) throw new Error('nothing sealed');
    const s = sealed;
    // A retry must target the SAME proposal; a different one starts clean.
    const already = onlyMissing && s.uploadedFor === proposalId ? s.uploadedIds : new Map<number, string>();
    s.uploadedFor = proposalId;
    try {
        const ids = await uploadParts(s.parts.map(p => ({ index: p.index, wire: p.wire })), {
            baseUrl, token, clipId: proposalId, already, concurrency: 2,
            onProgress: (done, total, bytesDone) => post({ t: 'uploadProgress', done, total, bytesDone }),
        });
        s.uploadedIds = ids;
        const ordered = s.parts.map(p => ids.get(p.index)!);
        const manifest: ClipManifest = {
            key: s.secrets.key, noncePrefix: s.secrets.noncePrefix, clipId: s.clipId,
            videoCodec: s.videoCodec, audioCodec: s.audioCodec ?? 'mp4a.40.2', durationMs: s.info.durationMs, width: s.info.width, height: s.info.height,
            totalCipherBytes: s.info.totalCipherBytes, parts: ordered, partDurMs: s.parts.map(p => p.durMs),
        };
        const href = encodeClipRef(manifest);
        post({ t: 'uploaded', href, partIds: ordered });
    } catch (e) {
        if (e instanceof ClipUploadError) {
            s.uploadedIds = new Map(e.uploaded);
            post({ t: 'uploadFailed', message: e.message, status: e.status, failedIdx: e.failedIdx });
        } else {
            post({ t: 'uploadFailed', message: e instanceof Error ? e.message : String(e), failedIdx: s.parts.map(p => p.index) });
        }
    }
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
    const m = ev.data;
    try {
        switch (m.t) {
            case 'arm': {
                if (ring) await ring.wipe();
                ring = new Ring();
                await ring.arm(m.cfg, m.video, m.audio);
                break;
            }
            case 'rebindAudio': ring?.bindAudio(m.audio); break;
            case 'nativeVideoChunk': ring?.ingestNativeVideoChunk(m); break;
            case 'seal': {
                if (!ring) throw new Error('not armed');
                discardSealed();
                try {
                    sealed = await ring.seal(m.clipId, m.requestedMs, m.maxMs);
                    post({ t: 'sealed', info: sealed.info });
                } catch (e) {
                    post({ t: 'sealFailed', message: e instanceof Error ? e.message : String(e) });
                }
                break;
            }
            case 'preview': {
                // Every outcome posts previewReady or previewFailed — the main
                // thread awaits one of them; a silent return would hang it.
                const seq = m.seq;
                const run = preview(seq).catch((e: unknown) => { post({ t: 'previewFailed', seq, message: e instanceof Error ? e.message : String(e) }); });
                previewRun = run;
                await run;
                if (previewRun === run) previewRun = null;
                break;
            }
            case 'trim': {
                // Every outcome posts sealed or trimFailed — same contract.
                try {
                    if (!sealed) throw new Error('nothing sealed');
                    // Supersede and drain any in-flight preview before touching
                    // the parts it reads; it fails fast at its next step.
                    previewGen++;
                    if (previewRun) await previewRun;
                    // …and an in-flight upload, which reads the same wires.
                    if (uploadRun) await uploadRun.catch(() => { /* reported on its own channel */ });
                    if (!sealed) throw new Error('nothing sealed');
                    const s = sealed;
                    const partialIds = new Map(s.uploadedIds);
                    const r = await trimSealed(s, m.startMs, m.endMs);
                    if (sealed !== s) {
                        // A discardSeal (cancel/decline/disarm) landed while the
                        // re-mux ran: what it destroyed must not come back under
                        // a fresh key. The rollback in trimSealedParts cannot see
                        // this, so retire the result here.
                        for (const p of r.parts) p.wire.fill(0);
                        r.secrets.key.fill(0); r.secrets.noncePrefix.fill(0);
                        throw new Error('the clip was discarded');
                    }
                    sealed = r;
                    // Parts a failed upload already landed belong to the PRE-trim
                    // clip; nothing references them now and discardSeal only knows
                    // the current ids — delete them rather than leave quota debris.
                    if (r !== s && partialIds.size && m.token && m.baseUrl) discardParts(partialIds.values(), { baseUrl: m.baseUrl, token: m.token });
                    post({ t: 'sealed', info: sealed.info });
                } catch (e) {
                    post({ t: 'trimFailed', message: e instanceof Error ? e.message : String(e) });
                }
                break;
            }
            case 'upload': {
                const run = upload(m.token, m.baseUrl, m.proposalId, m.onlyMissing);
                uploadRun = run;
                try { await run; } finally { if (uploadRun === run) uploadRun = null; }
                break;
            }
            case 'discardSeal': {
                // Parts that already reached the server are unreferenced ciphertext
                // that would count against the clipper's quota forever — delete them.
                if (sealed && sealed.uploadedIds.size && m.token && m.baseUrl) discardParts(sealed.uploadedIds.values(), { baseUrl: m.baseUrl, token: m.token });
                discardSealed();
                break;
            }
            case 'wipe': {
                discardSealed();
                if (ring) { await ring.wipe(); ring = null; }
                post({ t: 'wiped' });
                self.close();
                break;
            }
        }
    } catch (e) {
        // `stage` names the message that failed so the main thread settles
        // exactly that caller's pending promise and no other.
        post({ t: 'error', stage: m.t, message: e instanceof Error ? e.message : String(e), fatal: m.t === 'arm' });
    }
};
