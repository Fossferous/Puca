/**
 * Per-app ("game only") stream audio — desktop only.
 *
 * The Rust side (src-tauri/src/audio_capture.rs) captures ONE process's audio
 * via WASAPI process loopback (the game + its children, nothing else) and emits
 * base64 PCM chunks (f32 LE, 48 kHz, stereo) as 'audio-data' events. This
 * module turns those into a live MediaStreamTrack for the screen-share stream:
 * each chunk becomes an AudioBuffer scheduled back-to-back into a
 * MediaStreamAudioDestinationNode, with a small jitter cushion so IPC timing
 * wobble doesn't glitch, and a backlog cap so clock drift can't grow latency.
 */
import { isTauri } from './platform';

export interface CaptureApp {
    pid: number;
    name: string;
    window_title: string | null;
    /** This app's process tree owns an ACTIVE audio render session right now —
     *  i.e. it is audibly playing sound. The strongest auto-detect signal:
     *  WebView2's generic surface labels defeat window-title matching, but "the
     *  one non-Puca app currently making sound" is almost always the game. */
    has_active_audio?: boolean;
    /** Base64 encoded PNG of the application's icon, if available. */
    icon?: string | null;
}

/** Apps that can be captured (empty outside the desktop app). */
export async function listCaptureApps(): Promise<CaptureApp[]> {
    if (!isTauri()) return [];
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<CaptureApp[]>('get_running_apps');
    } catch (err) {
        console.error('[AppAudio] Failed to list apps:', err);
        return [];
    }
}

type AudioDataEvent = {
    data: string; // base64 PCM
    sample_rate: number;
    channels: number;
    bits_per_sample: number;
    /** WASAPI flagged this packet AUDCLNT_BUFFERFLAGS_SILENT — the capture is
     *  alive and delivering packets, but Windows says this one had nothing
     *  real in it. Distinct from no packets arriving at all. */
    silent: boolean;
};

let ctx: AudioContext | null = null;
let dest: MediaStreamAudioDestinationNode | null = null;
let unlisten: (() => void) | null = null;
let unlistenError: (() => void) | null = null;
let unlistenEnded: (() => void) | null = null;
let unlistenSourceEnded: (() => void) | null = null;
let unlistenResume: (() => void) | null = null;
let playhead = 0;
let active = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let resumeTimer: ReturnType<typeof setInterval> | null = null;

const JITTER_S = 0.06; // scheduling cushion after (re)start or underrun
const MAX_BACKLOG_S = 0.25; // clock-drift cap: reset instead of growing latency
const SILENCE_WATCHDOG_MS = 3000; // no data after start → warn the streamer
const RESUME_POLL_MS = 300; // keep nudging a suspended capture context back to running

/**
 * Window events for the UI (VoicePanel listens):
 *  - 'sovereign:stream-audio-error'  detail: string — capture died mid-stream.
 *  - 'sovereign:stream-audio-silent' detail: undefined — capture started but
 *    produced no data (usually the wrong app was guessed, or the app is
 *    genuinely silent) — surfaced as a dismissible hint, not an error.
 */
function emitUiEvent(name: string, detail?: unknown): void {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* non-DOM env */ }
}

/**
 * Find the running app whose window matches the shared surface. Chromium sets
 * the display-capture video track's label to the shared window's title, so
 * "share Elden Ring's window" can auto-select Elden Ring's audio.
 * Returns null for screen shares (label like "screen:0:0") or no match.
 */
export function matchAppByWindowTitle(apps: CaptureApp[], trackLabel: string): CaptureApp | null {
    const label = trackLabel.trim().toLowerCase();
    // No label, a screen/monitor share, or Chromium's generic surface ids
    // ("window:271812:0" — no title in sight) can't be matched; the UI falls
    // back to a manual app picker in those cases.
    if (!label || label.length < 3) return null;
    if (/^(screen|monitor|window|web-contents-media-stream)[:\d]/.test(label)) return null;
    const clean = (s: string) => s.toLowerCase().trim();
    return (
        apps.find(a => a.window_title && clean(a.window_title) === label) ??
        apps.find(a => {
            if (!a.window_title) return false;
            const title = clean(a.window_title);
            // Substring either way, but only against real titles — require a
            // minimum length so "go" doesn't match "Google Chrome".
            return title.length >= 3 && (label.includes(title) || title.includes(label));
        }) ??
        apps.find(a => a.name.length >= 3 && label.includes(clean(a.name))) ??
        null
    );
}

/** Display name for an app: window title beats process name. */
export function appLabel(app: CaptureApp): string {
    return app.window_title?.trim() ? app.window_title : app.name;
}

