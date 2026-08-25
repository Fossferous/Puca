/**
 * React view of an authenticated file (see api/authedMedia).
 *
 * `GET /files/:id` requires the Authorization header now, and `<img src>`
 * cannot send one — so components ask for an object URL instead of a
 * `/files/...` URL. Returns null until the bytes arrive, and stays null if the
 * fetch fails, so callers keep rendering their existing fallback (initials, a
 * placeholder icon) rather than a broken image.
 *
 * The api layer stays React-free, hence this thin wrapper living in hooks/.
 */
import { useEffect, useState } from 'react';
import { cachedFileUrl, fetchFileUrl } from '../api/authedMedia';

export function useAuthedFileUrl(fileId: string | null | undefined): string | null {
    // Seed from the cache so an already-fetched avatar paints on the FIRST
    // render. Without this every re-mount in a scrolling message list would
    // flash its fallback for a frame even though the blob is already in hand.
    const [url, setUrl] = useState<string | null>(() => (fileId ? cachedFileUrl(fileId) : null));

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

        let alive = true;
        setUrl(null);
        void fetchFileUrl(fileId).then(resolved => {
            // Ignore a late resolve after the id changed or the component went
            // away, or a fast-scrolling list would paint the wrong avatar.
            if (alive) setUrl(resolved);
        });
        return () => { alive = false; };
    }, [fileId]);

    return url;
}
