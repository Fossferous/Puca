/**
 * Keep a live call's remote-voice <audio> elements PLAYING.
 *
 * Android pauses every playing media element the moment the app leaves the
 * foreground (measured; deviceStageResume.ts fights the same platform pause
 * for the video stages) — but only PLAYBACK dies: the microphone is a
 * getUserMedia track feeding an RTCPeerConnection, which has no media element
 * to pause and keeps transmitting. Field report 2026-08-31: switching apps
 * mid-call left the peer audible to everyone ("we could still hear him")
 * while he heard nothing — and nothing un-paused the elements on return
 * either, so he stayed deaf until a peer reconnected and the remote-stream
 * handler re-ran play().
 *
 * Two duties, mirroring deviceStageResume's split:
 *
 * 1. keepVoiceAudioAlive — a 'pause' listener per element, because it is the
 *    only signal that still fires while HIDDEN (timers are throttled and the
 *    visibilitychange for "hidden" is long past by the time the platform
 *    pauses). A paused element that is still in the DOM with a live stream is
 *    always the platform's doing: every deliberate teardown in this app
 *    REMOVES the element (leave, peer left, stream ended), deafen drives
 *    `.muted`, and per-user volume drives `.volume` — nothing calls pause().
 *    play() from here works in the app shell: Capacitor's WebView disables
 *    the media-engagement gesture requirement; in a browser a refusal lands
 *    in duty 2.
 *
 * 2. installVoiceAudioResume — on every return to 'visible', play() whatever
 *    is still paused, for platforms that refuse the background resume
 *    outright (iOS Safari) or paused after our last nudge.
 */

/** Re-pauses inside this window mean the platform is INSISTING — stop the
 *  synchronous pause/play fight and fall back to one (throttled) timer. */
export const REPAUSE_FIGHT_WINDOW_MS = 1000;
/** The backoff retry. While hidden, Chromium rounds this up (~1s batches,
 *  up to a minute under intensive throttling) — still better than deaf. */
export const REPAUSE_RETRY_DELAY_MS = 1500;

export function keepVoiceAudioAlive(audio: HTMLAudioElement): () => void {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // -Infinity: "never resumed" must always fight immediately — 0 would be
    // read as "resumed at the epoch", which a mocked clock lands inside.
    let lastResume = -Infinity;

    const resume = () => {
        retryTimer = null;
        // Removed, torn down, or already playing again — nothing to fight.
        if (!audio.isConnected || !audio.srcObject || !audio.paused) return;
        lastResume = Date.now();
        void audio.play().catch(() => { /* duty 2 retries on next foreground */ });
    };

    const onPause = () => {
        if (!audio.isConnected || !audio.srcObject) return;
        if (Date.now() - lastResume < REPAUSE_FIGHT_WINDOW_MS) {
            if (retryTimer === null) retryTimer = setTimeout(resume, REPAUSE_RETRY_DELAY_MS);
            return;
        }
        resume();
    };

    audio.addEventListener('pause', onPause);
    return () => {
        audio.removeEventListener('pause', onPause);
        if (retryTimer !== null) clearTimeout(retryTimer);
    };
}

/** Resume every remote-voice element still paused when the app comes back to
 *  the foreground. Keyed on the `audio-<userId>` ids VoicePanel appends to
 *  <body>, so a dynamic roster needs no registration bookkeeping. */
export function installVoiceAudioResume(doc: Document = document): () => void {
    const onVisibility = () => {
        if (doc.visibilityState !== 'visible') return;
        doc.querySelectorAll<HTMLAudioElement>('audio[id^="audio-"]').forEach(a => {
            if (!a.srcObject || !a.paused) return;
            void a.play().catch(() => { /* retried on the next foreground */ });
        });
    };
    doc.addEventListener('visibilitychange', onVisibility);
    return () => doc.removeEventListener('visibilitychange', onVisibility);
}
