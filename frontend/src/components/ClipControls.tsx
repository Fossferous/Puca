/**
 * Clip replay-buffer controls for the voice panel: the Arm/Save buttons that
 * sit in `.voice-controls-compact` and the status pill row under it. Both read
 * the controller's state bus (api/clips/replayBuffer.ts); nothing here owns
 * media. Desktop (Tauri) only — the pure gate in api/clips/clipsGate.ts decides
 * visibility, and its reasons drive every title/help string.
 *
 * Phase 2: the buttons read the VOICE server's clip policy (Chat.tsx computes
 * it, VoicePanel threads it) and the composer runs the consent protocol.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '../api/platform';
import { loadSettings } from './settingsStore';
import { registerPress, unregisterPress } from '../api/hotkeys';
import { arm, armNative, disarm, seal, getReplayState, isClipCaptureSupported, discardSeal, retrySystemAudio, type ReplayState } from '../api/clips/replayBuffer';
import { isNativeCaptureSupported } from '../api/clips/nativeCapture';
import { NO_CLIP_POLICY, useReplayState, type ClipPolicy } from '../api/clips/clipsUiState';
import { clipUiState, clipReasonCopy } from '../api/clips/clipsGate';
import { clipPreset, formatClock, formatMB } from '../api/clips/clipPresets';
import { ClipIcon, ClipOffIcon, WarningIcon } from './Icons';
import { ClipComposerModal } from './ClipComposerModal';

interface ClipButtonsProps {
    inVoice: boolean;
    isAfkChannel: boolean;
    listenOnly: boolean;
    roomId: string;
    /** The VOICE server's clip policy + the voice channel's permission bits. */
    policy?: ClipPolicy;
    /** Everyone this client saw in the room while the buffer was armed (D1). */
    getDeclaredParticipants?: () => number[];
}

const isArmedPhase = (p: ReplayState['phase']) => p === 'armed' || p === 'sealing' || p === 'sealed' || p === 'uploading';

