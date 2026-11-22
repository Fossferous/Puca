/**
 * A parked picture's URL (one added with no connection, not uploaded yet:
 * api/parkedPreview.ts) for as long as a component shows it: the same hold
 * useHeldAttachmentUrl takes on an uploaded one. The plaintext exists only
 * while something holds it, and the URL goes when the component unmounts,
 * when `enabled` turns false, or when the app has been in the background a
 * moment (api/attachmentAwake.ts) unless `keep` (open in the lightbox).
 *
 * `failed` is true when the bytes are not on this device any more (or could
 * not be opened). The URL is returned only while it is wanted, so the render
 * that stops using it removes it from the page BEFORE it is let go.
 */
import { useEffect, useState } from 'react';
import { acquireParkedUrl, type ParkedHold } from '../api/parkedPreview';
import { useAttachmentsAwake } from '../api/attachmentAwake';

export function useHeldParkedUrl(
    href: string | null,
    opts: { enabled?: boolean; keep?: boolean } = {},
): { url: string | null; failed: boolean; type: string | null } {
    const { enabled = true, keep = false } = opts;
    const awake = useAttachmentsAwake();
    const want = !!href && enabled && (awake || keep);
    const k = href ?? '';
    const [state, setState] = useState<{ k: string; url: string | null; failed: boolean; type: string | null }>({ k: '', url: null, failed: false, type: null });
    useEffect(() => {
        if (!href || !want) return;
        let alive = true;
        let hold: ParkedHold | null = null;
        acquireParkedUrl(href)
            .then((h) => {
                if (!alive) { h?.release(); return; }
                if (!h) { setState({ k, url: null, failed: true, type: null }); return; }
                hold = h;
                setState({ k, url: h.url, failed: false, type: h.type });
            })
            .catch(() => { if (alive) setState({ k, url: null, failed: true, type: null }); });
        return () => {
            alive = false;
            // After the commit that stopped rendering it (see above).
            hold?.release();
            setState((s) => (s.k === k ? { k, url: null, failed: s.failed, type: null } : s));
        };
        // `k` stands for `href`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [k, want]);
    const mine = state.k === k;
    return { url: want && mine ? state.url : null, failed: mine && state.failed, type: want && mine ? state.type : null };
}
