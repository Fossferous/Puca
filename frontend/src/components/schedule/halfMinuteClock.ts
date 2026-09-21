/**
 * The shared 30-second clock for anything whose look depends on "now":
 * overdue chips, relative times. Quantized so the snapshot is referentially
 * stable between ticks, which is what lets useSyncExternalStore re-render
 * only when the value really changed.
 *
 * Reading `Date.now()` during render is an impure render call — `npm run
 * lint` refuses it, and worse, the refusal makes the other react-hooks rules
 * in that component stop reporting. TaskTree and NotesShell each had a
 * private copy of this; they still do, and new callers use this one.
 */
export function subscribeHalfMinute(onTick: () => void): () => void {
    const id = window.setInterval(onTick, 30_000);
    return () => window.clearInterval(id);
}

export function halfMinuteNow(): number {
    return Math.floor(Date.now() / 30_000) * 30_000;
}
