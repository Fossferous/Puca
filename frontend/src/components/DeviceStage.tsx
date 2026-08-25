/**
 * Controller-side view of a device session: the remote screen, and the surface
 * that turns local input into sealed events.
 *
 * NOT StreamStage. That component is bound to voiceState (which stream is
 * selected, who is in the room, the filmstrip), and reusing it would re-couple
 * this feature to voice channels — the thing the whole device path exists to
 * escape. The coordinate mapping below is deliberately the SAME maths as
 * StreamStage's `normalizedOverVideo`, because `object-fit: contain`
 * letterboxing is a property of the layout, not of that component.
 *
 * Everything here sends NORMALISED 0..1 coordinates. The host maps them onto
 * the monitor it actually captured, including secondary monitors whose
 * virtual-desktop coordinates are legitimately negative — a controller that
 * sent pixels would put the cursor on the wrong screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ALL_DISPLAYS,
    deviceDiagnosticsWindow,
    endSession,
    requestKeyframe,
    setCaretTracking,
    setCursorOwned,
    requestMonitor,
    sendClipboard,
    sendInput,
    sendStreamQuality,
    subscribeCaret,
    subscribeSessions,
    type CaretReport,
    type DeviceControlSession,
} from '../api/devices/session';
import {
    currentKeyboardInset, watchKeyboardInset, type KeyboardInset,
} from '../api/keyboardInset';
import { isEditableTarget, matchesRegisteredHotkey } from '../api/hotkeys';
import { useStreamStore } from '../stores/streamStore';
import { STREAM_QUALITY_PRESETS, parsePresetValue, presetValue } from '../api/devices/streamQualityPresets';
import { tunnelStatus, type TunnelStatus } from '../api/devices/tunnel';
import { getStreamQualityErrorMessage } from '../api/devices/streamQualityMessages';
import { isInjectableKey, normalizedOverVideo, pictureBox } from '../api/devices/pointerMapping';
import {
    HOP_COOLDOWN_MS, HOP_EDGE_QUANTUM_PX, HOP_MIN_SCALE, HOP_PRESSURE_PX, HOP_PRESSURE_TTL_MS,
    ZOOM_FOLLOW_IN, ZOOM_FOLLOW_OUT_AT, accumulateHopPressure, captureSurfaceSize, caretBandFrom,
    caretFollowTransform, clampPanTo, hopDirection,
    initialMonitorRequest, manualCompositeHoldActive,
    monitorNeighbour, monitorRegions, pickFollowTarget,
    remapAcrossBoundary, remapIntoComposite, remapIntoMonitor, viewportInVideo,
    type HopPressure, type MonitorGeom, type View as ZoomView,
} from './deviceZoomFollow';
import {
    autoKeyboardVerdict, autoKeyboardVerdictAtPress,
    type AutoKeyboardVerdict, type Press, type SurfaceSize,
} from './deviceAutoKeyboard';
import { installBackgroundResume } from './deviceStageResume';
import { installStallWatchdog } from './deviceStageStall';
import { TouchGestures } from '../api/devices/touchGestures';
import { isMobile as isNativeMobile } from '../api/platform';
import { computeRmoveScale } from '../api/remoteControl';
import {
    FPS_SENS_MAX, FPS_SENS_MIN, FPS_SENS_STEP,
    fmtSens, loadFpsMode, loadFpsSens, saveFpsMode, saveFpsSens,
} from '../utils/fpsSens';
import { DeviceFileManager } from './DeviceFileManager';
import './DeviceStage.css';
import { MobileToolbar, MobileToolbarToggle } from './DeviceStageMobileToolbar';
import { MoreMenu, MonitorMenu, MouseMenu } from './DeviceStageMobileMenus';
import { KeyboardOverlay } from './DeviceStageMobileKeyboard';
import { DeviceStageVirtualMouse } from './DeviceStageVirtualMouse';
import { CopyIcon, CrosshairIcon, ForwardIcon, LiveDotIcon } from './Icons';
import './DeviceStageMobile.css';


/**
 * How large the picture is DRAWN inside the video element, in layout pixels.
 *
 * `offsetWidth`/`offsetHeight`, not `getBoundingClientRect()`: the video sits
 * inside the zoom transform, and this feeds both the cursor overlay (which is
 * inside that transform too) and the trackpad's delta scaling. Using the
 * transformed rect for the overlay would double-apply the zoom.
 */
function currentPictureBox(v: HTMLVideoElement): { dispW: number; dispH: number } | null {
    return pictureBox(v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight);
}

/**
 * The picture box AS THE FINGER SEES IT, for scaling trackpad deltas.
 *
 * Finger movement is measured in client pixels, which are post-transform, so
 * the denominator has to be too. Using the untransformed box meant that at 5x
 * zoom the pointer travelled five times as far as the finger — precisely when
 * the user has zoomed in to be MORE precise.
 *
 * Null when there is no picture yet, and the caller must then not move the
 * pointer at all: substituting a 1x1 box makes every pixel of finger travel a
 * full sweep of the remote screen.
 */
function gestureSurface(v: HTMLVideoElement, scale: number): { dispW: number; dispH: number } | null {
    const box = currentPictureBox(v);
    if (!box) return null;
    // The precision gain saturates: past ~8x the pointer is already finer than
    // a remote pixel, and dividing travel by the full zoom at 40x would take
    // dozens of swipes to cross the screen. The divisor stops growing at 8.
    const s = Math.min(Math.max(scale > 0 ? scale : 1, 1), 8);
    return { dispW: box.dispW * s, dispH: box.dispH * s };
}

/** A touch device, whatever its current width or orientation. */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

function detectCoarsePointer(): boolean {
    // The Capacitor app is authoritative about itself; the media query covers a
    // phone browser, and a desktop with a touchscreen reports `fine` for its
    // primary pointer so it correctly stays on the desktop UI.
    if (isNativeMobile()) return true;
    return typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** Remembered across sessions: a chosen input mode should not reset. */
const MOUSE_MODE_KEY = 'device-stage-mouse-mode';
const VIRTUAL_MOUSE_KEY = 'device-stage-virtual-mouse';
const FOLLOW_CURSOR_KEY = 'device-stage-follow-cursor';
const FOLLOW_CARET_KEY = 'device-stage-follow-caret';
const AUTO_KEYBOARD_KEY = 'device-stage-auto-keyboard';

/** ON by default: at any zoom the trackpad's pointer creeps (finger travel is
 *  divided by the scale for precision), so walking it off the visible region
 *  and needing a manual two-finger pan was the NORMAL case, not a rare one. */
function readFollowCursorPreference(): boolean {
    try {
        const saved = localStorage.getItem(FOLLOW_CURSOR_KEY);
        if (saved === 'on') return true;
        if (saved === 'off') return false;
    } catch {
        // Private mode, or storage disabled. Fall through to the default.
    }
    return true;
}

/** ON by default, for the same shape of reason as follow-cursor: on a phone the
 *  remote caret is 3-4 CSS px tall at fit zoom and can sit anywhere behind the
 *  soft keyboard, so "type and watch nothing" is the NORMAL case, not a rare
 *  one. */
function readFollowCaretPreference(): boolean {
    try {
        const saved = localStorage.getItem(FOLLOW_CARET_KEY);
        if (saved === 'on') return true;
        if (saved === 'off') return false;
    } catch {
        // Private mode, or storage disabled. Fall through to the default.
    }
    return true;
}

/** ON by default: "tap a text box, start typing" is what every native app on
 *  the phone does, and the keyboard being a toolbar button was the reported
 *  friction. The off switch exists because the decision is a heuristic over the
 *  remote caret (deviceAutoKeyboard.ts) and a heuristic that cannot be turned
 *  off is a bug report waiting to happen. */
function readAutoKeyboardPreference(): boolean {
    try {
        const saved = localStorage.getItem(AUTO_KEYBOARD_KEY);
        if (saved === 'on') return true;
        if (saved === 'off') return false;
    } catch {
        // Private mode, or storage disabled. Fall through to the default.
    }
    return true;
}

/** The zoom floor is load-bearing: scale 1 is the fit state and the
 *  `newScale === 1` origin reset in both zoom branches assumes it (the
 *  picture clamp also centres any underfilled axis, so the two agree). The
 *  ceiling is not — nothing in the mapping depends on it (cursor coordinates
 *  come out of post-transform rects, so they cancel the zoom at any scale).
 *  It exists only to keep the composited canvas a sane size; past the point
 *  where one remote pixel fills several screen pixels more zoom adds only
 *  blur, so 40x is "infinite" for every real screen pairing. Was 5, which
 *  users hit. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

/** How long to wait for the peer's first caret report before placing the view
 *  from where this end last AIMED instead.
 *
 *  The only evidence a peer can report a caret is a report arriving: str0m opens
 *  the SCTP stream whatever the label, so an agent that predates the feature
 *  opens the channel and then drops every byte — as do a webview host, a phone
 *  host, a non-Windows host, Windows Terminal (no caret through the first two
 *  tiers) and an elevated window a user-flavour agent may not query. All silent,
 *  and all still deserve a readable band. */
const CARET_REPORT_GRACE_MS = 500;
/** How recently a real caret must have arrived for it to own the placement. Past
 *  this, a tap (which is the user saying where the caret now is) re-places the
 *  view — the fallback's only way to follow a moving caret on a silent peer. */
const CARET_VIS_FRESH_MS = 1000;

/** The pan clamp, shared by the pinch, wheel and follow-cursor writers so
 *  they cannot drift. Bounds come from where the PICTURE sits inside the
 *  canvas (deviceZoomFollow.clampPanTo — one implementation for this stage
 *  AND the zoom-follow remaps): the canvas box alone let the letterboxed
 *  picture be panned clean out of the viewport, showing only black bar. */
function clampPan(
    video: { videoWidth: number; videoHeight: number } | null,
    rect: { width: number; height: number },
    scale: number,
    x: number,
    y: number,
): { x: number; y: number } {
    const pict = video
        ? pictureBox(video.videoWidth, video.videoHeight, rect.width, rect.height)
        : null;
    return clampPanTo({ w: rect.width, h: rect.height }, pict, scale, x, y);
}

function readMouseModePreference(): boolean {
    try {
        const saved = localStorage.getItem(MOUSE_MODE_KEY);
        if (saved === 'trackpad') return true;
        if (saved === 'touch') return false;
    } catch {
        // Private mode, or storage disabled. Fall through to the default.
    }
    return detectCoarsePointer();
}

/**
 * OFF by default: the pad is an extra control surface, not the primary way to
 * drive the stage.
 *
 * This used to also toggle a blue dot drawn over the video, standing in for a
 * cursor the stream did not contain — DXGI excludes the pointer from the
 * captured desktop, so early hosts sent mouseless screens. The agent
 * composites the real cursor in now (true position, true SHAPE — an I-beam, a
 * resize arrow, a spinner all mean something), and two cursors separating
 * under latency made the overlay strictly worse than the picture, so the dot
 * is gone. This preference now toggles only the L/M/R pad.
 */
function readVirtualMousePreference(): boolean {
    try {
        const saved = localStorage.getItem(VIRTUAL_MOUSE_KEY);
        if (saved === 'on') return true;
        if (saved === 'off') return false;
    } catch {
        // Private mode, or storage disabled. Fall through to the default.
    }
    return false;
}

/**
 * THE STAGE'S OWN CARET STATE, for the diagnostic.
 *
 * session.ts owns the wire half (channel state, frames, drops); the band, the
 * inset source and the fallback only exist here. A module-level slot the mounted
 * stage fills, because `__pucaDeviceDiag` is installed by session.ts at
 * import time and there is exactly one stage.
 *
 * Both routes matter and they are different: the window global is the desktop
 * console's, and "Copy diagnostics" (below) is the ONLY console a signed release
 * APK has — a phone cannot reach chrome://inspect.
 */
const caretDiag: { read: () => Record<string, unknown> } = { read: () => ({ active: false }) };
if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    const base = w.__pucaDeviceDiag as (() => Promise<Record<string, unknown>[]>) | undefined;
    if (typeof base === 'function') {
        w.__pucaDeviceDiag = async () => {
            const rows = await base();
            const caret = caretDiag.read();
            return rows.map(r => ({ ...r, caret }));
        };
    }
}

/** How long a mobile notice ("Clipboard sent", "Locking…") stays up. */
const NOTE_LIFETIME_MS = 6000;

