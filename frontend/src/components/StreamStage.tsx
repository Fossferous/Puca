import { useState, useEffect, useRef, useCallback } from 'react';
import {
    subscribeToStreamState,
    subscribeToVoiceUsers,
    getSelectedStreams,
    getStreamData,
    getAllStreamers,
    deselectStream,
    selectStream,
    clearAllStreams,
    stopOwnScreenShare,
    getCurrentStreamingUserId,
    notifyStreamStateChange,
    globalSpeakingUsers,
    getAllVoiceUsers,
} from './voiceState';
import {
    getStreamVolumes,
    getStreamMutes,
    setStreamVolume,
    setStreamMuted,
    getAttenuation,
    setAttenuation,
    type AttenuationSettings,
    DEFAULT_STREAM_VOLUME,
    MAX_STREAM_VOLUME,
} from './streamVolumeStore';
import {
    requestControl,
    stopControlling,
    sendControlEvent,
    subscribeControl,
    getControlState,
    offerControl,
    computeRmoveScale,
    getControlHostCapture,
    type ControlState,
} from '../api/remoteControl';
import { isMobile, isTauri, RC_ENABLED } from '../api/platform';
import { outputGain, applyOutputDevice } from './settingsStore';
import { sfuManager } from '../api/rtc/sfuManager';
import { useStreamStore } from '../stores/streamStore';
import {
    ChatIcon, CloseIcon, CrosshairIcon, FullscreenIcon, GamepadIcon, GridIcon, KeyboardIcon,
    LiveDotIcon, MegaphoneIcon, MonitorIcon, PendingIcon, PopOutIcon, ScreenIcon, SpeakerIcon,
    SpeakerOffIcon, StopIcon, StopSharingIcon,
} from './Icons';
import { pipSupported } from './streamPopout.utils';
import { docPipSupported } from './streamDocPip';
import './StreamStage.css';
import {
    FPS_SENS_MAX, FPS_SENS_MIN, FPS_SENS_STEP,
    fmtSens, loadFpsMode, loadFpsSens, saveFpsMode, saveFpsSens,
} from '../utils/fpsSens';
import { installBackgroundResumeAll } from './deviceStageResume';

const MOBILE = isMobile();

// FPS-mode mouse sensitivity + toggle persistence live in utils/fpsSens,
// SHARED with DeviceStage so the two viewers cannot drift.

/** Map a typed character (from a mobile soft keyboard) to a KeyboardEvent.code
 *  the host can inject. Covers letters/digits/space; other chars are skipped. */
function charToKeyCode(ch: string): string | null {
    if (ch === ' ') return 'Space';
    if (/^[a-zA-Z]$/.test(ch)) return 'Key' + ch.toUpperCase();
    if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
    return null;
}

interface StreamStageProps {
    onBackToChat: () => void;
    /** Mobile: minimize to the docked mini-player over chat, KEEPING every
     *  selected stream. When present it replaces the header's "Back to Chat"
     *  (which deselects everything) — on a phone the stage covers the whole
     *  screen including the bottom nav, so this button is how you get to the
     *  composer without giving up the stream. Stopping a stream stays on the
     *  per-tile close button. */
    onMinimize?: () => void;
    /** Which stream (if any) is popped out into the OS picture-in-picture
     *  window, and the toggle for it. Optional: absent → no control. */
    poppedStreams?: number[];
    onTogglePopout?: (userId: number) => void;
}

/**
 * Map a client (mouse) coordinate over the stream <video> to a 0..1 position on
 * the shared surface, accounting for `object-fit: contain` letterboxing. Returns
 * null when the pointer is over the letterbox bars (outside the actual content).
 */
function normalizedOverVideo(
    video: HTMLVideoElement,
    clientX: number,
    clientY: number,
): { x: number; y: number } | null {
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || rect.width === 0 || rect.height === 0) return null;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    const x = (clientX - offX) / dispW;
    const y = (clientY - offY) / dispH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
}

// Per-stream Web Audio playback chain. Stream audio routes through
// source -> per-stream gain -> speakers, which buys us per-viewer volume
// control (including >100% boost) and smooth attenuation ducking.
// The video element stays muted — it only renders video (and acts as the
// media-element sink Chromium needs for remote tracks to flow into Web Audio).
// Deafen deliberately does NOT touch this graph: deafen silences people's
// voice, and a stream is something you chose to watch — you can deafen the
// chatter and still hear the game. Per-stream mute/volume is how you silence
// a stream.
type StreamAudioGraph = {
    source: MediaStreamAudioSourceNode;
    gain: GainNode;
    trackId: string;
};

type StreamContextMenu = {
    x: number;
    y: number;
    userId: number;
    isOwn: boolean;
};

