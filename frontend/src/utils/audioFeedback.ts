// Audio feedback for voice actions using Web Audio API
import { notifEnabled, outputGain } from '../components/settingsStore';
import { getToken } from '../api/auth';

let audioContext: AudioContext | null = null;
let unlockArmed = false;

/**
 * Chromium (and the desktop WebView2) create an AudioContext SUSPENDED when the
 * document has no user activation, and never resume it on their own. Because
 * this context is memoized, ONE suspended birth silenced every notification
 * sound for the whole page lifetime — and the message ping is the sound most
 * likely to be requested first with no preceding gesture (someone messages you
 * while the window sits idle, or right after a reload/OTA update). That is the
 * "notification sound doesn't come through" report.
 *
 * Every other AudioContext in the app already guards this (api/appAudio.ts,
 * api/noiseFilter.ts, api/deepFilter.ts, components/StreamStage.tsx); this one
 * did not.
 */
function armUnlock() {
    if (unlockArmed || typeof window === 'undefined') return;
    unlockArmed = true;
    const nudge = () => {
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(() => { /* still no activation */ });
        }
    };
    // Capture phase + never removed: any interaction anywhere re-arms audio,
    // including after the renderer suspends a minimised window.
    window.addEventListener('pointerdown', nudge, true);
    window.addEventListener('keydown', nudge, true);
    document.addEventListener('visibilitychange', nudge);
}

function getAudioContext(): AudioContext {
    // A closed context (device teardown / renderer suspend) can never play again.
    if (audioContext && audioContext.state === 'closed') audioContext = null;
    if (!audioContext) {
        audioContext = new AudioContext();
    }
    armUnlock();
    return audioContext;
}

function emitTone(ctx: AudioContext, frequency: number, duration: number, type: OscillatorType, volume: number) {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = type;

    // Fade in and out for smooth sound
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
}

// Generate a simple tone
function playTone(frequency: number, duration: number, type: OscillatorType = 'sine', volume: number = 0.3) {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
        // Schedule only AFTER the resume settles: notes queued against a frozen
        // clock are timestamped in the past and never sound.
        ctx.resume()
            .then(() => emitTone(ctx, frequency, duration, type, volume))
            .catch(() => { /* no user gesture yet — the unlock listeners retry */ });
        return;
    }
    emitTone(ctx, frequency, duration, type, volume);
}

// Play two notes in sequence for a pleasant sound
function playChime(freq1: number, freq2: number, ascending: boolean = true) {
    const delay = 0.08;

    if (ascending) {
        playTone(freq1, 0.15);
        setTimeout(() => playTone(freq2, 0.2), delay * 1000);
    } else {
        playTone(freq2, 0.15);
        setTimeout(() => playTone(freq1, 0.2), delay * 1000);
    }
}

// Join sound - ascending pleasant chime (the familiar voice-chat join tone)
export function playJoinSound() {
    playChime(440, 587, true); // A4 to D5 - ascending
}

// Leave sound - descending low tone
export function playLeaveSound() {
    playChime(349, 262, false); // F4 to C4 - descending
}

// Mute sound - single short low beep
export function playMuteSound() {
    playTone(220, 0.12, 'sine', 0.25); // A3 - low note
}

// Unmute sound - single short higher beep  
export function playUnmuteSound() {
    playTone(440, 0.12, 'sine', 0.25); // A4 - higher note
}

// Deafen sound - two quick low beeps
export function playDeafenSound() {
    playTone(196, 0.1, 'sine', 0.2); // G3
    setTimeout(() => playTone(196, 0.1, 'sine', 0.2), 120);
}

// Undeafen sound - two quick higher beeps
export function playUndeafenSound() {
    playTone(392, 0.1, 'sine', 0.2); // G4
    setTimeout(() => playTone(392, 0.1, 'sine', 0.2), 120);
}

