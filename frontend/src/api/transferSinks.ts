/**
 * Where received bytes go, per platform. See docs/P2P_FILE_TRANSFER_PLAN.md §5.
 *
 * The three targets differ enormously, and pretending otherwise is how "no cap"
 * turns into a crashed tab:
 *
 *  - **Desktop (Tauri)** streams straight to a file. This is the only target
 *    where an uncapped transfer is genuinely true, and the only one that can
 *    resume, because only it keeps a partial file between attempts.
 *  - **Browser** can stream via the File System Access API where available
 *    (Chromium), and otherwise has to hold the file in memory — so it is capped.
 *  - **Mobile** streams to disk on Android via @capacitor/filesystem, with no
 *    cap — see capacitorSink.ts. iOS, an APK too old to carry the plugin,
 *    Android below 11, and "storage access not granted" all fall back to the
 *    capped in-memory path, because there the whole file really is resident.
 *    A caveat remains that the other two do not have: Android may freeze the
 *    process while the app is backgrounded, stalling the transfer until it
 *    returns to the foreground. The UI warns rather than refusing outright.
 */
import { isTauri, isMobile } from './platform';
import { safeBlobType } from './attachments';
import { capacitorFileSink } from './capacitorSink';
import type { ByteSink } from './fileTransfer';
import type { TransferView } from './fileTransferManager';

/** What a browser without the File System Access API can hold without dying. */
export const MEMORY_SINK_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The same, for a phone. Much lower: a mobile webview's heap is a fraction of
 * a desktop browser's, and the whole file is resident before it is handed to
 * the download manager. Dying at 90% with the bytes already transferred is a
 * far worse outcome than declining the offer up front.
 */
export const MOBILE_MEMORY_MAX_BYTES = 100 * 1024 * 1024;

export interface PreparedSink {
    sink: ByteSink;
    /** Bytes already on disk from a previous attempt (desktop only). */
    resumeFrom: number;
    /** Shown to the user on completion. */
    describeDestination: () => string;
    /**
     * Digest of the finished file AT REST, or null when it was not computed.
     *
     * This is the ONLY way to verify a RESUMED transfer: the receiving process
     * never saw the bytes the earlier attempt wrote, so its running hash covers
     * only part of the file. Without this, a resume would complete with no
     * integrity check whatsoever — the worst kind of pass, since a corrupt file
     * would be presented as done.
     */
    verifiedDigest?: () => string | null;
    /**
     * Abandon the transfer WITHOUT completing it.
     *
     * Distinct from `sink.close()` on purpose: on desktop, closing promotes the
     * partial file to its real name. Calling that on a failed transfer would
     * present a truncated file as a finished one — the single worst outcome
     * available here. `keep` retains the partial so a later attempt can resume.
     */
    abort?: (keep: boolean) => Promise<void>;
}

/** Desktop: append into `<Downloads>/Puca/<name>.part`, rename on success. */
async function tauriSink(t: TransferView): Promise<PreparedSink> {
    const { invoke } = await import('@tauri-apps/api/core');
    const begun = await invoke<{ existing_bytes: number; path: string }>('transfer_begin', {
        transferId: t.id,
        fileName: t.name,
        sha256: t.sha256 ?? '',
    });

    let finalPath = begun.path;
    let atRestDigest: string | null = null;
    // Only a resumed transfer needs the extra read pass to hash at rest; a
    // fresh one was hashed as it streamed.
    const resumed = begun.existing_bytes > 0;

    return {
        resumeFrom: begun.existing_bytes,
        describeDestination: () => finalPath,
        verifiedDigest: () => atRestDigest,
        async abort(keep: boolean) {
            await invoke('transfer_abort', { transferId: t.id, keep });
        },
        sink: {
            async write(chunk: Uint8Array) {
                // Raw ipc body: serialising 16 KiB as a JSON array of numbers
                // would inflate it several-fold and dominate the transfer cost.
                await invoke('transfer_write', chunk, {
                    headers: { 'x-transfer-id': t.id },
                });
            },
            async close() {
                const res = await invoke<{ path: string; sha256: string | null }>(
                    'transfer_finish',
                    { transferId: t.id, verify: resumed },
                );
                finalPath = res.path;
                atRestDigest = res.sha256;
            },
        },
    };
}

/** Browser with File System Access: stream into a user-chosen file.
 *
 *  `null` = the API is not there; `'cancelled'` = the user pressed Cancel in
 *  the picker. These MUST stay distinguishable: when both were `null`, the
 *  caller's memory-sink fallback swallowed the cancel and downloaded the file
 *  anyway — a dialog whose No means Yes. */