export interface ResolvedAppAudio {
    pid: number;
    name: string;
    /** True only for a real window-title match — the only signal safe to
     *  persist as the "last app" (heuristic guesses poisoned it before). */
    confident: boolean;
}

/**
 * Resolve which app's audio to stream for the "game only" choice, without
 * asking the user. Signals, strongest first:
 *
 *  1. A real window-title match against the shared surface (rare under
 *     WebView2 — it usually reports a generic surface id, not the title).
 *  2. Audio-session activity: the apps whose process trees are audibly playing
 *     sound RIGHT NOW (`has_active_audio`, from WASAPI session enumeration).
 *     The remembered "last app" is trusted only when it is currently audible;
 *     a single audible app is taken outright (streaming a game that's playing
 *     sound is exactly this case); several audible apps with no history is
 *     ambiguous — give up rather than guess (caller broadens to system audio).
 *  3. No audio activity anywhere (game silent in a menu): fall back to the
 *     remembered app if it's still running.
 *
 * Returns undefined when nothing is trustworthy — the caller broadens to
 * system audio and tells the streamer.
 */
export function resolveAppAudio(
    apps: CaptureApp[],
    matchedPid: number | null,
    savedName: string | null,
): ResolvedAppAudio | undefined {
    if (apps.length === 0) return undefined;

    const matched = matchedPid != null ? apps.find(a => a.pid === matchedPid) : undefined;
    if (matched) return { pid: matched.pid, name: appLabel(matched), confident: true };

    const bySaved = (a: CaptureApp) => savedName != null && (a.name === savedName || appLabel(a) === savedName);
    const audible = apps.filter(a => a.has_active_audio === true);

    if (audible.length > 0) {
        // Prefer the remembered app when it's one of the apps making sound.
        const saved = audible.find(bySaved);
        if (saved) return { pid: saved.pid, name: appLabel(saved), confident: false };
        if (audible.length === 1) {
            return { pid: audible[0].pid, name: appLabel(audible[0]), confident: false };
        }
        // Several apps audible and none of them remembered — a windowed one is
        // likelier to be the game than a background player, but only pick it
        // when that too is unambiguous.
        const windowed = audible.filter(a => a.window_title?.trim());
        if (windowed.length === 1) {
            return { pid: windowed[0].pid, name: appLabel(windowed[0]), confident: false };
        }
        return undefined; // genuinely ambiguous — broaden, don't guess
    }

    // Nothing audible (e.g. game paused in a silent menu) — the remembered app
    // is the best available guess, exactly as before the activity signal.
    const saved = apps.find(bySaved);
    if (saved) return { pid: saved.pid, name: appLabel(saved), confident: false };
    return undefined;
}

/** A remembered mixer selection entry (persisted by NAME — pids don't survive
 *  app restarts; names are re-resolved against the running-app list). */
export interface SavedAppSelection {
    name: string;
    gainPercent: number;
}

const LAST_APPS_KEY = 'sovereign:lastStreamAudioApps';

