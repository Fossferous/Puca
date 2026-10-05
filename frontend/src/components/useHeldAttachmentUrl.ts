/**
 * A decrypted attachment's URL for as long as a component shows it: Tasks'
 * attachment strip, a note's pictures and voice notes, a note card's
 * thumbnails. The same hold a chat message's attachment takes
 * (api/attachments.ts acquireAttachmentUrl): the plaintext exists only while
 * something holds it, the cache keeps the ciphertext, and the URL goes when
 * the component unmounts, when `enabled` turns false, or when the app has
 * been in the background a moment (api/attachmentAwake.ts) unless `keep`
 * (it is playing, open in the lightbox, being saved).
 *
 * These used to call decryptToBlobUrl, which kept every picture a session
 * had opened decrypted until sign-out: in the Android WebView that is a
 * plaintext file per picture in app_webview/Default/blob_storage, there
 * while the app sat in the background and after it was killed.
 *
 * The URL is returned only while it is wanted, so the render that stops
 * using it removes it from the page BEFORE it is let go: a released URL is
 * never in the DOM.
 */
import { useEffect, useState } from 'react';
import { acquireAttachmentUrl, type AttachmentHold } from '../api/attachments';
import { useAttachmentsAwake } from '../api/attachmentAwake';
import { isAbortError } from '../api/priorityLimiter';

export interface HeldRef {
    id: string;
    key: string;
    /** The MIME to decrypt it under (as for acquireAttachmentUrl). */
    mime: string;
    cap?: string;
}

export function useHeldAttachmentUrl(
    ref: HeldRef | null,
    opts: { enabled?: boolean; keep?: boolean } = {},
): { url: string | null; failed: boolean } {
    const { enabled = true, keep = false } = opts;
    const awake = useAttachmentsAwake();
    const want = !!ref && enabled && (awake || keep);
    const k = ref ? `${ref.id}\n${ref.key}\n${ref.mime}\n${ref.cap ?? ''}` : '';
    const [state, setState] = useState<{ k: string; url: string | null; failed: boolean }>({ k: '', url: null, failed: false });
    useEffect(() => {
        if (!ref || !want) return;
        let alive = true;
        let hold: AttachmentHold | null = null;
        const ac = new AbortController();
        acquireAttachmentUrl(ref.id, ref.key, ref.mime, ref.cap, { signal: ac.signal })
            .then((h) => {
                if (!alive) { h.release(); return; }
                hold = h;
                setState({ k, url: h.url, failed: false });
            })
            .catch((err) => {
                if (!alive || isAbortError(err)) return;
                setState({ k, url: null, failed: true });
            });
        return () => {
            alive = false;
            ac.abort();
            // After the commit that stopped rendering it (see above).
            hold?.release();
            setState((s) => (s.k === k ? { k, url: null, failed: s.failed } : s));
        };
        // `k` stands for `ref` (every field of it).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [k, want]);
    const mine = state.k === k;
    return { url: want && mine ? state.url : null, failed: mine && state.failed };
}
