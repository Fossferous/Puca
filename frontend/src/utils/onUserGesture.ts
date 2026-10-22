/**
 * Run `fn` on every user gesture that can unlock media playback (a pointer
 * press, a key, a touch end), until the returned function is called.
 *
 * Why: a browser lets a page start audible media only after the user has
 * interacted with it. A stream watched by a click carries that gesture; one
 * started WITHOUT a click (auto-watch of a stream-only account's share,
 * docs/STREAM_ONLY.md) may find its AudioContext suspended or its audio
 * element's play() refused - typically after a reload rejoined the call with
 * nobody touching the page. The picture is a muted <video> and plays anyway;
 * this lets its sound start at the first tap instead of never.
 */
export function onUserGesture(fn: () => void): () => void {
    const opts = { capture: true, passive: true } as const;
    const events = ['pointerdown', 'keydown', 'touchend'] as const;
    for (const e of events) document.addEventListener(e, fn, opts);
    return () => {
        for (const e of events) document.removeEventListener(e, fn, opts);
    };
}
