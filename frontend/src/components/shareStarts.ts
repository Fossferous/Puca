/**
 * A share on its way, from the capture to live: the Share dialog's, or an
 * embedding host's startShare (docs/EMBEDDING.md). One at a time, whoever
 * asked, so neither can stop the other's capture halfway.
 *
 * WHY. Going live takes a capture, an announcement the server must answer,
 * and a publish: a second or more on a slow link. A Stop pressed in that
 * window used to be dropped (nothing was live to stop yet), and so was the
 * picture ending in it (its `ended` handler stops a LIVE share), so the share
 * went live anyway with a dead track: an empty tile on everyone's screen
 * until someone pressed Stop again. Now the Stop, or the end, cancels the
 * start, and Go Live checks before each step whether the share is still
 * wanted and still has a picture (VoicePanel.tsx, goLive).
 */

export type ShareStartBy = 'dialog' | 'host';

/** A start nobody ended by then (a path that forgot, a picture that ended
 *  while the dialog waited) no longer holds the next one back: past WebView2's
 *  5 s first-frame wait and a slow server's answer, short of forever. Never
 *  while it is still asking for its picture or still holds a live one: the
 *  capture is one slot (a new capture stops the old one, media.ts), so
 *  replacing it then would stop its picture under it. */
export const SHARE_START_STALE_MS = 60_000;

type StreamLike = { getVideoTracks(): { readyState: string }[] } | null | undefined;

export interface ShareStart {
    readonly by: ShareStartBy;
    readonly startedAt: number;
    /** A Stop, or the picture ending, came while it was starting. */
    cancelled: boolean;
    /** Its picture is still being asked for (captureFor). */
    capturing: boolean;
    /** The picture it captured (captureFor). */
    picture: StreamLike;
}

function hasPicture(stream: StreamLike): boolean {
    return stream?.getVideoTracks()[0]?.readyState === 'live';
}

export class ShareStarts {
    private current: ShareStart | null = null;
    /** The start the Share dialog's own capture began, until its Go Live or
     *  its Cancel takes it (takeDialog). */
    private dialog: ShareStart | null = null;
    private readonly now: () => number;

    constructor(now: () => number = Date.now) {
        this.now = now;
    }

    /** Begin a start, or null while another one runs. A stale one is
     *  cancelled and replaced. */
    begin(by: ShareStartBy): ShareStart | null {
        const now = this.now();
        const cur = this.current;
        if (cur && (now - cur.startedAt < SHARE_START_STALE_MS || cur.capturing || hasPicture(cur.picture))) return null;
        if (cur) cur.cancelled = true;
        this.current = { by, startedAt: now, cancelled: false, capturing: false, picture: null };
        if (by === 'dialog') this.dialog = this.current;
        return this.current;
    }

    /** The dialog's Go Live, or its Cancel, takes the start its own capture
     *  began: never whichever start runs NOW, which may be a host's that
     *  replaced it as stale, and then it must find its own (cancelled) start
     *  and stop at the next step, not run on beside the new one. Null when
     *  the dialog has none. Taking clears it. */
    takeDialog(): ShareStart | null {
        const start = this.dialog;
        this.dialog = null;
        return start;
    }

    /** Stop the start that is running, if one is: it will not go live. True when one was. */
    cancel(): boolean {
        if (!this.current) return false;
        this.current.cancelled = true;
        return true;
    }

    /** That start is over, however it ended. Another's is left alone. */
    end(start: ShareStart | null | undefined): void {
        if (start && this.current === start) this.current = null;
        if (start && this.dialog === start) this.dialog = null;
    }

    get active(): ShareStart | null {
        return this.current;
    }
}

/** Ask for a start's picture, and keep it on the start. While it is asked
 *  for, and once it is there and live, the start is never taken for stale. */
export async function captureFor<S extends NonNullable<StreamLike>>(start: ShareStart, ask: () => Promise<S>): Promise<S> {
    start.capturing = true;
    try {
        const picture = await ask();
        start.picture = picture;
        return picture;
    } finally {
        start.capturing = false;
    }
}

/** Whether a start may still go live: nobody stopped it, and its picture is still there. */
export function stillWanted(start: ShareStart | null | undefined, stream: StreamLike): boolean {
    if (start?.cancelled) return false;
    return hasPicture(stream);
}

/** Whether what the capture slot holds is still this start's to take down:
 *  nothing, or its own picture. A start replaced as stale finds its
 *  replacement's there, and must leave that (and the announcement) alone. */
export function ownsCapture(start: ShareStart | null | undefined, slot: StreamLike): boolean {
    return !slot || !start?.picture || slot === start.picture;
}