async function fileSystemAccessSink(t: TransferView): Promise<PreparedSink | null | 'cancelled'> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picker = (window as any).showSaveFilePicker;
    if (typeof picker !== 'function') return null;
    let handle: { createWritable(): Promise<FileSystemWritableFileStream> };
    try {
        handle = await picker({ suggestedName: t.name });
    } catch {
        return 'cancelled';
    }
    const writable = await handle.createWritable();
    return {
        // No resume: we cannot know what a freshly picked file already holds.
        resumeFrom: 0,
        describeDestination: () => t.name,
        sink: {
            async write(chunk: Uint8Array) {
                // Copy into a view whose buffer is definitely an ArrayBuffer:
                // the writable stream refuses a SharedArrayBuffer-backed one.
                await writable.write(new Uint8Array(chunk));
            },
            async close() { await writable.close(); },
        },
    };
}

/** Last resort: assemble in memory and hand the user a download. Capped. */
function memorySink(t: TransferView, cap = MEMORY_SINK_MAX_BYTES): PreparedSink | null {
    if (t.size > cap) return null;
    const parts: Uint8Array[] = [];
    return {
        resumeFrom: 0,
        describeDestination: () => t.name,
        sink: {
            write(chunk: Uint8Array) { parts.push(chunk); },
            close() {
                // `t.mime` is whatever the SENDER put in their FileOffer, and
                // the server only bounds its length. Not exploitable as written
                // — this anchor is never appended to the document, so there is
                // nothing to middle-click, and `download` beats navigation for
                // a same-origin blob. It gets the same treatment as attachments
                // anyway: the moment this URL is ever attached to the DOM or
                // reused, a `text/html` blob would run script in this origin
                // with the JWT and the E2EE keys in reach. Cheaper to be
                // consistent than to remember the caveat.
                const blob = new Blob(parts as BlobPart[], { type: safeBlobType(t.mime) });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = t.name;
                a.click();
                // Revoke late: revoking immediately can cancel the download in
                // some browsers before it has read the blob.
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
            },
        },
    };
}

/** Why a transfer cannot be received here — shown to the user verbatim. */
export class NoSinkError extends Error {}

/** Which sink the LAST prepareSink chose, for `__pucaTransferDiag()`.
 *  Exists because the Capacitor path can silently fall back to the capped
 *  memory sink (old APK, storage not granted), which changes which
 *  throughput mechanism is even in play — a diagnosis must not have to
 *  infer the sink from the shape of the completion line. */
export let lastSinkChoice: string | null = null;

/**
 * Choose the best sink this platform can offer, or explain why it cannot.
 * Returning null means the user cancelled; throwing means it was never possible.
 */
export async function prepareSink(t: TransferView): Promise<PreparedSink | null> {
    if (isTauri()) {
        lastSinkChoice = 'tauri';
        return tauriSink(t);
    }

    if (isMobile()) {
        // ANDROID STREAMS TO DISK, UNCAPPED. @capacitor/filesystem ships in
        // the APK as of 0.8.28 (it arrived with phone-as-file-host), so the
        // note that used to live here — "adding it needs a new APK rather
        // than an OTA" — is stale, and it was the whole reason for the cap.
        const streamed = await capacitorFileSink(t);
        if (streamed) {
            lastSinkChoice = 'capacitor-stream';
            console.info('[p2p] sink: capacitor-stream ->', streamed.describeDestination?.());
            return streamed;
        }
        lastSinkChoice = 'memory-fallback';
        console.info('[p2p] sink: memory-fallback (old APK, <SDK30, or storage not granted)');

        // Everything else still assembles in memory: iOS, an APK too old to
        // carry the plugin, Android below 11, or storage access not granted.
        // The whole file is resident there, and a phone's heap is a fraction
        // of a desktop's, so the cap stays — declining up front beats dying
        // at 90% with the bytes already spent.
        const mem = memorySink(t, MOBILE_MEMORY_MAX_BYTES);
        if (mem) return mem;
        throw new NoSinkError(
            `This phone can receive files up to `
            + `${Math.floor(MOBILE_MEMORY_MAX_BYTES / (1024 * 1024))} MB — this one is `
            + `${Math.round(t.size / (1024 * 1024))} MB. Turning on file sharing in `
            + `the Devices view — the Devices button in the left rail — lifts the limit, `
            + `or use the desktop app.`,
        );
    }

    const fsa = await fileSystemAccessSink(t);
    // A cancelled Save As is an ANSWER, not an invitation to fall back: this
    // is the "Returning null means the user cancelled" the contract above
    // promises, and both callers already treat null as a decline.
    if (fsa === 'cancelled') return null;
    if (fsa) return fsa;

    const mem = memorySink(t);
    if (mem) return mem;

    throw new NoSinkError(
        `This browser can only receive files up to ${Math.floor(MEMORY_SINK_MAX_BYTES / (1024 * 1024))} MB. `
        + 'Use the desktop app for larger transfers.',
    );
}
