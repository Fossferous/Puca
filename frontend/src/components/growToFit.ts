/**
 * Grow the message box to fit what is written in it, up to `max` px, without
 * moving the message list beside it.
 *
 * The box measures its words the usual way: height `auto`, then read
 * `scrollHeight`. Reading it lays the page out with the box at ONE line, so
 * for that moment the message list above it is taller, and WebKit (the
 * iPhone's engine) clamps the list's scrollTop to that taller list's bottom.
 * The box gets its height back at once, the list its old height, but not its
 * scrollTop: a list that was at the newest message is left that many px short
 * of it. Measured 2026-11-16 in Playwright's WebKit at 390x844, the box at
 * four lines: 90 px of the newest message hidden after every keystroke, and
 * nothing re-pins it, because no height has changed by the time anything
 * looks (repinOnResize). From six lines on it is more than Chat.tsx's
 * AT_BOTTOM_SLOP, and the list took the keystroke for a reader scrolling up:
 * the next message stopped following and "Jump to latest" came up. Chromium
 * does not clamp there; there this changes nothing.
 *
 * So the list's scrollTop is put back to what it was before the measuring.
 * If the box really did grow or shrink, the list's height has changed and
 * repinOnResize takes it from there, as for any other change of its height.
 */
export function growToFit(
    box: { style: { height: string }; readonly scrollHeight: number },
    max: number,
    list: { scrollTop: number } | null,
): void {
    const top = list ? list.scrollTop : 0;
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, max) + 'px';
    if (list && list.scrollTop !== top) list.scrollTop = top;
}
