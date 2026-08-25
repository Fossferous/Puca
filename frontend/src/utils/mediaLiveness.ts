/**
 * Is this entry backed by video that is actually still flowing?
 *
 * Used to tell three states apart that all look alike in a sharers map:
 *  - no entry / a `null` placeholder announced but whose media has not arrived,
 *  - a STALE entry whose stream died with an unclean disconnect (the black-tile
 *    producer: it must be replaced, not preserved),
 *  - a share we are genuinely watching.
 *
 * The last case is what makes a `ScreenShareStarted` event a re-announce rather
 * than news: a client re-claims its share on every WS reconnect, so the event
 * alone says nothing about whether anything changed.
 */
export function hasLiveVideo(entry?: { stream: MediaStream | null } | null): boolean {
    return !!entry?.stream?.active
        && entry.stream.getVideoTracks().some(t => t.readyState === 'live');
}
