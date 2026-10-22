/**
 * Which live shares to start watching without a click (docs/STREAM_ONLY.md,
 * "Watching its stream"): those of STREAM-ONLY members of the call, once per
 * share. Pure, so the rule is testable without a call; Chat.tsx runs it on
 * every stream-state change.
 *
 * `handled` is the set of members whose current share was already opened (or
 * found already open). A share the viewer then closes stays closed: its
 * member stays in `handled` until the share ends (it leaves `streamers`), so
 * only their NEXT share opens by itself again.
 */
export interface AutoWatchInput {
    /** Members with a live share in this call (the stream list). */
    streamers: readonly number[];
    /** This client's own user id: your own share is never auto-watched. */
    me: number;
    /** Shares already being watched. */
    selected: readonly number[];
    handled: ReadonlySet<number>;
    isStreamOnly: (userId: number) => boolean;
    /** Settings → Voice & Video → Automatically watch streams from stream-only accounts. */
    enabled: boolean;
    /** The browser asks to save data (navigator.connection.saveData). */
    saveData: boolean;
    /** This client is itself a stream-only account: it watches nothing by itself. */
    viewerIsStreamOnly: boolean;
}

export interface AutoWatchPlan {
    /** Start watching these now (and record them as handled). */
    open: number[];
    /** Already being watched (the viewer clicked first): record them as
     *  handled without touching anything, so closing it later sticks. */
    adopt: number[];
    /** Their share ended: forget them, so their next share opens again. */
    forget: number[];
}

export function autoWatchPlan(i: AutoWatchInput): AutoWatchPlan {
    const live = new Set(i.streamers);
    const forget = [...i.handled].filter(id => !live.has(id));
    if (!i.enabled || i.saveData || i.viewerIsStreamOnly) return { open: [], adopt: [], forget };
    const fresh = i.streamers.filter(id => id !== i.me && i.isStreamOnly(id) && !i.handled.has(id));
    return {
        open: fresh.filter(id => !i.selected.includes(id)),
        adopt: fresh.filter(id => i.selected.includes(id)),
        forget,
    };
}

/** Does the browser ask to save data? (Chromium's Network Information API;
 *  absent elsewhere, which reads as no.) */
export function browserSavesData(): boolean {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return c?.saveData === true;
}
