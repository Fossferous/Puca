import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { webrtcManager } from '../api/webrtc';
import { sfuManager } from '../api/rtc/sfuManager';
import { setSfuControlSender } from '../api/rtc/controlDc';
import type { MediaE2eeReason } from '../api/rtc/types';
import { mediaE2eeExplanation } from '../api/rtc/e2eeStatus';
import { loadSettings, inputGain, outputGain, applyOutputDevice } from './settingsStore';
import { wsClient, type ServerMessage, type MessageHandler } from '../api/websocket';
import ScreenShareModal from './ScreenShareModal';
import { type NoiseSuppressionMode, type NoiseModeChange, NOISE_MODE_EVENT, getNoiseSuppressionMode, setNoiseSuppressionMode, changeNoiseModeLive, modeUsesWebAudio, rawInputHasHadSignal, hasLiveGainStage, isDeepFilterGateOpen, selectedInputDeviceId } from '../api/noiseFilter';
import { registerHold, unregisterHold, registerPress, unregisterPress, startNativeFeed, stopNativeFeed, setNativeFeedHost } from '../api/hotkeys';
import { computeNativeWatch } from '../api/hotkeyScope';

/** Shared mic-health notice text — the sentinel clears only its own message
 *  (the dead-graph fallback writes to the same slot and must not be wiped). */
const MIC_SILENT_NOTICE = 'Your microphone is producing silence — nobody can hear you. Check its mute switch, then your input device in Settings.';
/** Shown when we joined with no usable capture device at all. */
const NO_MIC_NOTICE = 'No microphone detected — you joined in listen-only mode. You can hear everyone; nobody can hear you.';
/** Shown when the mic DIED mid-call (device unplugged / Bluetooth out of
 *  range) and no other input could be opened. The device watchdog retries
 *  automatically when one returns. */
const MIC_LOST_NOTICE = 'Your microphone disconnected and no other input is available — nobody can hear you. It will reconnect automatically when a microphone returns.';
import { startHidingCaptureBar, stopHidingCaptureBar } from '../api/captureBar';
import { holdStreamBoost, releaseStreamBoost } from '../api/streamBoost';
import { holdStreamDiag, releaseStreamDiag } from '../api/streamDiag';
import { isTauri } from '../api/platform';
import { phonePanelQuery } from '../utils/phonePanel';
import { buildVoiceStatus, parseVoiceStatus } from '../utils/voiceStatus';
import { onArmedChange as onClipArmedChange, disarm as disarmClipBuffer, getReplayState } from '../api/clips/replayBuffer';
import type { ClipPolicy } from '../api/clips/clipsUiState';
// A pending clip request is withdrawn on EVERY disarm by App.tsx (via
// onArmedChange) — not here, so suspend/lock, "Stop sharing" and fatal
// errors are covered too, not just the two paths this file drives.
import { ClipButtons, ClipStatusRow } from './ClipControls';
import {
    playJoinSound,
    playLeaveSound,
    playMuteSound,
    playUnmuteSound,
    playDeafenSound,
    playUndeafenSound,
    playUserJoinedSound,
    playUserLeftSound,
    playCustomUserSound,
    playStreamStartSound,
    playStreamStopSound,
    speak
} from '../utils/audioFeedback';
import { getFileUrl } from '../api/uploads';
import { isBlocked } from './blockStore';
import { hasLiveVideo } from '../utils/mediaLiveness';
import { ShareAnnouncements } from '../utils/shareAnnouncements';
import { decideAfk, DEFAULT_AFK_TIMEOUT_MS } from '../utils/afkIdle';
import { PendingJoins, JOIN_PRESENT_GRACE_MS, JOIN_ANNOUNCE_TIMEOUT_MS, PENDING_JOIN_POLL_MS } from '../utils/pendingJoins';
import { getLocalUserVolumes, getLocalUserMutes } from './userVolumeStore';
import { keepVoiceAudioAlive, installVoiceAudioResume } from './voiceAudioKeepAlive';
import { MicIcon, MicOffIcon, HeadphonesIcon, HeadphonesOffIcon, CameraIcon, CameraOffIcon, ScreenShareIcon, DisconnectIcon, FlipCameraIcon, FullscreenIcon, CloseIcon, LockIcon, MoonIcon, SignalIcon, InfoIcon, ChevronUpIcon, ChevronDownIcon } from './Icons';
import { Toast } from './Toast';
import './VoicePanel.css';


import { globalVoiceUsers, globalScreenSharers, globalCameraUsers, globalCameraStreams, globalSpeakingUsers, notifyVoiceUsersChange, registerStopScreenShareCallback, stopOwnScreenShare, setCurrentStreamingUser, setSelfInVoice, upsertVoiceUser, globalSelectedStreams, globalStreamData, notifyStreamStateChange, clearAllStreams, selectStream, deselectStream, subscribeToStreamState } from './voiceState';
import type { VoiceUser } from './voiceState';

interface VoicePanelProps {
    roomId: string;
    /** Human-readable channel name for display (roomId is now an opaque key). */
    channelName?: string;
    currentUserId: number;
    currentUsername: string;
    memberAvatars?: Map<number, string | null>; // userId -> avatar_file_id
    /** userId -> uploaded join/leave clip file ids. Built from the server's
     *  members-with-roles payload, which already nulls the ids for members the
     *  admin muted — absent/null means "play the default chime". Like
     *  memberAvatars, this covers the VIEWED server; a voice channel on another
     *  server degrades to the chime. */
    memberSounds?: Map<number, { join: string | null; leave: string | null }>;
    onDisconnect?: () => void; // called when the user hangs up
    /** Server-admin policy: this server requires media E2EE for calls. OR'd into
     *  the per-user setting (fail-closed — either source turns enforcement on). */
    serverRequireMediaE2ee?: boolean;
    /** This is an AFK channel: the mic is hard-muted (you can't talk here). */
    isAfkChannel?: boolean;
    /** The server's AFK window in ms (afk_timeout_minutes × 60000). Absent ⇒
     *  the backend predates the setting; the old fixed 15 min applies. */
    afkTimeoutMs?: number;
    /** Called after 15 min of no voice activity, so the parent can move the
     *  user to the server's AFK channel. Not armed in an AFK channel or while
     *  screen-sharing. */
    onInactive?: () => void;
    /** Tier-2 SFU channel: media goes through LiveKit instead of the mesh.
     *  Read once at join; a live call keeps the transport it started with. */
    sfuMode?: boolean;
    /** The VOICE server's clip policy (docs/CLIPS.md), computed by Chat.tsx. */
    clipPolicy?: ClipPolicy;
}

// Remote camera feeds used to render here in a floating `remote-cameras-grid`
// bolted to the compact panel. They now publish through globalCameraStreams
// (voiceState) and render INSIDE each participant's voice-stage tile
// (VoiceStage.tsx) — where profile/stream tiles already live.