// Someone else joined your voice channel — gated on the voiceChime setting.
export function playUserJoinedSound() {
    if (!notifEnabled('voiceChime')) return;
    playTone(523, 0.08, 'sine', 0.15); // C5 - subtle pop
}

// Someone else left your voice channel — gated on the voiceChime setting.
export function playUserLeftSound() {
    if (!notifEnabled('voiceChime')) return;
    playTone(330, 0.08, 'sine', 0.15); // E4 - subtle pop
}

// --- Custom per-user join/leave clips --------------------------------------

/** Hard playback bound: the server caps the FILE at 1 MB; this caps TIME. */
const CUSTOM_SOUND_MAX_SECONDS = 4;
/** Peak gain for user-uploaded clips — kept near the chime's presence so an
 *  intentionally-loud upload can't blast the room. Multiplied by the user's
 *  master output volume. */
const CUSTOM_SOUND_GAIN = 0.4;

// Decoded-clip cache: the members list refetches every 10s and join bursts
// re-announce — never re-download/decode per event. Small (few users have
// clips), dropped wholesale when it grows silly.
const clipCache = new Map<string, AudioBuffer>();
let clipPlayingUntil = 0; // overlap guard: one custom clip at a time

/**
 * Play another user's custom join/leave clip. Returns true when the clip is
 * (being) played, false when the caller should fall back to the synth chime
 * (no context, fetch/decode failure, overlap). Gated on the SAME setting as
 * the chime, plus the dedicated custom-sounds toggle.
 */
/** How long an in-flight fetch+decode may hold the overlap slot before a
 *  competing clip may steal it (covers a slow first download). */
const CLIP_CLAIM_MS = 5_000;
/** Mirrors the server's 1 MB file cap; a bigger body means the file changed
 *  underneath us or the endpoint isn't what we think it is. */
const MAX_CLIP_BYTES = 1024 * 1024;
/** Decoded-length ceiling. Bounds memory: PCM is ~10 MB per minute per
 *  channel at 48 kHz, so a heavily-compressed 1 MB upload could otherwise
 *  decode to hundreds of MB in EVERY listener's client. Generous next to the
 *  4 s that actually plays. */
const MAX_CLIP_DECODED_SECONDS = 30;

export async function playCustomUserSound(url: string): Promise<boolean> {
    if (!notifEnabled('voiceChime') || !notifEnabled('customSounds')) return false;
    const now = Date.now();
    if (now < clipPlayingUntil) return true; // a clip is already playing — swallow, don't stack
    // Claim the slot BEFORE any await. The guard used to be check-then-act
    // across fetch+decode, so two users joining in one burst (both clips
    // uncached) both passed it and played on top of each other — on exactly
    // the first hearing, when nothing was cached yet.
    const claim = now + CLIP_CLAIM_MS;
    clipPlayingUntil = claim;
    try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') {
            await ctx.resume(); // schedule only against a live clock (see playTone)
        }
        let buf = clipCache.get(url);
        if (!buf) {
            // /files is authenticated — an unauthenticated fetch 401s and
            // every custom clip silently falls back to the synth chime.
            const token = getToken();
            const res = await fetch(url, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            if (!res.ok) {
                if (clipPlayingUntil === claim) clipPlayingUntil = 0;
                return false;
            }
            const bytes = await res.arrayBuffer();
            // The server caps the FILE at 1 MB, which does not bound the
            // DECODED buffer: 1 MB of low-bitrate audio is many minutes, and
            // decoded PCM runs ~10 MB per minute per channel at 48 kHz. Refuse
            // anything oversized before it can be cached or played, and don't
            // trust a Content-Length either — check the bytes we actually got.
            if (bytes.byteLength > MAX_CLIP_BYTES) {
                if (clipPlayingUntil === claim) clipPlayingUntil = 0;
                return false;
            }
            buf = await ctx.decodeAudioData(bytes);
            if (buf.duration > MAX_CLIP_DECODED_SECONDS) {
                // Never cache it: caching would hold those hundreds of MB for
                // the session, and re-deciding per event is cheap.
                if (clipPlayingUntil === claim) clipPlayingUntil = 0;
                return false; // caller falls back to the synth chime
            }
            if (clipCache.size > 64) clipCache.clear();
            clipCache.set(url, buf);
        }
        // Our claim lapsed during a slow load and another clip took the slot:
        // swallow (same contract as arriving while one is playing).
        if (clipPlayingUntil !== claim) return true;
        const source = ctx.createBufferSource();
        source.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = CUSTOM_SOUND_GAIN * outputGain();
        source.connect(gain);
        gain.connect(ctx.destination);
        const seconds = Math.min(buf.duration, CUSTOM_SOUND_MAX_SECONDS);
        // Re-anchor at ACTUAL start — the old deadline ran from entry time, so
        // a load slower than the clip left the guard pre-expired mid-playback.
        clipPlayingUntil = Date.now() + seconds * 1000;
        source.start(ctx.currentTime);
        source.stop(ctx.currentTime + seconds);
        return true;
    } catch {
        // Release only if the claim is still ours — never wipe a later clip's.
        if (clipPlayingUntil === claim) clipPlayingUntil = 0;
        return false; // caller falls back to the synth chime
    }
}

