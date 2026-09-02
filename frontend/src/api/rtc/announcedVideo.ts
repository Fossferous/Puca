/**
 * Announcement-driven rendering of mesh video (B7 publish order).
 *
 * The server enforces the VIDEO and STREAM role bits on the ANNOUNCEMENT
 * (CameraStart / ScreenShareStart), but mesh media is peer-to-peer: a track can
 * be on the wire before — or without — the announcement the server would
 * refuse. Receivers therefore render only video the server has announced for
 * that peer. A track that arrives first is HELD and released the moment its
 * announcement lands (the reload/reconnect race where the track legitimately
 * beats the frame), so nothing is dropped, only deferred. What is never
 * rendered is video with no announcement behind it at all.
 *
 * Pure state, no DOM: the manager feeds it arrivals and announcements and
 * takes back "render as camera", "render as screen" or "hold".
 */

export type VideoKind = 'camera' | 'screen';

/** Everything classifyRemoteVideo needs to know about one arriving video. */
export interface VideoArrival {
    /** id of the MediaStream the video track arrived in */
    streamId: string;
    /** the arriving stream IS the peer's pinned voice stream */
    isVoiceStream: boolean;
    /** the peer's mic stream has been pinned (they are not listen-only) */
    micPinned: boolean;
}

/**
 * Classify by STREAM IDENTITY, not track contents. Mic (and camera) tracks
 * always travel in the sender's localStream; screen-share tracks travel in the
 * separate screen stream. With an announced share id the answer is exact;
 * without one (an old peer or server) it falls back to elimination.
 */
export function classifyRemoteVideo(i: VideoArrival & {
    /** a ScreenShareStarted for this peer is in effect */
    sharing: boolean;
    /** the stream id that announcement carried, if any */
    announcedShareId: string | null;
}): VideoKind {
    if (i.sharing && i.announcedShareId !== null) {
        return i.streamId === i.announcedShareId ? 'screen' : 'camera';
    }
    if (i.isVoiceStream || (!i.micPinned && !i.sharing)) return 'camera';
    return 'screen';
}

export interface HeldVideo<T> {
    streamId: string;
    payload: T;
}

/** Re-derives the arrival facts for a held stream at release time: the peer's
 *  voice stream may have been pinned since the track arrived. */
export type ArrivalContext = (streamId: string) => { isVoiceStream: boolean; micPinned: boolean };

export class AnnouncedVideoGate<T> {
    /** Peers currently screen-sharing per the WS announcements, mapped to the
     *  MediaStream id they ANNOUNCED — or null when the announce carried none
     *  (an old peer or an old server), which drops classifyRemoteVideo back to
     *  the elimination heuristic. */
    private shares = new Map<number, string | null>();
    private cameras = new Set<number>();
    private held = new Map<number, HeldVideo<T>[]>();

    announceShare(userId: number, streamId: string | null): void { this.shares.set(userId, streamId); }
    stopShare(userId: number): void { this.shares.delete(userId); }
    announceCamera(userId: number): void { this.cameras.add(userId); }
    stopCamera(userId: number): void { this.cameras.delete(userId); }

    isSharing(userId: number): boolean { return this.shares.has(userId); }
    /** The announced share stream id — null when sharing without one, or not sharing. */
    shareId(userId: number): string | null { return this.shares.get(userId) ?? null; }
    heldCount(userId: number): number { return this.held.get(userId)?.length ?? 0; }

    /** What an arriving video is, given the announcements in effect: a kind to
     *  render now, or 'held' when nothing announced accounts for it. */
    decide(userId: number, arrival: VideoArrival): VideoKind | 'held' {
        const kind = classifyRemoteVideo({
            ...arrival,
            sharing: this.shares.has(userId),
            announcedShareId: this.shares.get(userId) ?? null,
        });
        if (kind === 'screen') return this.shares.has(userId) ? 'screen' : 'held';
        return this.cameras.has(userId) ? 'camera' : 'held';
    }

    /** Decide for a newly arrived video, parking it when held. */
    offer(userId: number, arrival: VideoArrival, payload: T): VideoKind | 'held' {
        const kind = this.decide(userId, arrival);
        if (kind === 'held') {
            const list = this.held.get(userId) ?? [];
            // One entry per stream: a second track of the same stream must
            // not release it twice.
            if (!list.some(h => h.streamId === arrival.streamId)) {
                list.push({ streamId: arrival.streamId, payload });
            }
            this.held.set(userId, list);
        }
        return kind;
    }

    /** After an announcement changed: every held video of this peer that now
     *  classifies, in arrival order. The rest stays held. */
    release(userId: number, ctx: ArrivalContext): Array<{ kind: VideoKind; payload: T }> {
        const list = this.held.get(userId);
        if (!list || list.length === 0) return [];
        const out: Array<{ kind: VideoKind; payload: T }> = [];
        const keep: HeldVideo<T>[] = [];
        for (const h of list) {
            const kind = this.decide(userId, { streamId: h.streamId, ...ctx(h.streamId) });
            if (kind === 'held') keep.push(h);
            else out.push({ kind, payload: h.payload });
        }
        if (keep.length) this.held.set(userId, keep);
        else this.held.delete(userId);
        return out;
    }

    /** The peer's connection is gone: its held tracks are dead. Announcements
     *  are server state and outlive a rebuilt connection, so they stay. */
    forgetHeld(userId: number): void { this.held.delete(userId); }

    /** Leaving voice: nothing announced applies to the next call. */
    reset(): void {
        this.shares.clear();
        this.cameras.clear();
        this.held.clear();
    }
}
