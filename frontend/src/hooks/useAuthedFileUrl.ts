/**
 * React view of an authenticated file (see api/authedMedia).
 *
 * `GET /files/:id` requires the Authorization header now, and `<img src>`
 * cannot send one — so components ask for a data: URL instead of a
 * `/files/...` URL. Returns null until the bytes arrive, and null if they
 * cannot be had, so callers keep rendering their existing fallback (initials,
 * a placeholder icon) rather than a broken image.
 *
 * A null that may pass (the shared job gave up on a busy server or a network
 * that was down, after its own retries) is not for the rest of the session:
 * the component asks again at the next chance api/authedMedia names (back
 * online, the page shown again, the socket connected again, or another
 * component having loaded the same file), once per chance. It used to ask
 * again only for a NEW file id, and a member-list row keeps its id through
 * every members poll, so one 503 drew initials until a reload (2026-11-19).
 * Unmounting stops it all: the job is told nobody waits (it stops trying) and
 * the chance is no longer listened for.
 *
 * The api layer stays React-free, hence this thin wrapper living in hooks/.
 */
import { useEffect, useState } from 'react';
import { cachedFileUrl, loadFileUrl, onFileRecoveryChance } from '../api/authedMedia';

export function useAuthedFileUrl(fileId: string | null | undefined): string | null {
    // Seed from the cache so an already-fetched avatar paints on the FIRST
    // render. Without this every re-mount in a scrolling message list would
    // flash its fallback for a frame even though the URL is already in hand.
    const [url, setUrl] = useState<string | null>(() => (fileId ? cachedFileUrl(fileId) : null));
    // Bumped at each chance to recover after a give-up: asks again.
    const [chance, setChance] = useState(0);

    useEffect(() => {
        // Clearing/adopting the cached URL synchronously is the point: it must
        // happen in the same commit as the id change, or a scrolling list
        // paints the PREVIOUS avatar for a frame.
        //
        // The directive must sit DIRECTLY above the code. It previously led a
        // three-line comment block, so it applied to the next COMMENT line and
        // suppressed nothing — eslint reported it as an unused directive while
        // still erroring on the setState two lines below.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
        if (!fileId) { setUrl(null); return; }

        const hit = cachedFileUrl(fileId);
        if (hit) { setUrl(hit); return; }

        const asking = new AbortController();
        let stopListening: (() => void) | null = null;
        setUrl(null);
        void loadFileUrl(fileId, { signal: asking.signal }).then((outcome) => {
            // Ignore a late resolve after the id changed or the component went
            // away, or a fast-scrolling list would paint the wrong avatar.
            if (asking.signal.aborted) return;
            setUrl(outcome.url);
            if (!outcome.url && outcome.retryable) {
                stopListening = onFileRecoveryChance(fileId, () => setChance((n) => n + 1));
            }
        });
        return () => {
            asking.abort();
            stopListening?.();
        };
    }, [fileId, chance]);

    return url;
}
