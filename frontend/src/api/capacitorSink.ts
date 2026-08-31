/**
 * Streaming download sink for Android — the one that removes the 100 MB cap.
 *
 * The cap was never a policy, it was a symptom: the phone had no way to write
 * a file, so `memorySink` held the WHOLE download in the JS heap and handed it
 * to the browser at the end. Refusing at 100 MB was the honest response to
 * that, because dying at 90% with the bytes already spent is worse than
 * declining up front. The fix is to stop holding the file at all.
 *
 * `@capacitor/filesystem` has shipped inside the APK since 0.8.28 (it went in
 * with the phone-as-file-host work), so this needs no new APK — the comment in
 * transferSinks.ts that said otherwise was written before that landed.
 *
 * TWO THINGS MAKE OR BREAK THE THROUGHPUT, and both are why this is not just
 * "call appendFile per chunk":
 *
 *  - BATCHING. Chunks arrive at 16 KiB from both transfer paths. Every
 *    `appendFile` is a JSON bridge round trip AND, on external storage, a
 *    `MediaScannerConnection.scanFile` — so a per-chunk append is ~64 of each
 *    per MiB, i.e. tens of thousands for a large file. That would make the
 *    "uncapped" download slower than the capped one. Chunks accumulate to
 *    FLUSH_BYTES and go out as one write.
 *  - THE BASE64 ENCODER. The obvious `for (b of bytes) s += fromCharCode(b)`
 *    is O(n) string concatenation and dominates everything at megabyte sizes.
 *    Encoding walks the array in slices instead.
 *
 * Peak memory is therefore one batch, not one file, whatever the file's size.
 */
import { Capacitor } from '@capacitor/core';
import type { PreparedSink } from './transferSinks';
import type { TransferView } from './fileTransferManager';

/** How much to accumulate before one write reaches the filesystem.
 *
 *  4 MiB — raised from 1 MiB after the throughput audit: the old shape was
 *  STOP-AND-WAIT, one bridge round trip per window with zero overlap, so the
 *  sink's ceiling was FLUSH_BYTES / bridge-round-trip — at ~250 ms per
 *  1 MiB flush that is 4.19 MB/s, one of the two mechanisms that exactly
 *  predicted the field-reported 4 MB/s. The window is now 4 MiB AND the
 *  bridge call is double-buffered (one in flight while the next batch
 *  accumulates — see `startFlush`), so the native half of a flush overlaps
 *  arrival instead of serializing with it. Peak memory is bounded by two
 *  batches (raw + base64 at 4/3 each), still trivial next to the file. */
const FLUSH_BYTES = 4 * 1024 * 1024;

/** Flush telemetry for `__pucaTransferDiag()` — splits ENCODE (JS,
 *  unavoidable on-thread) from BRIDGE (native round trip, the part the
 *  double-buffer hides). Which of the two dominates decides whether further
 *  batching helps or only a native binary path would. */
const sinkDiag = {
    flushes: 0,
    encodeMs: 0,
    bridgeMs: 0,
    bytes: 0,
};

export function capacitorSinkDiag(): Record<string, unknown> {
    const d = sinkDiag;
    return {
        flushes: d.flushes,
        avgEncodeMs: d.flushes ? +(d.encodeMs / d.flushes).toFixed(1) : 0,
        avgBridgeMs: d.flushes ? +(d.bridgeMs / d.flushes).toFixed(1) : 0,
        mbWritten: +(d.bytes / (1024 * 1024)).toFixed(1),
        flushBytes: FLUSH_BYTES,
    };
}

/** Base64 without quadratic string building. */
function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const SLICE = 0x8000; // 32k args is comfortably under the apply() limit
    for (let i = 0; i < bytes.length; i += SLICE) {
        const view = bytes.subarray(i, Math.min(i + SLICE, bytes.length));
        binary += String.fromCharCode.apply(null, view as unknown as number[]);
    }
    return btoa(binary);
}

