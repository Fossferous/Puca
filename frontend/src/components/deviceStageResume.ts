/**
 * Recover the stage's <video> when the app returns to the foreground.
 *
 * Android and iOS both pause a playing <video> the moment the app leaves the
 * foreground, and neither un-pauses it on return. DeviceStage's bind effect
 * cannot recover from that: it acts only when the stream IDENTITY changes and
 * the stream survives a backgrounding on purpose (deviceBackground.test.ts
 * pins the session outliving the freeze). So tabbing out of a live session on
 * a phone and back produced a stage showing the last decoded frame — a still
 * image indistinguishable from a live session whose remote screen happens to
 * be still, with input silently landing on a picture that no longer matches
 * the desktop.
 *
 * TWO independent duties on every visible transition:
 *
 * 1. play(), if the element is paused — and nothing stronger. Re-binding
 *    srcObject would drop the retained frame and paint BLACK until the next
 *    one arrives — and the host agent deliberately sends nothing while the
 *    remote screen is still (stream.rs, PumpError::NoChange), so on an idle
 *    desktop that black frame would be permanent.
 *
 * 2. `onForeground`, ALWAYS (when a stream is bound). v0.8.43 shipped duty 1
 *    alone and the field report survived it: Android can freeze the process
 *    with the element still "playing" while the DECODER loses its reference
 *    state — and with the agent's infinite GOP no keyframe is coming unless
 *    someone asks. The callback is where DeviceStage asks (requestKeyframe →
 *    a sealed signal → the agent forces an IDR; a no-op against old hosts).
 *    It must NOT be gated on `paused` — the residual case is precisely the
 *    element that never paused.
 */
/**
 * The same un-pause duty for surfaces with MANY videos — the voice-channel
 * stages (StreamStage tiles, the PiP, camera tiles), which Android pauses
 * exactly like the device stage. No `onForeground` here on purpose: that
 * hook exists to request a keyframe from the agent's infinite-GOP encoder,
 * and voice-channel media comes from BROWSER encoders whose decoders recover
 * via their own PLI — the platform pause is the only dead end these
 * surfaces can reach.
 *
 * `getVideos` is called AT VISIBILITY TIME, so a dynamic tile set needs no
 * registration bookkeeping — hand back whatever is mounted right now.
 */
export function installBackgroundResumeAll(
    getVideos: () => Iterable<HTMLVideoElement | null | undefined>,
): () => void {
    const onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        for (const v of getVideos()) {
            if (!v || !v.srcObject || !v.paused) continue;
            void v.play().catch(() => { /* retried on the next foreground */ });
        }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
}

export function installBackgroundResume(
    getVideo: () => HTMLVideoElement | null,
    opts?: { onForeground?: () => void },
): () => void {
    const onVisibility = () => {
        // Only on the way BACK. While hidden the pause is the platform's,
        // deliberate, and fighting it burns battery to decode invisible frames.
        if (document.visibilityState !== 'visible') return;
        const v = getVideo();
        // No stream bound means nothing to resume — play() on an empty element
        // is a pending promise waiting for a source, not a no-op.
        if (!v || !v.srcObject) return;
        opts?.onForeground?.();
        // Not paused means the platform never paused it — duty 2 above still
        // ran, which is the whole point of the 0.8.44 revision.
        if (!v.paused) return;
        // muted + playsInline, so autoplay policy cannot refuse this; the
        // catch is for the transient AbortError of a teardown racing the
        // resume, which the next return retries.
        void v.play().catch(() => { /* retried on the next foreground */ });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
}