export function loadSavedSelection(): SavedAppSelection[] {
    try {
        const raw = localStorage.getItem(LAST_APPS_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((e): e is SavedAppSelection =>
                !!e && typeof (e as SavedAppSelection).name === 'string'
                && Number.isFinite((e as SavedAppSelection).gainPercent))
            // Tampered/corrupt storage must not smuggle junk volumes into the
            // mixer (NaN/Infinity would survive into the mixed PCM).
            .map(e => ({ name: e.name, gainPercent: Math.min(200, Math.max(0, e.gainPercent)) }));
    } catch {
        return [];
    }
}

export function saveSelection(sel: SavedAppSelection[]): void {
    try { localStorage.setItem(LAST_APPS_KEY, JSON.stringify(sel)); } catch { /* ignore */ }
}

/**
 * Default ticks + volumes for the mixer list: the saved multi-selection
 * (matched by name against the currently running apps) wins — the user
 * curated it explicitly; otherwise the single-app auto-detect suggestion.
 * Returns pid → gainPercent for the apps that should start ticked.
 */
export function defaultMixerSelection(
    apps: CaptureApp[],
    matchedPid: number | null,
    savedSingleName: string | null,
    savedMulti: SavedAppSelection[],
): Map<number, number> {
    const out = new Map<number, number>();
    for (const s of savedMulti) {
        const found = apps.find(a => a.name === s.name || appLabel(a) === s.name);
        if (found) out.set(found.pid, s.gainPercent);
    }
    if (out.size > 0) return out;
    const suggestion = resolveAppAudio(apps, matchedPid, savedSingleName);
    if (suggestion) out.set(suggestion.pid, 100);
    return out;
}

/**
 * Start capturing `pid`'s audio and return a MediaStreamTrack carrying it.
 * The caller owns wiring the track into the outgoing stream; call
 * stopGameAudio() when the share ends. `onGameExited` fires if the captured
 * process closes (the Rust side watches the PID) so the stream can end with
 * the game.
 */
export async function startGameAudioTrack(pid: number, onGameExited?: () => void): Promise<MediaStreamTrack> {
    return startCaptureTrack('start_app_audio_capture', { pid }, pid, onGameExited);
}

// startSystemAudioTrack ("all audio except Púca", WASAPI exclude-mode)
// is GONE. Exclude-mode only filters sessions created AFTER the loopback
// client initialises, and Púca's own voice call always predates it — so
// the mode echoed the call into the stream and was unfixable from our side.
// The mixer ('Selected apps') is the audio path now.

/** One entry of the multi-app mixer selection. */
export interface SelectedApp {
    pid: number;
    name: string;
    /** Volume slider value, 100 = unity. */
    gainPercent?: number;
}

/**
 * Capture EXACTLY the given apps' audio (multi-app mixer): one include-mode
 * capture per app, mixed natively into the same single stream the other modes
 * emit. `onSourceEnded` fires when one selected app closes — the STREAM keeps
 * going; the UI just tells the streamer that app's audio dropped out.
 * Throws if the native command is missing (older installed binary) so the
 * caller can fall back to single-app capture.
 */
export async function startMultiAppAudioTrack(
    apps: SelectedApp[],
    onSourceEnded?: (pid: number, name: string) => void,
): Promise<MediaStreamTrack> {
    const nameByPid = new Map(apps.map(a => [a.pid, a.name]));
    const track = await startCaptureTrack(
        'start_multi_app_audio_capture',
        { pids: apps.map(a => a.pid) },
        null,
        undefined,
        (pid) => onSourceEnded?.(pid, nameByPid.get(pid) ?? `PID ${pid}`),
        (result) => {
            // The command returns the pids it could NOT start (partial success).
            if (Array.isArray(result) && result.length > 0) {
                const names = (result as number[]).map(p => nameByPid.get(p) ?? `PID ${p}`).join(', ');
                console.warn(`[AppAudio] Mixer sources failed to start: ${names}`);
                emitUiEvent('sovereign:stream-audio-error', `Couldn't capture audio from: ${names}`);
            }
        },
    );
    for (const a of apps) {
        if (a.gainPercent != null && a.gainPercent !== 100) {
            void setAppCaptureGain(a.pid, a.gainPercent);
        }
    }
    return track;
}

/** Adjust one mixer source's volume (percent, 100 = unity, clamped 0–200). */
export async function setAppCaptureGain(pid: number, gainPercent: number): Promise<void> {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_app_capture_gain', { pid, gain: gainPercent / 100 });
    } catch (err) {
        console.warn('[AppAudio] set_app_capture_gain failed:', err);
    }
}