export function StreamStage({ onBackToChat, onMinimize, poppedStreams = [], onTogglePopout }: StreamStageProps) {
    const [selectedStreams, setSelectedStreams] = useState<number[]>([]);
    const [streamers, setStreamers] = useState<Array<{ userId: number; username: string; stream: MediaStream | null }>>([]);
    const { focusedStreamId: focusedStream, focusMode, setFocusedStream, setFocusMode } = useStreamStore();
    const [volumes, setVolumes] = useState<Record<number, number>>(() => getStreamVolumes());
    const [mutedStreams, setMutedStreams] = useState<Set<number>>(
        () => new Set(Object.entries(getStreamMutes()).filter(([, m]) => m).map(([id]) => Number(id)))
    );
    const [attenuation, setAttenuationState] = useState<AttenuationSettings>(() => getAttenuation());
    const [ctxMenu, setCtxMenu] = useState<StreamContextMenu | null>(null);
    const [control, setControl] = useState<ControlState>(getControlState);
    // FPS mode: relative mouse via pointer lock (for first-person games).
    // Persisted: someone who plays through this regularly should not have to
    // rediscover the Game mode button every session.
    const [fpsMode, setFpsMode] = useState(loadFpsMode);
    // Whether pointer lock is currently held (drives the "click to capture" hint).
    const [pointerLocked, setPointerLocked] = useState(false);
    // FPS-mode sensitivity multiplier (0.25..4, persisted).
    const [fpsSens, setFpsSens] = useState<number>(loadFpsSens);
    // Mobile: show an on-screen keyboard to type into the controlled machine.
    const [mobileKb, setMobileKb] = useState(false);
    // Web Audio failed → drive the video element's own audio instead (no boost).
    const [audioFallback, setAudioFallback] = useState(false);
    const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
    // FPS mode: mouse buttons whose 'down' we actually relayed, so onPointerUp
    // sends the matching 'up' even if the pointer lock dropped in between —
    // otherwise the host's physical button would stay held.
    const fpsPressed = useRef<Set<number>>(new Set());
    // Keys relayed as DOWN and not yet released, so we can release them if the
    // viewer loses focus (see the release-all effect).
    const heldKeys = useRef<Set<string>>(new Set());
    const audioCtxRef = useRef<AudioContext | null>(null);
    const graphsRef = useRef<Map<number, StreamAudioGraph>>(new Map());
    const duckedRef = useRef(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Current gain for a stream = user volume × mute × attenuation ducking.
    const targetGain = useCallback((userId: number): number => {
        if (mutedStreams.has(userId)) return 0;
        const base = (volumes[userId] ?? DEFAULT_STREAM_VOLUME) / 100;
        const duck = duckedRef.current && attenuation.enabled ? (1 - attenuation.strength) : 1;
        // Master output volume from Settings governs everything you hear, not
        // just voice — otherwise turning it down would silence people but leave
        // a stream at full volume.
        return base * duck * outputGain();
    }, [mutedStreams, volumes, attenuation]);

    // Smoothly move a stream's gain to its target (fast attack, gentle release).
    const applyGain = useCallback((userId: number, smooth = true) => {
        const graph = graphsRef.current.get(userId);
        const ctx = audioCtxRef.current;
        if (graph && ctx) {
            const t = targetGain(userId);
            if (smooth) {
                graph.gain.gain.setTargetAtTime(t, ctx.currentTime, t < graph.gain.gain.value ? 0.06 : 0.2);
            } else {
                graph.gain.gain.value = t;
            }
        }
        if (audioFallback) {
            const video = videoRefs.current.get(userId);
            if (video) {
                video.volume = Math.min(Math.max(targetGain(userId), 0), 1);
                video.muted = mutedStreams.has(userId) || userId === getCurrentStreamingUserId();
            }
        }
    }, [targetGain, audioFallback, mutedStreams]);

    const applyAllGains = useCallback(() => {
        graphsRef.current.forEach((_g, userId) => applyGain(userId));
    }, [applyGain]);

    // Build/refresh the audio chain for one stream. Idempotent per track.
    const ensureStreamAudio = useCallback((userId: number, stream: MediaStream) => {
        if (userId === getCurrentStreamingUserId()) return; // own preview: always silent (the game itself is the audio)

        const track = stream.getAudioTracks()[0];
        if (!track) {
            // System audio can arrive after video (separate ontrack) — rebind then.
            stream.onaddtrack = () => notifyStreamStateChange();
            return;
        }

        try {
            let ctx = audioCtxRef.current;
            if (!ctx) {
                ctx = new AudioContext();
                audioCtxRef.current = ctx;
            }
            if (ctx.state === 'suspended') ctx.resume().catch(() => { /* resumes on next gesture */ });

            const existing = graphsRef.current.get(userId);
            if (existing?.trackId === track.id) {
                applyGain(userId, false);
                return;
            }
            if (existing) {
                existing.source.disconnect();
                existing.gain.disconnect();
            }
            const source = ctx.createMediaStreamSource(new MediaStream([track]));
            const gain = ctx.createGain();
            source.connect(gain);
            gain.connect(ctx.destination);
            graphsRef.current.set(userId, { source, gain, trackId: track.id });
            applyGain(userId, false);
        } catch (err) {
            console.warn('[StreamStage] Web Audio unavailable — falling back to element audio:', err);
            setAudioFallback(true);
        }
    }, [applyGain]);

    // Subscribe to remote-control session state (viewer side).
    useEffect(() => subscribeControl(setControl), []);

    const controlActive = control.controlling?.status === 'active';

    // Pointer-lock lifecycle. Esc (or the browser) can drop the lock at any
    // time; track it so FPS mode never silently degrades to absolute moves.
    useEffect(() => {
        const onLockChange = () => setPointerLocked(document.pointerLockElement != null);
        const onLockError = () => setPointerLocked(false);
        document.addEventListener('pointerlockchange', onLockChange);
        document.addEventListener('pointerlockerror', onLockError);
        return () => {
            document.removeEventListener('pointerlockchange', onLockChange);
            document.removeEventListener('pointerlockerror', onLockError);
        };
    }, []);

    // Release the lock when FPS mode turns off or the control session ends —
    // a lingering lock would trap the cursor with nowhere to send input.
    useEffect(() => {
        if (fpsMode && controlActive) return;
        if (document.pointerLockElement) document.exitPointerLock();
    }, [fpsMode, controlActive]);
    useEffect(() => {
        return () => {
            if (document.pointerLockElement) document.exitPointerLock();
        };
    }, []);

    // Release everything the host is holding when WE stop receiving input.
    // onKeyUp/onPointerUp can only fire while the overlay still has focus, so
    // alt-tabbing mid-keypress sent a key DOWN and never the up — leaving the
    // host's machine with (say) Alt physically held until the session timed
    // out. That alone made remote control feel erratic.
    useEffect(() => {
        if (!controlActive) return;
        const releaseAll = () => {
            for (const button of fpsPressed.current) {
                sendControlEvent({ t: 'up', button });
            }
            fpsPressed.current.clear();
            for (const code of heldKeys.current) {
                sendControlEvent({ t: 'key', code, down: false });
            }
            heldKeys.current.clear();
        };
        const onVisibility = () => { if (document.hidden) releaseAll(); };
        window.addEventListener('blur', releaseAll);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('blur', releaseAll);
            document.removeEventListener('visibilitychange', onVisibility);
            releaseAll(); // ending the session must not strand a held key either
        };
    }, [controlActive]);

    const adjustFpsSens = (delta: number) => {
        setFpsSens((s) => {
            const next = Math.min(FPS_SENS_MAX, Math.max(FPS_SENS_MIN, s + delta));
            saveFpsSens(next);
            return next;
        });
    };

    // Subscribe to stream state changes
    useEffect(() => {
        const update = () => {
            const selected = getSelectedStreams();
            const allStreamers = getAllStreamers();
            setSelectedStreams(selected);
            setStreamers(allStreamers);

            // If focused stream is no longer available, reset
            if (focusedStream && !selected.includes(focusedStream)) {
                setFocusedStream(selected[0] || null);
            }
        };
        update(); // Initial load
        return subscribeToStreamState(update);
    }, [focusedStream]);

    // Attenuation: duck stream audio while anyone in voice is speaking.
    // Speaking state lands in globalSpeakingUsers (VAD); subscribe + poll as a
    // safety net since not every speaking change emits a voice-users event.
    useEffect(() => {
        const evaluate = () => {
            const speaking = globalSpeakingUsers.size > 0;
            if (speaking !== duckedRef.current) {
                duckedRef.current = speaking;
                applyAllGains();
            }
        };
        const unsub = subscribeToVoiceUsers(evaluate);
        const interval = setInterval(evaluate, 250);
        return () => { unsub(); clearInterval(interval); };
    }, [applyAllGains]);

    // Output volume/device changed in Settings: re-apply to the live stream
    // audio immediately rather than at the next gain recalculation. Also on
    // devicechange — the chosen sink can vanish and return without any
    // settings change (a Bluetooth headset out of / back in range), and
    // applyOutputDevice chases it in both directions.
    useEffect(() => {
        const reapply = () => {
            applyAllGains();
            videoRefs.current.forEach(video => applyOutputDevice(video));
        };
        window.addEventListener('settingsChanged', reapply);
        navigator.mediaDevices?.addEventListener?.('devicechange', reapply);
        return () => {
            window.removeEventListener('settingsChanged', reapply);
            navigator.mediaDevices?.removeEventListener?.('devicechange', reapply);
        };
    }, [applyAllGains]);

    // Close the context menu on outside click / Escape.
    useEffect(() => {
        if (!ctxMenu) return;
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtxMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [ctxMenu]);

    // Attach streams to video elements when they become available
    // Also includes a retry interval for streams that arrive after video elements mount
    useEffect(() => {
        const bindStreams = () => {
            let hasUnboundStreams = false;
            selectedStreams.forEach(userId => {
                const data = getStreamData(userId);
                const video = videoRefs.current.get(userId);

                if (video && data?.stream) {
                    if (video.srcObject !== data.stream) {
                        console.log('[StreamStage] Binding stream for userId:', userId);
                        video.srcObject = data.stream;
                        video.play().catch(err => console.warn('Video play failed:', err));
                    }
                    ensureStreamAudio(userId, data.stream);
                } else if (video && !data?.stream) {
                    // Stream not yet available - flag for retry
                    hasUnboundStreams = true;
                }
            });
            return hasUnboundStreams;
        };

        // Initial bind attempt
        const hasUnbound = bindStreams();

        // If any streams are unbound, poll until they arrive (max 10 seconds)
        if (hasUnbound) {
            let retries = 0;
            const maxRetries = 20; // 20 * 500ms = 10 seconds max
            const interval = setInterval(() => {
                retries++;
                const stillUnbound = bindStreams();
                if (!stillUnbound || retries >= maxRetries) {
                    clearInterval(interval);
                }
            }, 500);
            return () => clearInterval(interval);
        }
    }, [selectedStreams, streamers, ensureStreamAudio]);

    // SAFETY NET (0.6.7). Layout is now expressed purely as CSS classes over a
    // stable element set, so a focus/grid toggle no longer unmounts anything and
    // this should never have work to do. It stays because the failure it catches
    // is silent and ugly: a <video> that any DOM mutation detached+reattached
    // pauses and paints a BLACK frame over a stream that is still live, and the
    // bind effect above cannot see it (that one only acts when srcObject
    // IDENTITY differs). Every watched tile is rendered now, so check them all.
    useEffect(() => {
        selectedStreams.forEach(userId => {
            const video = videoRefs.current.get(userId);
            const stream = getStreamData(userId)?.stream;
            if (!video || !stream) return;
            if (video.srcObject !== stream) video.srcObject = stream;
            if (video.paused) video.play().catch(() => { /* autoplay retry on gesture */ });
        });
    }, [focusMode, focusedStream, selectedStreams, streamers]);

    // Android/iOS pause every playing <video> when the app backgrounds and
    // never un-pause on return — the safety net above cannot catch it (it
    // runs on layout changes, not visibility). Same fix, same rationale as
    // the device stage (deviceStageResume.ts); reading the ref map at
    // visibility time covers whatever tiles exist by then.
    useEffect(() => installBackgroundResumeAll(() => videoRefs.current.values()), []);

    // Tear down audio chains for streams no longer watched; close on unmount.
    useEffect(() => {
        graphsRef.current.forEach((graph, userId) => {
            if (!selectedStreams.includes(userId)) {
                graph.source.disconnect();
                graph.gain.disconnect();
                graphsRef.current.delete(userId);
            }
        });
    }, [selectedStreams]);

    useEffect(() => {
        const graphs = graphsRef.current;
        return () => {
            graphs.forEach(g => { g.source.disconnect(); g.gain.disconnect(); });
            graphs.clear();
            audioCtxRef.current?.close().catch(() => { /* already closed */ });
            audioCtxRef.current = null;
        };
    }, []);

    const handleVolumeChange = (userId: number, volume: number) => {
        setVolumes(prev => ({ ...prev, [userId]: volume }));
        setStreamVolume(userId, volume);
        // applyGain reads state on next render; set immediately for responsiveness.
        const graph = graphsRef.current.get(userId);
        const ctx = audioCtxRef.current;
        if (graph && ctx && !mutedStreams.has(userId)) {
            const duck = duckedRef.current && attenuation.enabled ? (1 - attenuation.strength) : 1;
            graph.gain.gain.setTargetAtTime((volume / 100) * duck, ctx.currentTime, 0.02);
        }
        if (audioFallback) {
            const video = videoRefs.current.get(userId);
            if (video) video.volume = Math.min(volume, 100) / 100;
        }
    };

    const toggleMute = (userId: number) => {
        setMutedStreams(prev => {
            const newSet = new Set(prev);
            const nowMuted = !newSet.has(userId);
            if (nowMuted) newSet.add(userId); else newSet.delete(userId);
            setStreamMuted(userId, nowMuted);
            const graph = graphsRef.current.get(userId);
            const ctx = audioCtxRef.current;
            if (graph && ctx) {
                const duck = duckedRef.current && attenuation.enabled ? (1 - attenuation.strength) : 1;
                const vol = (volumes[userId] ?? DEFAULT_STREAM_VOLUME) / 100;
                graph.gain.gain.setTargetAtTime(nowMuted ? 0 : vol * duck, ctx.currentTime, 0.02);
            }
            return newSet;
        });
    };

    const updateAttenuation = (next: AttenuationSettings) => {
        setAttenuationState(next);
        setAttenuation(next);
        // Re-evaluate current gains under the new settings on next tick.
        setTimeout(() => applyAllGains(), 0);
    };

    const handleCloseStream = (userId: number) => {
        deselectStream(userId);
        if (selectedStreams.length <= 1) {
            onBackToChat();
        }
    };

    const handleBackToChat = () => {
        // Deselect all streams and go back
        selectedStreams.forEach(id => deselectStream(id));
        onBackToChat();
    };

    const requestFullscreen = (userId: number) => {
        const video = videoRefs.current.get(userId);
        // Fullscreen the tile (not the bare <video>) so the control-capture
        // overlay stays on top; otherwise you couldn't control while fullscreen.
        const target = video?.parentElement ?? video;
        target?.requestFullscreen?.();
    };

    // Who is on the STAGE right now. Focus mode always has one: falling back to
    // the first selected stream matters because `focusedStream` is null until
    // you click a tile, and the layout would otherwise have no stage at all.
    const stageUser = focusMode ? (focusedStream ?? selectedStreams[0] ?? null) : null;

    // SFU layer hint (§5.2 of the SFU design): the focused stream pulls the HIGH
    // simulcast layer, everything in the grid stays LOW/MEDIUM. No-op on mesh
    // calls. Grid view focuses nobody — every tile stays at grid quality.
    // Keyed on the EFFECTIVE stage user, not the raw `focusedStream`: with the
    // fallback above, focus mode can show someone big while `focusedStream` is
    // still null, and asking the SFU for no focus would leave that tile on the
    // low layer — a big blurry stage.
    // MUST sit above the early return below — hooks run unconditionally every
    // render (Rules of Hooks), or React errors when the stream list empties.
    useEffect(() => {
        sfuManager.setFocusedRemote(stageUser);
    }, [stageUser]);

    // If no streams selected, nothing to show
    if (selectedStreams.length === 0) {
        return (
            <div className="stream-stage-empty">
                <div className="empty-message">
                    <span className="empty-icon"><ScreenIcon size={48} /></span>
                    <p>No streams to display</p>
                    <button className="back-to-chat-btn" onClick={onBackToChat}>
                        Back to Chat
                    </button>
                </div>
            </div>
        );
    }

    const streamCount = selectedStreams.length;
    // People who are live but that you have not started watching. They become
    // "Watch" cards at the end of the filmstrip.
    const unwatched = streamers.filter(s => !selectedStreams.includes(s.userId));
    // Focus mode shows a filmstrip under the stage: the OTHER watched tiles
    // (same elements, just smaller) plus those Watch cards.
    const hasStrip = focusMode && (streamCount > 1 || unwatched.length > 0);
    // Offer focus whenever the strip would have something in it. Gating this on
    // watched streams alone hid the toggle exactly when someone new went live
    // while you were watching one person — so their Watch card was unreachable.
    const canFocus = streamCount > 1 || unwatched.length > 0;

    return (
        <div className="stream-stage">
            {/* Slim header */}
            <div className="stream-stage-header">
                <div className="stream-stage-title">
                    <span className="live-indicator"><LiveDotIcon /> LIVE</span>
                    <span className="stream-count">{streamCount} stream{streamCount > 1 ? 's' : ''}</span>
                </div>
                <div className="stream-stage-controls">
                    {/* Controls for a LIVE control session live here, not in the
                        tile's hover header: the input-capture overlay covers the
                        whole tile (same stacking context, same z-index, rendered
                        later), so those buttons were visible but unclickable —
                        every click went to the remote machine. This strip is
                        above the grid and never overlaps the video, so it can't
                        create a dead zone over the remote screen either. */}
                    {control.controlling?.status === 'active' && (
                        <>
                            <button
                                className="stop-controlling-btn"
                                onClick={stopControlling}
                                title="Stop controlling this screen"
                            >
                                <StopIcon /> Stop controlling {control.controlling.username}
                            </button>
                            {MOBILE && (
                                <button
                                    className={`toggle-view-btn ${mobileKb ? 'focus' : 'grid'}`}
                                    onClick={() => setMobileKb(k => !k)}
                                    title={mobileKb ? 'Hide keyboard' : 'Show keyboard'}
                                >
                                    <KeyboardIcon /> {mobileKb ? 'Typing' : 'Type'}
                                </button>
                            )}
                            {!MOBILE && (
                                <button
                                    className={`toggle-view-btn ${fpsMode ? 'focus' : 'grid'}`}
                                    onClick={() => setFpsMode(f => { saveFpsMode(!f); return !f; })}
                                    title="Game mode: relative mouse (pointer lock)"
                                >
                                    <CrosshairIcon /> {fpsMode ? 'Game mode on' : 'Game mode'}
                                </button>
                            )}
                            {!MOBILE && fpsMode && (
                                <span className="fps-sens">
                                    <button
                                        className="tile-btn"
                                        onClick={() => adjustFpsSens(-FPS_SENS_STEP)}
                                        disabled={fpsSens <= FPS_SENS_MIN}
                                        title="Game mode: lower mouse sensitivity"
                                    >
                                        −
                                    </button>
                                    <span className="fps-sens-value" title="Game mode mouse sensitivity">
                                        {fmtSens(fpsSens)}
                                    </span>
                                    <button
                                        className="tile-btn"
                                        onClick={() => adjustFpsSens(FPS_SENS_STEP)}
                                        disabled={fpsSens >= FPS_SENS_MAX}
                                        title="Game mode: raise mouse sensitivity"
                                    >
                                        +
                                    </button>
                                </span>
                            )}
                        </>
                    )}
                    {canFocus && (
                        <button
                            className={`toggle-view-btn ${focusMode ? 'focus' : 'grid'}`}
                            onClick={() => {
                                // Entering focus with nobody spotlighted yet:
                                // adopt the first watched stream so the stage is
                                // never empty and the SFU layer hint has a
                                // target (the render falls back the same way).
                                if (!focusMode && focusedStream === null) {
                                    setFocusedStream(selectedStreams[0] ?? null);
                                }
                                setFocusMode(!focusMode);
                            }}
                            title={focusMode ? 'Switch to Grid View' : 'Switch to Focus View'}
                        >
                            {focusMode ? <><GridIcon /> Grid</> : <><MonitorIcon /> Focus</>}
                        </button>
                    )}
                    {selectedStreams.includes(getCurrentStreamingUserId() ?? -1) && (
                        <button
                            className="stop-watching-btn"
                            onClick={() => {
                                stopOwnScreenShare();
                                clearAllStreams();
                                onBackToChat();
                            }}
                            title="Stop sharing your screen"
                        >
                            <StopSharingIcon /> Stop Sharing
                        </button>
                    )}
                    {onMinimize ? (
                        <button
                            className="back-to-chat-btn"
                            onClick={onMinimize}
                            title="Keep watching in a mini player over chat"
                        >
                            <ChatIcon /> Chat
                        </button>
                    ) : (
                        <button className="back-to-chat-btn" onClick={handleBackToChat}>
                            ← Back to Chat
                        </button>
                    )}
                </div>
            </div>

            {/* Stream Grid.
                EVERY watched stream is rendered here, in every layout. Grid vs
                focus, and which tile is on the stage, are expressed ONLY as
                class names — so no <video> is ever mounted, unmounted or moved
                between parents by a layout change. That is the whole point: a
                remounted (or merely reparented) <video> pauses and paints a
                black frame over a live stream, which is the "tile went black
                after moving around the UI" bug. Rendering a subset here is what
                caused it. Do not reintroduce a filtered list, and do not wrap
                the thumbnails in their own container — moving a tile between
                two JSX parents unmounts it just as surely. */}
            <div className={`stream-grid ${focusMode ? `focus-mode${hasStrip ? ' has-strip' : ''}` : `grid-${Math.min(streamCount, 8)}`}`}>
                {selectedStreams.map(userId => {
                    const data = getStreamData(userId);
                    if (!data) return null;
                    const isOwnStream = userId === getCurrentStreamingUserId();
                    // Filmstrip thumbnail: same element, ~176px wide.
                    const isThumb = focusMode && stageUser !== userId;
                    const isMuted = mutedStreams.has(userId);
                    const volume = volumes[userId] ?? DEFAULT_STREAM_VOLUME;
                    const elementMuted = isOwnStream || !audioFallback ? true : isMuted;

                    return (
                        <div
                            key={userId}
                            className={[
                                'stream-tile',
                                focusedStream === userId ? 'focused' : '',
                                // Tile ROLE is a class, never a different place
                                // in the tree. CSS `order` floats the stage to
                                // the top of the flex container without the DOM
                                // node moving at all.
                                focusMode ? (isThumb ? 'is-thumb' : 'is-stage') : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => focusMode && setFocusedStream(userId)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                setCtxMenu({ x: e.clientX, y: e.clientY, userId, isOwn: isOwnStream });
                            }}
                        >
                            {/* Hover overlay: name top-left, quick controls top-right */}
                            <div className="stream-tile-header">
                                <span className="streamer-name">
                                    <span className="live-dot" /> {data.username}{isOwnStream ? ' (you)' : ''}
                                </span>
                                <div className="stream-tile-controls">
                                    {!isOwnStream && (
                                        <button
                                            className={`tile-btn ${isMuted ? 'active' : ''}`}
                                            onClick={(e) => { e.stopPropagation(); toggleMute(userId); }}
                                            title={isMuted ? 'Unmute stream' : 'Mute stream'}
                                        >
                                            {isMuted ? <SpeakerOffIcon /> : volume > 100 ? <MegaphoneIcon /> : <SpeakerIcon />}
                                        </button>
                                    )}
                                    {/* Remote control of a viewed screen. RC_ENABLED, not just
                                        isTauri(): a lite build has no control transport at all, so
                                        rendering these would offer a button that silently does
                                        nothing. Folding on the literal also drops the JSX. */}
                                    {RC_ENABLED && !isOwnStream && (() => {
                                        const mine = control.controlling?.userId === userId ? control.controlling : null;
                                        if (mine?.status === 'active') {
                                            return (
                                                <>
                                                    {/* FPS mode needs pointer lock (desktop only). */}
                                                    {!MOBILE && (
                                                        <button
                                                            className={`tile-btn ${fpsMode ? 'active' : ''}`}
                                                            onClick={(e) => { e.stopPropagation(); setFpsMode((f) => { saveFpsMode(!f); return !f; }); }}
                                                            title="Game mode: relative mouse (pointer lock)"
                                                        >
                                                            <CrosshairIcon />
                                                        </button>
                                                    )}
                                                    {/* Sensitivity stepper: deltas are already scaled to host
                                                        pixels; this is the user's multiplier on top. */}
                                                    {!MOBILE && fpsMode && (
                                                        <span className="fps-sens" onClick={(e) => e.stopPropagation()}>
                                                            <button
                                                                className="tile-btn"
                                                                onClick={() => adjustFpsSens(-FPS_SENS_STEP)}
                                                                disabled={fpsSens <= FPS_SENS_MIN}
                                                                title="Game mode: lower mouse sensitivity"
                                                            >
                                                                −
                                                            </button>
                                                            <span className="fps-sens-value" title="Game mode mouse sensitivity">
                                                                {fmtSens(fpsSens)}
                                                            </span>
                                                            <button
                                                                className="tile-btn"
                                                                onClick={() => adjustFpsSens(FPS_SENS_STEP)}
                                                                disabled={fpsSens >= FPS_SENS_MAX}
                                                                title="Game mode: raise mouse sensitivity"
                                                            >
                                                                +
                                                            </button>
                                                        </span>
                                                    )}
                                                    {/* Mobile: pop the soft keyboard to type into the remote machine. */}
                                                    {MOBILE && (
                                                        <button
                                                            className={`tile-btn ${mobileKb ? 'active' : ''}`}
                                                            onClick={(e) => { e.stopPropagation(); setMobileKb((k) => !k); }}
                                                            title={mobileKb ? 'Hide keyboard' : 'Show keyboard'}
                                                        >
                                                            <KeyboardIcon />
                                                        </button>
                                                    )}
                                                    <button
                                                        className="tile-btn active"
                                                        onClick={(e) => { e.stopPropagation(); stopControlling(); }}
                                                        title="Stop controlling this screen"
                                                    >
                                                        <StopIcon />
                                                    </button>
                                                </>
                                            );
                                        }
                                        if (mine?.status === 'requesting') {
                                            return (
                                                <button className="tile-btn" title="Waiting for approval…" disabled>
                                                    <PendingIcon />
                                                </button>
                                            );
                                        }
                                        return (
                                            <button
                                                className="tile-btn"
                                                onClick={(e) => { e.stopPropagation(); requestControl(userId, data.username); }}
                                                title="Request control of this screen"
                                                disabled={!!control.controlling}
                                            >
                                                <GamepadIcon />
                                            </button>
                                        );
                                    })()}
                                    {/* OS-level picture-in-picture: stays on top when
                                        Púca is tabbed out. Only where the API exists. */}
                                    {onTogglePopout && (pipSupported() || docPipSupported()) && (
                                        <button
                                            className={`tile-btn ${poppedStreams.includes(userId) ? 'active' : ''}`}
                                            onClick={(e) => { e.stopPropagation(); onTogglePopout(userId); }}
                                            title={poppedStreams.includes(userId)
                                                ? 'Bring back from picture-in-picture'
                                                : 'Pop out (stays on top when Púca is tabbed out)'}
                                        >
                                            <PopOutIcon />
                                        </button>
                                    )}
                                    <button
                                        className="tile-btn"
                                        onClick={(e) => { e.stopPropagation(); requestFullscreen(userId); }}
                                        title="Fullscreen"
                                    >
                                        <FullscreenIcon />
                                    </button>
                                    <button
                                        className="tile-btn close"
                                        onClick={(e) => { e.stopPropagation(); handleCloseStream(userId); }}
                                        title="Stop Watching"
                                    >
                                        <CloseIcon />
                                    </button>
                                </div>
                            </div>
                            <video
                                ref={el => {
                                    if (el) {
                                        videoRefs.current.set(userId, el);
                                        // Get FRESH stream data (not captured data from render)
                                        const freshData = getStreamData(userId);
                                        if (freshData?.stream && el.srcObject !== freshData.stream) {
                                            el.srcObject = freshData.stream;
                                            el.play().catch(err => console.warn('Video play failed:', err));
                                            ensureStreamAudio(userId, freshData.stream);
                                        }
                                    } else {
                                        // Unmounted: drop the stale detached element so
                                        // fullscreen / FPS-scale / bind code don't read it.
                                        videoRefs.current.delete(userId);
                                    }
                                }}
                                autoPlay
                                playsInline
                                muted={elementMuted}
                                className="stream-video"
                            />
                            {/* Input-capture surface — active only while I'm controlling
                                this screen, and NEVER on a filmstrip thumbnail. Once
                                non-focused tiles became visible it was possible to be
                                controlling one person while spotlighting another; their
                                tile then carried a live capture surface at ~176px, so a
                                click meant to spotlight it would land on their real
                                desktop, at a coordinate mapped from a thumbnail. You
                                cannot aim at a screen you cannot see — spotlight it
                                first, and the surface comes back with it. */}
                            {!isOwnStream
                                && !isThumb
                                && control.controlling?.userId === userId
                                && control.controlling.status === 'active' && (
                                <div
                                    className="control-capture"
                                    tabIndex={0}
                                    ref={(el) => el?.focus()}
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerMove={(e) => {
                                        // FPS mode: relative deltas ONLY while pointer-locked.
                                        // Without the lock send nothing — falling back to
                                        // absolute moves was the confusing "tiny movements"
                                        // degraded mode.
                                        if (fpsMode) {
                                            if (document.pointerLockElement !== e.currentTarget) return;
                                            if (!e.movementX && !e.movementY) return;
                                            // Scale viewer CSS px → host source px (the video
                                            // renders far smaller than the host screen), then
                                            // apply the user's sensitivity multiplier.
                                            // Calibrate against the host's STABLE capture size
                                            // (relayed at grant time), not the live decoded
                                            // videoWidth — which shrinks when WebRTC downscales
                                            // under load and would otherwise sag sensitivity
                                            // mid-game. Fall back to videoWidth for older hosts.
                                            const v = videoRefs.current.get(userId);
                                            const rect = v?.getBoundingClientRect();
                                            const cap = getControlHostCapture();
                                            const srcW = cap?.w || v?.videoWidth || 0;
                                            const srcH = cap?.h || v?.videoHeight || 0;
                                            const k = (rect && srcW && srcH
                                                ? computeRmoveScale(srcW, srcH, rect.width, rect.height)
                                                : 1) * fpsSens;
                                            sendControlEvent({ t: 'rmove', dx: e.movementX * k, dy: e.movementY * k });
                                            return;
                                        }
                                        const v = videoRefs.current.get(userId);
                                        if (!v) return;
                                        const n = normalizedOverVideo(v, e.clientX, e.clientY);
                                        if (n) sendControlEvent({ t: 'move', x: n.x, y: n.y });
                                    }}
                                    onPointerDown={(e) => {
                                        // Escape hatch: let the browser produce its
                                        // normal contextmenu sequence so the tile
                                        // handler can open Púca's menu, and send
                                        // nothing to the host.
                                        if (e.button === 2 && e.shiftKey) return;
                                        e.preventDefault();
                                        const el = e.currentTarget as HTMLDivElement;
                                        el.focus();
                                        // FPS mode: first click engages pointer lock (no click sent).
                                        if (fpsMode && document.pointerLockElement !== el) {
                                            // Prefer RAW (unaccelerated) deltas so the host sees
                                            // physical motion, not the viewer OS's pointer
                                            // ballistics; retry without the option if the engine
                                            // rejects it. May return a promise and may be denied
                                            // (just-exited-lock cooldown) — swallow the rejection;
                                            // the pointerlockerror listener keeps the hint up.
                                            const lockEl = el as unknown as {
                                                requestPointerLock?: (options?: { unadjustedMovement?: boolean }) => void | Promise<void>;
                                            };
                                            try {
                                                const r = lockEl.requestPointerLock?.({ unadjustedMovement: true });
                                                void Promise.resolve(r).catch(() => {
                                                    try {
                                                        void Promise.resolve(lockEl.requestPointerLock?.()).catch(() => { /* hint stays up */ });
                                                    } catch { /* hint stays up */ }
                                                });
                                            } catch { /* unsupported — hint stays up */ }
                                            return;
                                        }
                                        // Under pointer lock, setPointerCapture throws
                                        // InvalidStateError (Chromium/WebView2) and would abort
                                        // before the press is relayed — the lock already routes
                                        // every pointer event to el, so capture is unneeded.
                                        if (document.pointerLockElement !== el) {
                                            el.setPointerCapture(e.pointerId);
                                        }
                                        if (!fpsMode) {
                                            const v = videoRefs.current.get(userId);
                                            if (v) {
                                                const n = normalizedOverVideo(v, e.clientX, e.clientY);
                                                if (n) sendControlEvent({ t: 'move', x: n.x, y: n.y });
                                            }
                                        }
                                        // Record the relayed press so onPointerUp releases it even
                                        // if the lock drops (Esc/alt-tab) before release.
                                        fpsPressed.current.add(e.button);
                                        sendControlEvent({ t: 'down', button: e.button });
                                    }}
                                    onPointerUp={(e) => {
                                        e.preventDefault();
                                        // Send 'up' iff we actually relayed the matching 'down'.
                                        // Keying on the recorded button (not lock-state-at-release)
                                        // guarantees the host's physical button is released after a
                                        // mid-hold lock drop, and suppresses the stray 'up' from the
                                        // capture click (which sent no 'down').
                                        const wasPressed = fpsPressed.current.delete(e.button);
                                        // No matching 'down' was relayed (FPS capture
                                        // click, or a Shift+right-click escape hatch)
                                        // → don't send a stray 'up'.
                                        if (!wasPressed) return;
                                        sendControlEvent({ t: 'up', button: e.button });
                                    }}
                                    onContextMenu={(e) => {
                                        // Shift+right-click is the escape hatch to
                                        // Púca's own stream menu; a plain
                                        // right-click belongs to the remote machine.
                                        // Without stopPropagation the tile's handler
                                        // popped our menu over the video even though
                                        // the click HAD been relayed — which read as
                                        // "right-click doesn't work".
                                        if (e.shiftKey) return;
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }}
                                    onWheel={(e) => sendControlEvent({ t: 'wheel', dy: Math.round(-e.deltaY) })}
                                    onKeyDown={(e) => {
                                        e.preventDefault();
                                        if (e.repeat) return;
                                        heldKeys.current.add(e.code);
                                        sendControlEvent({ t: 'key', code: e.code, down: true });
                                    }}
                                    onKeyUp={(e) => {
                                        e.preventDefault();
                                        heldKeys.current.delete(e.code);
                                        sendControlEvent({ t: 'key', code: e.code, down: false });
                                    }}
                                >
                                    {fpsMode ? (
                                        // Locked: stay out of the way. Unlocked: nothing is
                                        // being sent, so say exactly what to do about it.
                                        !pointerLocked && (
                                            <div className="control-capture-hint fps-lock-hint">
                                                <CrosshairIcon /> Click to capture mouse · Esc releases
                                            </div>
                                        )
                                    ) : (
                                        <div className="control-capture-hint">
                                            <GamepadIcon /> Controlling {data.username}
                                            {MOBILE
                                                ? ' · tap = click, drag = move' + (mobileKb ? ' · typing' : ' · keyboard button to type')
                                                : ' · Stop controlling above to release · Shift+right-click for stream options'}
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* Mobile keyboard capture: a focused offscreen input pops the soft
                                keyboard; typed characters + Enter/Backspace/arrows are relayed. */}
                            {MOBILE && mobileKb
                                && control.controlling?.userId === userId
                                && control.controlling.status === 'active' && (
                                <input
                                    className="mobile-kb-capture"
                                    autoFocus
                                    value=""
                                    aria-label="Remote keyboard input"
                                    onChange={() => { /* controlled empty; input handled below */ }}
                                    onBeforeInput={(e) => {
                                        const data = (e.nativeEvent as InputEvent).data;
                                        if (!data) return;
                                        for (const ch of data) {
                                            const code = charToKeyCode(ch);
                                            if (code) {
                                                sendControlEvent({ t: 'key', code, down: true });
                                                sendControlEvent({ t: 'key', code, down: false });
                                            }
                                        }
                                    }}
                                    onKeyDown={(e) => {
                                        // Special keys the soft keyboard reports as keydown.
                                        const map: Record<string, string> = {
                                            Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab',
                                            ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
                                            ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Escape: 'Escape',
                                        };
                                        const code = map[e.key];
                                        if (code) {
                                            e.preventDefault();
                                            sendControlEvent({ t: 'key', code, down: true });
                                            sendControlEvent({ t: 'key', code, down: false });
                                        }
                                    }}
                                />
                            )}
                        </div>
                    );
                })}

                {/* Anyone live that you are NOT watching yet, as "Watch" cards at
                    the end of the filmstrip, so you can opt in to a stream instead
                    of it joining automatically. These are
                    plain buttons, not media, so mounting them per layout is free;
                    the tiles above are what must never be conditionally rendered.
                    Focus mode only: the grid's `grid-N` templates are sized for
                    exactly N tiles, and extra cells would break that geometry. */}
                {focusMode && unwatched.map(s => (
                        <button
                            key={`watch-${s.userId}`}
                            className="stream-tile watch-card"
                            onClick={() => { selectStream(s.userId); setFocusedStream(s.userId); }}
                            title={`Watch ${s.username}'s stream`}
                        >
                            <span className="live-dot" />
                            <span className="watch-card-name">{s.username}</span>
                            <span className="watch-card-cta">Watch</span>
                        </button>
                    ))}
            </div>

            {/* Per-stream right-click context menu */}
            {ctxMenu && (
                <div
                    ref={menuRef}
                    className="stream-context-menu"
                    style={{
                        left: Math.min(ctxMenu.x, window.innerWidth - 260),
                        top: Math.min(ctxMenu.y, window.innerHeight - (ctxMenu.isOwn ? 340 : 380)),
                    }}
                >
                    {ctxMenu.isOwn ? (
                        <>
                            <button
                                className="scm-item scm-danger"
                                onClick={() => { setCtxMenu(null); stopOwnScreenShare(); clearAllStreams(); onBackToChat(); }}
                            >
                                Stop Sharing <span className="scm-icon"><StopSharingIcon /></span>
                            </button>
                            {/* Hand control of my screen to someone in voice
                                (desktop host only — injection is native). The
                                same action lives in the voice member context
                                menu, but this is where sharers look for it.
                                ALWAYS rendered (with an empty-state line) so a
                                solo sharer can see the feature exists — hiding
                                it entirely read as "feature missing". */}
                            {RC_ENABLED && isTauri() && (() => {
                                const me = getCurrentStreamingUserId();
                                const targets = getAllVoiceUsers().filter(u => u.id !== me);
                                return (
                                    <>
                                        <div className="scm-separator" />
                                        <span className="scm-section-label">Give Control <GamepadIcon /></span>
                                        {targets.length === 0 ? (
                                            <button className="scm-item" disabled>
                                                No one else in voice yet
                                            </button>
                                        ) : targets.map(u => (
                                            <button
                                                key={u.id}
                                                className="scm-item"
                                                onClick={() => { setCtxMenu(null); offerControl(u.id, u.username); }}
                                            >
                                                {u.username}
                                            </button>
                                        ))}
                                    </>
                                );
                            })()}
                        </>
                    ) : (
                        <button
                            className="scm-item"
                            onClick={() => { setCtxMenu(null); handleCloseStream(ctxMenu.userId); }}
                        >
                            Stop Watching <span className="scm-icon"><CloseIcon /></span>
                        </button>
                    )}

                    {!ctxMenu.isOwn && (
                        <>
                            <div className="scm-separator" />

                            {/* Remote control lives here too — the hover-header
                                Request control button is easy to miss (the header
                                only shows on hover). */}
                            {RC_ENABLED && (() => {
                                const mine = control.controlling?.userId === ctxMenu.userId ? control.controlling : null;
                                if (mine?.status === 'active') {
                                    return (
                                        <button
                                            className="scm-item scm-danger"
                                            onClick={() => { setCtxMenu(null); stopControlling(); }}
                                        >
                                            Stop Controlling <span className="scm-icon"><StopIcon /></span>
                                        </button>
                                    );
                                }
                                if (mine?.status === 'requesting') {
                                    return (
                                        <button className="scm-item" disabled>
                                            Control Requested… <span className="scm-icon"><PendingIcon /></span>
                                        </button>
                                    );
                                }
                                const username = getStreamData(ctxMenu.userId)?.username ?? `User ${ctxMenu.userId}`;
                                return (
                                    <button
                                        className="scm-item"
                                        disabled={!!control.controlling}
                                        onClick={() => { setCtxMenu(null); requestControl(ctxMenu.userId, username); }}
                                    >
                                        Request Control <span className="scm-icon"><GamepadIcon /></span>
                                    </button>
                                );
                            })()}

                            <label className="scm-item scm-toggle">
                                Mute
                                <input
                                    type="checkbox"
                                    checked={mutedStreams.has(ctxMenu.userId)}
                                    onChange={() => toggleMute(ctxMenu.userId)}
                                />
                            </label>

                            <div className="scm-slider-block">
                                <span className="scm-label">Stream Volume</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={audioFallback ? 100 : MAX_STREAM_VOLUME}
                                    step={5}
                                    value={volumes[ctxMenu.userId] ?? DEFAULT_STREAM_VOLUME}
                                    disabled={mutedStreams.has(ctxMenu.userId)}
                                    onChange={(e) => handleVolumeChange(ctxMenu.userId, Number(e.target.value))}
                                />
                            </div>

                            <div className="scm-separator" />

                            <label className="scm-item scm-toggle">
                                <span>
                                    Stream Attenuation
                                    <span className="scm-desc">Automatically reduce stream volume when people are talking.</span>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={attenuation.enabled}
                                    onChange={(e) => updateAttenuation({ ...attenuation, enabled: e.target.checked })}
                                />
                            </label>

                            <div className="scm-slider-block">
                                <span className="scm-label">Attenuation Strength</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={Math.round(attenuation.strength * 100)}
                                    disabled={!attenuation.enabled}
                                    onChange={(e) => updateAttenuation({ ...attenuation, strength: Number(e.target.value) / 100 })}
                                />
                            </div>
                        </>
                    )}

                    <div className="scm-separator" />

                    <button
                        className="scm-item"
                        onClick={() => { setCtxMenu(null); requestFullscreen(ctxMenu.userId); }}
                    >
                        Fullscreen <span className="scm-icon"><FullscreenIcon /></span>
                    </button>
                </div>
            )}

            {/* The focus-mode sidebar that used to live here is gone. It was a
                TEXT list duplicating what the filmstrip now shows as live video,
                and its one unique job — starting to watch someone new — moved
                into the strip as Watch cards. It was also hidden below 768px, so
                on a phone it could never do that job at all. */}

        </div>
    );
}
