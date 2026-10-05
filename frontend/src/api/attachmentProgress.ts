/**
 * How far along each encrypted attachment's download is, for the
 * "Loading attachment…" placeholder (components/AttachmentLoading.tsx).
 *
 * An attachment is one AES-GCM blob: nothing can show until all of it has
 * arrived. A 22.5 MB video sat behind a static "Decrypting attachment…" for
 * ~6 s on the measured emulator (2026-10-04), almost all of it download, and
 * a slower link stretches that further. This lets the placeholder show the
 * bytes arriving. Keyed by file id; a remount mid-download picks up the
 * latest figure.
 */
import { readBodyBytes } from './readBody';

export interface AttachmentBytes { received: number; total: number | null }
type Listener = (b: AttachmentBytes) => void;

const latest = new Map<string, AttachmentBytes>();
const listeners = new Map<string, Set<Listener>>();

function notify(id: string, b: AttachmentBytes): void {
    for (const l of listeners.get(id) ?? []) l(b);
}

/** `resp`'s body (the attachment cache's fetch of file `id`), publishing its
 *  progress while it arrives. The last figure stands until the attachment
 *  shows (decryption takes tens of ms) or fails; a retry counts again from 0. */
export async function readAttachmentBody(id: string, resp: Response): Promise<Uint8Array> {
    try {
        return await readBodyBytes(resp, (received, total) => {
            const b = { received, total };
            latest.set(id, b);
            notify(id, b);
        });
    } finally {
        latest.delete(id);
    }
}

/** Hear file `id`'s progress (called at once with the latest, if any).
 *  Returns the unsubscribe. */
export function watchAttachmentBytes(id: string, listener: Listener): () => void {
    let set = listeners.get(id);
    if (!set) { set = new Set(); listeners.set(id, set); }
    set.add(listener);
    const cur = latest.get(id);
    if (cur) listener(cur);
    return () => {
        const s = listeners.get(id);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) listeners.delete(id);
    };
}
