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

/** A start nobody ended by then (a dialog left open, a path that forgot) no
 *  longer holds the next one back: past WebView2's 5 s first-frame wait and a
 *  slow server's answer, short of forever. */
export const SHARE_START_STALE_MS = 60_000;

export interface ShareStart {
    readonly by: ShareStartBy;
    readonly startedAt: number;
    /** A Stop, or the picture ending, came while it was starting. */
    cancelled: boolean;
}

export class ShareStarts {
    private current: ShareStart | null = null;
    private readonly now: () => number;

    constructor(now: () => number = Date.now) {
        this.now = now;
    }

    /** Begin a start, or null while another one runs. A stale one is
     *  cancelled and replaced. */
    begin(by: ShareStartBy): ShareStart | null {
        const now = this.now();
        if (this.current && now - this.current.startedAt < SHARE_START_STALE_MS) return null;
        if (this.current) this.current.cancelled = true;
        this.current = { by, startedAt: now, cancelled: false };
        return this.current;
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
    }

    get active(): ShareStart | null {
        return this.current;
    }
}

type StreamLike = { getVideoTracks(): { readyState: string }[] } | null | undefined;

/** Whether a start may still go live: nobody stopped it, and its picture is still there. */
export function stillWanted(start: ShareStart | null | undefined, stream: StreamLike): boolean {
    if (start?.cancelled) return false;
    const video = stream?.getVideoTracks()[0];
    return !!video && video.readyState === 'live';
}
