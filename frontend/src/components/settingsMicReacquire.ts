/**
 * Does a Settings save mid-call re-open the microphone through the live-swap
 * path (VoicePanel's settingsChanged listener -> applyNoiseModeLive)?
 *
 * In a call with a microphone: when what the microphone is opened with
 * changed (echo cancellation, noise suppression, auto gain, the input
 * device), when DeepFilter's tuning did while DeepFilter is the mode, or
 * when a gain other than 1 needs a graph that is not there.
 *
 * LISTEN-ONLY (no usable microphone at the join, or one that died): only a
 * microphone picked in Settings. Nothing else is a reason to open one. The
 * gain test was always true there (no microphone, so no gain stage), so with
 * Input Volume anywhere but 100% EVERY save re-opened the microphone: choosing
 * a camera in Settings, any checkbox. A permission prompt answered by closing
 * it came back on each save, and a microphone that did open took the member
 * out of listen-only from a press that had nothing to do with it. (Without a
 * microphone by choice, or without SPEAK, the media layer refuses to open one
 * in any case: MediaManager.reacquireAudioTrack.)
 */
export function settingsReacquireMic(c: {
    inVoice: boolean;
    listenOnly: boolean;
    deviceChanged: boolean;
    constraintsChanged: boolean;
    dfTuningChanged: boolean;
    gainNeedsGraph: boolean;
}): boolean {
    if (!c.inVoice) return false;
    if (c.listenOnly) return c.deviceChanged;
    return c.constraintsChanged || c.dfTuningChanged || c.gainNeedsGraph;
}
