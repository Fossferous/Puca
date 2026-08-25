/**
 * Owner of in-flight "browse a device's files" downloads.
 *
 * WHY THIS EXISTS. The download used to be an async loop inside
 * DeviceFileManager, writing into that component's own useState. Closing the
 * file panel, toggling Files on the remote-control stage, or navigating
 * anywhere else unmounted the component while the loop kept running — writing
 * progress into a dead React tree, with no way to see it, no way to cancel it,
 * and no way to learn whether it finished. A transfer is not a property of the
 * screen that happened to start it.
 *
 * So it lives here instead, module-level, exactly like the chat transfers'
 * manager: state in a Map, subscribers notified on change, and a cancel that
 * actually stops the loop between chunks. Any surface can render it, and
 * unmounting one cannot orphan anything.
 */
import { downloadFileTo } from './fileTransfer';
import { prepareSink } from '../transferSinks';
import {
    beginBackgroundTransfer,
    updateBackgroundTransfer,
    endBackgroundTransfer,
    ensureTransferNotificationPermission,
} from '../mobileTransferService';
import type { TransferView } from '../fileTransferManager';

export type DeviceDownloadState = 'running' | 'complete' | 'failed' | 'cancelled';

export interface DeviceDownload {
    id: string;
    sessionId: string;
    /** Path on the remote machine. */
    path: string;
    name: string;
    size: number;
    bytes: number;
    state: DeviceDownloadState;
    /** Safe to show the user; set when state is 'failed'. */
    error?: string;
    /** Where it landed, once complete. */
    destination?: string;
}

interface Entry extends DeviceDownload {
    signal: { aborted: boolean };
}

type Listener = (list: DeviceDownload[]) => void;

const downloads = new Map<string, Entry>();
const listeners = new Set<Listener>();

function view(e: Entry): DeviceDownload {
    return {
        id: e.id, sessionId: e.sessionId, path: e.path, name: e.name,
        size: e.size, bytes: e.bytes, state: e.state,
        error: e.error, destination: e.destination,
    };
}

function emit(): void {
    const list = [...downloads.values()].map(view);
    listeners.forEach(l => l(list));
    syncBackgroundService();
}

/**
 * Hold the foreground service open for exactly as long as something is
 * moving. Driven from emit() so there is ONE place that decides, rather than
 * a start here and a stop over there that can drift out of step and leave a
 * notification for work that finished.
 */
function syncBackgroundService(): void {
    const live = [...downloads.values()].filter(e => e.state === 'running');
    if (live.length === 0) {
        void endBackgroundTransfer();
        return;
    }
    const bytes = live.reduce((n, e) => n + e.bytes, 0);
    const total = live.reduce((n, e) => n + e.size, 0);
    const pct = total > 0 ? (bytes / total) * 100 : undefined;
    const text = live.length === 1
        ? live[0].name
        : `${live.length} files`;
    void updateBackgroundTransfer(text, pct);
}

export function subscribeDeviceDownloads(fn: Listener): () => void {
    listeners.add(fn);
    fn([...downloads.values()].map(view));
    return () => { listeners.delete(fn); };
}

export function activeDeviceDownloads(): DeviceDownload[] {
    return [...downloads.values()].map(view);
}

/** Is anything still moving? Drives the background-service lifetime. */
export function hasRunningDeviceDownload(): boolean {
    return [...downloads.values()].some(e => e.state === 'running');
}

export function cancelDeviceDownload(id: string): void {
    const e = downloads.get(id);
    if (!e || e.state !== 'running') return;
    e.signal.aborted = true;      // the loop notices between chunks
    e.state = 'cancelled';
    emit();
}

/** Forget a finished row — the UI's dismiss button. */
export function clearDeviceDownload(id: string): void {
    const e = downloads.get(id);
    if (!e || e.state === 'running') return;
    downloads.delete(id);
    emit();
}

/**
 * Start a download and return its id. Resolves as soon as it is REGISTERED,
 * not when it finishes — the caller is a button, not the owner.
 */
export function startDeviceDownload(
    sessionId: string,
    path: string,
    name: string,
    size: number,
): string {
    const id = `dd-${crypto.randomUUID()}`;
    const entry: Entry = {
        id, sessionId, path, name, size,
        bytes: 0, state: 'running', signal: { aborted: false },
    };
    downloads.set(id, entry);
    emit();

    // Start the service BEFORE the first await. Android 12+ refuses to start
    // a foreground service from the background, so it has to go up while the
    // app is still on screen — which it is, since a tap started this.
    void (async () => {
        await ensureTransferNotificationPermission();
        await beginBackgroundTransfer(name, 0);
    })();

    void (async () => {
        let prepared: Awaited<ReturnType<typeof prepareSink>> = null;
        try {
            // A unique pseudo-digest per attempt: the desktop sink names its
            // partial file by this, and a shared name would let a stale
            // partial be appended to on a retry.
            prepared = await prepareSink({
                id, name, size,
                sha256: crypto.randomUUID().replace(/-/g, ''),
                mime: '',
            } as TransferView);
            if (!prepared) {
                // The user cancelled a Save As dialog; nothing was asked of
                // the other machine.
                downloads.delete(id);
                emit();
                return;
            }

            await downloadFileTo(
                sessionId, path, size,
                b => prepared!.sink.write(b),
                done => {
                    const live = downloads.get(id);
                    if (!live) return;
                    live.bytes = done;
                    emit();
                },
                entry.signal,
            );
            await prepared.sink.close();

            const live = downloads.get(id);
            if (live) {
                live.state = 'complete';
                live.bytes = size;
                live.destination = prepared.describeDestination();
                emit();
            }
        } catch (e) {
            // Never leave a half-written file wearing the real name.
            try { await prepared?.abort?.(false); } catch { /* already failing */ }
            const live = downloads.get(id);
            if (!live) return;
            const message = e instanceof Error ? e.message : String(e);
            // A cancel is not a failure; it already set its own state.
            live.state = live.signal.aborted ? 'cancelled' : 'failed';
            if (live.state === 'failed') live.error = message;
            emit();
        }
    })();

    return id;
}
