/**
 * Which peers we have already been TOLD are screen-sharing.
 *
 * `ScreenShareStarted` is not an edge — it is replayed. A client re-announces
 * its share on every WS reconnect (that re-claim is what stops the server
 * tearing the tile down when the dead connection is reaped), and the server
 * also replays room state to any (re)joining connection. Chiming and
 * auto-opening a tile on the raw event therefore re-fires on every socket blip,
 * reopening a tile the viewer had deliberately dismissed.
 *
 * So the UI reacts to the transition into this set, not to the event — the same
 * shape as the join-chime `announcedRef`.
 *
 * IMPORTANT: membership means "we were told", NOT "we have their pixels".
 * Media can arrive BEFORE the announcement — over the SFU, LiveKit pushes the
 * track independently of our socket while the sharer is still awaiting its
 * publish ack — so deciding this from live video would classify a genuinely new
 * share as a replay and silently swallow its chime and tile.
 */
export class ShareAnnouncements {
    private announced = new Set<number>();

    /**
     * Record an announcement. Returns true when this is NEWS (the first time
     * we have been told this peer is sharing), false when it is a replay.
     */
    announce(streamerId: number): boolean {
        const isNew = !this.announced.has(streamerId);
        this.announced.add(streamerId);
        return isNew;
    }

    /** They stopped, so their next announcement is news again. */
    stopped(streamerId: number): void {
        this.announced.delete(streamerId);
    }

    /** Leaving voice: a rejoin must re-seed from scratch. */
    clear(): void {
        this.announced.clear();
    }
}