export function DeviceStage() {
    // COARSE POINTER, not window width.
    //
    // This was `window.innerWidth <= 768`, so a phone turned to landscape (844
    // CSS px on the reporter's device) became "desktop" mid-session: the mobile
    // toolbar, the trackpad and the cursor all vanished at the moment of
    // rotation. Width says how much room there is; it says nothing about
    // whether the user is holding a finger or a mouse.
    const [isMobile, setIsMobile] = useState(() => detectCoarsePointer());
    const [isMinimized, setIsMinimized] = useState(false);
    // Session recording was a menu item that toggled this flag and its own
    // label. There is no MediaRecorder anywhere in the app and nothing was
    // ever written to disk, so "Stop session recording" was offering to stop
    // something that had never started. Removed with the menu item; bring both
    // back together when there is a recorder behind them.

    useEffect(() => {
        const mq = window.matchMedia(COARSE_POINTER_QUERY);
        const onChange = () => setIsMobile(detectCoarsePointer());
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    const [activeMobileMenu, setActiveMobileMenu] = useState<string | null>(null);
    /** The bottom toolbar folded away (the chevron), its OWN state — it used
     *  to be a value of activeMobileMenu ('collapsed'), which meant anything
     *  that opened a menu un-collapsed it. The auto-keyboard opens the
     *  keyboard panel without a toolbar tap, and a bar the user hid to see
     *  the whole picture must stay hidden through that. */
    const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
    /** The chrome heights (the keyboard bar's and the toolbar's, measured far
     *  below) as they were when the current surface gesture
     *  began, or null between gestures. The surface's margins are HELD at
     *  these for the gesture's duration: the keyboard panel can mount in the
     *  middle of a press (the at-press raise, or a report landing mid-drag),
     *  and a surface that re-letterboxes under a finger that is still down
     *  maps the rest of that drag to different remote pixels. The new
     *  heights apply on release. */
    const [chromeFrozen, setChromeFrozen] = useState<{ top: number; bottom: number } | null>(null);
    // TRACKPAD BY DEFAULT on a phone, and remembered.
    //
    // Touch mode sends an absolute position for wherever the finger lands, so
    // every touch jumps the remote pointer — which is exactly the reported
    // "each touch resets the position of the mouse". It is the right model for
    // a tablet used as a whiteboard and the wrong one for driving a desktop, so
    // it stays available and stops being what a phone lands in.
    const [isMouseMode, setIsMouseMode] = useState(readMouseModePreference);
    const [showVirtualMouse, setShowVirtualMouse] = useState(readVirtualMousePreference);
    /** Where THIS end draws the pointer, in picture-relative coordinates —
     *  the same numbers that steer the camera, written in the same frame. */
    const [virtualCursor, setVirtualCursor] = useState({ x: 0.5, y: 0.5 });
    const [followCursor, setFollowCursor] = useState(readFollowCursorPreference);
    /** Mirror for the gesture sink, which is wired once per session. */
    const followCursorRef = useRef(followCursor);
    useEffect(() => { followCursorRef.current = followCursor; }, [followCursor]);
    const [followCaret, setFollowCaret] = useState(readFollowCaretPreference);
    /** Mirror, read inside the caret rAF. */
    const followCaretRef = useRef(followCaret);
    useEffect(() => { followCaretRef.current = followCaret; }, [followCaret]);
    /** Open the soft keyboard when a tap lands in a text box on the remote
     *  machine — see deviceAutoKeyboard.ts for the decision. */
    const [autoKeyboard, setAutoKeyboard] = useState(readAutoKeyboardPreference);

    /** THE CARET CAMERA OWNS THE VIEWPORT while typing. Read by applyFollowPan,
     *  which must keep drawing the pointer but stop panning: two cameras writing
     *  setTransform fight, and the loser is whichever committed first. */
    const caretActiveRef = useRef(false);
    /** Where this end last AIMED, 0..1 over the picture — the fallback's stand-in
     *  for a caret when the peer reports none. Written in `send` (below) rather
     *  than read from the gesture machine, because TouchGestures' own position is
     *  integrated in TRACKPAD mode only: touch mode sends absolute moves straight
     *  from normalizedOverVideo and never touches that machine. */
    const lastAimRef = useRef({ x: 0.5, y: 0.5 });
    /** Filled by the caret section far below (and nulled when it deactivates).
     *  A slot rather than a callback declared here, because the aim is written by
     *  `send`, which the whole input path is built on and which is declared long
     *  before anything caret-shaped can be. */
    const caretOnAimRef = useRef<(() => void) | null>(null);
    /** Same shape, for the auto-keyboard: told about every primary-button PRESS
     *  that actually went out, with where it was aimed; its RELEASE, with
     *  whether the gesture between them was a tap (no pointer movement went
     *  out in between — a drag is not a tap into a field); and a CANCEL when
     *  the gesture turns out to be a pinch or is cancelled. Filled by the
     *  auto-keyboard section below, null while that feature is off. */
    const pressHookRef = useRef<((aim: { x: number; y: number }) => void) | null>(null);
    const pressEndHookRef = useRef<((wasTap: boolean) => void) | null>(null);
    const pressCancelHookRef = useRef<(() => void) | null>(null);
    /** Moves that went out since the last primary press — zero at release
     *  means the press was a tap. */
    const movesSincePressRef = useRef(0);

    const [sessions, setSessions] = useState<DeviceControlSession[]>([]);
    const [controlEnabled, setControlEnabled] = useState(true);
    const [armedFor, setArmedFor] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    /** The letterboxed surface, so the pan clamp measures the BOX and not the
     *  zoomed canvas inside it. */
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const [tunnels, setTunnels] = useState<TunnelStatus | null>(null);
    const [showFiles, setShowFiles] = useState(false);

    // GAME MODE (desktop only): relative mouse via pointer lock, for games
    // that read raw-input deltas. Absolute {t:'move'} teleports the OS cursor
    // but a first-person camera never turns — "the mouse moves off screen and
    // doesn't go very far". The protocol ({t:'rmove'}), the coalescer and both
    // host backends already handle relative moves; this viewer just never
    // emitted them. Mirrors StreamStage's Game mode, same shared sensitivity.
    const [fpsMode, setFpsMode] = useState(loadFpsMode);
    const [pointerLocked, setPointerLocked] = useState(false);
    const [fpsSens, setFpsSens] = useState<number>(loadFpsSens);
    /** Buttons whose 'down' we relayed under the lock, so the matching 'up'
     *  goes out even if the lock dropped mid-hold (Esc, alt-tab). */
    const fpsPressedRef = useRef<Set<number>>(new Set());

    // Pinch and zoom state
    const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
    /** Mirrored so the pointer callbacks can read the live zoom without being
     *  re-created on every pinch frame. */
    const transformRef = useRef(transform);
    useEffect(() => { transformRef.current = transform; }, [transform]);
    const activePointers = useRef<Map<number, React.PointerEvent>>(new Map());
    const lastPinchInfo = useRef<{ dist: number; center: { x: number; y: number } } | null>(null);
    /** TOUCH mode: which contacts actually pressed a button, so only those
     *  release one. */
    const touchDownSent = useRef<Set<number>>(new Set());

    // WHY A SESSION ENDED, kept after the session object is gone.
    //
    // A failed connection removes itself from the session list, so rendering
    // only live sessions meant every failure looked identical: the window shut
    // with no message. That is what made a broken unattended handshake
    // indistinguishable from a declined one, a wrong passphrase, or a host
    // already in a session — all four say something useful, and none of it was
    // ever on screen.
    const [failure, setFailure] = useState<{ id: string; reason: string } | null>(null);
    useEffect(() => subscribeSessions(next => {
        setSessions(next);
        const ended = next.find(s => s.role === 'controller' && s.phase === 'ended' && s.error);
        if (ended) setFailure({ id: ended.id, reason: ended.error! });
    }), []);

    // Only a controller session renders a stage; a host session shows a banner
    // elsewhere. NEWEST first (the list is in creation order): a stale session
    // that has not finished dying — exactly what an ungraceful drop leaves —
    // must not shadow the attempt the user just made. First-match relied on
    // the server's one-per-host cap keeping this list clean, but that cap
    // lives server-side; this array is whatever the local lifecycle left.
    //
    // A file-only session is skipped: no video is coming for it, so the stage
    // would sit on a black rectangle with a "Waiting for the device's screen…"
    // that never resolves. DeviceFileBrowser owns those sessions instead.
    const session = [...sessions].reverse().find(
        s => s.role === 'controller' && s.phase !== 'ended' && !s.filesOnly,
    ) ?? null;

    // A new attempt clears the last failure: a stale reason beside a live
    // session reads as if this one had failed too.
    if (session && failure && session.id !== failure.id) setFailure(null);

    // The stream the <video> should be showing, readable from the callback
    // ref below without retriggering it. Effect-maintained (the refs rule
    // forbids a render-time write), and that is SAFE here even though ref
    // callbacks run before effects: the only commit where this mirror can be
    // stale is one that swaps the stream and remounts the video together, and
    // there the srcObject effect below runs after the ref callback and
    // rebinds to the fresh stream anyway. The mirror only has to be right for
    // the remount-without-swap case (restore from minimize), where the stream
    // it holds from the previous commit IS the current one.
    const streamRef = useRef<MediaStream | null>(null);
    useEffect(() => {
        streamRef.current = session?.stream ?? null;
    }, [session?.stream]);

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (session?.stream && v.srcObject !== session.stream) {
            v.srcObject = session.stream;
            void v.play().catch(() => { /* autoplay policy; the user can click */ });
        }
        if (!session?.stream && v.srcObject) v.srcObject = null;
    }, [session?.stream]);

    // Bind on MOUNT as well as on stream change. The effect above keys on
    // stream IDENTITY, which survives a minimize (the toolbar's Chat button
    // unmounts the <video>) — so the element that remounted on restore kept
    // `srcObject === null` forever: a black stage with live input, and both
    // recovery mechanisms (stall watchdog, resume nudge) gated on srcObject
    // so neither could ever run again. A callback ref sees the remount; the
    // effect keeps seeing stream swaps (e.g. a media restart's fresh
    // MediaStream). Both call sites converge on the same bind.
    const attachVideo = useCallback((v: HTMLVideoElement | null) => {
        videoRef.current = v;
        if (v && streamRef.current && v.srcObject !== streamRef.current) {
            v.srcObject = streamRef.current;
            void v.play().catch(() => { /* autoplay policy; the user can click */ });
        }
    }, []);

    // Re-arm control for a NEW session, so pausing once does not silently
    // disable input for every session afterwards. Adjusted during render rather
    // than in an effect: an effect here would render once with the previous
    // session's paused state before correcting itself, and React explicitly
    // recommends this pattern over a cascading setState.
    if (session && session.id !== armedFor) {
        setArmedFor(session.id);
        setControlEnabled(true);
    }

    const sessionActiveId = session?.id ?? null;

    const send = useCallback((event: unknown) => {
        // AN ABSOLUTE MOVE IS AN AIM. Every path that puts the remote pointer
        // somewhere specific goes through here — touch taps, trackpad follow,
        // the virtual pad — so this is the one place that sees them all, and
        // where the user last aimed is the best guess at where the caret is when
        // the peer will not say. Read before the controlEnabled gate on purpose:
        // the aim is local knowledge, not an input.
        const e = event as { t?: unknown; x?: unknown; y?: unknown; button?: unknown } | null;
        if (e && e.t === 'move' && typeof e.x === 'number' && typeof e.y === 'number') {
            lastAimRef.current = { x: e.x, y: e.y };
            caretOnAimRef.current?.();
        }
        if (session && controlEnabled) {
            sendInput(session.id, event);
            // A PRIMARY PRESS THAT WENT OUT is what the auto-keyboard listens
            // for: every path that clicks the remote machine — a touch-mode
            // tap, the trackpad machine's tap, the virtual pad's L button —
            // sends its `down` through here, after a `move` that set the aim.
            // After the gate, deliberately: a press the pause swallowed moved
            // no caret over there. The RELEASE tells it whether the gesture
            // was a tap: moves between the down and the up make it a drag (a
            // selection, a window move), and a drag is not a tap into a field.
            // The pad's release bypasses this function (see padButton) and
            // reports itself.
            if (e && e.t === 'move') movesSincePressRef.current++;
            if (e && e.t === 'down' && e.button === 0) {
                movesSincePressRef.current = 0;
                pressHookRef.current?.(lastAimRef.current);
            }
            if (e && e.t === 'up' && e.button === 0) {
                pressEndHookRef.current?.(movesSincePressRef.current === 0);
            }
        }
    }, [session, controlEnabled]);
    // Live mirror for effects that must NOT re-run when `send`'s identity
    // churns — session view objects are rebuilt on every subscribeSessions
    // tick, so an effect keyed on `send` runs its cleanup constantly.
    const sendRef = useRef(send);
    useEffect(() => { sendRef.current = send; }, [send]);
    /** Keys relayed as DOWN and not yet released, so losing focus mid-press
     *  can release them on the host (alt-tab would otherwise strand them). */
    const heldKeysRef = useRef<Set<string>>(new Set());
    /** Buttons the virtual mouse pad holds down — same treatment as held
     *  keys: blur, hide and session end release them on the host. */
    const padPressedRef = useRef<Set<number>>(new Set());
    const sessionIdRef = useRef<string | null>(null);
    useEffect(() => { sessionIdRef.current = sessionActiveId; }, [sessionActiveId]);

    // Backgrounding the app pauses the <video> and the bind effect above
    // cannot see it (it acts on stream IDENTITY, which survives on purpose) —
    // so returning to a live session showed a frozen still of the desktop as
    // it was. The un-pause lives in deviceStageResume.ts; the keyframe
    // request covers the case the un-pause cannot (the DECODER lost state
    // while the element never paused — the residual 0.8.43 field report), and
    // the stall watchdog escalates if frames still do not flow. All three
    // share requestKeyframe's one budget, so overlapping triggers cost one
    // IDR. Placed after sessionIdRef so the compiler lint sees the ref's
    // declaration before this closure captures it.
    useEffect(() => {
        const watchdog = installStallWatchdog(
            () => videoRef.current,
            () => {
                const id = sessionIdRef.current;
                // The boolean matters: a request the shared budget suppressed
                // must not spend the watchdog's per-window cap.
                return id ? requestKeyframe(id) : false;
            },
        );
        const uninstallResume = installBackgroundResume(() => videoRef.current, {
            onForeground: () => {
                const id = sessionIdRef.current;
                if (id) requestKeyframe(id);
                watchdog.openWindow();
            },
        });
        // A transport reattach (ours or the peer's) is the other moment
        // decoder state can have just been lost — session.ts requests the IDR
        // and announces it here, because the watchdog's window is module
        // state it cannot reach. Without this the reattach path had exactly
        // one unverified shot and no escalation.
        const onReattached = (e: Event) => {
            const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
            if (sid && sid === sessionIdRef.current) watchdog.openWindow();
        };
        window.addEventListener('device-media-reattached', onReattached);
        return () => {
            window.removeEventListener('device-media-reattached', onReattached);
            uninstallResume();
            watchdog.uninstall();
        };
    }, []);

    const padButton = useCallback((button: number, down: boolean) => {
        if (down) {
            padPressedRef.current.add(button);
            sendRef.current({ t: 'down', button });
        } else {
            padPressedRef.current.delete(button);
            // NOT the gated send: a press that landed before control was
            // paused must still release, or the host keeps the button down
            // until the session ends. An unmatched up (the press itself was
            // swallowed by the pause gate) is a no-op on every host backend.
            if (sessionIdRef.current) sendInput(sessionIdRef.current, { t: 'up', button });
            // Bypassing `send` means bypassing its release bookkeeping, so the
            // pad tells the auto-keyboard itself — with the same tap test: L
            // held while the trackpad moves the pointer is a drag, not a tap.
            if (button === 0) pressEndHookRef.current?.(movesSincePressRef.current === 0);
        }
    }, []);
    const padWheel = useCallback((dy: number) => { sendRef.current({ t: 'wheel', dy }); }, []);

    // Pointer-lock lifecycle (Game mode). Esc or the browser can drop the lock
    // at any time; track it so relative mode never silently degrades to
    // absolute moves — sending nothing without the lock is deliberate.
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

    // Release the lock when Game mode turns off, the session ends, or the
    // stage unmounts — a lingering lock traps the viewer's cursor with
    // nowhere to send input.
    useEffect(() => {
        if (fpsMode && sessionActiveId) return;
        if (document.pointerLockElement) document.exitPointerLock();
    }, [fpsMode, sessionActiveId]);
    useEffect(() => () => {
        if (document.pointerLockElement) document.exitPointerLock();
    }, []);

    // Release everything we are holding on the host when input can no longer
    // reach us (alt-tab mid-press would otherwise leave the host's button or
    // key held). Keyed on the session id ALONE, through sendRef: with `send`
    // in the deps this tore down and re-ran on every session snapshot, and
    // the cleanup's releaseAll released a genuinely held button mid-hold.
    useEffect(() => {
        if (!sessionActiveId) return;
        const releaseAll = () => {
            for (const button of fpsPressedRef.current) sendRef.current({ t: 'up', button });
            fpsPressedRef.current.clear();
            for (const button of padPressedRef.current) sendRef.current({ t: 'up', button });
            padPressedRef.current.clear();
            for (const code of heldKeysRef.current) sendRef.current({ t: 'key', code, down: false });
            heldKeysRef.current.clear();
            // A gesture interrupted by the app going away never gets its
            // pointerup; the chrome margins it froze must not stay frozen.
            setChromeFrozen(null);
        };
        const onVisibility = () => { if (document.hidden) releaseAll(); };
        window.addEventListener('blur', releaseAll);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('blur', releaseAll);
            document.removeEventListener('visibilitychange', onVisibility);
            releaseAll(); // ending the session must not strand a held button
        };
    }, [sessionActiveId]);

    const adjustFpsSens = (delta: number) => {
        setFpsSens(s => {
            const next = Math.min(FPS_SENS_MAX, Math.max(FPS_SENS_MIN, s + delta));
            saveFpsSens(next);
            return next;
        });
    };

    // THE TRACKPAD.
    //
    // ONE machine for the life of the stage: it owns three timers and the
    // pointer position, so rebuilding it would drop a gesture mid-drag. It is
    // created empty and WIRED UP in an effect, so nothing it needs is read
    // during a render.
    const [gestures] = useState(() => new TouchGestures());

    // FOLLOW THE CURSOR while zoomed in (trackpad mode): solve, on EVERY move,
    // for the pan that puts the pointer at the centre of the viewport — the
    // picture slides under the cursor as it travels. The
    // previous version was edge-triggered with a 20% dead zone and panned only
    // far enough to park the cursor back on the margin line, which read as the
    // camera trailing the cursor and moving only at the edges. Near the remote
    // screen's edges clampPan runs out of pan room and the cursor naturally
    // drifts off-centre toward the edge, which is the right behaviour there.
    // Suppressed during a pinch so it cannot fight a deliberate pan, and
    // clamped with the SAME clamp as the pinch branch. The solve happens
    // against the updater's own `prev`, not transformRef — the ref only
    // refreshes in a passive effect, so two moves landing in one frame would
    // measure against a stale transform and double-apply.
    // COALESCED ONTO THE FRAME CLOCK.
    //
    // A finger emits moves faster than the display refreshes (a 120Hz digitiser
    // against a 60Hz panel), and this used to call setTransform on every one of
    // them. React commits on its own schedule, not the compositor's, so the pan
    // landed at a cadence unrelated to the frames it was panning over: the
    // camera and the picture beat against each other and the drift read as the
    // camera arriving slightly before or slightly after the cursor, never with
    // it. One rAF-batched commit per painted frame puts them on the same clock.
    //
    // The LATEST position wins rather than replaying every intermediate one:
    // where the finger is now is the only interesting answer, and the skipped
    // samples are precisely the ones that would never have been painted.
    //
    // NOTE this cannot fix the OTHER half of "the camera does not match the
    // cursor": the cursor is composited into the video by the host, so what you
    // SEE trails your finger by the pipeline's latency, and a camera that
    // tracks the finger necessarily leads it. Matching that needs the measured
    // round trip, not a guess — see __pucaDeviceDiag().
    const followTargetRef = useRef<{ x: number; y: number } | null>(null);
    const followRafRef = useRef<number | null>(null);

    // MONITOR-HOP pressure: blocked pan travel against a single-monitor
    // view's edge (deviceZoomFollow's accumulator — pure; these are just its
    // storage). Declared here, above BOTH writers that feed it. `hopKick`
    // exists because the one writer that can accumulate without changing the
    // transform — follow-cursor pinned at the clamp returns `prev` unchanged
    // — would otherwise never re-run the trigger effect: crossing the
    // threshold bumps it, and it sits in that effect's deps.
    const hopPressureRef = useRef<HopPressure | null>(null);
    const lastHopAtRef = useRef(0);
    const [hopKick, setHopKick] = useState(0);
    const feedHopPressure = useCallback((pushX: number, pushY: number) => {
        const now = performance.now();
        const prev = hopPressureRef.current;
        const next = accumulateHopPressure(prev, pushX, pushY, now);
        hopPressureRef.current = next;
        if (next && next.px >= HOP_PRESSURE_PX
            && (!prev || prev.px < HOP_PRESSURE_PX || prev.axis !== next.axis || prev.sign !== next.sign)) {
            setHopKick(k => k + 1);
        }
    }, []);

    const applyFollowPan = useCallback(() => {
        followRafRef.current = null;
        const target = followTargetRef.current;
        followTargetRef.current = null;
        if (!target) return;
        // THE LOCKSTEP GUARANTEE, and the reason this write lives here rather
        // than in the sink: the drawn cursor and the camera pan are committed
        // in the SAME frame, from the SAME coordinates. React batches the two
        // setStates in one callback into one render, so no frame can ever show
        // the picture panned to a position the pointer has not reached, or the
        // pointer somewhere the picture has not followed. Splitting them —
        // cursor in the sink, pan here — reintroduces exactly the one-frame
        // disagreement this whole change exists to remove.
        setVirtualCursor(target);
        // THE CARET CAMERA WINS while the keyboard is up. The drawn pointer above
        // still tracks the finger (the lockstep guarantee is untouched); only the
        // CAMERA yields, because two cameras both panning the same viewport
        // produce a picture that answers to neither.
        if (caretActiveRef.current) return;
        if (!followCursorRef.current) return;
        if (activePointers.current.size >= 2) return; // a pinch/pan owns the viewport
        if (transformRef.current.scale <= 1) return;
        const v = videoRef.current;
        const surface = surfaceRef.current;
        if (!v || !surface) return;
        // Canvas-space (pre-transform) position of the pointer.
        const box = pictureBox(v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight);
        if (!box) return;
        const left = box.offX + target.x * box.dispW;
        const top = box.offY + target.y * box.dispH;
        const rect = surface.getBoundingClientRect();
        // MONITOR-HOP dwell feed. The solve below wants the cursor centred;
        // where the clamp refuses, the residual's SIGN says which edge the
        // cursor is pressing (proposed further left than allowed = the user is
        // looking right). No travel to measure — the residual is a position,
        // and summing positions double-counts — so each pinned frame feeds a
        // fixed quantum: ~a quarter second of holding against the edge trips
        // the threshold. Read off transformRef: fine for detection (the exact
        // solve stays inside the updater, as the comment above it demands).
        {
            const t0 = transformRef.current;
            if (t0.scale > 1) {
                const propX = rect.width * 0.5 - left * t0.scale;
                const propY = rect.height * 0.5 - top * t0.scale;
                const c0 = clampPan(v, rect, t0.scale, propX, propY);
                const rx = propX - c0.x;
                const ry = propY - c0.y;
                feedHopPressure(
                    rx < -0.5 ? HOP_EDGE_QUANTUM_PX : rx > 0.5 ? -HOP_EDGE_QUANTUM_PX : 0,
                    ry < -0.5 ? HOP_EDGE_QUANTUM_PX : ry > 0.5 ? -HOP_EDGE_QUANTUM_PX : 0,
                );
            }
        }
        setTransform(prev => {
            if (prev.scale <= 1) return prev;
            const c = clampPan(
                v,
                rect,
                prev.scale,
                rect.width * 0.5 - left * prev.scale,
                rect.height * 0.5 - top * prev.scale,
            );
            if (c.x === prev.x && c.y === prev.y) return prev;
            return { ...prev, x: c.x, y: c.y };
        });
    }, [feedHopPressure]);

    const followPan = useCallback((x: number, y: number) => {
        // THE TRACKPAD'S AIM. Recorded here as well as in `send`, and not as
        // belt-and-braces: this is the position the drawn pointer is committed to
        // in this very frame, whereas the sink's {t:'move'} is subject to the
        // controlEnabled gate and to coalescing. When both fire they carry the
        // same coordinates, so the double write costs nothing and neither site
        // depends on the other existing.
        lastAimRef.current = { x, y };
        caretOnAimRef.current?.();
        // Cheap enough to run per move: the real work waits for the frame.
        // NOT gated on followCursorRef — the drawn cursor must track the
        // finger even when the CAMERA is parked (follow off, or zoomed out).
        // applyFollowPan makes that distinction; dropping the sample here
        // would freeze the pointer for anyone who does not use follow.
        followTargetRef.current = { x, y };
        if (followRafRef.current != null) return;   // a frame is already owed
        followRafRef.current = requestAnimationFrame(applyFollowPan);
    }, [applyFollowPan]);

    // A pending frame must not outlive the stage: it would run against an
    // unmounted surface (and React would warn about the setState).
    useEffect(() => () => {
        if (followRafRef.current != null) {
            cancelAnimationFrame(followRafRef.current);
            followRafRef.current = null;
        }
    }, []);


    useEffect(() => {
        gestures.setSink({
            // NOT inside a setState updater. These once ran inside a
            // cursor-overlay setState, which React StrictMode deliberately
            // invokes twice to expose exactly that — so every move, tap and
            // right-click was sent twice in a dev build.
            move: (x, y) => send({ t: 'move', x, y }),
            button: (button, down) => send({ t: down ? 'down' : 'up', button }),
            wheel: dy => send({ t: 'wheel', dy }),
            cursor: followPan,
        });
    }, [gestures, send, followPan]);
    // Release its timers when the stage goes away.
    useEffect(() => () => gestures.dispose(), [gestures]);

    /** Change input mode and REMEMBER it: a deliberate choice should survive a
     *  rotation, a remount and the next session. */
    const setMouseModeRemembered = useCallback((next: boolean) => {
        if (next === isMouseMode) return;
        // LET GO FIRST. Each mode keeps its own record of what is pressed, and
        // the other mode will not release a button it does not know about — so
        // switching with a finger down stranded it down on the remote machine,
        // which then drag-selects everything the pointer passes over.
        if (touchDownSent.current.size) {
            send({ t: 'up', button: 0 });
            touchDownSent.current.clear();
        }
        gestures.cancel();
        setIsMouseMode(next);
        try {
            localStorage.setItem(MOUSE_MODE_KEY, next ? 'trackpad' : 'touch');
        } catch {
            // Storage unavailable; the mode still applies for this session.
        }
    }, [isMouseMode, send, gestures]);

    /** Same treatment for the virtual dot: turning it back on is a deliberate
     *  choice about a trade-off, so it should not need making twice. */
    const setShowVirtualMouseRemembered = useCallback((next: boolean) => {
        setShowVirtualMouse(next);
        try {
            localStorage.setItem(VIRTUAL_MOUSE_KEY, next ? 'on' : 'off');
        } catch {
            // Storage unavailable; the choice still applies for this session.
        }
    }, []);

    /** And for follow-the-cursor. */
    const setFollowCursorRemembered = useCallback((next: boolean) => {
        setFollowCursor(next);
        try {
            localStorage.setItem(FOLLOW_CURSOR_KEY, next ? 'on' : 'off');
        } catch {
            // Storage unavailable; the choice still applies for this session.
        }
    }, []);

    /** And for zoom-to-the-caret. */
    const setFollowCaretRemembered = useCallback((next: boolean) => {
        setFollowCaret(next);
        try {
            localStorage.setItem(FOLLOW_CARET_KEY, next ? 'on' : 'off');
        } catch {
            // Storage unavailable; the choice still applies for this session.
        }
    }, []);

    /** And for the auto-keyboard. */
    const setAutoKeyboardRemembered = useCallback((next: boolean) => {
        setAutoKeyboard(next);
        try {
            localStorage.setItem(AUTO_KEYBOARD_KEY, next ? 'on' : 'off');
        } catch {
            // Storage unavailable; the choice still applies for this session.
        }
    }, []);

    // THE DRAWN PICTURE'S GEOMETRY, tracked rather than read during render.
    //
    // Zoom-follows-monitor needs to know when the intrinsic size changes —
    // `object-fit: contain` letterboxes the picture, and the box changes on
    // rotation, on a window resize, and when the first frame finally arrives
    // and gives the video intrinsic dimensions.
    const [videoBox, setVideoBox] = useState<{ vw: number; vh: number; w: number; h: number } | null>(null);
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const read = () => {
            setVideoBox({ vw: v.videoWidth, vh: v.videoHeight, w: v.offsetWidth, h: v.offsetHeight });
        };
        read();
        // `resize` on a <video> fires when the INTRINSIC size changes — which is
        // what happens when the host switches to a differently shaped screen.
        v.addEventListener('loadedmetadata', read);
        v.addEventListener('resize', read);
        const ro = new ResizeObserver(read);
        ro.observe(v);
        return () => {
            v.removeEventListener('loadedmetadata', read);
            v.removeEventListener('resize', read);
            ro.disconnect();

        };
    }, [sessionActiveId]);

    // RE-CLAMP WHEN THE BOX CHANGES. The pan clamp is applied by the writers
    // (pinch, wheel, follow-cursor, the caret solve) against the surface as it
    // is AT THAT MOMENT — and on a phone the surface now changes size without
    // any of them running: the keyboard bar and the toolbar reserve their
    // heights (above), so opening the panel, folding its keys, collapsing the
    // bar or rotating resizes the box under a zoomed-in pan that was legal a
    // moment ago. Left alone, the letterbox moves and the picture can end up
    // entirely outside the box — a black stage until the next pinch. `videoBox`
    // is the signal (the <video> fills the surface, so its ResizeObserver sees
    // every box change), and the functional update clamps whatever the
    // transform is by then, including a remap that landed in the same batch.
    // NOT while the caret camera drives: it uses a deliberately relaxed clamp
    // (slack below the picture, so a bottom-row caret can reach the band) that
    // this would undo on every keystroke; it re-solves on box changes itself.
    useEffect(() => {
        if (!videoBox) return;
        if (caretActiveRef.current) return;
        const v = videoRef.current;
        const surface = surfaceRef.current;
        if (!v || !surface) return;
        const rect = surface.getBoundingClientRect();
        // (No set-state-in-effect directive: the rule does not fire on this
        // functional update, and a directive that silences nothing is
        // decoration eslint reports as unused — checked by deleting it.)
        setTransform(prev => {
            if (prev.scale <= 1) return prev;
            const c = clampPan(v, rect, prev.scale, prev.x, prev.y);
            return c.x === prev.x && c.y === prev.y ? prev : { ...prev, x: c.x, y: c.y };
        });
    }, [videoBox]);

    // WHERE TO DRAW OUR POINTER, in the canvas's own (pre-transform) pixels.
    // Null before the first frame: there is no picture to point at yet, and
    // percentages of the ELEMENT put the mark hundreds of pixels off on a
    // phone in portrait, because `object-fit: contain` letterboxes.
    const cursorBox = videoBox
        ? pictureBox(videoBox.vw, videoBox.vh, videoBox.w, videoBox.h)
        : null;
    const cursorAt = cursorBox
        ? {
            left: cursorBox.offX + virtualCursor.x * cursorBox.dispW,
            top: cursorBox.offY + virtualCursor.y * cursorBox.dispH,
        }
        : null;

    // KEEP THE TRACKPAD'S SURFACE CURRENT. Before this, `gestures.setSurface`
    // was only called from pointer handlers — so a finger already down when
    // the first frame arrives (video had no size yet, `pictureBox` was null)
    // stayed silently inert until the NEXT pointerdown, with nothing logged.
    // Driving it off `videoBox` instead re-derives it the moment the picture
    // gets a size, independent of any touch happening.
    useEffect(() => {
        if (!isMobile || !isMouseMode) return;
        const v = videoRef.current;
        if (v) gestures.setSurface(gestureSurface(v, transformRef.current.scale));
    }, [isMobile, isMouseMode, gestures, videoBox]);

    // ASK THE HOST FOR THE CURSOR while driving by trackpad.
    //
    // Only in trackpad mode: that is the mode where the pointer is steered
    // relatively and the camera follows it, so a pointer that lags the finger
    // is the whole complaint. Touch mode teleports the pointer to wherever a
    // finger lands, where the host's own cursor is the honest thing to show.
    // Handing it back on the way out (and at teardown, below) matters as much
    // as taking it: a host left not drawing its cursor would show ITS user a
    // machine with no pointer.
    const cursorOwned = session?.cursorOwned === true;
    useEffect(() => {
        if (!sessionActiveId) return;
        const want = isMobile && isMouseMode;
        setCursorOwned(sessionActiveId, want);
        return () => {
            // Best effort: if the session is already gone this is a no-op,
            // and the host's capture dies with it either way.
            if (want) setCursorOwned(sessionActiveId, false);
        };
    }, [sessionActiveId, isMobile, isMouseMode]);

    // --- ZOOM FOLLOWS THE MONITOR (All Displays only) --------------------
    // The composite is integer-stepped down to fit the encoder cap
    // (composite.rs), so zooming into it magnifies quarter-res pixels. Cross
    // the threshold over one screen and the capture FOLLOWS it at native
    // resolution — the agent swaps the source under the live encoder, no
    // renegotiation — and zooming fully back out returns the composite,
    // remapped both ways so nothing visually jumps and nothing needs
    // reselecting. Auto-entries only: a screen chosen by hand in the picker
    // stays chosen. All of it is inert when the host never sent monitor
    // geometry (old host, webview host) — monitorRegions returns null.
    const autoFollowRef = useRef<{ mode: 'none' } | { mode: 'single'; monitorId: number }>({ mode: 'none' });
    const pendingFollowRef = useRef<{
        expectMonitor: number;
        becomes: { mode: 'none' } | { mode: 'single'; monitorId: number };
        fromVw: number;
        fromVh: number;
        remap: (to: ZoomView) => { scale: number; x: number; y: number };
        fallback: number;
        deadline: number;
        /** performance.now() at request, for the [zoom-follow] timing line —
         *  the number that says whether the agent-side switch work landed. */
        startedAt: number;
    } | null>(null);
    /** Mirror of session.activeMonitor for callbacks that must read it fresh. */
    const activeMonitorRef = useRef<number | null>(null);
    /** The screen change THIS feature asked for, outliving the pending entry:
     *  the demotion effect needs it to recognise the auto-switch's own
     *  confirmation, which can be observed in the same render that consumed
     *  the pending (resize-before-confirm ordering — media is peer-to-peer,
     *  the confirm rides the relay). Without it, auto mode was destroyed by
     *  its own success and zoom-out never returned to the composite. */
    const expectedAutoMonitorRef = useRef<number | null>(null);
    /** A manual "All displays" pick made while zoomed holds the in-trigger
     *  off until the user drops below the threshold — otherwise the level
     *  check re-followed a screen ~300ms after the person explicitly chose
     *  the grid. Cleared by zooming out below ZOOM_FOLLOW_IN. */
    // The scale at which the user last chose "All displays" by hand while
    // zoomed in, or null for no hold. A SCALE rather than a boolean: the hold
    // has to end when they zoom further in, and a boolean has nothing to
    // compare against. See manualCompositeHoldActive.
    const manualCompositeHoldRef = useRef<number | null>(null);
    /** Late-frame correction: a remap that had to run before the new
     *  capture's first frame arrived (same-size switch fallback, or a
     *  confirm that outlived the deadline) is re-run once with honest
     *  dimensions when the frame finally lands. */
    const followCorrectionRef = useRef<{
        expectMonitor: number;
        remap: (to: ZoomView) => { scale: number; x: number; y: number };
        until: number;
        /** What the switch MEANS for auto mode, carried along so a confirm
         *  that outlives the pending deadline still records it. Without this
         *  a slow switch (a busy phone link, a composite that takes its time
         *  to build) landed the view correctly but left auto mode 'none' —
         *  and zooming out then never returned to All Displays. */
        becomes: { mode: 'none' } | { mode: 'single'; monitorId: number };
    } | null>(null);

    const clearPendingFollow = useCallback(() => {
        const p = pendingFollowRef.current;
        if (!p) return;
        clearTimeout(p.fallback);
        clearTimeout(p.deadline);
        pendingFollowRef.current = null;
    }, []);

    const applyPendingFollow = useCallback(() => {
        const p = pendingFollowRef.current;
        const v = videoRef.current;
        if (!p || !v || !v.videoWidth || !v.offsetWidth) return;
        // Never remap until the HOST confirmed the switch — a remap computed
        // for the new capture but applied over the old one aims at nothing.
        if (activeMonitorRef.current !== p.expectMonitor) return;
        const pict = pictureBox(v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight);
        if (!pict) return;
        const to: ZoomView = { pict, videoW: v.videoWidth, videoH: v.videoHeight };
        const next = p.remap(to);
        console.debug(`[zoom-follow] applied ${Math.round(performance.now() - p.startedAt)}ms after request (monitor ${p.expectMonitor})`);
        autoFollowRef.current = p.becomes;
        // Applying with UNCHANGED dimensions can mean two things: a genuine
        // same-size switch (correct), or the new capture's first frame is
        // simply late (the remap just aimed at the old frame). Keep the
        // remap around so the eventual resize re-runs it with the truth.
        followCorrectionRef.current =
            v.videoWidth === p.fromVw && v.videoHeight === p.fromVh
                ? { expectMonitor: p.expectMonitor, remap: p.remap, until: Date.now() + 5_000, becomes: p.becomes }
                : null;
        clearPendingFollow();
        setTransform(next);
    }, [clearPendingFollow]);

    // Apply the pending remap once the switch is CONFIRMED and the intrinsic
    // frame size has actually become the new capture's. The fallback timer in
    // the pending entry covers the exotic same-dimensions switch, where no
    // resize event ever fires.
    useEffect(() => {
        activeMonitorRef.current = session?.activeMonitor ?? null;
        const p = pendingFollowRef.current;
        if (session && p && session.activeMonitor === p.expectMonitor
            && videoBox && (videoBox.vw !== p.fromVw || videoBox.vh !== p.fromVh)) {
            applyPendingFollow();
            return;
        }
        // A correction left behind by a dims-unchanged apply: re-run it once
        // the real frame arrives, while the switch it belongs to still holds.
        const c = followCorrectionRef.current;
        if (c && session && session.activeMonitor === c.expectMonitor && !pendingFollowRef.current) {
            if (Date.now() > c.until) {
                followCorrectionRef.current = null;
                return;
            }
            const v = videoRef.current;
            const pict = v && v.videoWidth && v.offsetWidth
                ? pictureBox(v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight)
                : null;
            if (v && pict) {
                followCorrectionRef.current = null;
                // The mode travels with the remap: a switch this feature asked
                // for is an AUTO switch however late its confirmation came, or
                // the way back out is lost.
                autoFollowRef.current = c.becomes;
                setTransform(c.remap({ pict, videoW: v.videoWidth, videoH: v.videoHeight }));
            }
        }
    }, [videoBox, session?.activeMonitor, session, applyPendingFollow]);

    // A screen change this feature did not ask for — the picker, the mobile
    // menu, the host itself — always wins: drop any pending auto switch and
    // fall back to manual semantics until the next threshold crossing. The
    // auto-switch's OWN confirmation is recognised via expectedAutoMonitorRef
    // (not via the pending entry, which the apply effect above may already
    // have consumed in this very render).
    const lastActiveMonitorRef = useRef<number | null>(null);
    useEffect(() => {
        const active = session?.activeMonitor ?? null;
        const prev = lastActiveMonitorRef.current;
        lastActiveMonitorRef.current = active;
        if (active === null || active === prev) return;
        if (expectedAutoMonitorRef.current === active) {
            expectedAutoMonitorRef.current = null; // ours — consumed
            return;
        }
        expectedAutoMonitorRef.current = null;
        clearPendingFollow();
        followCorrectionRef.current = null;
        autoFollowRef.current = { mode: 'none' };
        // Pressure was pushed against a screen that is no longer on the
        // stage; carrying it over would let a pick from the menu instantly
        // hop off the newly chosen screen.
        hopPressureRef.current = null;
        // An EXPLICIT return to the grid while still zoomed must stick, or the
        // level check would re-follow a screen 300ms after the person chose the
        // composite on purpose. Recorded as the scale it was chosen AT, so
        // zooming further in later reads as fresh intent and releases it.
        if (active === ALL_DISPLAYS) manualCompositeHoldRef.current = transformRef.current.scale;
    }, [session?.activeMonitor, session?.id, clearPendingFollow, session]);

    // A NEW session must not inherit any of this: a pending switch from an
    // ended session applying its stale remap to the next session's video was
    // a confirmed review finding.
    useEffect(() => {
        clearPendingFollow();
        followCorrectionRef.current = null;
        expectedAutoMonitorRef.current = null;
        manualCompositeHoldRef.current = null;
        autoFollowRef.current = { mode: 'none' };
        hopPressureRef.current = null;
        lastHopAtRef.current = 0;
    }, [session?.id, clearPendingFollow]);

    // EVERY SCREEN BY DEFAULT — the viewer's half. A host from 0.8.104 on
    // starts a multi-monitor machine on the composite itself (session.ts,
    // before startSession) and announces `active: 255`, and this never fires.
    // An older ARMED host starts on output 0; once per session, after the
    // FIRST FRAME (the agent only has a stream to switch once it has answered
    // the offer — a request before that is refused, and the refusal is a
    // banner), ask for the composite exactly as tapping "All" in the picker
    // would. UNATTENDED ONLY: on an attended host the starting screen is what
    // the person sitting there picked in the consent prompt, and a viewer
    // that silently widened "Display 2" to every screen would be overriding
    // a choice made at the machine. The decision itself is
    // initialMonitorRequest's; it only ever asks an agent host (geometry on
    // every screen), never a webview host whose setMonitor rejects. The
    // resulting `activeMonitor` change reads to the effect above as a manual
    // pick at scale 1, which holds nothing.
    //
    // NEVER OVER A PICK THE VIEWER ALREADY MADE. The screens are announced
    // seconds before the first frame can land (an armed host's displays may
    // take up to 8 s to wake), and the picker is live the whole time — so the
    // screen the host FIRST announced is remembered, and a different one at
    // the first frame means the viewer chose it. A Set of session ids, not a
    // single latch: the stage shows the newest live session, and falling back
    // to an older one (its successor ended) must not ask it a second time.
    const initialMonitorAskedRef = useRef<Set<string>>(new Set());
    const firstAnnouncedMonitorRef = useRef<{ id: string; active: number } | null>(null);
    useEffect(() => {
        if (!session || session.activeMonitor === null) return;
        const first = firstAnnouncedMonitorRef.current;
        if (!first || first.id !== session.id) {
            firstAnnouncedMonitorRef.current = { id: session.id, active: session.activeMonitor };
        }
    }, [session]);
    useEffect(() => {
        if (!session || !videoBox || videoBox.vw <= 0) return;
        if (initialMonitorAskedRef.current.has(session.id)) return;
        if (session.monitors.length === 0 || session.activeMonitor === null) return;
        initialMonitorAskedRef.current.add(session.id);
        if (!session.unattended) return;
        const first = firstAnnouncedMonitorRef.current;
        if (first && first.id === session.id && first.active !== session.activeMonitor) return;
        const want = initialMonitorRequest(session.monitors, session.activeMonitor);
        if (want !== null) requestMonitor(session.id, want);
    }, [session, videoBox]);

    // Trigger evaluation, debounced past the pinch: level-based, so it
    // cannot flap (see deviceZoomFollow.ts for the hysteresis story).
    useEffect(() => {
        if (!session || pointerLocked) return;
        const timer = setTimeout(() => {
            const s = session;
            if (!s || pendingFollowRef.current) return;
            const v = videoRef.current;
            if (!v || !v.videoWidth || !v.offsetWidth) return;
            const box = { w: v.offsetWidth, h: v.offsetHeight };
            const fromPict = pictureBox(v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight);
            if (!fromPict) return;
            const from: ZoomView = { pict: fromPict, videoW: v.videoWidth, videoH: v.videoHeight };
            const t = transformRef.current;
            // Release a manual "All displays" hold once the user shows fresh
            // intent — either direction. Zooming FURTHER IN counts, and must:
            // the composite is sampled down, so a held high zoom is exactly the
            // blurry picture someone answers by zooming in more.
            if (manualCompositeHoldRef.current !== null
                && !manualCompositeHoldActive(manualCompositeHoldRef.current, t.scale)) {
                manualCompositeHoldRef.current = null;
            }
            const begin = (
                expectMonitor: number,
                becomes: { mode: 'none' } | { mode: 'single'; monitorId: number },
                remap: (to: ZoomView) => { scale: number; x: number; y: number },
            ) => {
                expectedAutoMonitorRef.current = expectMonitor;
                pendingFollowRef.current = {
                    expectMonitor, becomes, remap,
                    fromVw: v.videoWidth, fromVh: v.videoHeight,
                    startedAt: performance.now(),
                    // The fallback covers a same-size switch, where no resize
                    // ever fires; a LATE frame instead of a same-size one is
                    // healed by the correction the apply leaves behind
                    // (followCorrectionRef) — which is why 350ms is safe where
                    // 900 once sat: a blind apply against a late frame is
                    // repaired the moment the real one lands, and the shorter
                    // wait is over half a second off every same-size switch.
                    fallback: window.setTimeout(applyPendingFollow, 350),
                    deadline: window.setTimeout(() => {
                        // The switch may still confirm after we stop waiting:
                        // leave the remap as a correction so a late confirm +
                        // frame still lands the view in the right space.
                        const p = pendingFollowRef.current;
                        if (p) {
                            followCorrectionRef.current = {
                                expectMonitor: p.expectMonitor,
                                remap: p.remap,
                                until: Date.now() + 4_000,
                                becomes: p.becomes,
                            };
                        }
                        clearPendingFollow();
                    }, 3500),
                };
                requestMonitor(s.id, expectMonitor);
            };

            if (s.activeMonitor === ALL_DISPLAYS) {
                if (t.scale < ZOOM_FOLLOW_IN || manualCompositeHoldRef.current !== null) return;
                const regions = monitorRegions(s.monitors, from.videoW, from.videoH);
                if (!regions) return;
                const target = pickFollowTarget(viewportInVideo(box, from, t), regions);
                if (target === null || target === ALL_DISPLAYS) return;
                const region = regions.find(r => r.id === target);
                if (!region) return;
                begin(target, { mode: 'single', monitorId: target },
                    to => remapIntoMonitor({ box, from, fromTransform: t, region, to, maxZoom: MAX_ZOOM }));
            } else if (
                autoFollowRef.current.mode === 'single'
                && s.activeMonitor === autoFollowRef.current.monitorId
                && t.scale <= ZOOM_FOLLOW_OUT_AT
            ) {
                const monitorId = autoFollowRef.current.monitorId;
                begin(ALL_DISPLAYS, { mode: 'none' }, to => {
                    const regions = monitorRegions(s.monitors, to.videoW, to.videoH);
                    const region = regions?.find(r => r.id === monitorId);
                    // Layout unknown on the way back: land on the whole grid.
                    if (!region) return { scale: 1, x: 0, y: 0 };
                    return remapIntoComposite({ box, from, fromTransform: t, region, to });
                });
            } else if (s.activeMonitor !== null && s.activeMonitor !== ALL_DISPLAYS
                && t.scale >= HOP_MIN_SCALE) {
                // MONITOR-HOP: enough pan pushed into this screen's edge,
                // recently, past the cooldown — switch to the neighbour on
                // the far side of that edge and land physically continuous,
                // half a viewport inside it. Works from an auto-followed AND
                // a hand-picked screen; `becomes` preserves which, so a hop
                // from a manual pick never surprise-returns to the composite
                // on zoom-out, while a hop from an auto follow still does.
                const p = hopPressureRef.current;
                const now = performance.now();
                if (!p || p.px < HOP_PRESSURE_PX || now - p.at > HOP_PRESSURE_TTL_MS) return;
                if (now - lastHopAtRef.current < HOP_COOLDOWN_MS) return;
                const dir = hopDirection(p);
                const neighbour = monitorNeighbour(s.monitors, s.activeMonitor, dir);
                if (neighbour === null) return;
                const fromMon = s.monitors.find(m => m.id === s.activeMonitor);
                const toMon = s.monitors.find(m => m.id === neighbour);
                // monitorNeighbour only answers from fully-measured geometry,
                // so these casts hold whenever it answered at all.
                if (!fromMon || !toMon) return;
                hopPressureRef.current = null;
                lastHopAtRef.current = now;
                const becomes = autoFollowRef.current.mode === 'single'
                    ? { mode: 'single' as const, monitorId: neighbour }
                    : { mode: 'none' as const };
                begin(neighbour, becomes, to => remapAcrossBoundary({
                    box, from, fromTransform: t,
                    fromMon: fromMon as Required<MonitorGeom>,
                    toMon: toMon as Required<MonitorGeom>,
                    dir, to, maxZoom: MAX_ZOOM,
                }));
            }
        // 120ms, down from 180: the timer re-arms per transform change, so it
        // already fires N ms after the LAST pinch movement — this keeps the
        // flap protection while shaving 60ms off every zoom-to-read.
        }, 120);
        return () => clearTimeout(timer);
    }, [transform, hopKick, session, pointerLocked, applyPendingFollow, clearPendingFollow]);

    // --- ZOOM TO THE TEXT CARET WHILE TYPING (mobile) --------------------
    //
    // The phone shows a whole desktop in a 390px strip and the soft keyboard
    // covers the bottom 40-55% of it, so the remote caret is both tiny and
    // usually hidden. While the keyboard panel is up, the agent reports the
    // caret's position as fractions of whatever surface it is capturing and the
    // pure solver in deviceZoomFollow.ts turns that into a transform that puts
    // the caret's LINE at a readable size inside the visible band.
    //
    // Everything that DECIDES anything is in that module or in keyboardInset.ts;
    // this section is plumbing — refs, one rAF, one setTransform — because
    // DeviceStage is never mounted in a test and a decision made here could not
    // be pinned.
    //
    // Placed below zoom-follows-monitor rather than above it (where the feature
    // reads more naturally) for one mechanical reason: the caret's stale-frame
    // filter reads activeMonitorRef, which that section declares.

    /** The extra-keys bar's measured height, from KeyboardOverlay's own
     *  ResizeObserver. MEASURED, never assumed: that bar was ~190px unfolded
     *  for as long as mobile.css's bare `button { min-height: 44px }` beat
     *  .keyboard-btn (which now sets its own), and it changes when the user
     *  folds it. The stage reserves exactly this much of the picture for it. */
    const [keyBarH, setKeyBarH] = useState(0);
    /** The bottom toolbar's measured height (0 while collapsed / unmounted).
     *  Same contract as keyBarH: MobileToolbar reports it from its own
     *  ResizeObserver. Both feed the surface's margins below, so the picture
     *  is laid out BETWEEN the chrome rather than underneath it. */
    const [toolbarH, setToolbarH] = useState(0);
    const [kbInset, setKbInset] = useState<KeyboardInset>(currentKeyboardInset);
    useEffect(() => watchKeyboardInset(setKbInset), []);

    /** The visible band of picture, in SURFACE px, or null when there is not
     *  enough of it to aim at. Decided by the pure `caretBandFrom`; this is only
     *  the measurement that feeds it.
     *
     *  STATE FROM AN EFFECT, not a useMemo: the band can only be read from the
     *  DOM after layout, and reading a ref during render is exactly what the
     *  react-hooks/refs rule forbids (and would be wrong here — the rect the
     *  render sees is the one BEFORE this commit's layout). */
    const [caretBand, setCaretBand] = useState<{ top: number; bottom: number } | null>(null);
    useEffect(() => {
        // videoBox is both a value and the TRIGGER: the surface rect changes on
        // rotation and when the picture first gets a size, and nothing else
        // notifies us of either. A band with no picture in it is also nothing to
        // aim at.
        const rect = videoBox ? surfaceRef.current?.getBoundingClientRect() ?? null : null;
        const next = caretBandFrom(rect, keyBarH, kbInset.top);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- a MEASUREMENT of the laid-out surface, which is the "synchronise with an external system" case; the compare below makes it converge in one pass
        setCaretBand(prev => (
            prev === next
            || (prev !== null && next !== null && prev.top === next.top && prev.bottom === next.bottom)
        ) ? prev : next);
    }, [keyBarH, kbInset.top, videoBox]);
    const caretBandRef = useRef(caretBand);
    useEffect(() => { caretBandRef.current = caretBand; }, [caretBand]);

    /** The latest caret worth solving for — a real report, or the pointer
     *  fallback's stand-in. */
    const caretReportRef = useRef<CaretReport | null>(null);
    const caretRafRef = useRef<number | null>(null);
    /** Solve from scratch on the next pass: first placement, a band change, a
     *  surface change, or a tap while the peer is silent. */
    const caretForceRef = useRef(false);
    const caretGraceRef = useRef<number | null>(null);
    /** Was the band up on the previous render? Drives the deactivate restore. */
    const caretWasActiveRef = useRef(false);
    /** When a vis:true report last arrived (0 = never this activation). */
    const caretSawVisRef = useRef(0);
    /** The agent's surface generation, so a rebuild forces a re-place. */
    const caretSurfRef = useRef<number | null>(null);
    /** The view to give back when the keyboard closes. */
    const preCaretViewRef = useRef<{
        transform: { scale: number; x: number; y: number };
        activeMonitor: number | null;
        videoW: number;
        videoH: number;
    } | null>(null);
    /** The user pinched while the caret camera was driving: their zoom wins, and
     *  closing the keyboard must not undo it. */
    const userZoomedDuringCaretRef = useRef(false);
    const caretFallbackUsedRef = useRef(false);
    const caretSolvedScaleRef = useRef<number | null>(null);
    /** Frames dropped as belonging to a surface this end is not watching, and
     *  surface generations seen — a `surf` change is not a drop, it is a forced
     *  re-place, and calling it one in the diagnostic would send whoever reads it
     *  looking for a bug. */
    const caretDropRef = useRef({ mon: 0, surfChanged: 0 });

    const applyCaretFollow = useCallback(() => {
        caretRafRef.current = null;
        const caret = caretReportRef.current;
        if (!caret || !caret.vis) return;
        if (!caretActiveRef.current || !followCaretRef.current) return;
        if (activePointers.current.size >= 2) return;   // a pinch/pan owns the viewport
        const band = caretBandRef.current;
        if (!band) return;
        const v = videoRef.current;
        const surface = surfaceRef.current;
        if (!v || !surface) return;
        // Measured fresh inside the rAF, exactly as applyFollowPan does: after a
        // monitor switch `videoWidth` changes several frames after the host's
        // confirmation, and a stale letterbox mis-SCALES the caret even though
        // fractions cannot mis-place it.
        const pict = pictureBox(v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight);
        if (!pict) return;
        const rect = surface.getBoundingClientRect();
        const next = caretFollowTransform({
            box: { w: rect.width, h: rect.height },
            strip: band,
            view: { pict, videoW: v.videoWidth, videoH: v.videoHeight },
            current: transformRef.current,
            caret: { x: caret.x, y: caret.y, w: caret.w, h: caret.h, src: caret.src },
            force: caretForceRef.current,
            userDrove: userZoomedDuringCaretRef.current,
            minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
        });
        if (!next) return;
        caretForceRef.current = false;
        caretSolvedScaleRef.current = next.scale;
        // The updater stays PURE — no ref writes, no sends. React StrictMode
        // invokes it twice on purpose, which is how every move, tap and
        // right-click once shipped twice.
        setTransform(prev =>
            next.scale === prev.scale && next.x === prev.x && next.y === prev.y ? prev : next);
    }, []);

    const scheduleCaretSolve = useCallback(() => {
        if (caretRafRef.current == null) caretRafRef.current = requestAnimationFrame(applyCaretFollow);
    }, [applyCaretFollow]);

    /** Place using where this end last aimed — the answer for every peer that
     *  cannot report a caret. `h: 0` deliberately: the solver owns the assumed
     *  line height, so there is one definition of it. */
    const caretPlaceOnAim = useCallback(() => {
        const aim = lastAimRef.current;
        caretReportRef.current = {
            vis: true, x: aim.x, y: aim.y, w: 0, h: 0,
            src: null, mon: null, surf: null, seq: null,
        };
        caretFallbackUsedRef.current = true;
        caretForceRef.current = true;
        scheduleCaretSolve();
    }, [scheduleCaretSolve]);

    // `isMobile` is the FIRST conjunct and that is the whole desktop story:
    // activeMobileMenu is only ever written by MobileToolbar, which renders
    // behind isMobile, so a desktop viewer never asks, never subscribes and never
    // writes a transform. `kbInset.visible` rather than "the overlay is mounted":
    // the panel is deliberately not dismissed by the backdrop and has a "Tap to
    // type" re-raise, so mounted is not the same as an IME being up — a
    // back-gesture dismissal, a hardware keyboard or DeX must all stop the
    // follow.
    const caretFollowActive = isMobile && followCaret && activeMobileMenu === 'keyboard'
        && kbInset.visible && sessionActiveId !== null;

    // --- THE CARET CHANNEL, tracked for as long as anything here wants it ---
    //
    // Two consumers, one `track on` to the host: the camera (only while the
    // keyboard panel is up) and the auto-keyboard below (for the whole session,
    // on a phone). Tracking used to be owned by the camera's own effect and
    // switched on with the panel; the auto-keyboard needs the caret's state
    // BEFORE the tap that opens the panel, so the ask moves out here and stays
    // on. A view-only share never asks for the auto-keyboard's sake: it cannot
    // type, so there is nothing to open.
    //
    // `lastCaretRef` is the remote caret's CURRENT state while tracking is on —
    // the agent reports only on change, so the last report is the truth — and
    // null while it is off, so a stale caret from minutes ago can never seed
    // the camera or be mistaken for "what was there before this tap".
    const autoKeyboardWanted = isMobile && autoKeyboard && sessionActiveId !== null
        && session?.viewOnly !== true;
    const wantCaretTracking = autoKeyboardWanted || caretFollowActive;
    const lastCaretRef = useRef<CaretReport | null>(null);
    /** The auto-keyboard's report sink; a slot for the same reason as
     *  caretOnAimRef — the subscription below outlives any one render of the
     *  feature and must not be re-created when its closure changes. */
    const autoKeyboardSinkRef = useRef<((r: CaretReport, before: CaretReport | null) => void) | null>(null);
    /** Reports dropped as belonging to a monitor this end is not watching —
     *  counted at the one subscription and read by the diagnostic. */
    const caretMonDropRef = useRef(0);
    // `session?.activeMonitor` IS a dependency, and that is load-bearing: on a
    // monitor switch the agent sends exactly ONE report for the new surface
    // (it clears its dedupe key on the commit) — on the DIRECT channel, while
    // `monitor-active` rides the relay — so that report can land while this end
    // still thinks it is watching the old screen and be dropped by the filter
    // below. The agent then reports only on change, so nothing corrects it:
    // `lastCaretRef` would hold fractions of the wrong surface for as long as
    // the remote caret sits still. Re-running here turns tracking off and on
    // (`caret_last_sent` is reset on the host, which answers with the current
    // state within ~100 ms) and clears what was known.
    const activeMonitorForTracking = session?.activeMonitor ?? null;
    useEffect(() => {
        if (!wantCaretTracking || !sessionActiveId) return;
        setCaretTracking(sessionActiveId, true);
        const unsub = subscribeCaret(sessionActiveId, r => {
            // A frame sampled on a surface this end is not watching would fly
            // the camera to a fraction of the WRONG screen, and would tell the
            // auto-keyboard a caret is somewhere it is not. The data channel is
            // direct while `monitor-active` rides the relay, so this happens in
            // both directions and neither order can be assumed.
            const active = activeMonitorRef.current;
            if (r.mon !== null && active !== null && r.mon !== active) {
                caretMonDropRef.current++;
                return;
            }
            const before = lastCaretRef.current;
            lastCaretRef.current = r;
            autoKeyboardSinkRef.current?.(r, before);
        });
        return () => {
            unsub();
            setCaretTracking(sessionActiveId, false);
            lastCaretRef.current = null;
        };
    }, [wantCaretTracking, sessionActiveId, activeMonitorForTracking]);

    useEffect(() => {
        caretActiveRef.current = caretFollowActive;
        if (!caretFollowActive || !sessionActiveId) return;
        const v = videoRef.current;
        preCaretViewRef.current = {
            transform: transformRef.current,
            activeMonitor: activeMonitorRef.current,
            videoW: v?.videoWidth ?? 0,
            videoH: v?.videoHeight ?? 0,
        };
        userZoomedDuringCaretRef.current = false;
        caretFallbackUsedRef.current = false;
        caretForceRef.current = true;
        caretSawVisRef.current = 0;
        caretSurfRef.current = null;
        caretDropRef.current = { mon: 0, surfChanged: 0 };

        const accept = (r: CaretReport) => {
            // A capture rebuild or a committed SetMonitor bumps `surf`: the
            // fractions mean something different now, so re-place rather than
            // letting the dead zone suppress the move.
            if (r.surf !== null) {
                if (caretSurfRef.current !== null && r.surf !== caretSurfRef.current) {
                    caretDropRef.current.surfChanged++;
                    caretForceRef.current = true;
                }
                caretSurfRef.current = r.surf;
            }
            // vis:false is meaningful — the caret went away (focus moved to a
            // button, or it is on a screen that is not being streamed). HOLD the
            // view; never re-solve to nothing, and never say anything on screen.
            // It does NOT disarm the fallback either: "no caret here" still
            // deserves a readable band.
            if (!r.vis) return;
            caretSawVisRef.current = Date.now();
            if (caretGraceRef.current != null) {
                clearTimeout(caretGraceRef.current);
                caretGraceRef.current = null;
            }
            caretReportRef.current = r;
            scheduleCaretSolve();
        };
        // Its own subscription (the channel fans out), with the same monitor
        // filter as the tracking one: a report from a screen this end is not
        // watching is dropped, and counted, up there.
        const unsub = subscribeCaret(sessionActiveId, r => {
            const active = activeMonitorRef.current;
            if (r.mon !== null && active !== null && r.mon !== active) {
                caretDropRef.current.mon++;
                return;
            }
            accept(r);
        });

        // SEED FROM WHAT IS ALREADY KNOWN. With the channel tracking for the
        // auto-keyboard's sake, opening the panel sends no fresh `track on` and
        // the agent (which reports only on change) may stay silent for as long
        // as the caret sits still — so without this the grace timer below would
        // fall back to the pointer while the agent knew exactly where the caret
        // was. null when tracking was off until this moment: the ACK and the
        // first real report then arrive the old way.
        const known = lastCaretRef.current;
        if (known && (known.mon === null || known.mon === activeMonitorRef.current)) accept(known);

        // NOBODY ANSWERED — see CARET_REPORT_GRACE_MS. Disarmed only by a real
        // vis:true report, because that is the only proof the peer can find a
        // caret at all.
        caretGraceRef.current = window.setTimeout(() => {
            caretGraceRef.current = null;
            if (caretSawVisRef.current !== 0) return;
            caretPlaceOnAim();
        }, CARET_REPORT_GRACE_MS);

        // While the peer is silent, a tap IS the caret: the user just put it
        // there. Suppressed as soon as real reports are flowing, so a well-behaved
        // agent's caret is never overridden by where a finger landed.
        caretOnAimRef.current = () => {
            if (Date.now() - caretSawVisRef.current < CARET_VIS_FRESH_MS) return;
            caretPlaceOnAim();
        };

        return () => {
            caretOnAimRef.current = null;
            unsub();
            if (caretGraceRef.current != null) {
                clearTimeout(caretGraceRef.current);
                caretGraceRef.current = null;
            }
            if (caretRafRef.current != null) {
                cancelAnimationFrame(caretRafRef.current);
                caretRafRef.current = null;
            }
            caretReportRef.current = null;
            caretForceRef.current = false;
        };
    }, [caretFollowActive, sessionActiveId, scheduleCaretSolve, caretPlaceOnAim]);

    // --- OPEN THE KEYBOARD WHEN A TAP LANDS IN A TEXT BOX (mobile) ----------
    //
    // The stage cannot hit-test the remote screen. What it has is the press it
    // just sent (where, when — via pressHookRef in `send`) and the caret
    // reports flowing on the channel above; deviceAutoKeyboard.ts decides, in
    // two places:
    //
    //  - AT THE PRESS, against the caret already known: a tap onto a field
    //    that already has focus changes nothing on the host and no report
    //    will ever come. The verdict is computed at the press and ACTED ON AT
    //    ITS RELEASE, if the gesture turned out to be a tap (no pointer
    //    movement went out in between — a drag-select, a window move or a
    //    pinch's first finger is not a tap into a field). The release is
    //    still the tap's own gesture, so the panel it mounts focuses its
    //    field while Blink raises the IME for free.
    //  - ON A REPORT within the press window: the press put a caret where
    //    there was none, or moved it — onto the finger's line. This is long
    //    after the gesture, so the raise also bumps `kbRaiseToken` and the
    //    panel brings the IME up through the native show. A press whose
    //    gesture became a drag is forgotten, so a drag never raises.
    //
    // ONE RAISE PER PRESS: the press is consumed on a raise, so the caret
    // moving again while the user types (which happens on every keystroke)
    // cannot keep re-raising. The diagnostic keeps the last verdicts, because
    // a keyboard that opens when it should not, or does not when it should,
    // is only diagnosable from the phone's "Copy diagnostics".
    const [kbRaiseToken, setKbRaiseToken] = useState(0);
    const pressRef = useRef<Press | null>(null);
    /** The at-press verdict, awaiting the release that says it was a tap. */
    const pendingAtPressRef = useRef<AutoKeyboardVerdict | null>(null);
    const autoKbDiagRef = useRef<{
        atPress: AutoKeyboardVerdict | null;
        onReport: AutoKeyboardVerdict | null;
        press: Press | null;
        raised: number;
        dropped: number;
    }>({ atPress: null, onReport: null, press: null, raised: 0, dropped: 0 });
    /** The captured surface in desktop px — what the caret fractions are OF
     *  — so the decision's tolerances can be pixels (a third of one screen,
     *  not a third of a three-screen composite). From the host's announced
     *  geometry; a host that reported none is assumed 1920x1080. A ref: the
     *  verdicts run inside pointer handlers and channel callbacks. */
    const surfaceSizeRef = useRef<SurfaceSize | null>(null);
    useEffect(() => {
        surfaceSizeRef.current = session
            ? captureSurfaceSize(session.monitors, session.activeMonitor)
            : null;
    }, [session]);
    useEffect(() => {
        if (!autoKeyboardWanted) {
            pressRef.current = null;
            pendingAtPressRef.current = null;
            return;
        }
        const raise = () => {
            pressRef.current = null;
            pendingAtPressRef.current = null;
            autoKbDiagRef.current.raised++;
            setActiveMobileMenu('keyboard');
            setKbRaiseToken(t => t + 1);
        };
        pressHookRef.current = aim => {
            const press = { x: aim.x, y: aim.y, at: Date.now() };
            autoKbDiagRef.current.press = press;
            const now = autoKeyboardVerdictAtPress({
                press, known: lastCaretRef.current, surface: surfaceSizeRef.current,
            });
            autoKbDiagRef.current.atPress = now;
            pendingAtPressRef.current = now;
            pressRef.current = press;
        };
        pressEndHookRef.current = wasTap => {
            const pending = pendingAtPressRef.current;
            pendingAtPressRef.current = null;
            if (!wasTap) {
                // A drag. Not a tap into a field, whatever the caret does next.
                if (pressRef.current) autoKbDiagRef.current.dropped++;
                pressRef.current = null;
                return;
            }
            if (pending?.raise) raise();
        };
        pressCancelHookRef.current = () => {
            if (pressRef.current) autoKbDiagRef.current.dropped++;
            pressRef.current = null;
            pendingAtPressRef.current = null;
        };
        autoKeyboardSinkRef.current = (r, before) => {
            const verdict = autoKeyboardVerdict({
                press: pressRef.current, before, report: r, now: Date.now(),
                surface: surfaceSizeRef.current,
            });
            autoKbDiagRef.current.onReport = verdict;
            if (verdict.raise) raise();
        };
        return () => {
            pressHookRef.current = null;
            pressEndHookRef.current = null;
            pressCancelHookRef.current = null;
            autoKeyboardSinkRef.current = null;
            pressRef.current = null;
            pendingAtPressRef.current = null;
        };
    }, [autoKeyboardWanted]);

    // A resolution or monitor change (<video> 'resize' → videoBox), a fold of the
    // key bar, the keyboard growing for a language switch, or a rotation: the band
    // and the picture are both different, so the caret's fractions must be
    // re-placed from scratch rather than dead-zoned away.
    useEffect(() => {
        if (!caretFollowActive) return;
        caretForceRef.current = true;
        if (caretReportRef.current) scheduleCaretSolve();
    }, [caretFollowActive, videoBox, caretBand, scheduleCaretSolve]);

    // THE WAY BACK. The relaxed clamp left blank space below the picture on
    // purpose; that is right while a keyboard covers the bottom of the screen and
    // wrong the instant it does not. There is no reset-zoom control anywhere in
    // this stage, so a feature that zooms 4x and then abandons the user at that
    // zoom is a support ticket — the pre-typing view is given back, unless they
    // pinched during typing (their zoom wins, re-clamped normally) or the captured
    // surface changed underneath (the remembered pan means nothing then, so fit).
    //
    // CLAMPED AGAINST THE RIGHT BOX. When this runs because the keyboard PANEL
    // closed, the surface still carries the key bar's reserved margin — the
    // overlay's cleanup hands in its 0 in this same commit, and the box grows
    // on the next render. A clamp against the shrunk box would pull a
    // perfectly legal pre-typing pan inwards, and the view would land short of
    // where it was. So in that case the restore is applied UNCLAMPED — it was
    // legal in the box it was captured in, which is the box about to return —
    // and the box-change re-clamp above (on videoBox) is what bounds it,
    // against the final geometry. When the panel STAYS (the IME went down, the
    // toggle went off) the box does not change and the clamp runs here.
    const activeMobileMenuRef = useRef(activeMobileMenu);
    useEffect(() => { activeMobileMenuRef.current = activeMobileMenu; }, [activeMobileMenu]);
    useEffect(() => {
        if (caretFollowActive) {
            caretWasActiveRef.current = true;
            return;
        }
        if (!caretWasActiveRef.current) return;
        caretWasActiveRef.current = false;
        const v = videoRef.current;
        const surface = surfaceRef.current;
        const pre = preCaretViewRef.current;
        preCaretViewRef.current = null;
        caretSolvedScaleRef.current = null;
        if (!v || !surface) return;
        const rect = surface.getBoundingClientRect();
        const zoomed = userZoomedDuringCaretRef.current;
        const boxWillChange = activeMobileMenuRef.current !== 'keyboard';
        // "The surface changed" means the remembered pan points at different
        // content, or into a differently-shaped picture. Compared by ASPECT,
        // cross-multiplied so it is integer-exact, NOT by videoWidth: WebRTC
        // downscales the stream under bandwidth pressure, which changes
        // videoWidth while `pictureBox` (and therefore every coordinate the
        // remembered transform is expressed in) stays identical. Comparing the
        // raw dimensions would throw the user's view away for a bitrate dip.
        const surfaceChanged = !pre
            || pre.activeMonitor !== activeMonitorRef.current
            || pre.videoW * v.videoHeight !== pre.videoH * v.videoWidth;
        const restore = !zoomed && pre && !surfaceChanged ? pre.transform : null;
        // No eslint-disable here on purpose: set-state-in-effect does not fire on
        // this one (it is reached only through the early returns above, once per
        // keyboard close), and a directive that silences nothing is decoration
        // eslint reports as unused.
        setTransform(prev => {
            if (restore) {
                const c = boxWillChange
                    ? { x: restore.x, y: restore.y }
                    : clampPan(v, rect, restore.scale, restore.x, restore.y);
                const next = { scale: restore.scale, x: c.x, y: c.y };
                return next.scale === prev.scale && next.x === prev.x && next.y === prev.y ? prev : next;
            }
            if (zoomed) {
                // Only the relaxed clamp has to go; the scale they chose stays.
                // Against the box about to return, when it is: the re-clamp on
                // the resize does it then.
                if (boxWillChange) return prev;
                const c = clampPan(v, rect, prev.scale, prev.x, prev.y);
                return c.x === prev.x && c.y === prev.y ? prev : { ...prev, x: c.x, y: c.y };
            }
            return prev.scale === 1 && prev.x === 0 && prev.y === 0 ? prev : { scale: 1, x: 0, y: 0 };
        });
    }, [caretFollowActive]);

    // A pending frame must not outlive the stage — it would run against an
    // unmounted surface, and React would warn about the setState.
    useEffect(() => () => {
        if (caretRafRef.current != null) {
            cancelAnimationFrame(caretRafRef.current);
            caretRafRef.current = null;
        }
    }, []);

    // The diagnostic's caret half. Refs so the reader is cheap and never stale;
    // the mirror below is the only part that needs a render to update.
    const caretDiagStateRef = useRef<{
        active: boolean;
        source: KeyboardInset['source'];
        strip: { top: number; bottom: number } | null;
        keyBarH: number;
    }>({ active: false, source: 'none', strip: null, keyBarH: 0 });
    useEffect(() => {
        caretDiagStateRef.current = {
            active: caretFollowActive, source: kbInset.source, strip: caretBand, keyBarH,
        };
    }, [caretFollowActive, kbInset.source, caretBand, keyBarH]);
    useEffect(() => {
        caretDiag.read = () => ({
            active: caretDiagStateRef.current.active,
            imeSource: caretDiagStateRef.current.source,
            strip: caretDiagStateRef.current.strip,
            keyBarH: caretDiagStateRef.current.keyBarH,
            lastFrame: caretReportRef.current,
            solvedScale: caretSolvedScaleRef.current,
            fallbackUsed: caretFallbackUsedRef.current,
            userDrove: userZoomedDuringCaretRef.current,
            dropped: { ...caretDropRef.current, trackingMon: caretMonDropRef.current },
            // The auto-keyboard's half: what the channel last said while
            // tracking, the last press, and what was decided about each.
            known: lastCaretRef.current,
            autoKeyboard: { ...autoKbDiagRef.current },
        });
        return () => { caretDiag.read = () => ({ active: false }); };
    }, []);

    // Centre the pointer for each new session rather than inheriting where the
    // last one left it — and reset the zoom with it. The transform used to
    // survive into the next session, which mattered little at 5x but with a
    // 40x ceiling would open the next session on a blur of nothing.
    useEffect(() => {
        if (sessionActiveId) {
            gestures.reset(0.5, 0.5);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot reset keyed on the session id, not a render-cascading mirror of props
            setTransform({ scale: 1, x: 0, y: 0 });
        }
    }, [sessionActiveId, gestures]);

    // ABOVE the `if (!session) return null` below, and it must stay there: a
    // hook after an early return is called conditionally, which is React error
    // #310 and takes the whole app down via the root ErrorBoundary. That exact
    // mistake shipped in v0.7.7 and only `npm run lint` caught it -- tsc,
    // vitest and `npm run build` all passed it. The effect handles the no-session
    // case internally instead.
    //
    // Poll while a session is live. Forwarding starts and stops DURING a session
    // as clients connect and disconnect, so a one-shot read at session start
    // would show a stale count — and a stale zero is the worst kind, since it
    // reads as "nothing is being forwarded" when something is.
    const sessionId = session?.id ?? null;

    // Quality changes are fire-and-ack over the device session: session.ts
    // raises 'stream-quality-failed' when the host rejects one or the 5s apply
    // timer lapses. This is the surface that owns the quality <select>, so the
    // failure belongs here too — a transient note next to the control, not a
    // toast on some other view.
    const [qualityError, setQualityError] = useState<string | null>(null);
    /** Outcome of the last "Send clipboard", or null. The call reports its own
     *  failure as a string instead of throwing, so it must be displayed —
     *  swallowing it looks like the paste failed on the far side. */
    const [clipboardNote, setClipboardNote] = useState<string | null>(null);
    const [clipboardBusy, setClipboardBusy] = useState(false);
    // A note is a moment's feedback, not a fixture. Nothing cleared it before,
    // so after the first More-menu tap the mobile banner stayed up for the
    // rest of the session — over the remote screen. Same lifetime as the
    // quality note; the timer restarts on every new note.
    useEffect(() => {
        if (!clipboardNote) return;
        const t = setTimeout(() => setClipboardNote(null), NOTE_LIFETIME_MS);
        return () => clearTimeout(t);
    }, [clipboardNote]);

    /**
     * The stage's own numbers, onto the clipboard.
     *
     * `__pucaDeviceDiag()` answers "why does this feel behind" — but a
     * SIGNED RELEASE APK has WebView debugging disabled, so chrome://inspect
     * cannot see this app and there is no console to type it into. Latency is
     * invisible after the fact, so the reading has to be takeable, by the
     * person holding the phone, at the moment it feels wrong. Mirrors the
     * Settings "Test notification" button: the diagnostic a user can actually
     * reach is the only one that ever gets used.
     *
     * Declared HERE, below the note state it writes — a useCallback above it
     * captures a binding that does not exist yet, which eslint's immutability
     * rule catches and a reader should not have to reason about.
     */
    const copyDiagnostics = useCallback(async () => {
        setClipboardNote(null);
        try {
            // MEASURED WHILE DRIVING, not at the moment of the tap: reaching
            // this button means letting go, and a still desktop stops
            // producing frames on purpose — so a one-shot reading reports the
            // pause rather than the problem. Close the menu and keep using it.
            setClipboardNote('Measuring for 5s — close this and keep using it…');
            const rows = await deviceDiagnosticsWindow(5_000);
            // The caret half lives in this component (the band, the IME source,
            // the fallback), and this button is the only console a signed release
            // APK has — so it has to be merged in here, not left to the window
            // global nobody on a phone can reach.
            const caret = caretDiag.read();
            await navigator.clipboard.writeText(JSON.stringify(rows.map(r => ({ ...r, caret })), null, 2));
            setClipboardNote('Diagnostics copied — paste them into the chat');
        } catch {
            // Clipboard can be refused (permission, insecure context). Say so
            // rather than leaving a button that silently does nothing.
            setClipboardNote('Could not copy diagnostics');
        }
    }, []);
    // Confirmed quality (set from the host's ack) and whether a change is in
    // flight. Reading the store here is what makes the <select> reflect the
    // stream instead of the last click.
    const confirmedQuality = useStreamStore(st => (sessionId ? st.qualities[sessionId] : undefined));
    const qualityPending = useStreamStore(st => (sessionId ? !!st.pendingQualities[sessionId] : false));
    const pendingQuality = useStreamStore(st => (sessionId ? st.pendingQualities[sessionId] : undefined));
    const shown = pendingQuality ?? confirmedQuality;
    const qualityValue = shown ? `${shown.bitrate},${shown.fps}` : '6000,30';
    useEffect(() => {
        if (!sessionId) return;
        let clearTimer: ReturnType<typeof setTimeout> | null = null;
        const onQualityFailed = (e: Event) => {
            const detail = (e as CustomEvent<{ sessionId: string; code?: string }>).detail;
            if (detail.sessionId !== sessionId) return;
            setQualityError(getStreamQualityErrorMessage(detail.code));
            if (clearTimer) clearTimeout(clearTimer);
            clearTimer = setTimeout(() => setQualityError(null), 5000);
        };
        window.addEventListener('stream-quality-failed', onQualityFailed);
        return () => {
            window.removeEventListener('stream-quality-failed', onQualityFailed);
            if (clearTimer) clearTimeout(clearTimer);
            setQualityError(null);
        };
    }, [sessionId]);

    useEffect(() => {
        if (!sessionId) {
            // Clearing stale tunnel counts when the session ends is exactly the
            // "synchronise with an external system" case: the poll below is the
            // subscription and this is its teardown value. No cascade -- it runs
            // once per session end.
            //
            // The directive MUST be the last line before the call: it applies to
            // the next LINE, not the next statement, so leading a comment block
            // with it silences nothing (and eslint then reports it as unused).
            //
            // When this file carries certain OTHER react-hooks errors, eslint
            // spuriously reports this directive as unused while it is in fact
            // load-bearing — deleting it turned the "unreported" problem into
            // a hard error (observed 2026-08-13, while a react-hooks/refs
            // error existed elsewhere in the file; with the file clean the
            // false warning disappears too). Before believing an
            // unused-directive warning on this RULE, delete the directive and
            // re-run lint: only a delete that stays clean proves it dead.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTunnels(null);
            return;
        }
        let alive = true;
        const tick = () => {
            void tunnelStatus(sessionId)
                .then(s => { if (alive) setTunnels(s); })
                .catch(() => { /* a status read failing must not disturb the session */ });
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => { alive = false; window.clearInterval(timer); };
    }, [sessionId]);


    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // GAME MODE (desktop): relative deltas ONLY while pointer-locked.
        // Without the lock send nothing — degrading to absolute moves is the
        // confusing "tiny movements" mode this feature exists to kill. Sits
        // ABOVE the pinch/pointer bookkeeping so a locked pointer never feeds
        // lastPinchInfo.
        if (!isMobile && fpsMode) {
            if (document.pointerLockElement !== e.currentTarget) return;
            if (!e.movementX && !e.movementY) return;
            // Scale viewer CSS px → host source px, calibrated against the
            // host's STABLE capture size (not the live decoded videoWidth,
            // which sags under WebRTC downscale), then the user multiplier.
            const v = videoRef.current;
            const rect = v?.getBoundingClientRect();
            const cap = session?.captureSize;
            const srcW = cap?.w || v?.videoWidth || 0;
            const srcH = cap?.h || v?.videoHeight || 0;
            const k = (rect && srcW && srcH
                ? computeRmoveScale(srcW, srcH, rect.width, rect.height)
                : 1) * fpsSens;
            send({ t: 'rmove', dx: e.movementX * k, dy: e.movementY * k });
            return;
        }
        if (activePointers.current.has(e.pointerId)) {
            activePointers.current.set(e.pointerId, e);
        }

        // THE MACHINE SEES EVERY MOVE, including multi-finger ones. It was
        // only fed from the single-pointer branch below, so the three-finger
        // wheel it implements could never run — the gesture menu advertised a
        // scroll that was as dead as before it was written. The machine filters
        // for itself: it ignores moves while pinching and only tracks the
        // primary finger while scrolling.
        if (isMobile && isMouseMode) {
            const v = videoRef.current;
            if (v) gestures.setSurface(gestureSurface(v, transformRef.current.scale));
            gestures.move({ id: e.pointerId, x: e.clientX, y: e.clientY });
        }

        if (activePointers.current.size >= 2) {
            const pts = Array.from(activePointers.current.values()).slice(0, 2);
            const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
            const center = {
                x: (pts[0].clientX + pts[1].clientX) / 2,
                y: (pts[0].clientY + pts[1].clientY) / 2
            };
            
            if (lastPinchInfo.current) {
                const prev = lastPinchInfo.current;
                const safePrevDist = prev.dist > 0 ? prev.dist : 1;
                const deltaScale = dist / safePrevDist;

                // A DELIBERATE PINCH OR TWO-FINGER PAN BEATS THE CARET CAMERA,
                // now and for the rest of this typing bout: the solver stops
                // changing the scale and only pans the caret back when it has
                // left the visible band, and closing the keyboard restores the
                // zoom THEY chose, not the one typing chose. (This branch is
                // both gestures — a pan is a pinch with deltaScale ~1.) Set
                // outside the updater — StrictMode invokes that twice.
                if (caretActiveRef.current) userZoomedDuringCaretRef.current = true;

                // MONITOR-HOP travel feed — a two-finger PAN (deltaScale ~1;
                // a real pinch changes the focal maths and its "blocked"
                // residual means nothing) whose motion the clamp refused.
                // The magnitude is the FINGER's travel — motion the user made
                // that the view could not follow — and the residual's sign
                // says which edge (proposed further left than allowed = they
                // are looking right). Computed OUTSIDE the updater from
                // transformRef, which is exact here: with ratio 1 the
                // proposed pan is just t.x + fingerDx, and updaters must stay
                // side-effect-free (StrictMode runs them twice).
                {
                    const t0 = transformRef.current;
                    const surface0 = surfaceRef.current;
                    if (Math.abs(deltaScale - 1) < 0.02 && t0.scale > 1 && surface0) {
                        const rect0 = surface0.getBoundingClientRect();
                        const fdx = center.x - prev.center.x;
                        const fdy = center.y - prev.center.y;
                        const c0 = clampPan(videoRef.current, rect0, t0.scale, t0.x + fdx, t0.y + fdy);
                        const rx = (t0.x + fdx) - c0.x;
                        const ry = (t0.y + fdy) - c0.y;
                        feedHopPressure(
                            rx < -0.5 ? Math.abs(fdx) : rx > 0.5 ? -Math.abs(fdx) : 0,
                            ry < -0.5 ? Math.abs(fdy) : ry > 0.5 ? -Math.abs(fdy) : 0,
                        );
                    }
                }

                setTransform(t => {
                    const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.scale * deltaScale));
                    const ratio = newScale / t.scale;

                    // MEASURED ON THE SURFACE, not on the video's parent.
                    // The video now lives inside the transformed canvas, so
                    // its parent's rect is itself scaled — clamping against
                    // that would compound the zoom and the pan limits would
                    // drift further out the more you zoomed in.
                    const surface = surfaceRef.current;
                    const rect = surface ? surface.getBoundingClientRect() : null;

                    // The focal point arrives in CLIENT coordinates, but t.x/t.y
                    // and clampPan's bounds are canvas-local (canvas origin =
                    // surface origin), so shift by the surface origin before the
                    // fixed-point maths. Invisible on mobile where the surface
                    // starts at the screen origin; on desktop the bar above it
                    // offset the anchor, and the drift compounds with zoom.
                    const ox = rect ? rect.left : 0;
                    const oy = rect ? rect.top : 0;

                    let newX = (center.x - ox) - ((prev.center.x - ox) - t.x) * ratio;
                    let newY = (center.y - oy) - ((prev.center.y - oy) - t.y) * ratio;

                    if (newScale === 1) {
                        newX = 0;
                        newY = 0;
                    } else if (rect) {
                        const c = clampPan(videoRef.current, rect, newScale, newX, newY);
                        newX = c.x;
                        newY = c.y;
                    }

                    return {
                        scale: newScale,
                        x: newX,
                        y: newY,
                    };
                });
            }
            lastPinchInfo.current = { dist, center };
            return;
        }

        if (activePointers.current.size === 1) {
            const v = videoRef.current;
            if (!v) return;

            if (!isMobile || !isMouseMode) {
                const p = normalizedOverVideo(v, e.clientX, e.clientY);
                if (p) send({ t: 'move', x: p.x, y: p.y });
            }
        }
    }, [send, isMobile, isMouseMode, gestures, fpsMode, fpsSens, session, feedHopPressure]);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // GAME MODE (desktop): handled entirely here — no pointer capture
        // (setPointerCapture throws under an active lock), no pinch
        // bookkeeping, no absolute move.
        if (!isMobile && fpsMode) {
            // Paused control sends nothing — capturing the pointer anyway
            // would trap the cursor with every input discarded.
            if (!controlEnabled) return;
            e.preventDefault();
            const el = e.currentTarget as HTMLElement;
            if (document.pointerLockElement !== el) {
                // First click engages the lock; no click is sent. Prefer RAW
                // (unaccelerated) deltas; retry without the option if the
                // engine rejects it. May be denied (just-exited-lock
                // cooldown) — the hint overlay stays up via pointerlockerror.
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
            fpsPressedRef.current.add(e.button);
            send({ t: 'down', button: e.button });
            return;
        }
        // PRUNE STALE CONTACTS before counting this one. A pointer whose
        // up/cancel never reached us (capture lost on remount, or a
        // setPointerCapture that silently no-ops) leaves a permanent entry —
        // then a single real finger touching down reads as "2 pointers" and
        // hijacks the pinch/pan branch below forever. Liveness is whether the
        // element still holds capture on that id; a live contact always does,
        // because onPointerDown always granted it.
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture) {
            for (const id of Array.from(activePointers.current.keys())) {
                if (id !== e.pointerId && !el.hasPointerCapture(id)) {
                    activePointers.current.delete(id);
                    touchDownSent.current.delete(id);
                }
            }
        }
        activePointers.current.set(e.pointerId, e);
        el.setPointerCapture?.(e.pointerId);

        // HOLD THE CHROME STILL for the gesture (see chromeFrozen): the first
        // contact freezes the margins at their current values; the last
        // release below lets them go. A second contact is a pinch, which is
        // never a tap into a field — cancel the auto-keyboard's pending press
        // BEFORE the release that follows goes out through `send`, or that
        // release would read as the end of a clean tap.
        if (isMobile && activePointers.current.size === 1) {
            setChromeFrozen({ top: keyBarH, bottom: toolbarH });
        }
        if (activePointers.current.size === 2) pressCancelHookRef.current?.();

        // TRACKPAD: every contact goes to the machine, which decides what it
        // means. It must see the second and third fingers too — that is how it
        // knows a pinch or a scroll has started and stops driving the pointer.
        if (isMobile && isMouseMode) {
            const v = videoRef.current;
            if (v) gestures.setSurface(gestureSurface(v, transformRef.current.scale));
            gestures.down({ id: e.pointerId, x: e.clientX, y: e.clientY });
        } else if (activePointers.current.size === 1) {
            const v = videoRef.current;
            if (!v) return;
            const p = normalizedOverVideo(v, e.clientX, e.clientY);
            if (!p) return;
            send({ t: 'move', x: p.x, y: p.y });
            send({ t: 'down', button: e.button });
            touchDownSent.current.add(e.pointerId);
        } else if (activePointers.current.size === 2) {
            send({ t: 'up', button: 0 });
            touchDownSent.current.clear();
        }

        if (activePointers.current.size === 2) {
            const pts = Array.from(activePointers.current.values()).slice(0, 2);
            const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
            const center = {
                x: (pts[0].clientX + pts[1].clientX) / 2,
                y: (pts[0].clientY + pts[1].clientY) / 2
            };
            lastPinchInfo.current = { dist, center };
        }
    }, [send, isMobile, isMouseMode, gestures, fpsMode, controlEnabled, keyBarH, toolbarH]);

    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // GAME MODE: send 'up' iff we relayed the matching 'down'. Keying on
        // the recorded button (not lock-state-at-release) releases the host's
        // button even after a mid-hold lock drop, and swallows the stray 'up'
        // from the lock-engaging click (which sent no 'down').
        if (!isMobile && fpsMode) {
            if (fpsPressedRef.current.delete(e.button)) send({ t: 'up', button: e.button });
            return;
        }
        activePointers.current.delete(e.pointerId);

        if (isMobile && isMouseMode) {
            gestures.up({ id: e.pointerId, x: e.clientX, y: e.clientY });
        } else if (touchDownSent.current.delete(e.pointerId)) {
            // Only release a button this contact actually pressed.
            send({ t: 'up', button: e.button });
        }

        if (activePointers.current.size < 2) {
            lastPinchInfo.current = null;
        }
        // The gesture is over: the chrome may take its real height now.
        if (isMobile && activePointers.current.size === 0) setChromeFrozen(null);
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }, [send, isMouseMode, isMobile, gestures, fpsMode]);

    const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // GAME MODE: release only a button this pointer actually pressed.
        if (!isMobile && fpsMode) {
            if (fpsPressedRef.current.delete(e.button)) send({ t: 'up', button: e.button });
            return;
        }
        activePointers.current.delete(e.pointerId);
        if (activePointers.current.size < 2) lastPinchInfo.current = null;
        // A cancelled gesture is not a tap into anything. Before the release
        // below, which would otherwise read as a tap's end.
        pressCancelHookRef.current?.();

        if (isMobile && isMouseMode) {
            // The machine releases a button only if it pressed one.
            gestures.cancel({ id: e.pointerId, x: e.clientX, y: e.clientY });
        } else if (touchDownSent.current.delete(e.pointerId)) {
            // WAS UNCONDITIONAL, and that was a real defect: a cancelled touch
            // that had never pressed anything still released a button on the
            // remote machine — a phantom click on whatever was under the
            // pointer, on a screen the user is not looking at.
            send({ t: 'up', button: 0 });
        }
        if (isMobile && activePointers.current.size === 0) setChromeFrozen(null);
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }, [send, isMobile, isMouseMode, gestures, fpsMode]);

    useEffect(() => {
        if (!controlEnabled) return;

        const onKey = (e: KeyboardEvent) => {
            if (!session) return;
            if (e.key === 'Escape') {
                setControlEnabled(false);
                return;
            }
            // RELEASES FIRST, decided by what was actually forwarded — never
            // by the guards below. Modifier state and focus can change while
            // a key is held (press M, add Ctrl+Shift, release M), and running
            // a keyup through matchesRegisteredHotkey/isEditableTarget
            // swallowed exactly those releases: the host never got the
            // key-up and the key stayed logically held on the controlled
            // machine (a game kept strafing) until a blur released all.
            if (e.type !== 'keydown') {
                if (!heldKeysRef.current.has(e.code)) return; // never forwarded down
                heldKeysRef.current.delete(e.code);
                e.preventDefault();
                sendInput(session.id, { t: 'key', code: e.code, down: false });
                return;
            }
            // Typing into a LOCAL input inside the stage (the files overlay's
            // rename/search fields, etc.) is not remote input — forwarding it
            // typed every character into the controlled PC as well.
            if (isEditableTarget(e.target)) return;
            // A registered hotkey acts locally, exactly once — never ALSO
            // typed into the remote machine (toggle mute both muting you and
            // typing M into the game was the reported jank). Policy: while in
            // a call, a bound combo wins over remote forwarding; unbind it or
            // leave voice to send that combo remotely.
            if (matchesRegisteredHotkey(e)) return;
            if (!isInjectableKey(e.code)) return;
            e.preventDefault();
            // Track held keys so the blur/hide release-all can free them on
            // the host — alt-tab mid-press otherwise strands the key down.
            heldKeysRef.current.add(e.code);
            sendInput(session.id, { t: 'key', code: e.code, down: true });
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKey, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('keyup', onKey, true);
        };
    }, [session, controlEnabled]);


    if (!session) {
        // No live session, but the last one failed: say why. Dismissible, and
        // replaced the moment a new attempt starts.
        if (!failure) return null;
        return (
            <div className="device-stage-failure" role="alert">
                <span className="device-stage-failure-text">{failure.reason}</span>
                <button
                    type="button"
                    className="device-stage-btn"
                    onClick={() => setFailure(null)}
                >
                    Dismiss
                </button>
            </div>
        );
    }

    if (isMinimized) {
        return (
            <div className="device-stage-minimized" onClick={() => setIsMinimized(false)}>
                <span><LiveDotIcon /> Return to remote device ({session.id})</span>
            </div>
        );
    }

    return (
        <div
            className="device-stage"
            role="dialog"
            aria-modal="true"
            aria-label="Remote device"
            // The toolbar's REAL height, for everything anchored above it (the
            // mobile menus). The stylesheet's `--device-toolbar-h` is a guess
            // that mobile.css's blanket 44px button rule can make wrong; the
            // measured value overrides it for this subtree while the bar is up.
            style={isMobile && toolbarH > 0
                ? ({ '--device-toolbar-h': `${toolbarH}px` } as React.CSSProperties)
                : undefined}
        >
            {!isMobile && (
                <div className="device-stage-bar">
                    <span className="device-stage-title">
                        {session.phase === 'connecting' ? 'Connecting…' : 'Controlling a device'}
                    </span>
                    {!!tunnels?.listeners.length && (
                        <span
                            className="device-stage-tunnels"
                            title={tunnels.listeners
                                .map(l => `127.0.0.1:${l.local_port} \u2192 ${l.target_host}:${l.target_port}`)
                                .join('\n')}
                        >
                            <ForwardIcon />
                            {` ${tunnels.listeners.length} forward${tunnels.listeners.length === 1 ? '' : 's'}`}
                            {tunnels.active_streams > 0 && ` \u00B7 ${tunnels.active_streams} active`}
                        </span>
                    )}
                    {session.monitors.length > 1 && (
                        <label className="device-stage-monitor">
                            <span className="device-stage-monitor-label">Screen</span>
                            <select
                                value={session.activeMonitor ?? session.monitors[0].id}
                                aria-label="Which screen to view"
                                onChange={e => requestMonitor(session.id, Number(e.target.value))}
                            >
                                {session.monitors.map(m => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                ))}
                                {/* The composite the mobile picker already
                                    offers. Also load-bearing for the select
                                    itself: a session switched to the
                                    composite elsewhere sets activeMonitor to
                                    the sentinel, and a controlled select with
                                    no matching option renders BLANK. */}
                                <option value={ALL_DISPLAYS}>All displays</option>
                            </select>
                        </label>
                    )}
                    <label className="device-stage-monitor">
                        <span className="device-stage-monitor-label">Quality</span>
                        {/* Values are KILObits, matching the wire field and
                            `sendStreamQuality`. They used to be bits, which the
                            agent's IPC boundary then multiplied by 1000 again —
                            so every preset asked for 1000x its label and was
                            refused, and the picture never changed.

                            CONTROLLED off the store, so it shows what the host
                            confirmed rather than what was last clicked: a
                            refused change now snaps back instead of lying. */}
                        <select
                            value={qualityValue}
                            aria-label="Stream quality"
                            disabled={qualityPending}
                            onChange={e => {
                                const parsed = parsePresetValue(e.target.value);
                                if (parsed) sendStreamQuality(session.id, parsed.fps, parsed.bitrateKbps);
                            }}
                        >
                            {STREAM_QUALITY_PRESETS.map(p => (
                                <option key={presetValue(p)} value={presetValue(p)}>{p.label}</option>
                            ))}
                        </select>
                    </label>
                    {session.error && <span className="device-stage-error">{session.error}</span>}
                    {qualityError && <span className="device-stage-error">{qualityError}</span>}
                    <button
                        className="device-stage-btn"
                        aria-pressed={fpsMode}
                        onClick={() => {
                            // LET GO FIRST — same rule as the touch/trackpad
                            // switch: each mode tracks its own pressed state
                            // and will not release the other's, so toggling
                            // mid-hold stranded a button down on the host.
                            for (const button of fpsPressedRef.current) send({ t: 'up', button });
                            fpsPressedRef.current.clear();
                            if (touchDownSent.current.size) {
                                send({ t: 'up', button: 0 });
                                touchDownSent.current.clear();
                            }
                            setFpsMode(f => { saveFpsMode(!f); return !f; });
                        }}
                        title="Game mode: relative mouse (pointer lock) for games that read raw input"
                    >
                        <CrosshairIcon /> {fpsMode ? 'Game mode on' : 'Game mode'}
                    </button>
                    {fpsMode && (
                        <span className="device-stage-fps-sens">
                            <button
                                className="device-stage-btn"
                                onClick={() => adjustFpsSens(-FPS_SENS_STEP)}
                                disabled={fpsSens <= FPS_SENS_MIN}
                                title="Lower Game-mode sensitivity"
                            >
                                −
                            </button>
                            <span title="Game mode mouse sensitivity">{fmtSens(fpsSens)}</span>
                            <button
                                className="device-stage-btn"
                                onClick={() => adjustFpsSens(FPS_SENS_STEP)}
                                disabled={fpsSens >= FPS_SENS_MAX}
                                title="Raise Game-mode sensitivity"
                            >
                                +
                            </button>
                        </span>
                    )}
                    <button
                        className="device-stage-btn"
                        aria-pressed={controlEnabled}
                        onClick={() => setControlEnabled(v => !v)}
                    >
                        {controlEnabled ? 'Pause control' : 'Resume control'}
                    </button>
                    {/* sendClipboard has existed and been tested since 0.8.x
                        with NO caller — a working feature nobody could reach.
                        One-shot and user-initiated by design: password
                        managers put secrets on the clipboard, so an automatic
                        mirror would stream them to the other machine. The
                        outcome is shown because the call reports its own
                        failure rather than throwing (a silent no-op here reads
                        as "the paste did not work over there"). */}
                    <button
                        className="device-stage-btn"
                        disabled={clipboardBusy}
                        onClick={() => {
                            setClipboardBusy(true);
                            setClipboardNote(null);
                            void sendClipboard(session.id)
                                .then(err => setClipboardNote(err ?? 'Clipboard sent'))
                                .catch(() => setClipboardNote('Could not send the clipboard'))
                                .finally(() => setClipboardBusy(false));
                        }}
                        title="Send this device's clipboard text to the device you are controlling"
                    >
                        {clipboardBusy ? 'Sending…' : <><CopyIcon /> Send clipboard</>}
                    </button>
                    {clipboardNote && (
                        <span className="device-stage-error">{clipboardNote}</span>
                    )}
                    <button
                        className="device-stage-btn"
                        onClick={() => setShowFiles(v => !v)}
                    >
                        Files
                    </button>
                    <button
                        className="device-stage-btn device-stage-btn-danger"
                        onClick={() => endSession(session.id, 'you disconnected')}
                    >
                        Disconnect
                    </button>
                </div>
            )}

            <div
                ref={surfaceRef}
                className="device-stage-surface"
                // THE PICTURE LIVES BETWEEN THE CHROME, NOT UNDER IT. On a
                // phone the keyboard bar (fixed, top) and the toolbar (fixed,
                // bottom) used to float over a full-screen surface, so in
                // landscape — where the picture fills the height — the bottom
                // of the remote screen (the Windows taskbar) sat under the
                // toolbar and the top (title bars) under the key bar, and the
                // only way to see either was to collapse the bar. The surface
                // now gives up exactly their measured heights: `object-fit:
                // contain` letterboxes into what is left, the pan clamp bounds
                // a zoomed picture to it, and the caret band maths reads the
                // surface rect in screen coordinates so it is unaffected.
                // Nothing is reserved for the IME itself: the caret camera
                // owns the picture while it is up.
                style={isMobile && ((chromeFrozen?.top ?? keyBarH) > 0 || (chromeFrozen?.bottom ?? toolbarH) > 0)
                    ? { marginTop: chromeFrozen?.top ?? keyBarH, marginBottom: chromeFrozen?.bottom ?? toolbarH }
                    : undefined}
                onPointerMove={onPointerMove}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onWheel={e => {
                    if (e.ctrlKey) {
                        e.preventDefault();
                        const { clientX, clientY } = e;
                        // As with the pinch: a zoom the user asked for outranks
                        // the caret camera, now and at deactivation.
                        if (caretActiveRef.current) userZoomedDuringCaretRef.current = true;
                        setTransform(t => {
                            const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.scale - e.deltaY * 0.01));
                            const ratio = newScale / t.scale;
                            // Same surface-origin shift as the pinch branch:
                            // t.x/t.y are canvas-local, the pointer is client-
                            // space, and on desktop the bar above the surface
                            // made the two differ by its height — drifting the
                            // zoom anchor further the deeper you zoomed.
                            const surface = surfaceRef.current;
                            const rect = surface ? surface.getBoundingClientRect() : null;
                            const fx = clientX - (rect ? rect.left : 0);
                            const fy = clientY - (rect ? rect.top : 0);
                            let newX = fx - (fx - t.x) * ratio;
                            let newY = fy - (fy - t.y) * ratio;
                            if (newScale !== 1 && rect) {
                                const c = clampPan(videoRef.current, rect, newScale, newX, newY);
                                newX = c.x;
                                newY = c.y;
                            }
                            return {
                                scale: newScale,
                                x: newScale === 1 ? 0 : newX,
                                y: newScale === 1 ? 0 : newY,
                            };
                        });
                    } else {
                        send({ t: 'wheel', dy: e.deltaY });
                    }
                }}
                onContextMenu={e => e.preventDefault()}
            >
                {/* ONE TRANSFORMED CANVAS for the picture, so pinch-zoom and
                    pan move everything the stage draws together. */}
                <div
                    className="device-stage-canvas"
                    style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: '0 0' }}
                >
                    <video
                        ref={attachVideo}
                        className="device-stage-video"
                        autoPlay
                        playsInline
                        muted
                    />

                    {/* OUR pointer, drawn only once the host has confirmed it
                        stopped drawing ITS one (session.cursorOwned comes from
                        the host's ack, never optimism) — so there is always
                        exactly one cursor, on every host version.

                        Inside the transformed canvas, so a pinch-zoom moves
                        the picture and the pointer together; the inverse scale
                        keeps it a constant size on screen at any zoom. */}
                    {cursorOwned && cursorAt && (
                        <div
                            className="device-stage-virtual-cursor"
                            style={{
                                left: `${cursorAt.left}px`,
                                top: `${cursorAt.top}px`,
                                transform: `scale(${1 / transform.scale})`,
                            }}
                        >
                            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                                {/* The standard arrow, drawn from its tip:
                                    the hotspot is (0,0) of this box, which is
                                    what `left/top` position — no centring
                                    offset, because a pointer points. */}
                                <path
                                    d="M2 1.5 L2 17.5 L6.2 13.6 L8.9 19.8 L11.6 18.6 L8.9 12.6 L14.5 12.4 Z"
                                    fill="#fff"
                                    stroke="#000"
                                    strokeWidth="1.4"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </div>
                    )}
                </div>

                {/* The relay dropped and both ends are holding the session
                    for a reconnect. The last frame stays up behind this so
                    the user keeps their bearings; input meanwhile goes
                    nowhere, which is exactly what the banner explains. */}
                {session.reconnecting && (
                    <div className="device-stage-waiting">Connection lost — reconnecting…</div>
                )}
                {/* awaitingMedia, not !stream: the stream is attached eagerly
                    at connect (Safari refuses to start the pipeline without
                    it on a playing <video>), so `!stream` never fired on
                    Chromium and a host whose screens were asleep showed a
                    silent black stage instead of this overlay. The flag
                    clears on the first real RTP (track unmute). */}
                {/* A WINDOWS SECURITY SCREEN, NAMED RATHER THAN MYSTERIOUS.
                    A UAC prompt (or the lock screen) takes the display away
                    from the host's capture, and the host holds the last frame —
                    so without this the picture simply freezes and every visible
                    signal says "crashed". Windows puts those screens out of
                    reach of anything below SYSTEM, so there is nothing the
                    viewer can press; saying so is the whole feature.

                    It WINS over the waiting/stalled banner below and takes it
                    off the screen: "Waiting for the device's screen…" is the
                    wrong story once we know the real one. It also pins the
                    liveness ladder (see session.ts), so "stalled — reconnecting
                    it…" can no longer appear for a prompt no reconnect clears.

                    PARKED AT THE TOP (.device-stage-secure), not centred like
                    the waiting banner: the centre is exactly where Windows
                    draws the PIN box and the UAC dialog, so a centred notice
                    covers the control it is describing. An ELEVATED agent never
                    raises this at all (session.rs gates on flavour), so a
                    sign-in-screen session showing a real PIN box never gets a
                    banner over it in the first place — the top position is the
                    second line of defence for the transitions in between. */}
                {session.secureDesktop && !session.reconnecting && (
                    <div className="device-stage-secure">
                        That computer is showing a Windows security screen &mdash;
                        the lock screen, the sign-in screen, or an administrator
                        prompt. Windows hides these from ordinary remote control.
                        Sign-in-screen access (Devices &rsaquo; this computer)
                        reaches the lock and sign-in screens; an administrator
                        prompt can be cancelled with Ctrl+Alt+Del from the More
                        menu.
                    </div>
                )}
                {/* A ClipCursor conflict: a fullscreen app on ANOTHER screen is
                    holding the host's pointer, so injected clicks here get
                    clamped back into it — SendInput reports success and the
                    click lands in the game. Host-asserted only (the
                    `cursor-clipped` notice off the 1Hz status poll), same
                    trust rule as the secure banner above, and yielding to it:
                    a security screen is the bigger story and the clip usually
                    dies with it. Same parked-at-top styling — the centre of
                    the stage is the picture the viewer is trying to use. */}
                {session.cursorClipped && !session.secureDesktop && !session.reconnecting && (
                    <div className="device-stage-secure">
                        A fullscreen app on another screen is holding that
                        computer&rsquo;s mouse pointer, so clicks here may land in it
                        instead. Switch to that screen, or close the app on the
                        controlled computer.
                    </div>
                )}
                {(session.awaitingMedia || !session.stream) && !session.secureDesktop && (
                    <div className="device-stage-waiting">
                        {session.mediaRestarting
                            // The picture died mid-session and a fresh
                            // transport is being negotiated under the same
                            // session — different promise from the first
                            // connect's "waiting", so different words.
                            ? 'The stream stalled — reconnecting it…'
                            : 'Waiting for the device\'s screen…'}
                    </div>
                )}
                {!controlEnabled && (
                    <div className="device-stage-paused">
                        Control paused — you are only watching. Press Resume to take over.
                    </div>
                )}
                {!isMobile && fpsMode && !pointerLocked && controlEnabled && (
                    <div className="device-stage-fps-hint">
                        <CrosshairIcon /> Click the screen to capture your mouse · Esc releases it
                    </div>
                )}
            </div>

            {!isMobile && (
                <div className="device-stage-hint">
                    Press <kbd>Esc</kbd> to pause control without disconnecting.
                </div>
            )}

            {/* The virtual mouse pad rides the same switch as the virtual
                cursor dot: Left/Middle/Right + scroll buttons,
                because the trackpad gestures have no middle click, no
                right-drag, and no hold-while-steering. */}
            {isMobile && isMouseMode && showVirtualMouse && (
                <DeviceStageVirtualMouse onButton={padButton} onWheel={padWheel} />
            )}

            {/* Errors on mobile too. All three render inside the DESKTOP
                toolbar, which is behind `!isMobile` — so a phone changing
                quality got no feedback at all, on the surface where the quality
                control is most likely to be used.

                EVERY present message, not the first: this used to pick
                `qualityError ?? clipboardNote ?? session.error`, and the More
                menu sets a note on every tap that nothing clears — so the
                host's honest refusal (input-failed / power-failed / a privacy
                failure, all written to session.error) sat permanently behind
                "Ctrl+Alt+Del sent". The desktop bar shows all three as
                separate spans; the phone now does the same. */}
            {isMobile && (session.error || qualityError || clipboardNote) && (
                <div className="device-stage-mobile-error" role="status">
                    {qualityError && <span>{qualityError}</span>}
                    {clipboardNote && <span>{clipboardNote}</span>}
                    {session.error && <span>{session.error}</span>}
                </div>
            )}
            
            {isMobile && toolbarCollapsed && (
                <MobileToolbarToggle onExpand={() => setToolbarCollapsed(false)} />
            )}
            
            {isMobile && !toolbarCollapsed && (
                <MobileToolbar
                    session={session}
                    onCloseSession={() => endSession(session.id, 'you disconnected')}
                    activeMenu={activeMobileMenu}
                    setActiveMenu={setActiveMobileMenu}
                    onCollapse={() => setToolbarCollapsed(true)}
                    onMinimize={() => setIsMinimized(true)}
                    onHeight={setToolbarH}
                />
            )}

            {/* A tap outside an open menu closes it — on the backdrop, never
                on the surface, because the surface forwards every pointerdown
                to the host as real input; a document-level listener could
                close the menu but could not stop that. Dismissal happens on
                pointerUP, not pointerdown: React removes the backdrop
                synchronously, so a pointerdown-dismiss left the surface bare
                for the rest of the gesture and a SECOND finger landing a
                moment later became a first-class tracked contact — a real
                click on the host from a tap that was meant to close a menu.
                Held until the up, every finger of the gesture lands on the
                backdrop; the orphaned ups that follow the unmount hit the
                surface with no tracked down and are inert on both input
                paths. preventDefault on both events stops the synthetic
                click a touch would otherwise emit. 'keyboard' is deliberately
                NOT dismissed this way: it is a typing surface, and the user
                must be able to tap the remote screen to place a caret while
                it is up. */}
            {isMobile
                && activeMobileMenu !== null
                && activeMobileMenu !== 'keyboard' && (
                <div
                    className="device-stage-mobile-menu-backdrop"
                    onPointerDown={e => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    onPointerUp={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setActiveMobileMenu(null);
                    }}
                />
            )}

            {isMobile && activeMobileMenu === 'more' && (
                <MoreMenu
                    session={session}
                    onClose={() => setActiveMobileMenu(null)}
                    onOpenFiles={() => setShowFiles(true)}
                    onNotice={setClipboardNote}
                    controlEnabled={controlEnabled}
                />
            )}
            
            {isMobile && activeMobileMenu === 'monitor' && (
                <MonitorMenu 
                    session={session} 
                    onClose={() => setActiveMobileMenu(null)} 
                />
            )}
            
            {isMobile && activeMobileMenu === 'mouse' && (
                <MouseMenu
                    isMouseMode={isMouseMode}
                    setMouseMode={setMouseModeRemembered}
                    showVirtualMouse={showVirtualMouse}
                    setShowVirtualMouse={setShowVirtualMouseRemembered}
                    followCursor={followCursor}
                    setFollowCursor={setFollowCursorRemembered}
                    followCaret={followCaret}
                    setFollowCaret={setFollowCaretRemembered}
                    autoKeyboard={autoKeyboard}
                    setAutoKeyboard={setAutoKeyboardRemembered}
                    onCopyDiagnostics={() => void copyDiagnostics()}
                />
            )}
            
            {/* THROUGH `send`, NOT `sendInput`.
                The overlay used to call the transport directly, which walked
                straight past the `controlEnabled` gate: tapping "Pause control"
                put up the paused banner while every keystroke still landed on
                the remote machine. A control that says it is off has to be off.
                It also means Escape — which is the keyboard shortcut for
                pausing — can no longer ship one last keystroke to the host on
                its way out. */}
            {isMobile && activeMobileMenu === 'keyboard' && (
                <KeyboardOverlay
                    send={send}
                    onHeight={setKeyBarH}
                    raiseToken={kbRaiseToken}
                    // Only a MEASURED "up" (the native plugin, or a real
                    // visual-viewport shrink) may veto the re-focus fallback:
                    // the 'assumed' tier pins visible:true for the session on
                    // exactly the APKs without the native show, which would
                    // make the fallback that exists for them unreachable.
                    imeVisible={kbInset.visible && kbInset.source !== 'assumed'}
                />
            )}
            
            {showFiles && <DeviceFileManager sessionId={session.id} onClose={() => setShowFiles(false)} />}
        </div>
    );
}