export function ClipButtons({ inVoice, isAfkChannel, listenOnly, roomId, policy = NO_CLIP_POLICY, getDeclaredParticipants = () => [] }: ClipButtonsProps) {
    const replay = useReplayState();
    const [composerOpen, setComposerOpen] = useState(false);
    const armed = isArmedPhase(replay.phase);
    const gate = clipUiState({
        isDesktop: isTauri() && isClipCaptureSupported(), inVoice, isAfkChannel, listenOnly,
        serverClipsEnabled: policy.serverClipsEnabled, viewerIsOwner: policy.viewerIsOwner, voiceChannelPerms: policy.voiceChannelPerms, armed, bufferedSeconds: replay.bufferedMs / 1000,
    });
    const voiceChannelId = roomId.startsWith('voice_') ? Number(roomId.slice(6)) : NaN;
    // The longest clip is the SERVER's cap, bounded by the user's own buffer length.
    const maxSeconds = Math.min(policy.available ? policy.maxSeconds : Infinity, loadSettings().clipBufferSeconds ?? 300);

    const openComposer = useCallback(() => {
        if (!isArmedPhase(getReplayState().phase) || getReplayState().phase === 'sealing') return;
        // The hotkey fires from a fullscreen game: bring our window forward
        // first (same primitive remote control uses), then open the composer.
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('attention_main_window', { mode: 'surface' })).catch(() => { /* older shell */ });
        setComposerOpen(true);
    }, []);
    const openRef = useRef(openComposer);
    useEffect(() => { openRef.current = openComposer; }, [openComposer]);

    // clipArmOnJoin 'prompt': a nudge on the Arm button for a few seconds
    // after joining. Also shown after an 'auto' attempt that failed to arm.
    const [nudge, setNudge] = useState(false);
    const [autoState, setAutoState] = useState<'idle' | 'trying' | 'failed'>('idle');
    useEffect(() => {
        const mode = loadSettings().clipArmOnJoin;
        if (!inVoice || armed || (mode !== 'prompt' && autoState !== 'failed')) return;
        setNudge(true);
        const t = setTimeout(() => setNudge(false), 12_000);
        return () => { clearTimeout(t); setNudge(false); };
    }, [inVoice, armed, autoState]);

    // clipArmOnJoin 'auto': arm as soon as we are in a call that allows clips
    // — genuinely with NO popup. armNative() drives DXGI capture + the
    // hardware H.264 encoder directly (nativeCapture.ts), the same
    // no-gesture-needed primitive the remote-desktop agent uses for
    // unattended hosting; there is no getDisplayMedia call here for Chromium
    // to gate on a picker at all. The target monitor is chosen automatically
    // — whichever monitor a fullscreen app/game is filling, else the primary
    // monitor (clip_capture.rs::choose_target). ONE attempt per room: a
    // failure must not retry on every render, and a manual disarm must stay
    // disarmed. A VoiceMoved (new room id) counts as a new join — the buffer
    // never spans two rooms' rosters.
    const autoTriedForRef = useRef<string | null>(null);
    useEffect(() => {
        if (!inVoice) { autoTriedForRef.current = null; setAutoState('idle'); return; }
        if (armed || replay.phase === 'arming') return;
        if (loadSettings().clipArmOnJoin !== 'auto' || !gate.visible || !gate.armEnabled) return;
        if (!isNativeCaptureSupported()) { setAutoState('failed'); return; } // e.g. non-Windows desktop build
        if (autoTriedForRef.current === roomId) return;
        autoTriedForRef.current = roomId;
        // A beat after the join so the panel has settled.
        const t = setTimeout(() => {
            setAutoState('trying');
            armNative()
                .then(() => { setAutoState(getReplayState().phase === 'idle' ? 'failed' : 'idle'); })
                .catch((e: unknown) => { console.warn('[clips] auto-arm failed:', e); setAutoState('failed'); });
        }, 800);
        return () => clearTimeout(t);
    }, [inVoice, armed, replay.phase, roomId, gate.visible, gate.armEnabled]);

    // Save-clip hotkey (in-app feed; the native fullscreen feed is wired by
    // VoicePanel's watch list, which dispatches to the same registry id).
    useEffect(() => {
        if (!armed) return;
        registerPress('voice.saveClip', () => loadSettings().saveClipBinding, () => openRef.current());
        return () => unregisterPress('voice.saveClip');
    }, [armed]);

    if (!gate.visible) return null;

    const onArm = async () => {
        if (armed) { await disarm('user'); return; }
        try { await arm(); } catch (e) { console.warn('[clips] arm failed:', e); }
    };
    const armTitle = armed
        ? 'Clip buffer on — nothing has left your PC. Click to turn off.'
        : gate.armEnabled
            ? (autoState === 'failed' ? 'Auto-arm did not start the buffer — press to arm manually' : `Arm clip buffer — keep the last ${formatClock(loadSettings().clipBufferSeconds ?? 300)} of this call in memory`)
            : clipReasonCopy(gate.reason);
    const saveTitle = gate.clipEnabled ? 'Save the last few minutes as a clip' : (armed ? clipReasonCopy(gate.reason || 'buffer-too-short') : 'Arm the clip buffer first');

    return (
        <>
            <button
                className={`voice-btn voice-clip-arm ${armed ? 'active' : ''} ${replay.phase === 'arming' ? 'pending' : ''} ${nudge && gate.armEnabled ? 'nudge' : ''}`}
                onClick={() => void onArm()}
                disabled={(!gate.armEnabled && !armed) || replay.phase === 'arming'}
                title={armTitle}
                aria-label={armed ? 'Disarm clip buffer' : 'Arm clip buffer'}
                aria-pressed={armed}
            >
                {armed ? <ClipIcon size={18} /> : <ClipOffIcon size={18} />}
            </button>
            <button
                className={`voice-btn voice-clip-save ${gate.clipEnabled ? 'ready' : ''}`}
                onClick={openComposer}
                disabled={!gate.clipEnabled || replay.phase !== 'armed'}
                title={saveTitle}
                aria-label="Save the last few minutes as a clip"
            >
                <ClipIcon size={18} />
            </button>
            {composerOpen && createPortal(
                <ClipComposerModal
                    isOpen={composerOpen}
                    onClose={() => { setComposerOpen(false); if (getReplayState().sealed) discardSeal(); }}
                    bufferedSeconds={replay.bufferedMs / 1000}
                    maxSeconds={maxSeconds}
                    // The server refuses anything over its cap; the ring must not seal past it.
                    onSeal={(secs) => seal(secs * 1000, policy.available ? policy.maxSeconds * 1000 : undefined)}
                    localOnly={!policy.available}
                    voiceChannelId={Number.isFinite(voiceChannelId) ? voiceChannelId : null}
                    policy={policy}
                    getDeclaredParticipants={getDeclaredParticipants}
                />,
                document.body,
            )}
        </>
    );
}