async function startCaptureTrack(
    command: string,
    args: Record<string, unknown>,
    watchPid: number | null,
    onGameExited?: () => void,
    onSourceEnded?: (pid: number) => void,
    onStartResult?: (result: unknown) => void
): Promise<MediaStreamTrack> {
    if (active) await stopGameAudio();
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* gesture pending */ } }
    // A SUSPENDED capture context is the classic "no stream audio" cause on
    // desktop: the getDisplayMedia picker consumes the go-live user gesture, so
    // resume() above fires without activation and the MediaStreamDestination
    // track emits SILENCE even though audio-data arrives and buffers schedule.
    // The one-shot gesture retry wasn't enough (needs the user to click again).
    // Instead, keep polling resume() for the whole capture — it succeeds the
    // moment any interaction happens or the autoplay policy allows, and is a
    // cheap no-op once running. Plus resume immediately on the next interaction.
    const c = ctx;
    const nudge = () => { if (c.state === 'suspended') c.resume().catch(() => { /* closed / needs gesture */ }); };
    window.addEventListener('pointerdown', nudge);
    window.addEventListener('keydown', nudge);
    resumeTimer = setInterval(() => {
        if (!active || !c) return;
        if (c.state === 'running') return; // stays armed as a safety net; no-op while running
        c.resume().catch(() => { /* still no activation — try again next tick */ });
    }, RESUME_POLL_MS);
    // Remove the interaction listeners when capture ends.
    unlistenResume = () => { window.removeEventListener('pointerdown', nudge); window.removeEventListener('keydown', nudge); };
    console.log(`[AppAudio] capture context created — state: ${ctx.state}`);
    dest = ctx.createMediaStreamDestination();
    playhead = 0;
    active = true;
    let gotData = false;
    let warnedSilent = false;
    let silentStreak = 0;
    let warnedWasapiSilent = false;

    unlisten = await listen<AudioDataEvent>('audio-data', (event) => {
        if (!active || !ctx || !dest) return;
        if (!gotData) {
            gotData = true;
            console.log(`[AppAudio] first audio-data chunk received — context state: ${ctx.state}`
                + (ctx.state !== 'running' ? ' (SUSPENDED → viewers will hear SILENCE until it resumes)' : '')
                + (event.payload.silent ? ' (WASAPI-flagged SILENT)' : ''));
            // Late first chunk after the silence hint fired — retract it.
            if (warnedSilent) emitUiEvent('sovereign:stream-audio-recovered');
        }
        // WASAPI can mark a packet silent while still "succeeding" — distinct
        // from no packets arriving at all (the 3s watchdog below). If it's
        // silent-flagged for ~1s straight, the source itself has nothing real
        // to give (independent of AudioContext state), so say so once.
        if (event.payload.silent) {
            silentStreak++;
            if (!warnedWasapiSilent && silentStreak >= 50) {
                warnedWasapiSilent = true;
                console.warn('[AppAudio] WASAPI has reported SILENCE for ~1s straight — capture is alive '
                    + 'and receiving packets, but Windows says this source has nothing real in it right now.');
            }
        } else {
            silentStreak = 0;
        }
        try {
            const { data, sample_rate, channels } = event.payload;
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const interleaved = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
            const frames = Math.floor(interleaved.length / channels);
            if (frames === 0) return;

            const buf = ctx.createBuffer(channels, frames, sample_rate);
            for (let ch = 0; ch < channels; ch++) {
                const chan = buf.getChannelData(ch);
                for (let i = 0; i < frames; i++) chan[i] = interleaved[i * channels + ch];
            }
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(dest);

            const now = ctx.currentTime;
            if (playhead < now + 0.01) {
                playhead = now + JITTER_S; // prime / recover from underrun
            } else if (playhead > now + MAX_BACKLOG_S) {
                playhead = now + JITTER_S; // drift reset: skip ahead rather than lag
            }
            src.start(playhead);
            playhead += buf.duration;
        } catch (err) {
            console.warn('[AppAudio] Dropped malformed chunk:', err);
        }
    });

    // Capture died mid-stream (WASAPI error after a successful start) — the
    // Rust side emits this so the UI can tell the streamer instead of the
    // stream just going quiet.
    unlistenError = await listen<string>('audio-capture-error', (event) => {
        if (!active) return;
        console.error('[AppAudio] Capture error:', event.payload);
        emitUiEvent('sovereign:stream-audio-error', event.payload);
    });

    if (watchPid !== null) {
        unlistenEnded = await listen<number>('game-audio-ended', (event) => {
            if (event.payload !== watchPid) return;
            console.log(`[AppAudio] Game (PID ${watchPid}) exited`);
            stopGameAudio().finally(() => onGameExited?.());
        });
    }

    // Multi-app mixer: one selected app closed. The stream continues on the
    // remaining sources — this only informs the UI.
    if (onSourceEnded) {
        unlistenSourceEnded = await listen<number>('app-audio-source-ended', (event) => {
            if (!active) return;
            console.log(`[AppAudio] Mixer source PID ${event.payload} ended`);
            onSourceEnded(event.payload);
        });
    }

    try {
        const result = await invoke(command, args);
        onStartResult?.(result);
    } catch (err) {
        await stopGameAudio();
        throw err;
    }
    console.log(`[AppAudio] Capture started via ${command}`);

    // Silent-capture watchdog: capture "succeeded" but no audio arrives —
    // usually the ticked apps are simply quiet right now. Hint, don't error.
    // (The detail used to name the capture mode and mislabelled the mixer as
    // 'system'; every remaining mode is app-scoped, so it is a constant.)
    watchdog = setTimeout(() => {
        watchdog = null;
        if (active && !gotData) {
            warnedSilent = true;
            console.warn('[AppAudio] No audio data within 3s of capture start');
            emitUiEvent('sovereign:stream-audio-silent', 'app');
        }
    }, SILENCE_WATCHDOG_MS);

    return dest.stream.getAudioTracks()[0];
}

/** Stop the capture + release the audio graph. Safe to call repeatedly. */
export async function stopGameAudio(): Promise<void> {
    if (!active && !ctx) return;
    active = false;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
    unlistenResume?.();
    unlistenResume = null;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_app_audio_capture');
    } catch { /* was not running */ }
    unlisten?.();
    unlisten = null;
    unlistenError?.();
    unlistenError = null;
    unlistenEnded?.();
    unlistenEnded = null;
    unlistenSourceEnded?.();
    unlistenSourceEnded = null;
    dest = null;
    if (ctx) {
        ctx.close().catch(() => { /* already closed */ });
        ctx = null;
    }
}
