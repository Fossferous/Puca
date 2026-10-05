/**
 * Keep a message list pinned to its newest message while its content grows
 * (Chat.tsx: late-loading pictures, link previews, decrypted attachments) —
 * but only when it GROWS. The handler runs on every `load` in the list, every
 * resize of a row and every node added or removed anywhere in it; re-pinning
 * on each of those pulled a reader who had just scrolled up less than
 * AT_BOTTOM_SLOP back to the bottom whenever the list changed without moving.
 * Measured 2026-10-05 in headless Edge, a channel of 12 videos: a video at
 * the edge of the loaded zone swaps its placeholder for its card of the same
 * height as the reader's own scroll brings it in range, and every wheel notch
 * up from the bottom was undone — the list could not be scrolled up a notch
 * at a time.
 */
export function repinOnGrowth(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop'>, atBottom: () => boolean): () => void {
    let height = el.scrollHeight;
    return () => {
        const h = el.scrollHeight;
        if (h === height) return;
        height = h;
        if (atBottom()) el.scrollTop = h;
    };
}