/** The status row under the control bar. Renders nothing while idle. */
export function ClipStatusRow() {
    const r = useReplayState();
    const [audioBusy, setAudioBusy] = useState(false);
    if (r.phase === 'idle' && !r.notice && !r.error) return null;
    const preset = clipPreset(r.presetId);
    let text = '';
    let cls = '';
    switch (r.phase) {
        case 'arming': text = 'Choosing what to record…'; break;
        case 'armed': text = `Buffering ${formatClock(r.bufferedMs / 1000)} · ${preset.id} · ~${formatMB(r.ringBytes)}${r.hasSystemAudio ? '' : ' · mic only'}${r.captureReason === 'fullscreen' ? ' · fullscreen app' : r.captureReason === 'primary' ? ' · primary monitor' : ''}`; break;
        case 'sealing': text = 'Preparing clip…'; break;
        case 'sealed': text = `Clip ready (${formatClock((r.sealed?.durationMs ?? 0) / 1000)}) · buffer still running`; break;
        case 'uploading': text = r.upload ? `Uploading ${r.upload.done} of ${r.upload.total}` : 'Uploading…'; break;
        case 'error': text = r.error ? `Clip buffer stopped: ${r.error}` : 'Clip buffer stopped.'; cls = 'error'; break;
        default: text = '';
    }
    // Gated on the DURABLE flag, not only the notice: `notice` is a shared
    // slot that unrelated worker messages overwrite (a lossless capture
    // reconfigure emits `notice: null`), and gating recovery on it made the
    // Retry control vanish while the buffer silently kept recording mic-only.
    // The picker's pre-flag arm still reaches this through `notice`.
    const showNoAudio = r.phase !== 'idle' && r.phase !== 'error' && !r.hasSystemAudio
        && (r.systemAudioLost !== null || !!r.notice);
    return (
        <div className={`voice-clip-status ${cls} ${showNoAudio ? 'warn' : ''}`}>
            {/* The live-updating counter must not be a screen-reader firehose:
                the announced text is only the armed/off state. */}
            <span role="status" aria-live="polite" className="voice-clip-status-live">
                {r.phase === 'idle' || r.phase === 'error' ? 'Clip buffer off' : 'Clip buffer armed'}
            </span>
            {text && (
                <span
                    aria-hidden="true"
                    className="voice-clip-status-text"
                    // The one place the ACTUAL loopback device is named — the
                    // pill itself stays short. "Which output is the clip
                    // listening to" is exactly the question when clip audio
                    // sounds wrong.
                    title={r.systemAudioDevice ? `System audio from: ${r.systemAudioDevice}` : undefined}
                >{text}</span>
            )}
            {showNoAudio && (
                <span className="voice-clip-notice">
                    <WarningIcon size={14} /> {r.systemAudioLost === 'died'
                        ? 'System audio stopped — new footage has your microphone only.'
                        : 'No system audio — this clip will only have your microphone.'}
                    {/* Which recovery exists depends on how this session was
                        armed. A NATIVE session (captureReason set) has no
                        picker: retrySystemAudio splices a fresh WASAPI
                        loopback into the live graph, keeping every second of
                        footage — unless the session armed with no audio rail
                        at all (no mic either), where only a restart can add
                        one and the copy must say what that costs. A PICKER
                        session keeps "Pick again": re-running the dialog is
                        its one recovery, and always was. */}
                    {r.captureReason === null ? (
                        <button
                            className="voice-clip-link"
                            disabled={audioBusy}
                            onClick={() => {
                                setAudioBusy(true);
                                arm({ repick: true })
                                    .catch((e) => console.warn('[clips] repick failed:', e))
                                    .finally(() => setAudioBusy(false));
                            }}
                        >Pick again (clears current footage)</button>
                    ) : r.hasMic || r.hasSystemAudio ? (
                        <button
                            className="voice-clip-link"
                            disabled={audioBusy}
                            onClick={() => {
                                setAudioBusy(true);
                                retrySystemAudio()
                                    .catch((e) => console.warn('[clips] system-audio retry failed:', e))
                                    .finally(() => setAudioBusy(false));
                            }}
                        >{audioBusy ? 'Retrying…' : 'Retry system audio'}</button>
                    ) : (
                        <button
                            className="voice-clip-link"
                            disabled={audioBusy}
                            title="This buffer was armed with no audio at all, so audio cannot be added to it in place."
                            onClick={() => {
                                setAudioBusy(true);
                                disarm('audio-restart')
                                    .then(() => armNative())
                                    .catch((e) => console.warn('[clips] audio restart failed:', e))
                                    .finally(() => setAudioBusy(false));
                            }}
                        >Restart buffer (clears current footage)</button>
                    )}
                </span>
            )}
            {/* The notice TEXT, which nothing rendered before — it was only a
                boolean gate, so "Could not arm: <the reason>" after a failed
                restart left a bare "Clip buffer off" and the reason in a
                console nobody reads. Suppressed while showNoAudio carries its
                own copy for the same condition. */}
            {!showNoAudio && r.notice && (
                <span className="voice-clip-notice"><WarningIcon size={14} /> {r.notice}</span>
            )}
            {r.phase === 'error' && (
                <button className="voice-clip-link" onClick={() => void arm()}>Retry</button>
            )}
        </div>
    );
}
