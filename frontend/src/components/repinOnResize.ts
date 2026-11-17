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
 *    follows, or one `headingToEnd()` (Chat.tsx's Jump to latest, until its
 *    scroll has got there: scrollToEnd below):
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
        // A list on its way to the end gets there whichever of the two changed.
        if (headingToEnd() || (contentChanged ? atBottom() : wasAtEnd)) el.scrollTop = h;
    };
}

type Scroller = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;

/** At the newest message. The browser can leave a fraction of a px there. */
export const atEnd = (el: Scroller): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= 1;

export interface ScrollToEnd {
    /** Chat.tsx's own scroll to the newest message begins (Jump to latest, a send, a
     *  conversation opened), and its clock restarts. */
    start(): void;
    /** The reader took the wheel or a finger: the list is theirs again. */
    cancel(): void;
    /** Still on its way: repinOnResize's `headingToEnd`. */
    heading(): boolean;
    /** For each scroll event: true while the scroll is still this one's own, which the
     *  caller then ignores (a smooth scroll's steps would read as the reader scrolling
     *  up). The event that finds the list at its end lets go; one that finds it moved
     *  back up lets go and is the reader's (false), for the caller to read as theirs. */
    ownScroll(el: Scroller): boolean;
}

/**
 * A scroll of Chat.tsx's own to the newest message, from its start until it has
 * got there. It lets go at the END, not within AT_BOTTOM_SLOP of it: a smooth
 * scroll's target is the end as it was when it started, so when the list's box
 * shrank in the last stretch (the other side's typing indicator, a line more in
 * the message box) the scroll stopped that many px short, and with this already
 * let go nothing took it on (repinOnResize moves a list on a change of its box
 * only if it was at its end, or heading there). Measured 2026-11-17 in Chromium
 * and WebKit, a jump of 900 px with the typing indicator (31 px) coming up 100,
 * 60 or 20 px from the end: 31 px short every time when let go within the slop,
 * at the end every time when held to the end. It also lets go when the reader
 * takes the wheel or a finger (cancel), or scrolls back up some other way (a
 * drag of the scrollbar, PageUp: a step up, further from the end than it has
 * been, is never this scroll's), and
 * `settleMs` after its last step with no arrival: a scroll that was already at
 * the end makes no event. `onSettle` then squares the caller's state with where
 * the list really is. After its LAST step, not its start: Chromium takes up to
 * 1.5 s for a long one (measured 892 ms for 3,000 px, 1,281 for 6,000, 1,497
 * for 12,000; WebKit about 210 ms whatever the length), and a valve counted from
 * the start let go mid-flight, so the indicator coming up after that left a
 * 6,000 px jump 31 px short again.
 */
export function scrollToEnd(settleMs: number, onSettle: () => void): ScrollToEnd {
    let on = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastTop: number | null = null;
    let nearest = Infinity;
    const stop = () => {
        on = false;
        lastTop = null;
        nearest = Infinity;
        if (timer !== null) { clearTimeout(timer); timer = null; }
    };
    const clock = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => { stop(); onSettle(); }, settleMs);
    };
    return {
        start() {
            stop();
            on = true;
            clock();
        },
        cancel: stop,
        heading: () => on,
        ownScroll(el) {
            if (!on) return false;
            if (atEnd(el)) { stop(); return true; }
            // The reader's: the list moved up, and is further from the end than this scroll has
            // been (a slow drag a fraction of a px a step adds up). Content above shrinking moves
            // it up too, as the browser keeps what is on screen in place (scroll anchoring), but
            // leaves the distance to the end as it was.
            const from = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (lastTop !== null && el.scrollTop < lastTop && from > nearest + 1) { stop(); return false; }
            lastTop = el.scrollTop;
            nearest = Math.min(nearest, from);
            clock();
            return true;
        },
    };
}
