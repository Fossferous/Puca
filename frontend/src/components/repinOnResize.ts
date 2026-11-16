/**
 * Keep a message list pinned to its newest message while its geometry
 * changes (Chat.tsx) — but only when it CHANGES. Two things change it:
 *
 *  - its CONTENT grows: late-loading pictures, link previews, decrypted
 *    attachments (scrollHeight);
 *  - its own BOX changes height (clientHeight): the soft keyboard (the Android
 *    app's WebView is resized above it), the message box growing a line as you
 *    type, the typing indicator, the reply banner, the attachment chips, the
 *    phone's bottom bar stepping aside for the keyboard and coming back. The
 *    list shrinks from the bottom, the browser keeps scrollTop, and the newest
 *    message slides under the box. Measured 2026-11-16 at 390x844 on the trunk:
 *    the Android app's keyboard hid the newest 254 px, each line of the box 22
 *    px, the typing indicator 31 px more; on an iPhone's engine (WebKit) closing
 *    the keyboard left 27 px of it hidden. "When typing in an active
 *    conversation on mobile, the latest message doesn't stay at the bottom."
 *
 * The handler runs on every `load` in the list, every resize of a row or of
 * the list itself and every node added or removed anywhere in it; re-pinning
 * on each of those pulled a reader who had just scrolled up less than
 * AT_BOTTOM_SLOP back to the bottom whenever the list changed without moving.
 * Measured 2026-10-05 in headless Edge, a channel of 12 videos: a video at
 * the edge of the loaded zone swaps its placeholder for its card of the same
 * height as the reader's own scroll brings it in range, and every wheel notch
 * up from the bottom was undone — the list could not be scrolled up a notch
 * at a time. So it pins only when one of the two heights moved since it last
 * looked, and only a list `atBottom()` says is at the bottom: a reader further
 * up keeps their scrollTop, so what they are reading stays where it is.
 */
export function repinOnResize(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, atBottom: () => boolean): () => void {
    let height = el.scrollHeight;
    let box = el.clientHeight;
    return () => {
        const h = el.scrollHeight;
        const b = el.clientHeight;
        if (h === height && b === box) return;
        height = h;
        box = b;
        if (atBottom()) el.scrollTop = h;
    };
}