function joinChunks(parts: Uint8Array[], total: number): Uint8Array {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

/** Keep the extension when de-duplicating: "clip.mp4" -> "clip (2).mp4". */
function numbered(name: string, n: number): string {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name} (${n})`;
    return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/**
 * Reduce a peer-supplied filename to a safe basename inside the download dir.
 *
 * `t.name` comes straight off the wire — the SENDER chooses it. Concatenated
 * into `${dir}/${name}` unsanitized, `"../../../../sdcard/Download/x"` or an
 * absolute `"/sdcard/x"` would let a remote peer write ANYWHERE the app can,
 * outside Downloads/Sovereign. Strip every directory component (both separator
 * kinds), drop control/NUL bytes, refuse the pure-traversal names, and cap the
 * length. A literal `%2f` etc. is left alone: the filesystem treats it as one
 * ordinary filename character, so it cannot traverse.
 */
export function safeDownloadName(raw: string): string {
    let name = (raw ?? '').split(/[/\\]/).pop() ?? '';
    // Drop control chars / NUL without embedding literal control bytes here.
    name = Array.from(name)
        .filter(c => { const code = c.charCodeAt(0); return code >= 0x20 && code !== 0x7f; })
        .join('')
        .trim();
    if (name === '' || name === '.' || name === '..') return 'download';
    if (name.length > 200) {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
        name = name.slice(0, 200 - ext.length) + ext;
    }
    return name;
}

/**
 * A streaming sink, or null when this device cannot provide one — an older
 * APK without the plugin, iOS, Android below 11, or all-files access not
 * granted. Null means "fall back", never "fail": the caller keeps the capped
 * memory sink for those cases so nothing regresses.
 */
export async function capacitorFileSink(t: TransferView): Promise<PreparedSink | null> {
    if (Capacitor.getPlatform() !== 'android') return null;

    const { allFilesAccessStatus, shareableRoots } = await import('./androidStorage');
    const status = await allFilesAccessStatus();
    // No plugin (old APK running new JS over the air), too old, or the user
    // has not granted storage access — all fall back rather than throw.
    if (!status || status.sdk < 30 || !status.hasAllFilesAccess) return null;

    const roots = await shareableRoots();
    const downloads = roots.find(r => /download/i.test(r.label)) ?? roots[0];
    if (!downloads) return null;

    const { Filesystem } = await import('@capacitor/filesystem');
    const dir = `${downloads.path}/Puca`;
    try {
        await Filesystem.mkdir({ path: dir, recursive: true });
    } catch {
        // Already there — the only expected failure, and stat-then-create
        // would be a race rather than a fix.
    }

    // Sanitize the peer-chosen name to a safe basename BEFORE it touches a path
    // (path traversal / absolute-path escape out of Downloads/Puca).
    const baseName = safeDownloadName(t.name);

    // Pick a name that is free NOW. A collision appearing mid-transfer is
    // handled again at rename time.
    let finalName = baseName;
    for (let n = 2; n < 200; n++) {
        try {
            await Filesystem.stat({ path: `${dir}/${finalName}` });
            finalName = numbered(baseName, n);
        } catch {
            break; // stat throws when absent, which is what we want
        }
    }

    const partPath = `${dir}/${finalName}.part`;
    let finalPath = `${dir}/${finalName}`;

    // Per-transfer diagnostics: a diagnosis must read THIS transfer's
    // numbers, not the session-lifetime mix of every transfer before it.
    sinkDiag.flushes = 0;
    sinkDiag.encodeMs = 0;
    sinkDiag.bridgeMs = 0;
    sinkDiag.bytes = 0;

    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let started = false;
    /** The one bridge call allowed in flight. Append ORDER is what makes the
     *  file correct, so there is never more than one: a second flush waits
     *  for this before issuing its own write. `null` when idle. */
    let inFlight: Promise<void> | null = null;
    /** A failed flush surfaces on the NEXT write/close — never silently. */
    let flushError: unknown = null;
    /** Once aborted, this sink is DEAD: no write may accumulate, no flush may
     *  issue, and close() must refuse. Without this flag, writeChain
     *  callbacks already queued at cancel time kept feeding the sink after
     *  abort() deleted the .part — appendFile re-created it with only the
     *  tail bytes and close() renamed that fragment over the real filename,
     *  reporting a cancelled transfer as complete (the running digest covers
     *  what the RECEIVER saw, not what the sink persisted, so the hash check
     *  passed). Found in adversarial review before it shipped. */
    let aborted = false;

    /** Snapshot the batch and queue its bridge write WITHOUT awaiting it —
     *  the caller keeps accumulating while the native side works. The
     *  first-batch decision (writeFile truncates, appendFile extends) is
     *  taken at SNAPSHOT time, synchronously, so ordering can never invert
     *  it. */
    function startFlush(): void {
        if (aborted || pendingBytes === 0) return;
        const raw = joinChunks(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        const first = !started;
        started = true;
        const prev = inFlight ?? Promise.resolve();
        inFlight = prev.then(async () => {
            const t0 = performance.now();
            const data = toBase64(raw);
            const t1 = performance.now();
            if (first) {
                // writeFile TRUNCATES, which is what a fresh transfer wants: a
                // leftover .part from an abandoned attempt must not be
                // appended to.
                await Filesystem.writeFile({ path: partPath, data, recursive: true });
            } else {
                await Filesystem.appendFile({ path: partPath, data });
            }
            const t2 = performance.now();
            sinkDiag.flushes++;
            sinkDiag.encodeMs += t1 - t0;
            sinkDiag.bridgeMs += t2 - t1;
            sinkDiag.bytes += raw.length;
        }).catch(e => { flushError = e; });
    }

    return {
        resumeFrom: 0,
        describeDestination: () => finalPath,
        async abort(keep: boolean) {
            // The flag FIRST: any write/close still queued behind this on the
            // manager's writeChain must find the sink already dead.
            aborted = true;
            pending = [];
            pendingBytes = 0;
            // Let an in-flight append settle before deleting, or the delete
            // could race the write and leave a resurrected .part behind.
            if (inFlight) await inFlight.catch(() => undefined);
            if (keep) return;
            try { await Filesystem.deleteFile({ path: partPath }); } catch { /* nothing written yet */ }
        },
        sink: {
            async write(chunk: Uint8Array) {
                // Aborted is a NO-OP, not an error: the cancel that set it is
                // already tearing the transfer down, and a throw here would
                // race the user's own action into a spurious failure card.
                if (aborted) return;
                if (flushError) throw flushError;
                pending.push(chunk);
                pendingBytes += chunk.length;
                if (pendingBytes >= FLUSH_BYTES) {
                    // At most ONE bridge call outstanding: wait out the
                    // previous flush (usually already settled), then queue
                    // this batch and return to accumulating immediately.
                    if (inFlight) {
                        await inFlight;
                        if (flushError) throw flushError;
                    }
                    startFlush();
                }
            },
            async close() {
                // A cancelled sink must never promote its .part — see the
                // aborted-flag comment above for the corruption this stops.
                if (aborted) throw new Error('cancelled');
                if (inFlight) await inFlight;
                // A flush that already failed makes the remainder pointless —
                // surface it before issuing another doomed bridge write.
                if (flushError) throw flushError;
                startFlush(); // the sub-window remainder
                if (inFlight) await inFlight;
                if (aborted) throw new Error('cancelled');
                if (flushError) throw flushError;
                if (!started) {
                    // A zero-byte file still has to exist.
                    await Filesystem.writeFile({ path: partPath, data: '', recursive: true });
                }
                // Promote only now, so a failed transfer never leaves
                // something wearing the real name.
                for (let n = 2; n < 200; n++) {
                    try {
                        await Filesystem.rename({ from: partPath, to: finalPath });
                        return;
                    } catch (e) {
                        // Someone created it between the check above and now.
                        try { await Filesystem.stat({ path: finalPath }); } catch { throw e; }
                        finalPath = `${dir}/${numbered(finalName, n)}`;
                    }
                }
                throw new Error('could not find a free filename for the download');
            },
        },
    };
}
