/**
 * Keep a message list pinned to its newest message while its geometry
 * changes (Chat.tsx) — but only when it CHANGES. Two things change it:
 *
 *  - its CONTENT grows: late-loading pictures, link previews, decrypted
 *    attachments (scrollHeight). A list `atBottom()` calls at the bottom
 *    (Chat.tsx: within AT_BOTTOM_SLOP) is pinned, as a new message pins it;
 *  - its own BOX changes height (clientHeight): the soft keyboard (the Android
 *    app's WebView is resized above it), the message box growing a line as you
 *    type, the typing indicator, the reply banner, the attachment chips, the
 *    phone's bottom bar stepping aside for the keyboard and coming back. The
 *    list shrinks from the bottom, the browser keeps scrollTop, and the newest
 *    message slides under the box. Measured 2026-11-16 at 390x844 on the trunk:
 *    with the Android app's resize in desktop Chromium the keyboard hid the
 *    newest 254 px, each line of the box 22 px, the typing indicator 31 px
 *    more; on an iPhone's engine (WebKit) closing the keyboard left 27 px of it
 *    hidden; the desktop hid it the same way as the box grew. "When typing in
 *    an active conversation on mobile, the latest message doesn't stay at the
 *    bottom." (The real Android WebView already keeps such a list at its end by
 *    itself.) Only a list that was AT ITS END by the geometry it had until now
 *    follows, or one `headingToEnd()` (Chat.tsx's Jump to latest, while its
 *    scroll is still more than AT_BOTTOM_SLOP away: pinningRef is let go within
 *    the slop, and a box change in that last stretch can leave it short):
 *    a reader who has scrolled up even one wheel notch, inside the slop, keeps
 *    their scrollTop, because none of these changes is theirs (the typing
 *    indicator, a notice over the list).
 *
 * The handler runs on every `load` in the list, every resize of a row or of
 * the list itself and every node added or removed anywhere in it; re-pinning
 * on each of those pulled a reader who had just scrolled up less than
 * AT_BOTTOM_SLOP back to the bottom whenever the list changed without moving.
 * Measured 2026-10-05 in headless Edge, a channel of 12 videos: a video at
 * the edge of the loaded zone swaps its placeholder for its card of the same
 * height as the reader's own scroll brings it in range, and every wheel notch
 * up from the bottom was undone — the list could not be scrolled up a notch
 * at a time. So it does nothing unless one of the two heights moved since it
 * last looked.
 */
export function repinOnResize(
    el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
    atBottom: () => boolean,
    headingToEnd: () => boolean = () => false,
): () => void {
    let height = el.scrollHeight;
    let box = el.clientHeight;
    return () => {
        const h = el.scrollHeight;
        const b = el.clientHeight;
        if (h === height && b === box) return;
        // Where the list was by the geometry it had until now. The browser keeps
        // scrollTop when the box shrinks, so this is where it was left; when the
        // box grows the browser may have clamped scrollTop to the new end, which
        // is the end already and needs nothing.
        const wasAtEnd = height - el.scrollTop - box <= 1;
        const contentChanged = h !== height;
        height = h;
        box = b;
        if (contentChanged ? atBottom() : wasAtEnd || headingToEnd()) el.scrollTop = h;
    };
}