export function VoicePanel({ roomId, channelName, currentUserId, currentUsername, memberAvatars: _memberAvatars, memberSounds, onDisconnect, serverRequireMediaE2ee = false, isAfkChannel = false, afkTimeoutMs = DEFAULT_AFK_TIMEOUT_MS, onInactive, sfuMode = false, clipPolicy }: VoicePanelProps) {
    const [isInVoice, setIsInVoice] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [isDeafened, setIsDeafened] = useState(false);
    /** Why a mute toggle refused — shown as a Toast so a hotkey no-op is
     *  never silent (a silent refusal reads as "the hotkey is broken"). */
    const [muteNotice, setMuteNotice] = useState<string | null>(null);
    const [_voiceUsers, setVoiceUsers] = useState<VoiceUser[]>([]);
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showPermissionHelp, setShowPermissionHelp] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [isCameraOn, setIsCameraOn] = useState(false);
    const [noiseMode, setNoiseMode] = useState<NoiseSuppressionMode>(() => getNoiseSuppressionMode());
    // Whether the DeepFilter option is offered — Settings → Advanced →
    // Experimental. Tracked as state so flipping the gate while this panel is
    // mounted updates the dropdown without a remount.
    const [dfGateOpen, setDfGateOpen] = useState(() => isDeepFilterGateOpen());
    useEffect(() => {
        const sync = () => setDfGateOpen(isDeepFilterGateOpen());
        window.addEventListener('settingsChanged', sync);
        return () => window.removeEventListener('settingsChanged', sync);
    }, []);
    const [showStreamSettings, setShowStreamSettings] = useState(false);
    // Multi-streamer support: Map of userId -> { username, stream }
    const [screenSharers, setScreenSharers] = useState<Map<number, { username: string; stream: MediaStream | null }>>(new Map());
    // Stream WATCH selection lives ONLY in globalSelectedStreams (voiceState):
    // every entry point mutates it via selectStream/deselectStream — the
    // VoiceStage Watch button and StreamStage cards (via Chat), remote
    // control's auto-watch, and this panel's own handlers. A component-state
    // mirror used to shadow it and silently clobber global-side selections.
    const selfPreviewRef = useRef<HTMLVideoElement>(null);
    // App matched to the shared window during screen capture (for "app audio").
    const cameraPreviewRef = useRef<HTMLVideoElement>(null);
    const isInVoiceRef = useRef(false);
    // Users we have SPOKEN a join for in this room, mapped to the name we
    // announced them under. Announcements are transitions of THIS map, not of
    // the raw (asymmetric, replayed) events. The name is retained because
    // StreamStopped carries only an id, and by the time announceLeave runs the
    // roster entry has already been deleted by earlier-registered handlers.
    const announcedRef = useRef<Map<number, string>>(new Map());
    // While Date.now() is below this, transitions seed the set SILENTLY (the
    // join-time replay of everyone already here, and the post-reconnect burst).
    // A timestamp rather than a flag, so an aborted join can never leave
    // announcements permanently muted.
    const speechMuteUntilRef = useRef(0);
    // Joins we were told about but have NOT chimed yet — the chime waits for
    // the peer's media to be reachable (see utils/pendingJoins). One interval
    // exists only while this is non-empty.
    const pendingJoinsRef = useRef(new PendingJoins());
    const pendingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Detect mobile for hiding screen share option
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // The PANEL-LAYOUT gate — DESIGN_PHILOSOPHY §2: it IS mobile.css's media
    // query (utils/phonePanel.ts), and nothing else. This decides whether the
    // compact panel is the fixed bottom bar (collapsible, height-reserved).
    // It used to add `|| isNativeMobile()`, which made the JS gate wider than
    // the CSS one: the native shell above 1024 CSS px (an iPad in landscape)
    // rendered an expand chevron that toggled nothing, because every collapse
    // rule lives inside the media query. Live-subscribed so rotating across
    // the boundary re-renders; the UA-sniff `isMobile` answers a different
    // question ("no screen-share picker on this device") and must not gate
    // layout.
    const [isPhonePanel, setIsPhonePanel] = useState(() => phonePanelQuery()?.matches ?? false);
    useEffect(() => {
        const mq = phonePanelQuery();
        if (!mq) return;
        const onChange = () => setIsPhonePanel(mq.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    // Mobile: the full control set is behind an expand chevron. Collapsed is
    // the DEFAULT — the full panel is ~230px tall, which with the soft
    // keyboard up left no room for messages at all (the "everything stacked
    // on top of each other while typing" report).
    const [controlsExpanded, setControlsExpanded] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    // Mobile: publish the panel's REAL height so mobile.css can reserve
    // exactly that much room above the bottom nav for .chat-main and the
    // side panels. The old hardcoded 172px drifted from the panel's actual
    // size as controls were added, leaving the composer covered by the
    // panel's top rows. documentElement, not the panel: the panel is
    // portaled to <body> while the readers are elsewhere in the tree.
    useEffect(() => {
        if (!isPhonePanel) return;
        const el = panelRef.current;
        if (!el) return;
        const apply = () => document.documentElement.style.setProperty(
            '--mobile-voice-panel-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
        apply();
        const ro = new ResizeObserver(apply);
        ro.observe(el);
        return () => {
            ro.disconnect();
            document.documentElement.style.removeProperty('--mobile-voice-panel-h');
        };
    }, [isPhonePanel]);

    // Coming back to the foreground: resume any remote-voice element the
    // platform paused AND our background nudge could not restart (iOS Safari
    // refuses play() while hidden). Companion to keepVoiceAudioAlive above.
    useEffect(() => installVoiceAudioResume(), []);

    // Camera PiP (Picture-in-Picture) state for mobile
    const [pipPosition, setPipPosition] = useState({ x: 20, y: 100 });
    const [isDragging, setIsDragging] = useState(false);
    const [showPipOptions, setShowPipOptions] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const dragStartRef = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
    const pipRef = useRef<HTMLDivElement>(null);

    // Track which users are currently speaking
    const [speakingUsers, setSpeakingUsers] = useState<Set<number>>(new Set());
    // Mic-health warning (silent capture / dead noise-suppression graph): the
    // "everyone says they can't hear me but everything looks fine" class.
    // Two writers share this slot, so clears are matched against the message.
    const [micNotice, setMicNotice] = useState<string | null>(null);
    // Joined without any usable microphone — receive-only participation.
    const [listenOnly, setListenOnly] = useState(false);
    // Aggregate media-E2EE status (polled) so the UI can show a lock — a
    // server-forced downgrade to transport-only is then visible.
    const [mediaSecure, setMediaSecure] = useState<{ total: number; encrypted: number; supported: boolean; enforced: boolean }>(
        { total: 0, encrypted: 0, supported: true, enforced: false },
    );
    // Per-peer downgrade reasons, so the (i) tooltip can explain WHICH peer is
    // downgraded and WHY, rather than just "not encrypted".
    const [e2eeDetail, setE2eeDetail] = useState<{ userId: number; encrypted: boolean; reason: MediaE2eeReason }[]>([]);
    useEffect(() => {
        const tick = () => {
            // Read the ACTIVE transport: LiveKit facts on SFU calls, mesh peer
            // state otherwise. (On SFU the mesh manager has 0 peers, so a
            // webrtcManager-only poll kept total at 0 and the badge never
            // mounted — the deferred re-audit item.)
            const src = sfuMode ? sfuManager : webrtcManager;
            setMediaSecure(src.mediaEncryptionSummary());
            setE2eeDetail(src.allMediaE2eeStatuses());
        };
        tick();
        const iv = setInterval(tick, 2000);
        return () => clearInterval(iv);
    }, [sfuMode]);

    // --- Inactivity auto-move to AFK ---------------------------------------
    // Discord's rules, copied (see utils/afkIdle.ts for the contract and the
    // history): silent for the server's AFK window AND no input → moved to
    // the AFK channel. Muted / deafened / listen-only / watching a stream do
    // NOT exempt — they used to, and since everyone mutes before walking
    // away, the move had become nearly unreachable ("users are not getting
    // kicked when AFK"). Not armed in an AFK channel, or when there's no AFK
    // channel to move to (parent passes no onInactive).
    const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Server-configurable window (Discord's 1/5/15/30/60 min); ref so live
    // timer callbacks read the current value without re-arming churn.
    const afkTimeoutMsRef = useRef(afkTimeoutMs);
    useEffect(() => { afkTimeoutMsRef.current = afkTimeoutMs; }, [afkTimeoutMs]);
    // Refs so the timer callback reads current values without re-arming churn.
    const isScreenSharingRef = useRef(isScreenSharing);
    const listenOnlyRef = useRef(false);
    const isCameraOnRef = useRef(isCameraOn);
    const onInactiveRef = useRef(onInactive);
    const isAfkChannelRef = useRef(isAfkChannel);
    const isMutedRef = useRef(false);
    // In-app input — the browser/mobile stand-in for the OS idle probe (and
    // the only input signal a web build can see). A ref write per event; no
    // state, no re-renders, no throttling needed.
    const lastAppInputRef = useRef<number | null>(null);
    /** Watching someone else's stream — presence on the no-OS-probe AFK path
     *  only (utils/afkIdle.ts). Fed from the stream-state subscription below. */
    const watchingStreamRef = useRef(false);
    useEffect(() => {
        const mark = () => { lastAppInputRef.current = Date.now(); };
        const opts = { capture: true, passive: true } as AddEventListenerOptions;
        window.addEventListener('pointerdown', mark, opts);
        window.addEventListener('keydown', mark, opts);
        window.addEventListener('touchstart', mark, opts);
        window.addEventListener('wheel', mark, opts);
        return () => {
            window.removeEventListener('pointerdown', mark, { capture: true });
            window.removeEventListener('keydown', mark, { capture: true });
            window.removeEventListener('touchstart', mark, { capture: true });
            window.removeEventListener('wheel', mark, { capture: true });
        };
    }, []);
    // Live deafen state read from the setOnRemoteStream callback: a peer that
    // (re)connects while we're deafened must have its <audio> start muted, else
    // deafen is bypassed for anyone who joins after we deafened. (audit M8)
    const isDeafenedRef = useRef(isDeafened);
    // Always-fresh clip map for the announce callbacks (they're deps of the big
    // WS-handler effect — reading through a ref keeps a members refetch from
    // tearing down every handler).
    const memberSoundsRef = useRef(memberSounds);
    memberSoundsRef.current = memberSounds;
    // Peers we have ALREADY been told are screen-sharing. A share announcement
    // is news only on the transition into this set — the same shape as
    // `announcedRef` for join chimes, and for the same reason: the raw events
    // are replayed, not edges.
    //
    // This deliberately does NOT ask "do we hold live video from them". Media
    // can arrive BEFORE the announcement (handleScreenShareStream has an
    // explicit no-entry branch for it; over the SFU, LiveKit pushes the track
    // independently of our socket, so it routinely wins), and treating that as
    // "already sharing" would swallow the chime and the tile auto-open for a
    // genuinely new share.
    const sharingAnnouncedRef = useRef(new ShareAnnouncements());
    // Freshest broadcastStatus for the presence re-assert paths (UserJoined
    // timer, reconnect) — assigned once the callback exists below.
    const broadcastStatusRef = useRef<(muted: boolean, deafened: boolean) => void>(() => {});
    /** Clip replay buffer armed on THIS machine (docs/CLIPS.md, roster badge). */
    const isBufferingRef = useRef(false);
    const [clipArmed, setClipArmed] = useState(false);
    /** Everyone seen in this room while the buffer was armed — the client's
     *  declared-participants list for a proposal (D1: the server unions it with
     *  its own log; it can only ADD approvers, never remove). Reset on arm. */
    const seenWhileArmedRef = useRef<Set<number>>(new Set());
    useEffect(() => {
        // Arming/disarming is the ONE event no existing broadcastStatus caller
        // fires on; without this the badge only appears at the next mute toggle.
        const un = onClipArmedChange((armed) => {
            const wasArmed = isBufferingRef.current;
            isBufferingRef.current = armed;
            if (armed && !wasArmed) {
                // A fresh arm: the declared-participants set starts from the
                // room as it is right now.
                seenWhileArmedRef.current = new Set(globalVoiceUsers.get(roomId)?.keys() ?? []);
            } else if (armed) {
                // A re-assert while ALREADY armed (armNative fires once when
                // native capture starts and again when the worker confirms a
                // codec) — MERGE, never rebuild: someone who left the call
                // between the two notifications is already in the ring and
                // must stay declared, or the client under-declares a person
                // whose footage it holds (the server union can only ADD).
                for (const id of globalVoiceUsers.get(roomId)?.keys() ?? []) seenWhileArmedRef.current.add(id);
            }
            setClipArmed(armed);
            broadcastStatusRef.current(isMutedRef.current, isDeafenedRef.current);
        });
        return un;
    }, [roomId]);
    useEffect(() => { isScreenSharingRef.current = isScreenSharing; }, [isScreenSharing]);
    useEffect(() => { listenOnlyRef.current = listenOnly; }, [listenOnly]);
    useEffect(() => { isCameraOnRef.current = isCameraOn; }, [isCameraOn]);
    useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);
    useEffect(() => { onInactiveRef.current = onInactive; }, [onInactive]);
    useEffect(() => { isAfkChannelRef.current = isAfkChannel; }, [isAfkChannel]);
    useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

    // --- Input mode: voice activity / push-to-talk / push-to-mute -----------
    // The HOLD key gates the transmitted track locally (track.enabled) without
    // touching mute state or broadcasting status — per-press WS chatter would
    // be noise, and the speaking indicator already reflects what transmits.
    // An explicit mute (button/deafen/AFK) always wins over either hold key.
    const [voiceInputMode, setVoiceInputMode] = useState<'open' | 'pushToTalk' | 'pushToMute'>(
        () => loadSettings().voiceInputMode ?? 'open');
    const voiceInputModeRef = useRef(voiceInputMode);
    useEffect(() => { voiceInputModeRef.current = voiceInputMode; }, [voiceInputMode]);
    /** True while the PTT (or PTM) key is physically held. */
    const holdKeyDownRef = useRef(false);
    // Mirror of holdKeyDownRef for the UI: push-to-mute/push-to-talk gate the
    // outgoing track silently, and with NO visual change a working hold reads
    // as "hold to mute doesn't work" (exactly the field report — the RTP gate
    // was verified live while the UI showed nothing).
    const [holdKeyDown, setHoldKeyDown] = useState(false);

    /** Single authority over whether the mic track transmits. `mutedOverride`
     *  lets toggleMute/toggleDeafen apply their NEW state before React commits
     *  it to isMutedRef. */
    const applyMicGate = useCallback((mutedOverride?: boolean) => {
        if (listenOnlyRef.current) return; // no track to gate
        const muted = mutedOverride ?? isMutedRef.current;
        const mode = voiceInputModeRef.current;
        const open = !muted && !isAfkChannelRef.current && (
            mode === 'pushToTalk' ? holdKeyDownRef.current :
            mode === 'pushToMute' ? !holdKeyDownRef.current :
            true);
        webrtcManager.setAudioEnabled(open);
    }, []);

    const clearInactivity = useCallback(() => {
        if (inactivityTimer.current) { clearTimeout(inactivityTimer.current); inactivityTimer.current = null; }
    }, []);
    /** Arm the idle check `ms` from now. The timer firing at all proves no
     *  speech reset it in the meantime (the VAD calls resetInactivity), so
     *  the check only has to separate present-but-silent from away — which
     *  decideAfk (utils/afkIdle.ts) does from the input signals, per
     *  Discord's rules. Fail-OPEN on a probe error: wrongly moving a present
     *  user is the worse failure, so a full quiet window must pass again
     *  before the next look. */
    const armInactivity = useCallback(function arm(ms: number) {
        clearInactivity();
        // Only arm when a move is possible and meaningful.
        if (!onInactiveRef.current || isAfkChannelRef.current) return;
        inactivityTimer.current = setTimeout(() => {
            void (async () => {
                const timeoutMs = afkTimeoutMsRef.current;
                // Desktop: ANY system-wide input is presence. Someone deep in
                // a game — silent, push-to-talk idle — generates constant
                // keyboard/mouse input the app can never observe as speech,
                // and used to be yanked to AFK mid-match. GetLastInputInfo is
                // a single idle-seconds number (no input contents). <0 means
                // the platform has no probe (non-Windows desktop) — treated
                // as absent so the in-app fallback decides, never as
                // "present forever".
                let osIdleSecs: number | null = null;
                if (isTauri()) {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const idleSecs = await invoke<number>('get_idle_seconds');
                        if (idleSecs >= 0) osIdleSecs = idleSecs;
                    } catch { arm(timeoutMs); return; }
                }
                const d = decideAfk({
                    timeoutMs,
                    broadcasting: isScreenSharingRef.current || isCameraOnRef.current,
                    // A phone viewer in the docked mini-player touches nothing;
                    // without this the mini-player moved its own viewer to AFK.
                    // Ignored wherever an OS probe answered (desktop).
                    watching: watchingStreamRef.current,
                    osIdleSecs,
                    lastAppInputMs: lastAppInputRef.current,
                    nowMs: Date.now(),
                });
                if (d.action === 'move') onInactiveRef.current?.();
                else arm(d.recheckInMs);
            })();
        }, ms);
    }, [clearInactivity]);
    const resetInactivity = useCallback(() => {
        armInactivity(afkTimeoutMsRef.current);
    }, [armInactivity]);
    // Clear on unmount (also covers the remount when the parent moves us).
    useEffect(() => clearInactivity, [clearInactivity]);

    // Apply the "Require encryption for calls" enforcement to the WebRTC
    // manager: either the per-user setting OR the server-admin policy turns it
    // on (fail-closed OR). Re-applies on the settingsChanged event and whenever
    // the server policy changes.
    useEffect(() => {
        const apply = () => webrtcManager.setRequireMediaE2ee(loadSettings().requireMediaE2ee || serverRequireMediaE2ee);
        apply();
        const onChange = () => apply();
        window.addEventListener('settingsChanged', onChange);
        return () => window.removeEventListener('settingsChanged', onChange);
    }, [serverRequireMediaE2ee]);
    const voiceDetectorCleanups = useRef<Map<number, () => void>>(new Map());

    // Refs for event listeners to allow cleanup
    const onStreamStartedRef = useRef<MessageHandler | null>(null);
    const onStreamStoppedRef = useRef<MessageHandler | null>(null);
    const onScreenShareStartedRef = useRef<MessageHandler | null>(null);
    const onScreenShareStoppedRef = useRef<MessageHandler | null>(null);
    const onCameraStartedRef = useRef<MessageHandler | null>(null);
    const onCameraStoppedRef = useRef<MessageHandler | null>(null);

    // Latest-teardown refs so the always-on RoomLeft handler (server-forced
    // eviction when another of our devices joins a different voice channel)
    // never calls a stale closure.
    const leaveVoiceRef = useRef<() => void>(() => { /* set below */ });
    const onDisconnectRef = useRef(onDisconnect);
    useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);
    // Mid-join window: joinVoice sends JoinRoom BEFORE getUserMedia resolves
    // (a permission prompt can hold that open for seconds), and isInVoiceRef
    // only flips true after. An eviction RoomLeft landing in that gap must not
    // be dropped by the !isInVoiceRef guard (zombie: UI in-voice, server
    // evicted) — it's recorded here and honored in joinVoice's finally.
    const joiningRef = useRef(false);
    const evictedWhileJoiningRef = useRef(false);

    // Keep ref in sync, and publish self-presence for chrome that must stay
    // out of a live call's way (UpdateBanner). Cleanup covers unmount: a
    // panel torn down mid-call must not leave "in voice" latched.
    useEffect(() => {
        isInVoiceRef.current = isInVoice;
        setSelfInVoice(isInVoice);
        return () => setSelfInVoice(false);
    }, [isInVoice]);

    // Properly sync self-preview video srcObject when screen sharing
    useEffect(() => {
        if (isScreenSharing && selfPreviewRef.current) {
            const stream = webrtcManager.getScreenShareStreamForPreview();
            if (stream) {
                selfPreviewRef.current.srcObject = stream;
            }
        } else if (selfPreviewRef.current) {
            selfPreviewRef.current.srcObject = null;
        }
    }, [isScreenSharing]);

    // Keep WebView2's redundant "… is sharing a window" bar hidden for the whole
    // duration of a share (desktop only; no-op in the browser). Covers every
    // stop path and unmount via the cleanup, and re-hides if Chromium re-shows it.
    // The stream boost rides the same lifecycle: while viewers are watching this
    // share, the webview capture/encode processes get CPU priority over a
    // foreground game (the "laggy until tabbed out" fix — see streamBoost.ts).
    // The diagnostic sampler rides it too, logging to file unattended — the
    // one moment a human could read the console live is exactly the moment a
    // fullscreen game has taken focus (see streamDiag.ts).
    useEffect(() => {
        if (isScreenSharing) { startHidingCaptureBar(); holdStreamBoost('voice-share'); holdStreamDiag('voice-share'); }
        else { stopHidingCaptureBar(); releaseStreamBoost('voice-share'); releaseStreamDiag('voice-share'); }
        return () => { stopHidingCaptureBar(); releaseStreamBoost('voice-share'); releaseStreamDiag('voice-share'); };
    }, [isScreenSharing]);

    // Stream-audio capture health (events from appAudio.ts/ScreenShareModal):
    // a capture that dies mid-stream, or starts but never produces data
    // (usually the ticked apps are simply quiet), used to be invisible —
    // viewers just heard nothing while the streamer had no idea. A late first
    // chunk retracts the silence hint. These prefixes MUST match the exact
    // leading text of every message the handlers below set, or onRecovered
    // stops clearing a stale warning and it sticks for the rest of the call.
    useEffect(() => {
        const STREAM_AUDIO_MSGS = [
            'Stream audio capture failed',
            'No stream audio detected',
        ];
        const onError = () => {
            setError('Stream audio capture failed — viewers can no longer hear it. Restart the share to retry.');
        };
        const onSilent = () => {
            setError('No stream audio detected — the apps you ticked seem silent right now (this clears itself once sound plays).');
        };
        const onRecovered = () => {
            setError(prev => prev && STREAM_AUDIO_MSGS.some(m => prev.startsWith(m)) ? null : prev);
        };
        window.addEventListener('sovereign:stream-audio-error', onError);
        window.addEventListener('sovereign:stream-audio-silent', onSilent);
        window.addEventListener('sovereign:stream-audio-recovered', onRecovered);
        return () => {
            window.removeEventListener('sovereign:stream-audio-error', onError);
            window.removeEventListener('sovereign:stream-audio-silent', onSilent);
            window.removeEventListener('sovereign:stream-audio-recovered', onRecovered);
        };
    }, []);

    // Sync speakingUsers to global for sidebar access
    useEffect(() => {
        globalSpeakingUsers.clear();
        speakingUsers.forEach(id => globalSpeakingUsers.add(id));
    }, [speakingUsers]);

    // Sync screenSharers to global for sidebar and Chat.tsx access
    useEffect(() => {
        globalScreenSharers.clear();
        globalStreamData.clear();
        screenSharers.forEach((data, id) => {
            globalScreenSharers.set(id, data.username);
            globalStreamData.set(id, data);
        });
        notifyStreamStateChange();
    }, [screenSharers]);

    // Drive the SFU subscriptions from the GLOBAL watch selection: a Watch
    // click starts the actual download, stop-watching stops it (the room
    // connects with autoSubscribe:false — see sfuManager). Subscribed to the
    // stream-state bus because every selection path notifies it. Own id is
    // excluded: we never subscribe to our own publications.
    useEffect(() => {
        const sync = () => {
            const others = [...globalSelectedStreams].filter(id => id !== currentUserId);
            watchingStreamRef.current = others.length > 0;
            sfuManager.setWatchedVideo(others);
        };
        sync();
        return subscribeToStreamState(sync);
    }, [currentUserId]);

    // Output volume / device changed in Settings: re-apply to every element
    // already playing. Without this the new value only reached peers who
    // connected afterwards, which reads as "the slider does nothing".
    useEffect(() => {
        const reapply = () => {
            const gain = outputGain();
            const mutes = getLocalUserMutes();
            const vols = getLocalUserVolumes();
            document.querySelectorAll('audio[id^="audio-"]').forEach(el => {
                const audio = el as HTMLAudioElement;
                const id = Number(audio.id.slice('audio-'.length));
                if (!Number.isFinite(id)) return;
                const muted = mutes[id] ?? false;
                const vol = vols[id] ?? 100;
                audio.volume = muted ? 0 : Math.max(0, Math.min(1, (vol / 100) * gain));
                applyOutputDevice(audio);
            });
        };
        window.addEventListener('settingsChanged', reapply);
        return () => window.removeEventListener('settingsChanged', reapply);
    }, []);

    // Listen for per-user volume/mute changes from UserContextMenu.
    // Applied straight to the <audio-${userId}> element's `.volume` (0..1). The
    // old WebAudio gain-node path was commented out ("TEMPORARY: bypass to ensure
    // playback works"), which left audioNodesRef empty and the slider dead — so
    // this uses HTMLMediaElement.volume instead: reliable, no graph, and it works
    // for BOTH the mesh and SFU transports (same audio elements). Composes with
    // deafen, which toggles the independent `.muted` flag.
    useEffect(() => {
        const applyUserVolume = (userId: number) => {
            const audio = document.getElementById(`audio-${userId}`) as HTMLAudioElement | null;
            if (!audio) return;
            const muted = getLocalUserMutes()[userId] ?? false;
            const vol = getLocalUserVolumes()[userId] ?? 100;
            // Master output volume from Settings multiplies the per-user one.
            // Without it the Settings slider moved nothing in a real call — it
            // only ever reached the panel's own test sound.
            audio.volume = muted ? 0 : Math.max(0, Math.min(1, (vol / 100) * outputGain()));
        };
        const handleVolumeChange = (e: CustomEvent<{ userId: number; volume: number }>) =>
            applyUserVolume(e.detail.userId);
        const handleMuteChange = (e: CustomEvent<{ userId: number; muted: boolean }>) =>
            applyUserVolume(e.detail.userId);

        window.addEventListener('userVolumeChanged', handleVolumeChange as EventListener);
        window.addEventListener('userMuteChanged', handleMuteChange as EventListener);

        return () => {
            window.removeEventListener('userVolumeChanged', handleVolumeChange as EventListener);
            window.removeEventListener('userMuteChanged', handleMuteChange as EventListener);
        };
    }, []);

    // Update voiceUsers display from global state
    const refreshVoiceUsersList = useCallback(() => {
        const roomUsers = globalVoiceUsers.get(roomId);
        if (!roomUsers) {
            setVoiceUsers([]);
            return;
        }

        const userList: VoiceUser[] = [];
        for (const [userId, status] of roomUsers) {
            if (isBufferingRef.current) seenWhileArmedRef.current.add(userId);
            userList.push({
                id: userId,
                username: status.username,
                isMuted: status.isMuted,
                isDeafened: status.isDeafened,
                isSpeaking: speakingUsers.has(userId),
                // Use ref to get current value (avoids stale closure)
                isConnected: isInVoiceRef.current ? (userId === currentUserId || webrtcManager.isConnectedTo(userId)) : false,
            });
        }
        setVoiceUsers(userList);
        // Notify Chat.tsx sidebar to re-render
        notifyVoiceUsersChange();
    }, [roomId, currentUserId, speakingUsers]);

    /**
     * Announce a join ONCE, as a transition of `announcedRef`.
     *
     * The raw WS events are not one-per-arrival: the server replays a
     * StreamStarted for every existing streamer to a joining connection, every
     * member re-broadcasts its own StartStream 500 ms after any UserJoined, and
     * UserJoined itself used to add people to the roster SILENTLY. Meanwhile a
     * leave was announced unconditionally — so anyone who entered via
     * UserJoined (a peer reconnecting, or a join that failed at the mic prompt)
     * produced "X left the channel" with no preceding "X joined".
     */
    /**
     * Play the joining/leaving user's uploaded clip when they have one, the
     * synth chime otherwise. Falls back to the chime on any clip failure
     * (playCustomUserSound resolves false) so an event is never silent just
     * because a download/decode broke.
     *
     * Two cases take the plain chime instead of the clip, because a clip is
     * ARBITRARY USER CONTENT while the chime is a fixed tone:
     *  - deafened: deafen means "no other people's audio", and the clip is
     *    synthesised by THIS client through Web Audio, so muting their audio
     *    element wouldn't catch it;
     *  - blocked: same reasoning, and it matters more — blocking someone must
     *    not leave them able to play a sound of their choosing at you by
     *    rejoining voice. The local per-user mute covers their VOICE stream
     *    only, never this path.
     */
    const playAnnouncement = useCallback((id: number, kind: 'join' | 'leave') => {
        const fallback = kind === 'join' ? playUserJoinedSound : playUserLeftSound;
        const suppressClip = isDeafenedRef.current || isBlocked(id);
        const clipId = suppressClip ? null : (memberSoundsRef.current?.get(id)?.[kind] ?? null);
        if (clipId) {
            void playCustomUserSound(getFileUrl(clipId)).then(ok => { if (!ok) fallback(); });
        } else {
            fallback();
        }
    }, []);

    const announceJoin = useCallback((id: number, name: string) => {
        if (id === currentUserId || announcedRef.current.has(id)) return;
        announcedRef.current.set(id, name);
        if (!isInVoiceRef.current || Date.now() < speechMuteUntilRef.current) return;
        playAnnouncement(id, 'join'); // clip or chime (gated on voiceChime)
        // No spoken announcement for someone you blocked — TTS reads their
        // display name aloud, which is the same "reach you anyway" problem.
        if (!isBlocked(id)) speak(`${name} joined the channel`); // opt-in TTS
    }, [currentUserId, playAnnouncement]);

    /** Announce a leave only for someone we actually counted as present. */
    const announceLeave = useCallback((id: number, name?: string) => {
        if (id === currentUserId) return;
        const known = announcedRef.current.get(id);
        if (!announcedRef.current.delete(id)) return; // never announced → stay silent
        if (!isInVoiceRef.current || Date.now() < speechMuteUntilRef.current) return;
        playAnnouncement(id, 'leave'); // clip or chime (gated on voiceChime)
        if (!isBlocked(id)) speak(`${name ?? known ?? 'Someone'} left the channel`); // opt-in TTS
    }, [currentUserId, playAnnouncement]);

    // ---- Join-announce gate -----------------------------------------------
    // The roster entry appears the instant we hear UserJoined/StreamStarted;
    // the CHIME waits until the peer's media is actually reachable (or the
    // timeout), because chiming on the first packet of a join had people
    // talking to someone who could not yet decrypt a word of it.

    /** Flip the `connecting` chip on a roster entry (both the stage tile and
     *  the sidebar row read it). Notifies through the bus, not
     *  refreshVoiceUsersList, whose identity churns with speakingUsers. */
    const setConnecting = useCallback((id: number, on: boolean) => {
        const entry = globalVoiceUsers.get(roomId)?.get(id);
        if (!entry || !!entry.connecting === on) return;
        entry.connecting = on || undefined;
        notifyVoiceUsersChange();
    }, [roomId]);

    const stopPendingTimer = useCallback(() => {
        if (pendingTimerRef.current !== null) {
            clearInterval(pendingTimerRef.current);
            pendingTimerRef.current = null;
        }
    }, []);

    /** One tick: re-probe every pending join and announce the ones that are
     *  ready. Reads through refs so the interval identity never changes. */
    const tickPendingJoins = useCallback(() => {
        const joins = pendingJoinsRef.current;
        if (joins.size === 0) { stopPendingTimer(); return; }
        // A replay-mute window that opened AFTER these joins were admitted (our
        // own reconnect) must not swallow them: announceJoin would record them
        // silently and they would never chime. Hold the tick — the entries
        // keep their `since`, and resolve normally once the window has passed.
        if (Date.now() < speechMuteUntilRef.current) return;
        // Build the probe once per tick, not per id: allMediaE2eeStatuses walks
        // every remote participant.
        let probe: (id: number) => { encrypted: boolean; present: boolean };
        if (sfuMode) {
            const encryptedIds = new Set(sfuManager.allMediaE2eeStatuses().filter(s => s.encrypted).map(s => s.userId));
            probe = (id) => ({ encrypted: encryptedIds.has(id), present: sfuManager.hasParticipant(id) });
        } else {
            probe = (id) => ({ encrypted: webrtcManager.isMediaEncrypted(id), present: webrtcManager.isConnectedTo(id) });
        }
        const ready = joins.takeReady(probe, { graceMs: JOIN_PRESENT_GRACE_MS, timeoutMs: JOIN_ANNOUNCE_TIMEOUT_MS });
        const roster = globalVoiceUsers.get(roomId);
        for (const r of ready) {
            setConnecting(r.id, false);
            // Never announce a ghost: an entry the roster has since dropped
            // would leave a permanent announcedRef record that silences their
            // real rejoin.
            if (!roster?.has(r.id)) continue;
            console.log(`[VoicePanel] join of ${r.name} (${r.id}) ready via ${r.reason}`);
            announceJoin(r.id, r.name);
        }
        if (joins.size === 0) stopPendingTimer();
    }, [sfuMode, roomId, setConnecting, announceJoin, stopPendingTimer]);
    const tickPendingJoinsRef = useRef(tickPendingJoins);
    useEffect(() => { tickPendingJoinsRef.current = tickPendingJoins; }, [tickPendingJoins]);

    const startPendingTimer = useCallback(() => {
        if (pendingTimerRef.current !== null) return;
        pendingTimerRef.current = setInterval(() => tickPendingJoinsRef.current(), PENDING_JOIN_POLL_MS);
    }, []);

    /** The gate in front of announceJoin. announceJoin stays the single writer
     *  of announcedRef, so the "every leave chime had a join chime" invariant
     *  is untouched. */
    const requestJoinAnnounce = useCallback((id: number, name: string) => {
        if (id === currentUserId || announcedRef.current.has(id)) return;
        // Already held: the tick owns this one. A replayed StreamStarted that
        // lands inside a LATER mute window (our reconnect) must not re-classify
        // a held join as a silent seed — that would record it in announcedRef
        // and the chime would be lost for good.
        if (pendingJoinsRef.current.has(id)) return;
        // Silent-seed pass-through: not in voice (a sidebar observer has no
        // transport state to probe), or inside the join/reconnect replay
        // window — announceJoin records these without a sound today, and
        // holding them here would narrate a room full of people once the
        // window had passed.
        if (!isInVoiceRef.current || Date.now() < speechMuteUntilRef.current) {
            announceJoin(id, name);
            return;
        }
        if (pendingJoinsRef.current.add(id, name)) {
            setConnecting(id, true);
            startPendingTimer();
        }
    }, [currentUserId, announceJoin, setConnecting, startPendingTimer]);

    /** They left (or their claim was retracted) before we chimed: no late chime. */
    const dropPendingJoin = useCallback((id: number) => {
        if (pendingJoinsRef.current.drop(id)) setConnecting(id, false);
    }, [setConnecting]);

    // The channel-switch path unmounts (or re-keys) without running leaveVoice
    // — make sure neither the interval nor a stale chip outlives the panel for
    // this room. The cleanup closes over the OLD roomId, which is the room
    // whose chips need clearing.
    useEffect(() => () => {
        for (const id of pendingJoinsRef.current.clear()) setConnecting(id, false);
        stopPendingTimer();
    }, [setConnecting, stopPendingTimer]);

    // Pending presence re-broadcast timers (see handleUserJoined). A ref, not
    // an effect-local set: the always-on effect re-runs whenever its handler
    // deps change identity, and effect-local timers were cancelled on every
    // such re-run — losing legitimate re-broadcasts. Cleared per-room below.
    const rebroadcastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    useEffect(() => {
        const timers = rebroadcastTimersRef.current;
        return () => { timers.forEach(t => clearTimeout(t)); timers.clear(); };
    }, [roomId]);

    // Always listen for StreamStarted/Stopped to track who's in voice (visible to everyone!)
    useEffect(() => {
        // Only initialize the room if it doesn't exist yet (don't clear existing users)
        if (!globalVoiceUsers.has(roomId)) {
            globalVoiceUsers.set(roomId, new Map());
        }
        // Refresh display from current state
        refreshVoiceUsersList();

        const handleStreamStarted = (msg: ServerMessage) => {
            const payload = msg.payload as {
                room_id: string;
                streamer: { id: number; username: string }
            };

            if (payload.room_id !== roomId) return;

            console.log(`[VoicePanel] StreamStarted from ${payload.streamer.username} (${payload.streamer.id})`);

            // Add to global tracking — PRESERVING mute/deafen: this event is
            // replayed for existing members on every join/reconnect, and the
            // old from-scratch write here wiped their status each time.
            upsertVoiceUser(roomId, { id: payload.streamer.id, username: payload.streamer.username });

            // Update display
            refreshVoiceUsersList();

            // Call INITIATION lives solely in joinVoice's onStreamStarted (Block
            // B) while in voice — doing it here too registered a second handler
            // for the same event, so every StreamStarted fired callUser twice and
            // logged everything twice. This always-on handler only maintains the
            // presence list (so the sidebar shows who's in a voice channel you're
            // NOT in) and requests the join chime (held until they're reachable).
            requestJoinAnnounce(payload.streamer.id, payload.streamer.username);
        };

        const handleStreamStopped = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; streamer_id: number };

            if (payload.room_id !== roomId) return;

            console.log(`[VoicePanel] StreamStopped from ${payload.streamer_id}`);

            // Capture the name BEFORE the delete below (the leave payload carries
            // only the id) so the TTS announcement can say who left.
            const leaverName = globalVoiceUsers.get(roomId)?.get(payload.streamer_id)?.username;

            // Remove from global tracking
            globalVoiceUsers.get(roomId)?.delete(payload.streamer_id);

            // Leaving voice implies any screen share ended — clear the tile +
            // selection too (a viewer that missed the ScreenShareStopped
            // broadcast otherwise keeps a stale LIVE badge + black tile), and
            // with it our record that they were announced, so a share after
            // they come back still counts as news.
            sharingAnnouncedRef.current.stopped(payload.streamer_id);
            setScreenSharers(prev => {
                if (!prev.has(payload.streamer_id)) return prev;
                const newMap = new Map(prev);
                newMap.delete(payload.streamer_id);
                return newMap;
            });
            deselectStream(payload.streamer_id);

            // Update display
            refreshVoiceUsersList();

            // Teardown stays unconditional on the EVENT — the peer and its
            // audio element must go regardless of whether we announce — EXCEPT
            // when the "departed" peer's LiveKit session is demonstrably still
            // alive: a WS blip on THEIR side makes the server broadcast
            // StreamStopped, but the SFU audio element is only ever created on
            // a TrackSubscribed, which never re-fires for a surviving session.
            // Removing it here silenced them PERMANENTLY ("voice stopped until
            // I disconnected and reconnected"). Their WS rejoin replays
            // StreamStarted and the roster heals; the audio must survive.
            if (isInVoiceRef.current && payload.streamer_id !== currentUserId
                && !(sfuMode && sfuManager.hasParticipant(payload.streamer_id))) {
                webrtcManager.closePeer(payload.streamer_id);
                const audio = document.getElementById(`audio-${payload.streamer_id}`);
                audio?.remove();
            }
            // Gone before we chimed: no late chime, and announceLeave stays
            // silent because announceJoin never recorded them.
            dropPendingJoin(payload.streamer_id);
            announceLeave(payload.streamer_id, leaverName);
        };

        // Handle voice status updates (mute/deafen) - using ChatMessage with special prefix
        const handleChatMessage = (msg: ServerMessage) => {
            const payload = msg.payload as {
                room_id: string;
                sender: { id: number; username: string };
                content: string;
            };

            if (payload.room_id !== roomId) return;
            const status = parseVoiceStatus(payload.content);
            if (!status) return;
            const roomUsers = globalVoiceUsers.get(roomId);
            if (roomUsers && roomUsers.has(payload.sender.id)) {
                const user = roomUsers.get(payload.sender.id)!;
                user.isMuted = status.muted;
                user.isDeafened = status.deafened;
                user.isBuffering = status.buffering;
                refreshVoiceUsersList();
            }
        };

        // When a new user joins the room, add them to voice users and re-broadcast our presence
        const handleUserJoined = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; user: { id: number; username: string } };

            if (payload.room_id !== roomId) return;
            if (payload.user.id === currentUserId) return; // Don't respond to ourselves

            console.log(`[VoicePanel] UserJoined: ${payload.user.username} (${payload.user.id}) in room ${payload.room_id}`);

            // Add the new user to our voice users list (status-preserving:
            // a UserJoined for someone already listed must not reset them).
            upsertVoiceUser(roomId, { id: payload.user.id, username: payload.user.username });

            // Update the UI
            refreshVoiceUsersList();

            // Request the announcement now — the roster shows them at once,
            // but the chime itself waits until their media is reachable
            // (getUserMedia + SFU connect + E2EE can be seconds on mobile, and
            // chiming before that had people talking to someone who could not
            // hear them yet). A reconnecting peer also produces a StreamStarted
            // — the server re-asserts the voice claim on JoinRoom — but the
            // gate and announceJoin both dedup by id, so the pair never
            // double-chimes.
            requestJoinAnnounce(payload.user.id, payload.user.username);

            // If we're in voice, re-broadcast our presence after a short delay
            // so the new user can receive our StreamStarted. The timer must be
            // cancelled on room change/unmount and must re-check we are STILL
            // in voice when it fires: a captured roomId outliving a channel
            // switch made this send StartStream for the room we just left,
            // which the server rejects ("Not in this room") into a user-facing
            // alert.
            if (isInVoiceRef.current) {
                const timer = setTimeout(() => {
                    rebroadcastTimersRef.current.delete(timer);
                    if (!isInVoiceRef.current) return;
                    console.log(`[VoicePanel] Re-broadcasting voice presence for new user ${payload.user.username}`);
                    wsClient.startStream(roomId);
                    // ...and our mute/deafen right behind it. Status only ever
                    // rode the toggle, so a newcomer had no way to learn we
                    // were deafened until we toggled again. Same ordered
                    // socket: the StreamStarted above lands first, so the
                    // receiver already has our roster entry to apply this to.
                    broadcastStatusRef.current(isMutedRef.current, isDeafenedRef.current);
                }, 500);
                rebroadcastTimersRef.current.add(timer);
            }
        };

        // Handle screen share events - support multiple streamers
        const handleScreenShareStarted = (msg: ServerMessage) => {
            const payload = msg.payload as {
                room_id: string;
                streamer: { id: number; username: string };
                stream_id?: string | null;
            };
            if (payload.room_id !== roomId) return;
            // Authoritative signal for classifying their incoming video track:
            // a peer with no mic never pins a "voice stream", so without this
            // their camera would be filed as a screen share. The stream id
            // (absent from old peers/servers) upgrades that classification
            // from elimination to identity — see classifyRemoteVideo.
            webrtcManager.setPeerSharing(payload.streamer.id, true, payload.stream_id ?? null);

            // ScreenShareStarted is NOT proof that a share is new. A client
            // re-announces its share on every WS reconnect — that re-claim is
            // what stops the server tearing the tile down when the dead
            // connection is reaped — and the server also replays it to a
            // (re)joining connection from room state. So this event is news
            // only on the transition INTO sharingAnnouncedRef; otherwise the
            // "went live" chime fires again and a tile the viewer had
            // dismissed springs back open.
            const isReannounce = !sharingAnnouncedRef.current.announce(payload.streamer.id);

            setScreenSharers(prev => {
                const newMap = new Map(prev);
                // Keep an existing entry only while its stream is genuinely
                // LIVE — that preserves the original intent (never clobber a
                // good stream with a null placeholder: our OWN share set in
                // onGoLive, or a remote whose media already arrived) WITHOUT
                // the old trap: after an unclean disconnect a sharer's stale
                // dead-stream entry survived here forever, so their rejoin +
                // re-share kept showing the black tile.
                if (!hasLiveVideo(newMap.get(payload.streamer.id))) {
                    newMap.set(payload.streamer.id, { username: payload.streamer.username, stream: null });
                }
                return newMap;
            });
            if (isReannounce) return;
            // Opt-in viewing: never auto-open someone ELSE's stream. The LIVE
            // badge + Watch affordances (voice-stage tile button, floating
            // "Live Streams" button, StreamStage watch cards) are the way in.
            // Our OWN share keeps auto-opening, as before.
            if (payload.streamer.id === currentUserId) {
                selectStream(payload.streamer.id);
            }
            // Distinct "went live" sound for others' streams while you're in voice.
            if (isInVoiceRef.current && payload.streamer.id !== currentUserId) {
                playStreamStartSound();
            }
        };

        const handleScreenShareStopped = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; streamer_id: number };
            if (payload.room_id !== roomId) return;
            webrtcManager.setPeerSharing(payload.streamer_id, false);
            // They are no longer sharing, so their NEXT announcement is news.
            sharingAnnouncedRef.current.stopped(payload.streamer_id);

            setScreenSharers(prev => {
                const newMap = new Map(prev);
                newMap.delete(payload.streamer_id);
                return newMap;
            });
            deselectStream(payload.streamer_id);
            if (isInVoiceRef.current && payload.streamer_id !== currentUserId) {
                playStreamStopSound();
            }
        };

        // Server-forced eviction: another of OUR devices joined a different
        // voice channel, so the server removed us from this room (voice
        // exclusivity — "mobile overrides"). Tear the local session down.
        // Self-initiated leaves are ignored: leaveVoice() flips isInVoiceRef
        // false synchronously, long before the echoed RoomLeft arrives.
        const handleRoomLeft = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string };
            if (payload.room_id !== roomId) return;
            // Eviction during the join's getUserMedia window: defer the
            // teardown to joinVoice's finally — running leaveVoice while the
            // join is still writing state would race it.
            if (joiningRef.current) {
                evictedWhileJoiningRef.current = true;
                return;
            }
            if (!isInVoiceRef.current) return;
            console.log('[VoicePanel] Server moved this user out of the room (another device took over) — tearing down');
            leaveVoiceRef.current();
            onDisconnectRef.current?.();
        };

        // Mirror of handleUserJoined: the voice-exclusivity eviction retracts
        // a departed member with UserLeft (they may hold no streamer claim, so
        // no StreamStopped is guaranteed). Without this, an evicted user
        // lingered in the in-call roster of everyone in the room.
        const handleUserLeft = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; user_id: number };
            if (payload.room_id !== roomId) return;
            if (payload.user_id === currentUserId) return; // RoomLeft handles self
            // Not gated on OUR delete succeeding: Chat's global UserLeft
            // handler is registered first and usually removes the roster
            // entry before this runs, which left the eviction leave-chime
            // dead. announceLeave has its own gate (only peers we announced),
            // and dropPendingJoin/refresh are idempotent.
            dropPendingJoin(payload.user_id);
            globalVoiceUsers.get(roomId)?.delete(payload.user_id);
            refreshVoiceUsersList();
            announceLeave(payload.user_id);
        };

        wsClient.on('StreamStarted', handleStreamStarted);
        wsClient.on('StreamStopped', handleStreamStopped);
        wsClient.on('ChatMessage', handleChatMessage);
        wsClient.on('UserJoined', handleUserJoined);
        wsClient.on('UserLeft', handleUserLeft);
        wsClient.on('ScreenShareStarted', handleScreenShareStarted);
        wsClient.on('ScreenShareStopped', handleScreenShareStopped);
        wsClient.on('RoomLeft', handleRoomLeft);

        return () => {
            wsClient.off('StreamStarted', handleStreamStarted);
            wsClient.off('StreamStopped', handleStreamStopped);
            wsClient.off('ChatMessage', handleChatMessage);
            wsClient.off('UserJoined', handleUserJoined);
            wsClient.off('UserLeft', handleUserLeft);
            wsClient.off('ScreenShareStarted', handleScreenShareStarted);
            wsClient.off('ScreenShareStopped', handleScreenShareStopped);
            wsClient.off('RoomLeft', handleRoomLeft);
        };
    }, [roomId, currentUserId, refreshVoiceUsersList, requestJoinAnnounce, dropPendingJoin, announceLeave, sfuMode]);

    // Broadcast our status when mute/deafen changes — and (via the ref below)
    // whenever we re-assert presence: on a newcomer's UserJoined and after our
    // own reconnect. The status message is one-shot and never persisted, so
    // without those re-sends anyone who missed the toggle (or had our entry
    // rebuilt) showed us un-deafened. Guarded on the REF, not the state, so it
    // can be called from timers and reconnect handlers.
    const broadcastStatus = useCallback((muted: boolean, deafened: boolean) => {
        if (!isInVoiceRef.current) return;
        // Clip buffer armed? Read from the ref, not a parameter: six call sites
        // pass two args on every re-assert (mute, deafen, SFU connect, UserJoined
        // replay) and each of them must carry the CURRENT buffering flag — a
        // newcomer learns you are buffering from exactly that replay.
        const buffering = isBufferingRef.current;

        // Update global state
        const roomUsers = globalVoiceUsers.get(roomId);
        if (roomUsers && roomUsers.has(currentUserId)) {
            const user = roomUsers.get(currentUserId)!;
            user.isMuted = muted;
            user.isDeafened = deafened;
            user.isBuffering = buffering;
            refreshVoiceUsersList();
        }

        // Broadcast to others via special message
        wsClient.sendChatMessage(roomId, buildVoiceStatus({ muted, deafened, buffering }));
    }, [roomId, currentUserId, refreshVoiceUsersList]);
    // Always-fresh handle for the WS-effect timers and the reconnect handler:
    // adding broadcastStatus to those effects' deps would tear down and
    // re-register every WS handler on each identity change.
    useEffect(() => { broadcastStatusRef.current = broadcastStatus; }, [broadcastStatus]);

    // Handle joining voice
    const joinVoice = useCallback(async () => {
        // Re-entry guard: auto-join, the retry button, and double-clicks can
        // overlap; a concurrent second join built a SECOND LiveKit session on
        // SFU channels — the loser leaked and fed the user's mic back to them.
        if (joiningRef.current || isInVoiceRef.current) return;
        setIsConnecting(true);
        setError(null);
        joiningRef.current = true;
        evictedWhileJoiningRef.current = false;

        try {
            // Identify ourselves for perfect-negotiation politeness (glare handling).
            webrtcManager.setLocalUserId(currentUserId);

            // Seed silently for a moment: joining makes the server replay a
            // StreamStarted for everyone ALREADY here, which must populate the
            // announced set without narrating a room full of "X joined".
            // Set before JoinRoom so the replay is inside the window.
            speechMuteUntilRef.current = Date.now() + 2500;

            // CRITICAL: Join the WebSocket room FIRST so we can receive events from others
            wsClient.joinRoom(roomId);

            const localStream = await webrtcManager.getLocalStream(true, false);
            // No usable microphone → we joined LISTEN-ONLY rather than failing
            // the join outright. We hear everyone; nobody hears us.
            const noMic = webrtcManager.isListenOnly();
            setListenOnly(noMic);

            setIsInVoice(true);
            isInVoiceRef.current = true;

            // Add ourselves to global tracking with our actual username. A
            // direct write on purpose (NOT upsertVoiceUser): our own mute/deafen
            // is local truth at join time and must never inherit whatever
            // stale entry the REST snapshot or a pre-join StreamStarted left.
            const roomUsers = globalVoiceUsers.get(roomId) || new Map();
            globalVoiceUsers.set(roomId, roomUsers);
            roomUsers.set(currentUserId, {
                id: currentUserId,
                username: currentUsername,
                isMuted: noMic,
                isDeafened: false,
            });

            // Skip the analysers entirely with no mic track: there is nothing to
            // measure, and createMediaStreamSource would throw + leak a context.
            if (!noMic) {
            // Set up voice activity detection for local stream
            const localCleanup = webrtcManager.createVoiceActivityDetector(
                localStream,
                (isSpeaking) => {
                    // Speaking is the primary activity signal: staying idle for
                    // 15 min moves us to AFK, so any speech resets the clock.
                    if (isSpeaking) resetInactivity();
                    setSpeakingUsers(prev => {
                        const newSet = new Set(prev);
                        if (isSpeaking) {
                            newSet.add(currentUserId);
                        } else {
                            newSet.delete(currentUserId);
                        }
                        return newSet;
                    });
                },
                0.02 // threshold
            );
            voiceDetectorCleanups.current.set(currentUserId, localCleanup);

            // Silent-capture sentinel: warn when the PUBLISHED mic has produced
            // nothing but digital zeros since it went live (dead device, dead
            // NS graph, OS-level mute) — the user otherwise talks into the void
            // with every local indicator looking healthy. Keyed at -1 (never a
            // real user id) so it rides the same cleanup path as the detectors.
            const silenceCleanup = webrtcManager.createSilenceSentinel(localStream, (silent) => {
                if (!silent) {
                    // Clear ONLY our own message: the dead-graph handler shares
                    // this slot, and its notice must survive the mic rebuild
                    // that follows (which is exactly what makes audio return).
                    setMicNotice(prev => (prev === MIC_SILENT_NOTICE ? null : prev));
                    return;
                }
                // Silence out means one of two very different things, and they
                // are indistinguishable from here: the suppression graph died,
                // or the MICROPHONE is producing nothing (hardware mute switch,
                // OS mute, wrong device). This used to assume the graph whenever
                // a graph mode was active — so a muted headset told the user
                // RNNoise was broken and cost them noise suppression for the
                // session, while the actual mute went unmentioned.
                //
                // Only the graph can be blamed when the RAW input was proven to
                // carry speech. Absent that evidence it is the mic, and the mode
                // is left exactly as the user set it.
                if (modeUsesWebAudio(getNoiseSuppressionMode()) && rawInputHasHadSignal()) {
                    window.dispatchEvent(new CustomEvent('sovereign:noise-graph-dead'));
                    return;
                }
                setMicNotice(MIC_SILENT_NOTICE);
            });
            voiceDetectorCleanups.current.set(-1, silenceCleanup);
            }

            // One handler for BOTH transports: the mesh delivers per-peer voice
            // streams, the SFU delivers per-participant mic streams — the audio
            // element + VAD wiring is identical either way.
            const handleRemoteStream = (userId: number, stream: MediaStream) => {
                console.log(`[VoicePanel] Got remote stream from ${userId}`);
                console.log(`[VoicePanel] Stream tracks:`, stream.getTracks().map(t => ({
                    kind: t.kind,
                    enabled: t.enabled,
                    muted: t.muted,
                    readyState: t.readyState
                })));

                const audioTracks = stream.getAudioTracks();
                if (audioTracks.length === 0) {
                    console.warn(`[VoicePanel] No audio tracks in stream from ${userId}!`);
                    return;
                }

                // Create/update audio element
                let audio = document.getElementById(`audio-${userId}`) as HTMLAudioElement;
                if (!audio) {
                    audio = document.createElement('audio');
                    audio.id = `audio-${userId}`;
                    audio.autoplay = true;
                    // Apply this peer's stored per-user volume/mute on creation
                    // (right-click → User Volume), so it's honored the moment they
                    // (re)connect, not only after a later slider change.
                    {
                        const uMuted = getLocalUserMutes()[userId] ?? false;
                        const uVol = getLocalUserVolumes()[userId] ?? 100;
                        audio.volume = uMuted ? 0 : Math.max(0, Math.min(1, (uVol / 100) * outputGain()));
                    }
                    // Play through the output device chosen in Settings, not
                    // just the system default.
                    applyOutputDevice(audio);
                    // Android pauses playing media elements when the app
                    // backgrounds while the MIC keeps transmitting — peers
                    // heard the user, the user heard silence. Fight the
                    // platform pause for the life of the element (removal
                    // disarms it; see voiceAudioKeepAlive.ts).
                    keepVoiceAudioAlive(audio);
                    document.body.appendChild(audio);
                    console.log(`[VoicePanel] Created new audio element for ${userId}`);
                }
                // Honor the current deafen state for BOTH new and reconnecting
                // peers — a peer that (re)connects while we're deafened must start
                // muted, not unmuted. (audit M8)
                audio.muted = isDeafenedRef.current;

                // First try: Play the raw stream directly (most reliable)
                audio.srcObject = stream;
                console.log(`[VoicePanel] Set srcObject to raw stream for ${userId}`);

                // Play with promise handling
                const playPromise = audio.play();
                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        console.log(`[VoicePanel] Audio playing for user ${userId}`);

                        // TEMPORARY: Bypass Web Audio volume control to ensure playback works
                        /*
                        // Now set up volume control via AudioContext (optional enhancement)
                        try {
                            if (!audioContextRef.current) {
                                audioContextRef.current = new AudioContext();
                            }
                            const ctx = audioContextRef.current;

                            // Resume if suspended
                            if (ctx.state === 'suspended') {
                                ctx.resume();
                            }

                            // Get stored volume settings
                            const volumes = getLocalUserVolumes();
                            const mutes = getLocalUserMutes();
                            const userVolume = volumes[userId] ?? 100;
                            const userMuted = mutes[userId] ?? false;

                            // Create audio processing chain for volume control
                            const source = ctx.createMediaStreamSource(stream);
                            const gainNode = ctx.createGain();
                            const destination = ctx.createMediaStreamDestination();

                            gainNode.gain.value = userMuted ? 0 : userVolume / 100;
                            source.connect(gainNode);
                            gainNode.connect(destination);

                            // Store nodes for later volume updates
                            audioNodesRef.current.set(userId, { source, gain: gainNode, destination });

                            // Switch to processed stream for volume control
                            audio.srcObject = destination.stream;
                            audio.play().catch(e => console.warn('[VoicePanel] Processed stream play failed:', e));
                            console.log(`[VoicePanel] Switched to processed stream for volume control for ${userId}`);
                        } catch (err) {
                            console.warn(`[VoicePanel] AudioContext setup failed, continuing with raw stream:`, err);
                        }
                        */
                    }).catch((err) => {
                        console.warn(`[VoicePanel] Autoplay blocked for user ${userId}:`, err);
                        // Add a click handler to retry
                        const startAudio = () => {
                            audio.play().then(() => {
                                console.log(`[VoicePanel] Audio started after interaction for ${userId}`);
                            }).catch(e => console.error('Failed to play audio after interaction:', e));
                            document.removeEventListener('click', startAudio);
                            document.removeEventListener('keydown', startAudio);
                        };
                        document.addEventListener('click', startAudio, { once: true });
                        document.addEventListener('keydown', startAudio, { once: true });
                    });
                }

                // Set up voice activity detection for remote stream. Renegotiation
                // (mute cycles, screen share start/stop) can re-deliver a stream for
                // the same user — tear down the previous detector first or its stale
                // interval keeps voting on this user's indicator with dead audio.
                voiceDetectorCleanups.current.get(userId)?.();
                const remoteCleanup = webrtcManager.createVoiceActivityDetector(
                    stream,
                    (isSpeaking) => {
                        setSpeakingUsers(prev => {
                            const newSet = new Set(prev);
                            if (isSpeaking) {
                                newSet.add(userId);
                            } else {
                                newSet.delete(userId);
                            }
                            return newSet;
                        });
                    },
                    0.02 // threshold
                );
                voiceDetectorCleanups.current.set(userId, remoteCleanup);

                refreshVoiceUsersList();
            };
            webrtcManager.setOnRemoteStream(handleRemoteStream);
            sfuManager.setOnRemoteStream(handleRemoteStream);

            // Define listeners
            const onStreamStarted = (msg: ServerMessage) => {
                const payload = msg.payload as { room_id: string; streamer: { id: number; username: string } };
                if (payload.room_id !== roomId) return;

                const streamer = payload.streamer;
                console.log(`[VoicePanel] User ${streamer.username} (${streamer.id}) joined voice`);

                // Add to our list (status-preserving — this is a replay for
                // anyone already in the room)
                upsertVoiceUser(roomId, { id: streamer.id, username: streamer.username });

                // Initiate when we're the lower id (first-contact convention) OR
                // whenever we have NO peer entry for an in-room streamer — no
                // entry means no negotiation is in flight at all, and the other
                // side may be silently stuck on a STALE pc for us (its callUser
                // no-ops on the existing entry), e.g. after we reloaded mid-call
                // and rejoined with an empty roster. callUser no-ops when a peer
                // exists, and a double offer is ordinary glare (politeness).
                // SFU rooms have no mesh to build — LiveKit delivers everyone's
                // media through the server; this event only drives the roster.
                if (!sfuMode
                    && streamer.id !== currentUserId
                    && (currentUserId < streamer.id || !webrtcManager.hasPeer(streamer.id))) {
                    console.log(`[VoicePanel] StreamStarted from ${streamer.id} — ensuring mesh (initiating if unmeshed)`);
                    setTimeout(() => webrtcManager.callUser(streamer.id), 500);
                }

                refreshVoiceUsersList();
            };

            const onStreamStopped = (msg: ServerMessage) => {
                const payload = msg.payload as { room_id: string; streamer_id: number };
                if (payload.room_id !== roomId) return;

                const streamerId = payload.streamer_id;
                console.log(`[VoicePanel] User ${streamerId} left voice`);

                const roomUsers = globalVoiceUsers.get(roomId);
                if (roomUsers) {
                    roomUsers.delete(streamerId);
                }

                // Same SFU-liveness guard as the always-on handler: a peer
                // whose LiveKit session survives a WS blip must keep their
                // audio element — it is never recreated for a live session.
                if (!(sfuMode && sfuManager.hasParticipant(streamerId))) {
                    webrtcManager.closePeer(streamerId);
                    const audio = document.getElementById(`audio-${streamerId}`);
                    audio?.remove();
                }

                const cleanup = voiceDetectorCleanups.current.get(streamerId);
                if (cleanup) {
                    cleanup();
                    voiceDetectorCleanups.current.delete(streamerId);
                }

                // Leaving voice implies any screen share ended — mirror the
                // always-on handler so a missed ScreenShareStopped can't leave
                // a stale LIVE badge + black tile behind.
                setScreenSharers(prev => {
                    if (!prev.has(streamerId)) return prev;
                    const newMap = new Map(prev);
                    newMap.delete(streamerId);
                    return newMap;
                });
                deselectStream(streamerId);

                refreshVoiceUsersList();
            };

            // Register and store listeners
            wsClient.on('StreamStarted', onStreamStarted);
            wsClient.on('StreamStopped', onStreamStopped);
            onStreamStartedRef.current = onStreamStarted;
            onStreamStoppedRef.current = onStreamStopped;

            // Define screen share listeners
            const onScreenShareStarted = (msg: ServerMessage) => {
                const payload = msg.payload as { room_id: string; streamer: { id: number; username: string } };
                if (payload.room_id !== roomId) return;
                const streamer = payload.streamer;
                console.log(`[VoicePanel] User ${streamer.username} (${streamer.id}) started screen share`);

                // Add to screenSharers list (stream will be null until WebRTC
                // delivers it). Same liveness guard as the always-on handler:
                // keep an existing entry only while its stream is actually
                // live, so a rejoining sharer's stale dead-stream entry gets
                // reset instead of pinning a black tile forever.
                setScreenSharers(prev => {
                    const newMap = new Map(prev);
                    if (!hasLiveVideo(newMap.get(streamer.id))) {
                        newMap.set(streamer.id, { username: streamer.username, stream: null });
                    }
                    return newMap;
                });

                // Trigger renegotiation to get the video stream (mesh only —
                // the SFU pushes new tracks without client renegotiation).
                // Deliberately NOT deduped against a re-announce: a redundant
                // offer is absorbed by perfect negotiation, while skipping one
                // that WAS needed leaves the viewer with no video at all.
                if (!sfuMode && streamer.id !== currentUserId && currentUserId < streamer.id) {
                    console.log(`[VoicePanel] Renegotiating to get screen share from ${streamer.id}`);
                    setTimeout(() => webrtcManager.callUser(streamer.id), 500);
                }
            };

            const onScreenShareStopped = (msg: ServerMessage) => {
                const payload = msg.payload as { room_id: string; streamer_id: number };
                if (payload.room_id !== roomId) return;
                const streamerId = payload.streamer_id;
                console.log(`[VoicePanel] User ${streamerId} stopped screen share`);

                setScreenSharers(prev => {
                    const newMap = new Map(prev);
                    newMap.delete(streamerId);
                    return newMap;
                });

                // Remove from selected streams if being watched
                deselectStream(streamerId);
            };

            // Register screen share listeners
            wsClient.on('ScreenShareStarted', onScreenShareStarted);
            wsClient.on('ScreenShareStopped', onScreenShareStopped);
            onScreenShareStartedRef.current = onScreenShareStarted;
            onScreenShareStoppedRef.current = onScreenShareStopped;

            // Set up callback for screen share streams - store per user
            const handleScreenShareStream = (userId: number, stream: MediaStream) => {
                console.log(`Got screen share stream from ${userId}`);
                setScreenSharers(prev => {
                    const newMap = new Map(prev);
                    const existing = newMap.get(userId);
                    if (existing) {
                        newMap.set(userId, { ...existing, stream });
                    } else {
                        newMap.set(userId, { username: `User ${userId}`, stream });
                    }
                    return newMap;
                });
            };
            webrtcManager.setOnScreenShareStream(handleScreenShareStream);
            sfuManager.setOnScreenShareStream(handleScreenShareStream);

            // Define camera event listeners
            const onCameraStarted = (msg: ServerMessage) => {
                const payload = msg.payload as { room_id: string; user: { id: number; username: string } };
                if (payload.room_id !== roomId) return;
                const user = payload.user;
                console.log(`[VoicePanel] User ${user.username} (${user.id}) started camera`);

                // Add to global camera users tracking
                globalCameraUsers.set(user.id, user.username);
                notifyStreamStateChange();
            };

            const onCameraStopped = (msg: ServerMessage) => {
                const payload = msg.payload as { room_id: string; user_id: number };
                if (payload.room_id !== roomId) return;
                const userId = payload.user_id;
                console.log(`[VoicePanel] User ${userId} stopped camera`);

                // Same liveness rule as StreamStopped: a sender's WS blip makes
                // the server broadcast CameraStopped while their LiveKit camera
                // publication is still live — tearing the tile down then loses
                // the feed permanently (no new TrackSubscribed fires). Genuine
                // camera-off unpublishes BEFORE sending CameraStop, and the
                // onCameraEnded callback below covers the unpublish race.
                if (sfuMode && sfuManager.hasCameraPublication(userId)) return;

                // Remove from global camera users tracking
                globalCameraUsers.delete(userId);
                globalCameraStreams.delete(userId);
                notifyStreamStateChange();
            };

            // Register camera listeners
            wsClient.on('CameraStarted', onCameraStarted);
            wsClient.on('CameraStopped', onCameraStopped);
            onCameraStartedRef.current = onCameraStarted;
            onCameraStoppedRef.current = onCameraStopped;

            // Set up callback for camera streams
            const handleCameraStream = (userId: number, stream: MediaStream) => {
                console.log(`[VoicePanel] Got camera stream from ${userId}`);
                const username = globalVoiceUsers.get(roomId)?.get(userId)?.username || `User ${userId}`;
                globalCameraUsers.set(userId, username);
                // Publish the feed so the voice-stage tile renders the video.
                globalCameraStreams.set(userId, stream);
                notifyStreamStateChange();
            };
            webrtcManager.setOnCameraStream(handleCameraStream);
            sfuManager.setOnCameraStream(handleCameraStream);
            // Authoritative SFU end-of-camera: the LiveKit unpublish. Covers
            // the case where CameraStopped arrived first and was skipped by
            // the liveness guard in onCameraStopped above.
            sfuManager.setOnCameraEnded((userId) => {
                globalCameraUsers.delete(userId);
                globalCameraStreams.delete(userId);
                notifyStreamStateChange();
            });

            const handlePeerDisconnected = (userId: number, terminal: boolean) => {
                console.log(`Peer ${userId} disconnected (terminal=${terminal})`);
                // A transient ICE blip must be a complete NO-OP. Everything
                // below is destructive and nothing recreates it on recovery:
                // the <audio> element is only ever built by onRemoteStream, and
                // a recovered connection fires no new ontrack — so tearing it
                // down here left the peer permanently silent to this listener.
                if (!terminal) return;
                const audio = document.getElementById(`audio-${userId}`);
                audio?.remove();
                // Drop any camera feed for the departed peer.
                globalCameraStreams.delete(userId);
                // Clean up voice detector for this user
                const cleanup = voiceDetectorCleanups.current.get(userId);
                if (cleanup) {
                    cleanup();
                    voiceDetectorCleanups.current.delete(userId);
                }
                setSpeakingUsers(prev => {
                    const newSet = new Set(prev);
                    newSet.delete(userId);
                    return newSet;
                });
                refreshVoiceUsersList();

                // SELF-HEAL for a sharer who vanished without a clean goodbye.
                // Their tile is otherwise only ever cleared by a WS event, and
                // an unclean disconnect (Wi-Fi off, sleep, power cut) produces
                // none — leaving a BLACK tile with a LIVE badge indefinitely.
                setScreenSharers(prev => {
                    if (!prev.has(userId)) return prev;
                    const next = new Map(prev);
                    next.delete(userId);
                    return next;
                });
                globalCameraUsers.delete(userId);
                // The global set is the only copy now (no component mirror to
                // resurrect from), so a plain deselect is safe and final.
                deselectStream(userId);
                notifyStreamStateChange();
            };
            webrtcManager.setOnPeerDisconnected(handlePeerDisconnected);
            sfuManager.setOnPeerDisconnected(handlePeerDisconnected);

            // AFK channel: hard-mute the mic so no audio is transmitted here
            // ("can't talk in AFK"). The track stays negotiated but sends
            // silence; toggleMute is blocked below so the user can't lift it.
            if (isAfkChannel) {
                webrtcManager.setAudioEnabled(false);
                setIsMuted(true);
            } else {
                // Arm the idle-move timer for a normal voice channel.
                resetInactivity();
                // Push-to-talk must not transmit between track acquisition and
                // the first render's gate effect — close the window here.
                applyMicGate();
            }

            // SFU channel: connect LiveKit as the media transport. The Puca
            // WS room (JoinRoom/StartStream above/below) stays — presence, voice
            // status, and conn-scoped relays (remote control) all depend on it.
            // Publishing the SAME mic track keeps mute (track.enabled) and the
            // noise-suppression pipeline working unchanged. Fail-closed: any
            // error here (capacity, no channel key, no insertable-streams
            // support) aborts the join — never a plaintext fallback.
            if (sfuMode) {
                sfuManager.setOnDisconnected(() => {
                    if (isInVoiceRef.current) {
                        console.log('[VoicePanel] SFU disconnected — leaving voice');
                        leaveVoiceRef.current();
                        onDisconnectRef.current?.();
                    }
                });
                // P2P INPUT over the SFU (R3): hand controlDc a publisher so
                // remote-control frames take the room's data path instead of
                // the WS relay. Same frames and same sealed-hello gate as the
                // mesh lanes — remoteControl never learns which pipe it is.
                setSfuControlSender((userId, frame) => sfuManager.publishControlFrame(userId, frame));
                const channelId = parseInt(roomId.replace(/^voice_/, ''), 10);
                const micTrack = localStream.getAudioTracks()[0] ?? null;
                await sfuManager.connect(channelId, micTrack);
            }

            // Broadcast that we joined
            wsClient.startStream(roomId);
            playJoinSound(); // Play join sound

            // CRITICAL: The JOINER initiates to everyone already in the room,
            // regardless of id order. Only we know our pcs are brand-new: on a
            // REJOIN, waiting for the lower id to call left the pair silent —
            // the other side's callUser found its old (stale) peer entry and
            // no-op'd, so no offer ever flowed. Our fresh offer also carries a
            // new connId, telling a peer that still holds a stale pc for us to
            // replace it. If the peer initiates too (lower-id StreamStarted
            // path), the double offer is ordinary glare, resolved by perfect-
            // negotiation politeness.
            if (!sfuMode) {
                const existingRoomUsers = globalVoiceUsers.get(roomId);
                if (existingRoomUsers) {
                    for (const [userId, _user] of existingRoomUsers) {
                        if (userId !== currentUserId) {
                            console.log(`[VoicePanel] Joining mesh — calling existing user ${userId}`);
                            webrtcManager.callUser(userId);
                        }
                    }
                }
            }

            refreshVoiceUsersList();

        } catch (err) {
            console.error('Failed to join voice:', err);

            // Tear down everything the join already acquired before it threw —
            // the mic track (was left live → OS mic indicator stayed on after a
            // "call at capacity" error), the WS room subscription, the six Block-B
            // listeners (each retry re-registered them → leaked handlers), the
            // roster entry and any SFU session. leaveVoice is idempotent and
            // clears isInVoice, so a retry starts from a clean slate.
            leaveVoiceRef.current();

            // Check if it's a permission denied error
            const error = err as Error;
            const isPermissionDenied = error.name === 'NotAllowedError' ||
                error.name === 'PermissionDeniedError' ||
                error.message?.includes('Permission denied') ||
                error.message?.includes('not allowed');

            if (isPermissionDenied) {
                setError('Microphone access was blocked.');
                setShowPermissionHelp(true);
            } else if (sfuMode && error.message) {
                // SFU join failures carry user-appropriate messages (call at
                // capacity, channel key unavailable, device unsupported).
                setError(error.message);
            } else {
                setError('Failed to access microphone. Please check permissions.');
            }

            setIsInVoice(false);
            isInVoiceRef.current = false;
        } finally {
            joiningRef.current = false;
            setIsConnecting(false);
            // An eviction RoomLeft arrived mid-join (see handleRoomLeft):
            // honor it now that the join's state writes are done. If the join
            // itself failed there's nothing to tear down — catch handled it.
            if (evictedWhileJoiningRef.current) {
                evictedWhileJoiningRef.current = false;
                if (isInVoiceRef.current) {
                    console.log('[VoicePanel] Eviction arrived during join — tearing down now');
                    leaveVoiceRef.current();
                    onDisconnectRef.current?.();
                }
            }
        }
    }, [roomId, currentUserId, currentUsername, refreshVoiceUsersList, isAfkChannel, resetInactivity, sfuMode, applyMicGate]);

    // Handle leaving voice
    // Apply the CURRENT noise mode to a live call: fresh mic through the new
    // pipeline, swapped into the mesh senders and (on SFU) republished. Also
    // the recovery path the audio-device watchdog below reuses — "restart the
    // mic through the current pipeline" is the same operation either way.
    // Returns the whole chain so the watchdog can coalesce restarts.
    const applyNoiseModeLive = useCallback(() => {
        if (!isInVoiceRef.current) return Promise.resolve();
        return webrtcManager.reapplyNoiseMode()
            .then(() => {
                // A mode change re-acquires the mic, so a listen-only user whose
                // device has since freed up now has a LIVE track — which
                // replaceMicTrack would publish while the UI still says
                // "nobody can hear you". Re-sync honestly instead of becoming a
                // silent hot mic.
                if (!webrtcManager.isListenOnly()) {
                    setListenOnly(prev => {
                        if (!prev) return prev;
                        setIsMuted(false);
                        setMicNotice(null);
                        broadcastStatus(false, isDeafenedRef.current);
                        return false;
                    });
                } else {
                    // The OTHER direction: the re-acquire found NO usable mic
                    // (device died mid-call with nothing to fall back to).
                    // Surface it honestly — roster shows muted, banner explains
                    // — instead of leaving a dead track behind healthy-looking
                    // UI. The device watchdog retries when a device returns.
                    setListenOnly(prev => {
                        if (prev) return prev;
                        setIsMuted(true);
                        setMicNotice(MIC_LOST_NOTICE);
                        broadcastStatus(true, isDeafenedRef.current);
                        return true;
                    });
                }
                // reapplyNoiseMode stops the old mic track and swaps a fresh
                // one into the mesh senders only. On an SFU call the LiveKit
                // publication would keep holding the ended track (→ silence to
                // the whole room), so re-publish the new track there too.
                if (sfuMode && sfuManager.connected) {
                    const newMic = webrtcManager
                        .getVideoStreamForPreview()?.getAudioTracks()[0];
                    if (newMic) return sfuManager.replaceMicTrack(newMic);
                }
            })
            .then(() => {
                // Re-assert the gate on the NEW track. reacquireAudioTrack
                // snapshots `enabled` from the old track BEFORE its awaits
                // (getUserMedia + an RNNoise wasm build — seconds), then stamps
                // that stale value onto the replacement. Any mute, unmute, PTT
                // press or release during that window was applied to a track
                // that gets thrown away, so without this the mic could come
                // back open while the UI says muted (or stay shut during a PTT
                // hold). applyMicGate reads the CURRENT state.
                applyMicGate();
            })
            .catch(err => console.warn('[VoicePanel] Failed to apply noise mode live:', err));
    }, [sfuMode, broadcastStatus, applyMicGate]);
    // Ref for the settingsChanged listener above, which is declared earlier in
    // the file (and deliberately mounted once).
    const applyNoiseModeLiveRef = useRef(applyNoiseModeLive);
    useEffect(() => { applyNoiseModeLiveRef.current = applyNoiseModeLive; }, [applyNoiseModeLive]);

    // The noise mode has TWO pickers — this panel's dropdown and Settings →
    // Voice — and one source of truth (noiseFilter). Both pickers call
    // changeNoiseModeLive(), which persists and fires NOISE_MODE_EVENT with
    // apply=true; this ONE listener re-syncs the dropdown and, if we are in
    // a call, swaps the mic through the new pipeline. Automatic downgrades
    // (setNoiseSuppressionMode from a graph-dead handler) fire apply=false:
    // sync only — the code that detected the death re-acquires itself.
    useEffect(() => {
        const onModeChange = (e: Event) => {
            const detail = (e as CustomEvent<NoiseModeChange>).detail;
            setNoiseMode(getNoiseSuppressionMode());
            if (detail?.apply) applyNoiseModeLiveRef.current();
        };
        window.addEventListener(NOISE_MODE_EVENT, onModeChange);
        return () => window.removeEventListener(NOISE_MODE_EVENT, onModeChange);
    }, []);

    // Re-announce our voice presence after a WS reconnect.
    //
    // The socket layer replays JoinRoom for every remembered room but NEVER
    // StartStream — and `streamers` is what voice presence actually is on the
    // server (it backs the voice roster and the REST voice-users snapshot). So
    // after any blip we were a room member the server no longer counted as
    // being in voice: once the dead connection was reaped, everyone was told
    // we left, our peer connections were closed, and nothing ever re-added us.
    // Re-stating it also re-claims the media against the NEW connection, so
    // reaping the old one releases only what it still held.
    useEffect(() => {
        const onReconnected = () => {
            if (!isInVoiceRef.current) return;
            // Don't narrate the replay that follows.
            speechMuteUntilRef.current = Date.now() + 3000;
            wsClient.startStream(roomId);
            if (isScreenSharingRef.current) {
                wsClient.startScreenShare(roomId, webrtcManager.getScreenShareStreamForPreview()?.id);
            }
            if (isCameraOnRef.current) wsClient.startCamera(roomId);
            // Re-state mute/deafen too: the StreamStarted echo above used to
            // wipe our own flags in everyone's roster (ours included), and a
            // toggle sent while the socket was down was dropped outright.
            // Short delay so it lands after peers have applied that echo.
            const statusTimer = setTimeout(() => {
                rebroadcastTimersRef.current.delete(statusTimer);
                if (!isInVoiceRef.current) return;
                broadcastStatusRef.current(isMutedRef.current, isDeafenedRef.current);
            }, 600);
            rebroadcastTimersRef.current.add(statusTimer);
        };
        window.addEventListener('wsConnected', onReconnected);
        return () => window.removeEventListener('wsConnected', onReconnected);
    }, [roomId]);

    // A noise-suppression graph died (worklet wasm crash, or the liveness
    // watchdog caught it emitting pure silence against live speech): fall back
    // to Standard so the user KEEPS TRANSMITTING, and say so.
    useEffect(() => {
        const onDead = () => {
            const mode = getNoiseSuppressionMode();
            if (mode !== 'rnnoise' && mode !== 'deepfilter') return; // stale event
            // Cascade one tier at a time: DeepFilter's failure says nothing
            // about RNNoise (different thread, different wasm), so a DF death
            // (usually "this device can't keep up") lands on the lighter ML
            // tier; an RNNoise death lands on Standard. A dead RNNoise fallback
            // then cascades again via this same handler.
            const fallback: NoiseSuppressionMode = mode === 'deepfilter' ? 'rnnoise' : 'standard';
            console.error(`[VoicePanel] Noise-suppression graph dead — falling back from ${mode} to ${fallback}`);
            setNoiseMode(fallback);
            // Session-only: a heuristic must not silently rewrite the user's
            // saved preference. Next launch retries their mode and falls back
            // again if it really is broken here.
            setNoiseSuppressionMode(fallback, false);
            setMicNotice(mode === 'deepfilter'
                ? 'DeepFilter can’t keep up on this device — switched to RNNoise for this call.'
                : 'RNNoise isn’t working on this device — switched to Standard noise suppression for this call so others can hear you.');
            applyNoiseModeLive();
        };
        window.addEventListener('sovereign:noise-graph-dead', onDead);
        return () => window.removeEventListener('sovereign:noise-graph-dead', onDead);
    }, [applyNoiseModeLive]);

    // The graph failed to BUILD (import/wasm/addModule threw) rather than dying
    // later. media.ts has already downgraded the mode and re-captured the mic
    // with native NS, so this only has to tell the user — and it needs its own
    // event, because the handler above bails out when the mode is no longer an
    // ML one, which it no longer is by the time that work is done.
    useEffect(() => {
        const onFallback = () => {
            setMicNotice('Noise suppression couldn’t start on this device — using Standard for this session.');
            // Resync the picker to module truth: media.ts has already
            // downgraded the mode (session-only), and a select still showing
            // the ML tier would claim a suppressor that never processed a
            // sample is running.
            setNoiseMode(getNoiseSuppressionMode());
        };
        window.addEventListener('sovereign:noise-fallback', onFallback);
        return () => window.removeEventListener('sovereign:noise-fallback', onFallback);
    }, []);

    // ── Audio-device watchdog ────────────────────────────────────────────
    // A Bluetooth headset walking out of range kills the call's audio both
    // ways and nothing above notices: the raw capture track dies inside the
    // noise graph (the PUBLISHED Web Audio track keeps emitting silence
    // forever), and the <audio> sinks point at a device that no longer
    // exists. Leaving and rejoining was the only fix. Three signals feed one
    // recovery:
    //   - 'sovereign:mic-device-lost' (media.ts): the raw track ended, or sat
    //     muted for 3 s → restart the mic through the current pipeline NOW
    //     (getMicStream falls back to the OS default, or degrades to
    //     listen-only when nothing can be opened).
    //   - devicechange: a device (re)appeared or vanished → re-route every
    //     playing element to the chosen sink, and restart the mic if we are
    //     listen-only, holding a dead/muted track, or holding the WRONG
    //     device (the selected one returned, or the OS default moved back to
    //     the headset — chase it; Chromium never re-points a live capture).
    //   - visibilitychange → visible: mobile can park capture and swallow
    //     device events while backgrounded; re-evaluate on return.
    // Restarts reuse applyNoiseModeLive (re-acquire → replaceTrack on every
    // mesh sender → SFU republish → re-assert the mute/PTT gate) and are
    // coalesced: one in flight, at most one queued.
    useEffect(() => {
        let debounce: ReturnType<typeof setTimeout> | null = null;
        let running = false;
        let queued = false;
        let lastMuteRestart = 0;
        const restartMic = () => {
            if (!isInVoiceRef.current) return;
            if (running) { queued = true; return; }
            running = true;
            Promise.resolve(applyNoiseModeLiveRef.current()).finally(() => {
                running = false;
                if (queued) { queued = false; restartMic(); }
            });
        };
        const onMicLost = (e: Event) => {
            const kind = (e as CustomEvent<{ kind?: string }>).detail?.kind;
            if (kind === 'muted') {
                // A wedged-but-still-registered device can hand back another
                // born-muted track; don't re-open it in a tight loop. Real
                // removals fire 'ended' or devicechange, which stay
                // unthrottled.
                const now = Date.now();
                if (now - lastMuteRestart < 15000) return;
                lastMuteRestart = now;
            }
            restartMic();
        };
        const evaluate = async () => {
            if (!isInVoiceRef.current) return;
            // OUTPUT half: chase the chosen sink. applyOutputDevice routes
            // back to it when it reappears and falls back to the default when
            // it is gone — either way the element keeps playing somewhere.
            document.querySelectorAll('audio[id^="audio-"]').forEach(el =>
                applyOutputDevice(el as HTMLAudioElement));
            // INPUT half.
            const state = webrtcManager.rawMicState();
            let restart = webrtcManager.isListenOnly() || !state || state.ended || state.muted;
            if (!restart && state) {
                try {
                    const inputs = (await navigator.mediaDevices.enumerateDevices())
                        .filter(d => d.kind === 'audioinput');
                    const selected = selectedInputDeviceId();
                    if (selected) {
                        // The device the user chose is back, but we are still
                        // holding the fallback we degraded to while it was away.
                        restart = !!state.deviceId && state.deviceId !== selected
                            && inputs.some(d => d.deviceId === selected);
                    } else if (state.deviceId && state.deviceId !== 'default' && state.groupId) {
                        // On "Default": the OS default moved (the headset came
                        // back and reclaimed it) while our capture stayed put.
                        // Chromium's 'default' pseudo-entry shares its groupId
                        // with the concrete device it aliases.
                        const alias = inputs.find(d => d.deviceId === 'default');
                        const concrete = alias && inputs.find(d =>
                            d.deviceId !== 'default' && d.groupId === alias.groupId);
                        restart = !!concrete && concrete.deviceId !== state.deviceId;
                    }
                } catch { /* can't enumerate — nothing to chase */ }
            }
            if (restart) restartMic();
        };
        const onDeviceChange = () => {
            if (!isInVoiceRef.current) return;
            if (debounce) clearTimeout(debounce);
            // Windows fires several devicechange events per Bluetooth
            // (dis)connect; let the churn settle, then act once.
            debounce = setTimeout(() => { debounce = null; void evaluate(); }, 800);
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible') onDeviceChange();
        };
        window.addEventListener('sovereign:mic-device-lost', onMicLost);
        navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('sovereign:mic-device-lost', onMicLost);
            navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
            document.removeEventListener('visibilitychange', onVisible);
            if (debounce) clearTimeout(debounce);
        };
    }, []);

    const leaveVoice = useCallback(() => {
        clearInactivity();
        // The clip ring is tied to THIS call's roster — hanging up wipes it.
        if (getReplayState().phase !== 'idle') void disarmClipBuffer('leave-voice');
        playLeaveSound(); // Play leave sound
        // End our own share EXPLICITLY and first. leaveVoice used to rely
        // entirely on the StopStream broadcast and the server's room teardown —
        // but wsClient.send is a silent no-op on a closed socket, so a hang-up
        // caused BY the connection dying (or an SFU-disconnect auto-leave, or a
        // forced eviction) told nobody, and viewers kept a frozen tile.
        if (isScreenSharingRef.current) {
            void sfuManager.stopScreenShare();
            webrtcManager.stopScreenShare();
            wsClient.stopScreenShare(roomId); // must precede leaveRoom
            setIsScreenSharing(false);
        }
        setCurrentStreamingUser(null);
        webrtcManager.closeAll();
        // No-op when the call wasn't SFU; prevents a dangling LiveKit session
        // (and its capacity slot) when it was.
        sfuManager.setOnDisconnected(null);
        // The publisher dies with the room: a frame sent into a disconnected
        // room is silently lost, and the relay must take over instead.
        setSfuControlSender(null);
        void sfuManager.disconnect();
        // Every media stop MUST precede leaveRoom: once we're out of the room
        // the server's membership gate refuses them, so the event is never
        // broadcast and everyone keeps a ghost tile. (stopCamera used to run
        // ~40 lines below this, i.e. after we'd already left.)
        if (isCameraOnRef.current) wsClient.stopCamera(roomId);
        wsClient.stopStream(roomId);
        wsClient.leaveRoom(roomId); // Leave the WebSocket room

        // Remove listeners using refs
        if (onStreamStartedRef.current) {
            wsClient.off('StreamStarted', onStreamStartedRef.current);
            onStreamStartedRef.current = null;
        }
        if (onStreamStoppedRef.current) {
            wsClient.off('StreamStopped', onStreamStoppedRef.current);
            onStreamStoppedRef.current = null;
        }
        if (onScreenShareStartedRef.current) {
            wsClient.off('ScreenShareStarted', onScreenShareStartedRef.current);
            onScreenShareStartedRef.current = null;
        }
        if (onScreenShareStoppedRef.current) {
            wsClient.off('ScreenShareStopped', onScreenShareStoppedRef.current);
            onScreenShareStoppedRef.current = null;
        }
        if (onCameraStartedRef.current) {
            wsClient.off('CameraStarted', onCameraStartedRef.current);
            onCameraStartedRef.current = null;
        }
        if (onCameraStoppedRef.current) {
            wsClient.off('CameraStopped', onCameraStoppedRef.current);
            onCameraStoppedRef.current = null;
        }

        globalVoiceUsers.get(roomId)?.delete(currentUserId);
        announcedRef.current.clear(); // a rejoin re-seeds from scratch
        // Other users' roster entries survive for the sidebar, so their
        // connecting chips must be cleared explicitly, not just the set.
        for (const id of pendingJoinsRef.current.clear()) setConnecting(id, false);
        stopPendingTimer();
        document.querySelectorAll('[id^="audio-"]').forEach(el => el.remove());

        // Clean up all voice activity detectors (incl. the -1 silence sentinel)
        voiceDetectorCleanups.current.forEach(cleanup => cleanup());
        voiceDetectorCleanups.current.clear();
        setSpeakingUsers(new Set());
        setMicNotice(null);

        // Local camera teardown (the WS notify already went out above, before
        // we left the room).
        setIsCameraOn(false);
        globalCameraUsers.delete(currentUserId);
        globalCameraStreams.clear(); // drop everyone's camera feeds (ours included)

        setIsInVoice(false);
        isInVoiceRef.current = false;
        setIsMuted(false);
        setIsDeafened(false);
        setListenOnly(false); // a rejoin retries the microphone
        refreshVoiceUsersList();

        // Clear all stream viewing state - this will switch view back to chat
        clearAllStreams(); // wipes globalSelectedStreams/StreamData/ScreenSharers
        // clearAllStreams only wipes the GLOBAL maps. Without this the
        // component's own screenSharers state survives a leave that doesn't
        // unmount the panel (SFU auto-leave, eviction) and the sync effect
        // immediately republishes every ghost back into the global maps.
        setScreenSharers(new Map());
        // Same reasoning as announcedRef above: a rejoin must re-seed from
        // scratch, or every share still running when we left would be silently
        // treated as a replay and never chime or open a tile.
        sharingAnnouncedRef.current.clear();
    }, [roomId, currentUserId, refreshVoiceUsersList, clearInactivity, setConnecting, stopPendingTimer]);

    // Keep the eviction handler's teardown pointer fresh (see RoomLeft handler).
    useEffect(() => { leaveVoiceRef.current = leaveVoice; }, [leaveVoice]);

    // Auto-join voice when the panel mounts (user clicked a voice channel)
    useEffect(() => {
        // Auto-join when mounted
        if (!isInVoice && !isConnecting) {
            joinVoice();
        }

        // Stable ref object (identity never changes; only its contents mutate) —
        // captured here so the cleanup can drain its FINAL contents at unmount.
        const vadCleanups = voiceDetectorCleanups.current;

        // Auto-leave when unmounted (user clicked disconnect or switched channels)
        return () => {
            if (isInVoiceRef.current) {
                // A channel switch (incl. VoiceMoved) remounts the panel without
                // leaveVoice; the ring must not span two rooms' rosters.
                if (getReplayState().phase !== 'idle') void disarmClipBuffer('channel-switch');
                webrtcManager.closeAll();
                // A channel switch remounts this panel WITHOUT leaveVoice — the
                // LiveKit session must die here too, or it lingers publishing
                // the mic (ghost sessions = users hearing themselves).
                sfuManager.setOnDisconnected(null);
                void sfuManager.disconnect();
                // Same ordering rule as leaveVoice: announce every media stop
                // BEFORE leaving, or the server's membership gate drops them
                // and the room keeps a ghost tile. This is the channel-switch
                // path, which remounts the panel without running leaveVoice.
                if (isScreenSharingRef.current) {
                    wsClient.stopScreenShare(roomId);
                    // End any live remote-control session while we can still
                    // reach the viewer: resetRemoteControl sends ControlEnd,
                    // which the server relays only while we share a room — so
                    // this MUST run before leaveRoom. Without it a granted
                    // controller kept injecting input after the share died.
                    window.dispatchEvent(new CustomEvent('voiceControlReset'));
                }
                if (isCameraOnRef.current) wsClient.stopCamera(roomId);
                wsClient.stopStream(roomId);
                wsClient.leaveRoom(roomId); // Leave the WebSocket room
                // We are OUT as of the LeaveRoom above. Flip the ref so no
                // latecomer (async camera/share paths, stray timers) sends a
                // media mutation for a room we already left.
                isInVoiceRef.current = false;
                globalVoiceUsers.get(roomId)?.delete(currentUserId);
                globalCameraStreams.clear(); // stage tiles die with the room
                document.querySelectorAll('[id^="audio-"]').forEach(el => el.remove());
                // Update the sidebar so this user stops showing in the old channel.
                notifyVoiceUsersChange();
            }
            // ALWAYS detach the joinVoice (Block B) WS listeners on unmount, even
            // if leaveVoice() didn't run (a channel switch remounts this panel via
            // its key without calling leaveVoice). Without this, every remount
            // permanently leaked 6 handlers that keep firing — and re-initiating
            // calls — forever. off() is a no-op when the ref is already cleared.
            if (onStreamStartedRef.current) { wsClient.off('StreamStarted', onStreamStartedRef.current); onStreamStartedRef.current = null; }
            if (onStreamStoppedRef.current) { wsClient.off('StreamStopped', onStreamStoppedRef.current); onStreamStoppedRef.current = null; }
            if (onScreenShareStartedRef.current) { wsClient.off('ScreenShareStarted', onScreenShareStartedRef.current); onScreenShareStartedRef.current = null; }
            if (onScreenShareStoppedRef.current) { wsClient.off('ScreenShareStopped', onScreenShareStoppedRef.current); onScreenShareStoppedRef.current = null; }
            if (onCameraStartedRef.current) { wsClient.off('CameraStarted', onCameraStartedRef.current); onCameraStartedRef.current = null; }
            if (onCameraStoppedRef.current) { wsClient.off('CameraStopped', onCameraStoppedRef.current); onCameraStoppedRef.current = null; }
            // Tear down any remaining VAD detectors + their intervals.
            vadCleanups.forEach(cleanup => cleanup());
            vadCleanups.clear();
            // Unconditional, like the (removed) legacy unmount effect: a stale
            // currentStreamingUserId is remote control's final host-side gate
            // (remoteControl.ts handleIncomingInput) — leaving it set after a
            // switch-while-sharing let a granted controller keep injecting.
            setCurrentStreamingUser(null);
        };
        // Only run on mount/unmount, not on every state change
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomId]);

    // Bind camera stream to preview when camera is on
    useEffect(() => {
        if (isCameraOn && cameraPreviewRef.current) {
            // Use a small delay to allow toggleVideo to complete first
            // The localStream already has the video track added by toggleVideo
            const timer = setTimeout(() => {
                const stream = webrtcManager.getVideoStreamForPreview();
                if (cameraPreviewRef.current && stream) {
                    cameraPreviewRef.current.srcObject = stream;
                }
            }, 100);
            return () => clearTimeout(timer);
        } else if (!isCameraOn && cameraPreviewRef.current) {
            cameraPreviewRef.current.srcObject = null;
        }
    }, [isCameraOn]);

    // Handle mute toggle
    const toggleMute = useCallback(() => {
        // AFK channels are talk-disabled: the mic stays hard-muted here.
        // Listen-only has no track to toggle.
        if (isAfkChannel || listenOnly) return;
        // Deafen force-mutes and DISABLES the mute button — the hotkey path
        // (Ctrl+M in-app, or the desktop-global feed) must match it, or it
        // opens the mic while deafened: a transmitting-but-deaf state the UI
        // treats as impossible and offers no button to undo. But a silent
        // no-op reads as "the hotkey is broken" (field report) — say why.
        if (isDeafened) {
            setMuteNotice("You're deafened — undeafen to unmute.");
            return;
        }
        resetInactivity(); // toggling mute counts as activity
        const newMuted = !isMuted;
        // Through the gate, not straight to the track: unmuting in push-to-talk
        // must NOT open the mic — it only re-arms the hold key.
        applyMicGate(newMuted);
        setIsMuted(newMuted);
        broadcastStatus(newMuted, isDeafened);

        // Play appropriate sound
        if (newMuted) {
            playMuteSound();
        } else {
            playUnmuteSound();
        }
    }, [isMuted, isDeafened, broadcastStatus, isAfkChannel, resetInactivity, listenOnly, applyMicGate]);

    // Tell the room we're muted once we're actually in voice. Kept as an
    // effect (rather than inline in joinVoice) so it runs after the join has
    // fully committed — broadcastStatus now guards on isInVoiceRef, which
    // joinVoice flips synchronously, so either shape would send; the effect
    // is simply the later, safer moment.
    useEffect(() => {
        if (isInVoice && listenOnly) {
            setIsMuted(true);
            broadcastStatus(true, isDeafened);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on entry to listen-only, not on every deafen change
    }, [isInVoice, listenOnly]);

    // Hold-key registration + gate normalization for the current input mode.
    // Registering through the shared hotkey registry (not a local listener)
    // means the desktop native hook can feed the same actions later. The
    // binding is read per-event, so a rebind in Settings applies live.
    useEffect(() => {
        if (!isInVoice || isAfkChannel || listenOnly) return;
        // Entering (or switching) a mode normalizes the track: push-to-talk
        // closes the mic until held, voice-activity/push-to-mute reopen it
        // (unless explicitly muted).
        applyMicGate();
        if (voiceInputMode === 'open') return;
        const action = voiceInputMode === 'pushToTalk' ? 'voice.ptt' : 'voice.ptm';
        const bindingOf = voiceInputMode === 'pushToTalk'
            ? () => loadSettings().pttBinding
            : () => loadSettings().ptmBinding;
        registerHold(action, bindingOf, {
            onDown: () => { holdKeyDownRef.current = true; setHoldKeyDown(true); applyMicGate(); },
            // unregisterHold fires onUp for a held key, so leaving voice (or
            // switching modes) mid-press releases cleanly through this path.
            onUp: () => { holdKeyDownRef.current = false; setHoldKeyDown(false); applyMicGate(); },
        });
        return () => unregisterHold(action);
    }, [isInVoice, voiceInputMode, isAfkChannel, listenOnly, applyMicGate]);

    // Toggle Mute / Toggle Deafen shortcuts (Keybinds tab). Registered only
    // while in voice — outside a call they no-op by not existing.
    const toggleMuteRef = useRef<() => void>(() => { });
    const toggleDeafenRef = useRef<() => void>(() => { });
    useEffect(() => {
        if (!isInVoice) return;
        registerPress('voice.toggleMute', () => loadSettings().toggleMuteBinding, () => toggleMuteRef.current());
        registerPress('voice.toggleDeafen', () => loadSettings().toggleDeafenBinding, () => toggleDeafenRef.current());
        return () => {
            unregisterPress('voice.toggleMute');
            unregisterPress('voice.toggleDeafen');
        };
    }, [isInVoice]);

    /** What the feed was last asked to watch — for __pucaHotkeysDebug.snapshot(). */
    const lastNativeWatchRef = useRef<{ ids: string[]; keys: number[]; at: number } | null>(null);
    // Lend the diag the inputs the feed decision is made from. Refs, not
    // state, so this stays fresh with [] deps — and so a snapshot taken while
    // the feed is DOWN still says why. That is the case that matters: every
    // cause of "hotkeys die when Púca loses focus" found so far was this
    // decision producing an empty list, with nothing recording that it had.
    useEffect(() => {
        setNativeFeedHost(() => {
            const s = loadSettings();
            return {
                isInVoice: isInVoiceRef.current,
                isAfkChannel: isAfkChannelRef.current,
                listenOnly: listenOnlyRef.current,
                voiceInputMode: voiceInputModeRef.current,
                clipArmed: isBufferingRef.current,
                globalVoiceHotkeys: s.globalVoiceHotkeys === true,
                voiceBindsUserSet: s.voiceBindsUserSet ?? {},
                bindings: {
                    toggleMute: s.toggleMuteBinding,
                    toggleDeafen: s.toggleDeafenBinding,
                    ptt: s.pttBinding,
                    ptm: s.ptmBinding,
                    saveClip: s.saveClipBinding,
                },
                lastComputed: lastNativeWatchRef.current,
            };
        });
        return () => setNativeFeedHost(null);
    }, []);

    // DESKTOP-GLOBAL feed: while in a call, the native WH_KEYBOARD_LL hook
    // reports the bound voice keys system-wide, so PTT/PTM and mute/deafen
    // keep working while a fullscreen game has focus. Scoped to the voice
    // actions only, and re-synced on every settings save so a rebind swaps
    // the watch list live. No-op on web.
    //
    // WHICH keys qualify is decided in api/hotkeyScope.ts — one predicate,
    // shared with the Keybinds tab, so the row's "works from other apps" and
    // the hook's watch list cannot disagree. (The rule used to live here and
    // inferred "the user chose this" from the bind differing from the shipped
    // default; that reclassified a deliberate choice of the same combination
    // as untouched, and the feed silently watched nothing.)
    useEffect(() => {
        if (!isInVoice || !isTauri()) return;
        // Listen-only / AFK: no mic, so no mic hotkeys — but the save-clip key
        // still works while the buffer is armed (a system-audio-only clip).
        const micKeys = !isAfkChannel && !listenOnly;
        const sync = () => {
            const { ids, keys } = computeNativeWatch(loadSettings(), {
                micKeys,
                voiceInputMode: voiceInputModeRef.current,
                // In this effect's deps, so arming re-syncs the watch list
                // immediately (a settings save is not something the user does
                // mid-match).
                clipArmed,
            });
            lastNativeWatchRef.current = { ids, keys, at: Math.round(performance.now()) };
            // Nothing qualifies: the feed is torn down rather than left idle.
            // Named, because a silent stop here and "never started" used to
            // be indistinguishable from outside.
            if (ids.length === 0) { void stopNativeFeed('sync: no bind qualifies for system-wide'); return; }
            void startNativeFeed(ids, keys);
        };
        sync();
        window.addEventListener('settingsChanged', sync);
        return () => {
            window.removeEventListener('settingsChanged', sync);
            void stopNativeFeed('voice hotkey effect cleanup');
        };
    }, [isInVoice, voiceInputMode, isAfkChannel, listenOnly, clipArmed]);

    // React to Settings changes mid-call: input-mode swaps apply immediately;
    // mic CONSTRAINT changes (echo cancellation, native noise suppression,
    // auto gain) and a gain slider that now needs a graph re-acquire the mic
    // through the live-swap path. Debounced — a slider drag saves settings on
    // every tick, and one swap at the end is enough. A live gain stage is
    // adjusted by noiseFilter's own listener without any re-acquire.
    const audioConstraintSigRef = useRef('');
    const dfTuningSigRef = useRef(false);
    const reacquireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        const sigOf = (s: ReturnType<typeof loadSettings>) =>
            JSON.stringify([s.echoCancellation, s.noiseSuppression, s.autoGainControl, s.inputDeviceId]);
        audioConstraintSigRef.current = sigOf(loadSettings());
        dfTuningSigRef.current = loadSettings().deepFilterPostFilter;
        const onSettings = () => {
            const s = loadSettings();
            setVoiceInputMode(s.voiceInputMode ?? 'open');
            const sig = sigOf(s);
            const constraintsChanged = sig !== audioConstraintSigRef.current;
            audioConstraintSigRef.current = sig;
            // deepFilterPostFilter is a DeepFilter-worker CONSTRUCTOR argument,
            // so flipping it needs the same graph re-acquire as a constraint
            // change — but ONLY while DeepFilter is the live mode. It is
            // tracked apart from the constraint sig because in every other
            // mode the value is never read, and a re-acquire there is a
            // room-audible track swap for nothing (worse: the listen-only
            // unwind in applyNoiseModeLive could flip a listen-only user live
            // off the back of an unrelated checkbox). A toggle made in another
            // mode is picked up for free when the user switches to DeepFilter,
            // because the mode switch rebuilds the graph anyway.
            const dfTuningChanged = s.deepFilterPostFilter !== dfTuningSigRef.current
                && getNoiseSuppressionMode() === 'deepfilter';
            dfTuningSigRef.current = s.deepFilterPostFilter;
            // Gain needs a graph it doesn't have (was 1.0 at join in a native
            // mode, slider moved since).
            const gainNeedsGraph = inputGain() !== 1 && !hasLiveGainStage();
            if (!isInVoiceRef.current || (!constraintsChanged && !dfTuningChanged && !gainNeedsGraph)) return;
            if (reacquireTimerRef.current) clearTimeout(reacquireTimerRef.current);
            reacquireTimerRef.current = setTimeout(() => {
                reacquireTimerRef.current = null;
                applyNoiseModeLiveRef.current();
            }, 600);
        };
        window.addEventListener('settingsChanged', onSettings);
        return () => {
            window.removeEventListener('settingsChanged', onSettings);
            if (reacquireTimerRef.current) clearTimeout(reacquireTimerRef.current);
        };
    }, []);


    // Handle deafen toggle
    const toggleDeafen = useCallback(() => {
        const newDeafened = !isDeafened;
        setIsDeafened(newDeafened);

        // When deafened, also mute mic
        if (newDeafened && !isMuted) {
            applyMicGate(true);
            setIsMuted(true);
        }

        // Mute all incoming voice audio. Deafen means "stop hearing people's
        // VOICE" — screen-share/stream audio is deliberately left alone (it
        // plays through StreamStage / StreamPip, not these elements), so you
        // can deafen the chatter and still hear the game. Per-stream mute and
        // volume remain the way to silence a stream.
        document.querySelectorAll('[id^="audio-"]').forEach((el) => {
            (el as HTMLAudioElement).muted = newDeafened;
        });

        broadcastStatus(newDeafened || isMuted, newDeafened);

        // Play appropriate sound
        if (newDeafened) {
            playDeafenSound();
        } else {
            playUndeafenSound();
        }
    }, [isDeafened, isMuted, broadcastStatus, applyMicGate]);
    // Keep the shortcut refs pointing at the freshest closures (the press
    // registrations above are mounted once per call).
    useEffect(() => { toggleMuteRef.current = toggleMute; }, [toggleMute]);
    useEffect(() => { toggleDeafenRef.current = toggleDeafen; }, [toggleDeafen]);

    // PiP drag handlers (touch for mobile)
    const handlePipTouchStart = useCallback((e: React.TouchEvent) => {
        const touch = e.touches[0];
        dragStartRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            startX: pipPosition.x,
            startY: pipPosition.y
        };
        setIsDragging(true);
    }, [pipPosition]);

    const handlePipTouchMove = useCallback((e: React.TouchEvent) => {
        if (!isDragging) return;
        e.preventDefault();
        const touch = e.touches[0];
        const deltaX = touch.clientX - dragStartRef.current.x;
        const deltaY = touch.clientY - dragStartRef.current.y;

        const newX = Math.max(0, Math.min(window.innerWidth - 150, dragStartRef.current.startX + deltaX));
        const newY = Math.max(0, Math.min(window.innerHeight - 200, dragStartRef.current.startY + deltaY));

        setPipPosition({ x: newX, y: newY });
    }, [isDragging]);

    const handlePipTouchEnd = useCallback(() => {
        setIsDragging(false);
    }, []);

    // PiP drag handlers (mouse for desktop)
    const handlePipMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragStartRef.current = {
            x: e.clientX,
            y: e.clientY,
            startX: pipPosition.x,
            startY: pipPosition.y
        };
        setIsDragging(true);
    }, [pipPosition]);

    useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e: MouseEvent) => {
            const deltaX = e.clientX - dragStartRef.current.x;
            const deltaY = e.clientY - dragStartRef.current.y;

            const newX = Math.max(0, Math.min(window.innerWidth - 150, dragStartRef.current.startX + deltaX));
            const newY = Math.max(0, Math.min(window.innerHeight - 200, dragStartRef.current.startY + deltaY));

            setPipPosition({ x: newX, y: newY });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    const handlePipClick = useCallback(() => {
        if (isDragging) return; // Don't handle click if we were dragging

        if (showPipOptions) {
            // Second click - go fullscreen
            setIsFullscreen(true);
            setShowPipOptions(false);
        } else {
            // First click - show options
            setShowPipOptions(true);
            // Auto-hide options after 3 seconds
            setTimeout(() => setShowPipOptions(false), 3000);
        }
    }, [isDragging, showPipOptions]);

    const handleFlipCamera = useCallback(async () => {
        try {
            await webrtcManager.switchCamera('environment'); // Toggle facing mode
            // switchCamera stops the old video track (mesh-only replaceTrack); on
            // an SFU call, re-publish the new camera track so it doesn't go dark.
            if (sfuMode && sfuManager.connected) {
                const newCam = webrtcManager.getVideoStreamForPreview()?.getVideoTracks()[0];
                if (newCam) await sfuManager.replaceCameraTrack(newCam);
            }
            setShowPipOptions(false);
            // Keep the stage tile on the live stream (switchCamera may mint a
            // fresh MediaStream object for the new facing mode).
            const fresh = webrtcManager.getVideoStreamForPreview();
            if (fresh && globalCameraStreams.get(currentUserId) !== fresh) {
                globalCameraStreams.set(currentUserId, fresh);
                notifyStreamStateChange();
            }
        } catch (err) {
            console.error('Failed to flip camera:', err);
        }
    }, [sfuMode, currentUserId]);

    /**
     * The ONE on/off path for the local camera. The main toggle, the PiP
     * "Close" button and the fullscreen "Turn Off Camera" button must all go
     * through here: the side buttons used to call only toggleVideo(false), so
     * on SFU calls the camera KEPT PUBLISHING to LiveKit and peers kept the
     * icon (and the video) until the user left — a ghost camera.
     */
    const setCameraEnabled = useCallback(async (on: boolean) => {
        await webrtcManager.toggleVideo(on);
        // The camera-permission prompt can hold the await open indefinitely.
        // If we left voice (or switched channels) meanwhile, bail BEFORE the
        // SFU block: getLocalStream would RE-ACQUIRE a hot microphone into a
        // call that no longer exists. toggleVideo(false) releases the camera
        // (media.toggleVideo itself stops a track acquired after teardown).
        if (!isInVoiceRef.current) {
            if (on) await webrtcManager.toggleVideo(false);
            return;
        }
        if (sfuMode) {
            if (on) {
                const camTrack = (await webrtcManager.getLocalStream(true, false)).getVideoTracks()[0];
                if (camTrack) await sfuManager.publishCamera(camTrack);
            } else {
                await sfuManager.unpublishCamera();
            }
        }
        // Second check: the SFU publish awaits yield too. Announcing into the
        // old room would be rejected by the server's membership gate —
        // release anything acquired/published and bail.
        if (!isInVoiceRef.current) {
            if (on) {
                await webrtcManager.toggleVideo(false);
                if (sfuMode) await sfuManager.unpublishCamera();
            }
            return;
        }
        setIsCameraOn(on);
        if (on) {
            globalCameraUsers.set(currentUserId, currentUsername);
            // Only publish a stream that actually carries video: binding an
            // audio-only stream would blank the tile (black video, no avatar).
            const stream = webrtcManager.getVideoStreamForPreview();
            if (stream && stream.getVideoTracks().some(t => t.readyState === 'live')) {
                globalCameraStreams.set(currentUserId, stream);
            }
            wsClient.startCamera(roomId);
        } else {
            globalCameraUsers.delete(currentUserId);
            globalCameraStreams.delete(currentUserId);
            wsClient.stopCamera(roomId);
        }
        // Notify sidebar/stage to update camera icons + tiles
        notifyStreamStateChange();
    }, [sfuMode, roomId, currentUserId, currentUsername]);

    // Function to stop own screen sharing - callable from StreamStage via global callback
    const stopMyScreenShare = useCallback(() => {
        if (!isScreenSharing) return;

        void sfuManager.stopScreenShare(); // no-op on mesh calls
        webrtcManager.stopScreenShare();
        wsClient.stopScreenShare(roomId);
        setIsScreenSharing(false);
        setCurrentStreamingUser(null);

        // Remove own stream from screenSharers
        setScreenSharers(prev => {
            const newMap = new Map(prev);
            newMap.delete(currentUserId);
            return newMap;
        });

        // Clear stream viewing state - this will switch view back to chat
        clearAllStreams();
    }, [isScreenSharing, roomId, currentUserId]);

    // Register the stop screen share callback when component mounts. The
    // manager's onScreenShareEnded fires when the share ends on its own
    // (shared window closed / picker's stop button) so the full stop flow
    // (WS broadcast + state) runs, not just media teardown.
    useEffect(() => {
        registerStopScreenShareCallback(stopMyScreenShare);
        webrtcManager.setOnScreenShareEnded(stopMyScreenShare);
        return () => {
            registerStopScreenShareCallback(() => { });
            webrtcManager.setOnScreenShareEnded(null);
        };
    }, [stopMyScreenShare]);

    // NOTE: an older duplicate unmount-cleanup effect lived here. It re-sent
    // wsClient.stopStream AFTER the mount effect's cleanup above had already
    // sent every media stop followed by leaveRoom (React runs unmount cleanups
    // in mount order), so the server rejected it with "Not in this room" —
    // surfaced as a blocking alert on EVERY channel switch. The mount effect's
    // cleanup already does the entire teardown (closeAll, stops, leaveRoom,
    // roster + audio-element removal); VoicePanel always remounts on a switch
    // (keyed by channel id in Chat.tsx), so nothing else ran this path.

    // Human-readable explanation of why a call is not (fully) end-to-end
    // encrypted, per peer. Shown in the (i) tooltip next to the E2EE badge.
    const nameFor = (userId: number) => globalVoiceUsers.get(roomId)?.get(userId)?.username || `User ${userId}`;
    const enforced = mediaSecure.enforced;
    // Deduplicate: if OUR device can't do it, that's the single cause for all peers.
    const localUnsupported = e2eeDetail.some(d => d.reason === 'local-unsupported') || mediaSecure.supported === false;
    const downgradeLines: string[] = localUnsupported
        ? [mediaE2eeExplanation('local-unsupported', '', enforced)!]
        : e2eeDetail.filter(d => !d.encrypted)
            .map(d => mediaE2eeExplanation(d.reason, nameFor(d.userId), enforced))
            .filter((s): s is string => !!s);

    // Unified E2EE badge content — every state (including fully encrypted) gets
    // the same hover/focus popup, so the indicator always explains itself.
    const allEncrypted = mediaSecure.total > 0 && mediaSecure.encrypted === mediaSecure.total;
    const someEncrypted = mediaSecure.encrypted > 0;
    // E2EE tooltip portal: measured, viewport-clamped fixed placement (the
    // sidebar clips anything absolutely-positioned inside it).
    const e2eeBadgeRef = useRef<HTMLSpanElement>(null);
    const e2eeTipRef = useRef<HTMLSpanElement>(null);
    const [e2eeTipOpen, setE2eeTipOpen] = useState(false);
    const [e2eeTipPos, setE2eeTipPos] = useState<{ top: number; left: number } | null>(null);
    const positionE2eeTip = useCallback(() => {
        const b = e2eeBadgeRef.current?.getBoundingClientRect();
        if (!b) return;
        // Measure the REAL node. The old estimates (260x150) were up to ~180px
        // short for the multi-line downgrade states, so the first painted frame
        // landed in the wrong place — and if that frame was dropped, it stayed
        // there. The portal now renders hidden-but-measurable before this runs.
        const tip = e2eeTipRef.current;
        const w = tip?.offsetWidth ?? 260;
        const h = tip?.offsetHeight ?? 150;
        const margin = 8;
        let top = b.top - h - 8; // prefer above the badge (panel sits at the bottom)
        if (top < margin) top = b.bottom + 8; // flip below
        // Clamp BOTH ends: a tall popup in a short window used to compute a
        // negative top, putting the headline above the viewport where it could
        // not be read or scrolled to.
        top = Math.min(top, window.innerHeight - h - margin);
        top = Math.max(margin, top);
        let left = Math.min(b.left, window.innerWidth - w - margin);
        left = Math.max(margin, left);
        setE2eeTipPos({ top, left });
    }, []);
    useLayoutEffect(() => {
        if (!e2eeTipOpen) { setE2eeTipPos(null); return; }
        positionE2eeTip();
        const raf = requestAnimationFrame(positionE2eeTip);
        // The content changes UNDER an open tooltip: mediaSecure/e2eeDetail are
        // polled every 2s, so lines appear/disappear while hovering. The box is
        // anchored by `top` and grows downward, so without this it grew past the
        // bottom of the screen and got cut off.
        const ro = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => positionE2eeTip())
            : null;
        if (ro && e2eeTipRef.current) ro.observe(e2eeTipRef.current);
        window.addEventListener('scroll', positionE2eeTip, true);
        window.addEventListener('resize', positionE2eeTip);
        return () => {
            cancelAnimationFrame(raf);
            ro?.disconnect();
            window.removeEventListener('scroll', positionE2eeTip, true);
            window.removeEventListener('resize', positionE2eeTip);
        };
    }, [e2eeTipOpen, positionE2eeTip]);
    // The badge unmounts when the last peer leaves (mediaSecure.total → 0);
    // mouseleave never fires on a removed node, so close the portaled tooltip
    // explicitly or it lingers on screen (pointer-events: none — undismissable).
    useEffect(() => {
        if (mediaSecure.total === 0) setE2eeTipOpen(false);
    }, [mediaSecure.total]);

    const e2eeBadge = {
        cls: allEncrypted ? 'on' : (someEncrypted ? 'partial' : 'off'),
        label: allEncrypted ? 'Encrypted'
            : enforced ? (someEncrypted ? 'Enforced' : 'Blocked')
                : (someEncrypted ? 'Partial' : 'Not E2EE'),
        // Short native-tooltip fallback (screen readers / no-hover).
        title: allEncrypted
            ? 'Voice, video and screen share are end-to-end encrypted'
            : enforced
                ? (someEncrypted ? 'Some participants’ media is blocked (encryption required)' : 'Media blocked — encryption required')
                : (someEncrypted ? 'Some connections aren’t end-to-end encrypted' : 'This call isn’t end-to-end encrypted'),
        headline: allEncrypted ? 'End-to-end encrypted'
            : enforced ? (someEncrypted ? 'Some participants’ media is blocked' : 'Media is blocked — encryption required')
                : (someEncrypted ? 'Some connections aren’t end-to-end encrypted' : 'This call isn’t end-to-end encrypted'),
    };
    const e2eeTooltipLines: string[] = allEncrypted
        ? ['Everyone’s microphone, camera and screen share is encrypted end-to-end — only the people in this call can access it. The server only ever relays data it can’t read.']
        : [
            ...(enforced
                ? [sfuMode
                    ? 'This is an encrypted-only call — the relay refuses unencrypted media and only ever carries data it can’t read.'
                    : serverRequireMediaE2ee
                        ? 'This server requires encrypted calls.'
                        : 'You’ve turned on “Require encryption for calls” in Settings.']
                : []),
            ...downgradeLines,
        ];
    // Fallback so a transient "not all encrypted yet" state is never blank.
    if (!allEncrypted && e2eeTooltipLines.length === 0) {
        e2eeTooltipLines.push('Setting up encryption…');
    }

    return (
        <>
        {/* Why a mute toggle refused (deafened) — Toast portals to <body>, so
            it is visible however the panel is clipped. */}
        {muteNotice && <Toast message={muteNotice} onDismiss={() => setMuteNotice(null)} />}
        {/* E2EE badge tooltip — portaled to <body> (same anti-clipping pattern
            as the reaction emoji picker): the sidebar is overflow:hidden and
            only ~240px wide, so the old in-place absolute tooltip was chopped
            to a strip. Fixed-position + measured + viewport-clamped instead. */}
        {e2eeTipOpen && createPortal(
            <span
                ref={e2eeTipRef}
                className="e2ee-tooltip e2ee-tooltip-portal"
                role="tooltip"
                // Rendered (hidden) BEFORE a position is known so the first
                // measurement reads the real box. `visibility`, never
                // `display:none` — that would measure zero.
                style={{
                    top: e2eeTipPos?.top ?? 0,
                    left: e2eeTipPos?.left ?? 0,
                    visibility: e2eeTipPos ? 'visible' : 'hidden',
                }}
            >
                <strong>{e2eeBadge.headline}</strong>
                {e2eeTooltipLines.map((line, i) => (
                    <span key={i} className="e2ee-tooltip-line">{line}</span>
                ))}
                <span className="e2ee-tooltip-foot">
                    Text messages, DMs and files remain end-to-end encrypted regardless.
                </span>
            </span>,
            document.body
        )}
        <div
            ref={panelRef}
            className={`voice-panel-compact${isPhonePanel && isInVoice && !controlsExpanded ? ' vp-collapsed' : ''}`}
        >
            {/* Permission Help Modal */}
            {showPermissionHelp && (
                <div className="permission-help-overlay">
                    <div className="permission-help-modal">
                        <h3><MicIcon /> Microphone Access Blocked</h3>
                        <p>You'll need to allow microphone access to join voice chat.</p>

                        <div className="permission-instructions">
                            <p><strong>To fix this:</strong></p>
                            {/* Check if running in Tauri (desktop app) - v2 uses __TAURI_INTERNALS__ */}
                            {typeof window !== 'undefined' && ((window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI__) ? (
                                // Desktop app - Windows/macOS instructions (Tauri uses Edge WebView2)
                                <ol>
                                    <li>Open <strong>Windows Settings</strong> (Win + I)</li>
                                    <li>Go to <strong>Privacy & Security → Microphone</strong></li>
                                    <li>Make sure <strong>"Microphone access"</strong> is ON</li>
                                    <li>Make sure <strong>"Let desktop apps access your microphone"</strong> is ON</li>
                                    <li>If still blocked, check <strong>Microsoft Edge</strong> in the app list (Puca uses Edge WebView)</li>
                                    <li>Restart Puca and click "Try Again"</li>
                                </ol>
                            ) : (
                                // Browser - standard instructions
                                <ol>
                                    <li>Click the <span className="icon-hint"><LockIcon /></span> icon in your browser's address bar</li>
                                    <li>Find "Microphone" in the permissions list</li>
                                    <li>Change it from "Block" to "Allow"</li>
                                    <li>Refresh the page or click "Try Again" below</li>
                                </ol>
                            )}
                        </div>

                        <div className="permission-help-buttons">
                            <button
                                className="permission-retry-btn"
                                onClick={async () => {
                                    setShowPermissionHelp(false);
                                    setError(null);
                                    // Small delay then try again
                                    setTimeout(() => joinVoice(), 100);
                                }}
                            >
                                Try Again
                            </button>
                            {/* Reset Permissions button for desktop (clears WebView2 data) */}
                            {typeof window !== 'undefined' && !!((window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI__) && (
                                <button
                                    className="permission-reset-btn"
                                    onClick={async () => {
                                        try {
                                            const { invoke } = await import('@tauri-apps/api/core');
                                            const result = await invoke<string>('clear_webview_permissions');
                                            alert(result);
                                            // Close app after showing message
                                            const { exit } = await import('@tauri-apps/plugin-process');
                                            await exit(0);
                                        } catch (e) {
                                            alert('Failed to reset permissions: ' + e);
                                        }
                                    }}
                                >
                                    Reset Permissions & Restart
                                </button>
                            )}
                            <button
                                className="permission-dismiss-btn"
                                onClick={() => {
                                    setShowPermissionHelp(false);
                                    setError(null);
                                }}
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Connection Status */}
            {!isInVoice ? (
                <button
                    className="voice-join-btn-compact"
                    onClick={joinVoice}
                    disabled={isConnecting}
                >
                    {isConnecting ? 'Connecting...' : 'Join Voice'}
                </button>
            ) : (
                <>
                    {/* Connection Info */}
                    <div className="voice-connection-info">
                        <div className="voice-status-row">
                            <span className="voice-connected-icon">{isAfkChannel ? <MoonIcon /> : <SignalIcon />}</span>
                            <div className="voice-connection-text">
                                <span className="voice-connected-label">{isAfkChannel ? 'AFK — mic disabled' : listenOnly ? 'Voice Connected · listen-only' : 'Voice Connected'}</span>
                                <span className="voice-channel-name">{channelName || roomId}</span>
                            </div>
                            {mediaSecure.total > 0 && (
                                <span
                                    className={`voice-e2ee ${e2eeBadge.cls}`}
                                    ref={e2eeBadgeRef}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`Media encryption: ${e2eeBadge.title}. Hover for details.`}
                                    onMouseEnter={() => setE2eeTipOpen(true)}
                                    onMouseLeave={() => setE2eeTipOpen(false)}
                                    onFocus={() => setE2eeTipOpen(true)}
                                    onBlur={() => setE2eeTipOpen(false)}
                                >
                                    <span className="voice-e2ee-label">{e2eeBadge.label}</span>
                                    <span className="e2ee-info" aria-hidden="true"><InfoIcon /></span>
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Compact Controls */}
                    <div className="voice-controls-compact">
                        {/* The button reflects the EFFECTIVE gate, not just the
                            toggle: a held push-to-mute (or an idle push-to-talk)
                            closes the mic with no toggle change, and showing
                            nothing made a working hold read as broken. */}
                        {(() => {
                            const holdClosed = voiceInputMode === 'pushToMute' && holdKeyDown && !isMuted;
                            const pttIdle = voiceInputMode === 'pushToTalk' && !holdKeyDown && !isMuted;
                            return (
                                <button
                                    className={`voice-btn ${listenOnly ? 'no-mic' : (isMuted || holdClosed ? 'active' : pttIdle ? 'ptt-idle' : '')}`}
                                    onClick={toggleMute}
                                    title={listenOnly ? 'No microphone detected — listen-only mode'
                                        : isAfkChannel ? 'Microphone is disabled in AFK channels'
                                            : holdClosed ? 'Push-to-mute held — mic muted'
                                                : pttIdle ? 'Push to talk — hold your key to speak'
                                                    : (isMuted ? 'Unmute' : 'Mute')}
                                    disabled={listenOnly || isDeafened || isAfkChannel}
                                >
                                    {listenOnly || isMuted || holdClosed || pttIdle
                                        ? <MicOffIcon size={18} />
                                        : <MicIcon size={18} />}
                                </button>
                            );
                        })()}
                        <button
                            className={`voice-btn ${isDeafened ? 'active' : ''}`}
                            onClick={toggleDeafen}
                            title={isDeafened ? 'Undeafen' : 'Deafen'}
                        >
                            {isDeafened ? <HeadphonesOffIcon size={18} /> : <HeadphonesIcon size={18} />}
                        </button>
                        <select
                            className="voice-dropdown"
                            value={noiseMode}
                            onChange={(e) => {
                                // Persist + fire NOISE_MODE_EVENT; the listener
                                // above re-syncs this dropdown and applies the
                                // mode live if we are in a call. Same path the
                                // Settings → Voice picker takes.
                                changeNoiseModeLive(e.target.value as NoiseSuppressionMode);
                            }}
                            title="Noise suppression"
                        >
                            <option value="off">No suppression</option>
                            <option value="standard">Standard</option>
                            <option value="rnnoise">RNNoise (ML)</option>
                            {/* Gated behind Settings → Advanced → Experimental.
                                Also rendered while ACTIVE with the gate off
                                (gate flipped mid-call) so the select never
                                shows a phantom value; next launch loadSavedMode
                                migrates ungated users to RNNoise. */}
                            {(dfGateOpen || noiseMode === 'deepfilter') && (
                                <option value="deepfilter">DeepFilter (Max)</option>
                            )}
                        </select>
                        <button
                            className={`voice-btn vp-camera ${isCameraOn ? 'active' : ''}`}
                            onClick={async () => {
                                try {
                                    await setCameraEnabled(!isCameraOn);
                                } catch (err) {
                                    console.error('Failed to toggle camera:', err);
                                    setError('Camera access denied');
                                }
                            }}
                            title={isCameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
                        >
                            {isCameraOn ? <CameraIcon size={18} /> : <CameraOffIcon size={18} />}
                        </button>
                        {/* Mobile only: collapsed, the bar shows just mic /
                            deafen / hang-up; everything else (noise mode,
                            camera, any future control) is behind this
                            chevron. CSS keys the hiding on .vp-collapsed. */}
                        {isPhonePanel && (
                            <button
                                className="voice-btn vp-expand"
                                onClick={() => setControlsExpanded(e => !e)}
                                title={controlsExpanded ? 'Fewer voice controls' : 'More voice controls'}
                                aria-label={controlsExpanded ? 'Fewer voice controls' : 'More voice controls'}
                                aria-expanded={controlsExpanded}
                            >
                                {controlsExpanded ? <ChevronDownIcon size={18} /> : <ChevronUpIcon size={18} />}
                            </button>
                        )}
                        {/* Hide screen share on mobile - not supported */}
                        {!isMobile && (
                            <button
                                className={`voice-btn vp-screenshare ${isScreenSharing ? 'active screen-share' : ''}`}
                                onClick={async () => {
                                    if (isScreenSharing) {
                                        void sfuManager.stopScreenShare(); // no-op on mesh calls
                                        webrtcManager.stopScreenShare();
                                        wsClient.stopScreenShare(roomId);
                                        setIsScreenSharing(false);
                                        // Remove own stream from screenSharers
                                        setScreenSharers(prev => {
                                            const newMap = new Map(prev);
                                            newMap.delete(currentUserId);
                                            return newMap;
                                        });
                                        // Clear stream viewing state - this will switch view back to chat
                                        clearAllStreams();
                                    } else {
                                        // Open settings modal instead of starting immediately
                                        setShowStreamSettings(true);
                                    }
                                }}

                                title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
                            >
                                <ScreenShareIcon size={18} />
                            </button>
                        )}
                        <ClipButtons
                            inVoice={isInVoice}
                            isAfkChannel={isAfkChannel}
                            listenOnly={listenOnly}
                            roomId={roomId}
                            policy={clipPolicy}
                            getDeclaredParticipants={() => Array.from(seenWhileArmedRef.current).filter(id => id !== currentUserId)}
                        />
                        <button
                            className="voice-btn disconnect"
                            onClick={() => { leaveVoice(); onDisconnect?.(); }}
                            title="Disconnect"
                        >
                            <DisconnectIcon size={18} />
                        </button>
                    </div>
                    <ClipStatusRow />

                    {/* Camera Preview (when camera is on) - Draggable PiP */}
                    {isCameraOn && !isFullscreen && (
                        <div
                            ref={pipRef}
                            className={`camera-preview-mini pip-draggable ${isDragging ? 'dragging' : ''}`}
                            style={{
                                position: 'fixed',
                                left: pipPosition.x,
                                top: pipPosition.y,
                                zIndex: 500,
                                touchAction: 'none',
                                cursor: isDragging ? 'grabbing' : 'grab'
                            }}
                            onTouchStart={handlePipTouchStart}
                            onTouchMove={handlePipTouchMove}
                            onTouchEnd={handlePipTouchEnd}
                            onMouseDown={handlePipMouseDown}
                            onClick={handlePipClick}
                        >
                            <video
                                ref={cameraPreviewRef}
                                autoPlay
                                playsInline
                                muted
                            />
                            <span className="camera-label">You (Camera)</span>

                            {/* Quick options overlay (shows on first tap) */}
                            {showPipOptions && (
                                <div className="pip-options-overlay">
                                    <button
                                        className="pip-option-btn"
                                        onClick={(e) => { e.stopPropagation(); handleFlipCamera(); }}
                                    >
                                        <FlipCameraIcon size={16} /> Flip
                                    </button>
                                    <button
                                        className="pip-option-btn"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setIsFullscreen(true);
                                            setShowPipOptions(false);
                                        }}
                                    >
                                        <FullscreenIcon size={16} /> Fullscreen
                                    </button>
                                    <button
                                        className="pip-option-btn close-btn"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            // Full stop path: unpublishes from the SFU and
                                            // notifies peers (used to skip both — ghost camera).
                                            void setCameraEnabled(false).catch(err =>
                                                console.error('Failed to stop camera:', err));
                                        }}
                                    >
                                        <CloseIcon size={16} /> Close
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Fullscreen camera view */}
                    {isCameraOn && isFullscreen && (
                        <div className="camera-fullscreen">
                            <video
                                ref={cameraPreviewRef}
                                autoPlay
                                playsInline
                                muted
                            />
                            <div className="camera-fullscreen-controls">
                                <button
                                    className="fullscreen-btn"
                                    onClick={handleFlipCamera}
                                >
                                    <FlipCameraIcon size={18} /> Flip Camera
                                </button>
                                <button
                                    className="fullscreen-btn exit-btn"
                                    onClick={() => setIsFullscreen(false)}
                                >
                                    <FullscreenIcon size={18} /> Exit Fullscreen
                                </button>
                                <button
                                    className="fullscreen-btn close-btn"
                                    onClick={() => {
                                        setIsFullscreen(false);
                                        // Full stop path: unpublishes from the SFU and
                                        // notifies peers (used to skip both — ghost camera).
                                        void setCameraEnabled(false).catch(err =>
                                            console.error('Failed to stop camera:', err));
                                    }}
                                >
                                    <CloseIcon size={18} /> Turn Off Camera
                                </button>
                            </div>
                        </div>
                    )}
                    {/* Remote camera feeds render inside the voice-stage tiles
                        (VoiceStage) via globalCameraStreams — no floating grid. */}
                </>
            )
            }

            {error && <div className="voice-error-mini">{error}</div>}
            {micNotice && <div className="voice-error-mini">{micNotice}</div>}
            {listenOnly && (
                <div className="voice-error-mini">
                    {NO_MIC_NOTICE}
                    {/* Some WebView2 builds report a privacy-blocked mic as
                        "not found", so offer the permission help from here. */}
                    <button className="listen-only-help" onClick={() => setShowPermissionHelp(true)}>
                        Microphone help
                    </button>
                </div>
            )}

            {/* Stream Settings Modal — 2-step: pick quality → OS picker → choose audio */}
            <ScreenShareModal
                isOpen={showStreamSettings}
                onClose={() => setShowStreamSettings(false)}
                onCancelAfterCapture={() => {
                    // User backed out after the OS picker; drop the captured surface.
                    webrtcManager.stopScreenShare();
                }}
                onCaptureScreen={async ({ resolution, fps }) => {
                    let width = 1920, height = 1080;
                    if (resolution === '720') { width = 1280; height = 720; }
                    else if (resolution === '1440') { width = 2560; height = 1440; }
                    else if (resolution === 'source') { width = 3840; height = 2160; }

                    const isDesktop = isTauri();
                    
                    // Start fetching apps BEFORE waiting on the OS picker so the
                    // 0.5s scan happens while the user is looking at the dialog.
                    // Assign the CHAIN synchronously, not from inside .then().
                    // Assigning in the callback meant that if the user answered
                    // the picker before the dynamic import resolved, this was
                    // still null at the await below and the app list silently
                    // became [] — app-audio matching skipped, with no error.
                    // The .catch keeps a cancelled picker (which never awaits
                    // this) from producing an unhandled rejection.
                    const appsPromise: Promise<import('../api/appAudio').CaptureApp[]> | null = isDesktop
                        ? import('../api/appAudio')
                            .then(({ listCaptureApps }) => listCaptureApps())
                            .catch(err => {
                                console.error('[VoicePanel] Failed to list capture apps:', err);
                                return [];
                            })
                        : null;

                    try {
                        // Desktop captures video-only (native audio is attached later);
                        // browsers must request audio at getDisplayMedia time.
                        const shareStream = await webrtcManager.getScreenShareStream({ width, height, fps, audio: !isDesktop });

                        if (isDesktop) {
                            const { matchAppByWindowTitle } = await import('../api/appAudio');
                            const label = shareStream.getVideoTracks()[0]?.label ?? '';
                            const apps = appsPromise ? await appsPromise : [];
                            const matched = matchAppByWindowTitle(apps, label);
                            const isScreenShare = /^(screen|monitor)/i.test(label.trim());
                            return {
                                appName: matched?.name ?? null,
                                appPid: matched?.pid ?? null,
                                apps,
                                isScreenShare,
                                hasBrowserAudio: false,
                            };
                        }
                        return {
                            appName: null,
                            appPid: null,
                            apps: [],
                            isScreenShare: false,
                            hasBrowserAudio: shareStream.getAudioTracks().length > 0,
                        };
                    } catch (err) {
                        // getDisplayMedia throws when the user cancels the OS picker.
                        // The appsPromise is safely orphaned and ignored.
                        console.warn('[VoicePanel] Screen capture cancelled/failed:', err);
                        webrtcManager.stopScreenShare();
                        return null;
                    }
                }}
                onGoLive={async (audioChoice, apps) => {
                    const isDesktop = isTauri();
                    try {
                        if (isDesktop && audioChoice === 'app' && apps && apps.length > 0) {
                            const { startMultiAppAudioTrack, startGameAudioTrack } = await import('../api/appAudio');
                            try {
                                // Mixer: exactly the ticked apps, mixed natively. One app
                                // closing drops its audio; the stream itself continues.
                                const track = await startMultiAppAudioTrack(apps, (_pid, name) => {
                                    setError(`${name} closed — its audio was removed from the stream.`);
                                });
                                webrtcManager.addGameAudioToScreenShare(track);
                            } catch (mixerErr) {
                                // Fall back to legacy single-app capture ONLY when the
                                // installed binary predates the mixer command — a genuine
                                // capture failure must surface as one (outer catch), not
                                // silently retry as something else.
                                const msg = String(mixerErr);
                                const commandMissing = /not found|unknown|not allowed/i.test(msg)
                                    && msg.includes('start_multi_app_audio_capture');
                                if (!commandMissing) throw mixerErr;
                                console.warn('[VoicePanel] Mixer command missing (older binary), falling back to single-app:', mixerErr);
                                const first = apps[0];
                                const gameTrack = await startGameAudioTrack(first.pid, () => {
                                    setError(`${first.name} closed — stream ended.`);
                                    stopOwnScreenShare();
                                });
                                webrtcManager.addGameAudioToScreenShare(gameTrack);
                                if (apps.length > 1) {
                                    setError('Multi-app audio needs the latest desktop update — streaming the first app only.');
                                }
                            }
                        } else if (!isDesktop && audioChoice === 'none') {
                            // Drop the browser-captured audio track the user opted out of.
                            webrtcManager.getScreenShareStreamForPreview()?.getAudioTracks().forEach(t => t.stop());
                        }
                    } catch (audioErr) {
                        console.error('[VoicePanel] Stream audio capture failed:', audioErr);
                        setError('Audio capture failed — streaming video only.');
                    }

                    if (sfuMode) {
                        // SFU path: publish the captured stream (video + any game/system
                        // audio) to LiveKit — capped bitrate, refuses past the share cap.
                        try {
                            const sfuStream = webrtcManager.getScreenShareStreamForPreview();
                            if (sfuStream) await sfuManager.startScreenShare(sfuStream);
                        } catch (shareErr) {
                            console.warn('[VoicePanel] SFU screen share refused:', shareErr);
                            setError((shareErr as Error).message || 'Screen share failed');
                            webrtcManager.stopScreenShare();
                            return;
                        }
                    } else {
                        await webrtcManager.addScreenShareToPeers();
                    }
                    // The capture + publish awaits above can outlive the call
                    // (channel switch / hang-up mid-picker): announcing then
                    // would hit the server's membership gate. Same guard as
                    // the camera path — release and bail.
                    if (!isInVoiceRef.current) {
                        void sfuManager.stopScreenShare();
                        webrtcManager.stopScreenShare();
                        return;
                    }
                    const stream = webrtcManager.getScreenShareStreamForPreview();
                    wsClient.startScreenShare(roomId, stream?.id);
                    setIsScreenSharing(true); // the effect below keeps WebView2's redundant "is sharing" bar hidden
                    setCurrentStreamingUser(currentUserId);
                    if (selfPreviewRef.current && stream) selfPreviewRef.current.srcObject = stream;
                    if (stream) {
                        setScreenSharers(prev => new Map(prev).set(currentUserId, { username: currentUsername || `User ${currentUserId}`, stream }));
                        globalStreamData.set(currentUserId, { username: currentUsername || `User ${currentUserId}`, stream });
                        selectStream(currentUserId); // adds to the global set + notifies
                    }
                }}
            />

            {/* Camera preview is now in camera-preview-mini above - removed duplicate */}
        </div>
        </>
    );
}