// Someone started streaming (went live) — bright rising two-tone, triangle
// timbre so it's clearly distinct from the join chime. Gated on `stream`.
export function playStreamStartSound() {
    if (!notifEnabled('stream')) return;
    playTone(587, 0.1, 'triangle', 0.22);          // D5
    setTimeout(() => playTone(880, 0.16, 'triangle', 0.22), 90); // up to A5
}

// Someone stopped streaming — falling two-tone counterpart. Gated on `stream`.
export function playStreamStopSound() {
    if (!notifEnabled('stream')) return;
    playTone(880, 0.1, 'triangle', 0.2);           // A5
    setTimeout(() => playTone(587, 0.16, 'triangle', 0.2), 90);  // down to D5
}

// A message landed in a non-muted channel/DM — soft single blip, low volume so
// it's unobtrusive when messages come in bursts. Gated on `message`.
export function playMessageSound() {
    if (!notifEnabled('message')) return;
    playTone(784, 0.07, 'sine', 0.12); // G5 - gentle
}

// Someone @mentioned you in the channel you have open — a brighter rising
// two-tone so it cuts through a burst of ordinary message blips. Gated on
// `mention`. (Cross-channel mentions can't be detected: messages are E2EE and
// the MessageNotification broadcast carries no content — only the open
// channel, where content is already decrypted, can know it mentions you.)
export function playMentionSound() {
    if (!notifEnabled('mention')) return;
    playTone(659, 0.09, 'sine', 0.2);                       // E5
    setTimeout(() => playTone(988, 0.14, 'sine', 0.2), 90); // up to B5
}

// Speak an announcement via the browser's local TTS (no network). Opt-in:
// gated on the voiceTTS setting. Cancels any queued utterance so rapid
// join/leave churn doesn't stack up a backlog of speech.
/** In-flight utterances, so a burst can't build an endless backlog. */
let ttsPending = 0;

export function speak(text: string) {
    if (!notifEnabled('voiceTTS')) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // Drop rather than queue past a small depth: announcements are only useful
    // while they're current, and a backlog would narrate the past.
    if (ttsPending >= 3) return;
    try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.1;
        u.volume = 0.8;
        const done = () => { ttsPending = Math.max(0, ttsPending - 1); };
        u.onend = done;
        u.onerror = done;
        ttsPending++;
        // Deliberately NO speechSynthesis.cancel() here: it used to run before
        // every utterance, so in any burst only the LAST one was ever heard —
        // a real "X joined" got cut off by a later announcement.
        window.speechSynthesis.speak(u);
    } catch {
        ttsPending = Math.max(0, ttsPending - 1);
        // TTS unavailable/blocked — the chime already covered the event.
    }
}
