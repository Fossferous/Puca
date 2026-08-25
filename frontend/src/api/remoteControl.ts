/**
 * Remote control of a shared screen — session orchestration.
 *
 * Roles:
 * - HOST: the user sharing their screen. Only the Windows desktop app (Tauri)
 *   can actually inject input. The host approves a request, then every input
 *   event from the approved viewer is replayed via the native `inject_input`
 *   command. The host is the authoritative gate — the server just relays.
 * - VIEWER: any platform. Requests control, and once granted, streams pointer/
 *   keyboard events captured over the shared video.
 *
 * Safety: the host injects ONLY events from the one viewer it has an active
 * grant for; it refuses to grant while an anti-cheat product is running; and a
 * control session is torn down the moment either side ends it, the request is
 * denied, or the share stops.
 */
import { wsClient, type ServerMessage } from './websocket';
import { isTauri } from './platform';
import { getCurrentStreamingUserId, getStreamData, selectStream } from '../components/voiceState';
import { clearAllScreenLatency, setScreenLatencyMinimised } from './rtc/receiverLatency';
import {
    getActiveIdentity,
    generateControlEphemeral,
    deriveControlSessionKey,
    sealControl,
    openControl,
    sealControlBytes,
    openControlBytes,
    type ControlEphemeral,
} from './e2ee';
import {
    FRAME_HELLO, FRAME_SEALED_INPUT, controlDcReady, forgetControlChannels, laneFor,
    markHelloSeen, sendControlFrame, sendHello, setControlFrameHandler, type CtlLane,
} from './rtc/controlDc';
import { getCachedPublicKey } from './dms';

// End a control session that receives no input for this long (stuck/abandoned).
const INACTIVITY_MS = 90_000;
// Hard backstop on injected events/sec (real use is far below; blocks floods).
const MAX_EVENTS_PER_SEC = 600;

// --- Denied-request cooldowns (anti-spam) ---
//
// After a denial, re-requests to the same peer sit out a GROWING cooldown.
// Enforced on both roles: the viewer client won't send during cooldown
// (polite), and the host client silently auto-denies early re-requests
// (authoritative — a modified viewer still can't spam the approval prompt).
export const DENIAL_STEPS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

/** How long after a forced window-surface before another one is allowed.
 *  Beyond this the prompt still flashes the taskbar, it just won't put the
 *  window over the host's game again. */
const ATTENTION_COOLDOWN_MS = 10 * 60_000;
let lastAttentionAt = 0;

/** Host-side deadline for an unanswered control prompt. Without the old
 *  focus-steal the host may genuinely not see the prompt, and the viewer must
 *  not hang on "requested" forever — an unanswered prompt auto-denies. */
export const HOST_CONSENT_DEADLINE_MS = 45_000;
let consentDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

/** Clear the consent deadline and drop the surfaced window's TOPMOST bit.
 *  Runs on EVERY exit from the prompt: allow, deny, auto-deny, viewer gone. */
function clearConsentAttention() {
    if (consentDeadlineTimer !== null) {
        clearTimeout(consentDeadlineTimer);
        consentDeadlineTimer = null;
    }
    if (isTauri()) {
        void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('release_attention_topmost'))
            .catch(() => { /* older build without the command */ });
    }
}
// A grant — or this long without a fresh denial — forgets the history.
export const DENIAL_DECAY_MS = 10 * 60_000;

export type DenialRecord = { count: number; until: number; last: number };
const viewerDenials = new Map<number, DenialRecord>(); // me as viewer: hostId -> record
const hostDenials = new Map<number, DenialRecord>();   // me as host: viewerId -> record

/** Record one more denial for this peer; returns the new cooldown in ms.
 *  Pure over (map, now) so tests can drive time. */
export function bumpDenial(map: Map<number, DenialRecord>, peerId: number, now = Date.now()): number {
    const prev = map.get(peerId);
    const count = (prev && now - prev.last < DENIAL_DECAY_MS ? prev.count : 0) + 1;
    const step = DENIAL_STEPS_MS[Math.min(count - 1, DENIAL_STEPS_MS.length - 1)];
    map.set(peerId, { count, until: now + step, last: now });
    return step;
}

export function cooldownRemainingMs(map: Map<number, DenialRecord>, peerId: number, now = Date.now()): number {
    const rec = map.get(peerId);
    if (!rec) return 0;
    if (now - rec.last >= DENIAL_DECAY_MS) {
        map.delete(peerId);
        return 0;
    }
    return Math.max(0, rec.until - now);
}

const fmtCooldown = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`;
};

export type ControlEvent =
    | { t: 'move'; x: number; y: number }
    | { t: 'rmove'; dx: number; dy: number }
    | { t: 'down'; button: number }
    | { t: 'up'; button: number }
    | { t: 'wheel'; dy: number }
    | { t: 'key'; code: string; down: boolean };

export interface ControlState {
    /** HOST: a viewer is asking to control my screen; awaiting my decision. */
    incomingRequest: { userId: number; username: string } | null;
    /** HOST: the viewer actively controlling my screen right now. */
    controlledBy: { userId: number; username: string } | null;
    /** VIEWER: the host I'm controlling / requesting. */
    controlling: { userId: number; username: string; status: 'requesting' | 'active' } | null;
    /** VIEWER: a host is OFFERING me control of their screen; awaiting my choice. */
    offer: { userId: number; username: string } | null;
    /** Transient notice for a toast (denied, anti-cheat blocked, ended, …). */
    notice: string | null;
}

let state: ControlState = {
    incomingRequest: null,
    controlledBy: null,
    controlling: null,
    offer: null,
    notice: null,
};

// HOST: the viewer we proactively offered control to (auto-approve their request).
let offeredTo: number | null = null;
let offerTimer: ReturnType<typeof setTimeout> | null = null;

// --- Per-session control-channel crypto (ephemeral handshake) ---
//
// Each session derives a UNIQUE key from an ephemeral X25519 exchange (fresh per
// grant) authenticated by the static identity DH — see e2ee.ts. This defeats
// cross-session replay and cross-role reflection (a static pairwise key did
// not). Keyed by ROLE because one user can be host and viewer at once (A controls
// B while C controls A). A monotonic seq inside each sealed payload stops
// intra-session replay/reorder.
// `seq`/`recvSeq` are the WS relay's namespace; `dcSeq`/`dcRecvSeq` are the
// data channel's. SEPARATE ON PURPOSE (W5/R2): one counter across two
// transports means a fast DC move can bump the sequence past a WS click
// still in flight, and the host drops the click — the exact bug the P2P
// path exists to avoid creating.
let viewerCrypto: { peerId: number; key: Uint8Array; seq: number; dcSeq: number } | null = null;
let hostCrypto: { peerId: number; key: Uint8Array; recvSeq: number; dcRecvSeq: number } | null = null;
// My ephemeral as viewer (kept from request until the host's response arrives).
let viewerEph: ControlEphemeral | null = null;
// HOST: the viewer's ephemeral public key from their request, until I grant.
let pendingViewerEph: { userId: number; ephPub: string } | null = null;
// Serialize seal/open so events stay in seq order across async crypto.
let sendChain: Promise<void> = Promise.resolve();
let recvChain: Promise<void> = Promise.resolve();

/**
 * Resolve a peer's identity public key with TOFU pinning: pin on first use, and
 * FAIL CLOSED if the server ever serves a different key later (catches a server
 * key-substitution MITM after first contact). First-contact authenticity still
 * rests on the server, exactly as DMs do — verifying a key fingerprint
 * out-of-band would be the full fix.
 */
const controlPinMem = new Map<number, string>();

async function getPinnedIdentityKey(userId: number): Promise<string | null> {
    const served = await getCachedPublicKey(userId);
    if (!served) return null;
    const keyChanged = () => {
        setNotice("This user's security key changed — control blocked. Verify their identity before retrying.");
        return null;
    };
    // In-memory pin: catches a per-session key swap even when persistence is
    // unavailable (private mode / some mobile webviews), so the fix never
    // silently degrades to fully server-trusted within a run.
    const mem = controlPinMem.get(userId);
    if (mem && mem !== served) return keyChanged();
    if (!mem) controlPinMem.set(userId, served);
    // Persistent pin across restarts (best-effort — the in-memory pin still holds).
    try {
        const pinKey = `control_pin_${userId}`;
        const pinned = localStorage.getItem(pinKey);
        if (pinned && pinned !== served) return keyChanged();
        if (!pinned) localStorage.setItem(pinKey, served);
    } catch {
        /* no persistence this run; in-memory pin above still applies */
    }
    return served;
}

/** VIEWER: derive the session key from my ephemeral + the host's ephemeral/static. */
async function startViewerCrypto(hostId: number, hostEphPub: string): Promise<boolean> {
    const id = getActiveIdentity();
    const hostStatic = id ? await getPinnedIdentityKey(hostId) : null;
    if (!id || !hostStatic || !viewerEph) { viewerCrypto = null; return false; }
    const key = deriveControlSessionKey(id.privateKey, hostStatic, viewerEph.priv, hostEphPub);
    if (!key) { viewerCrypto = null; return false; }
    viewerCrypto = { peerId: hostId, key, seq: 0, dcSeq: 0 };
    void sendControlHello(hostId, key);
    return true;
}

/** HOST: derive the session key from my (fresh) ephemeral + the viewer's ephemeral/static. */
async function startHostCrypto(viewerId: number, viewerEphPub: string, myEph: ControlEphemeral): Promise<boolean> {
    const id = getActiveIdentity();
    const viewerStatic = id ? await getPinnedIdentityKey(viewerId) : null;
    // The session may have been torn down during the async key fetch — don't
    // resurrect a stale key (mirror the viewer's viewerEph guard).
    if (state.controlledBy?.userId !== viewerId) { hostCrypto = null; return false; }
    if (!id || !viewerStatic) { hostCrypto = null; return false; }
    const key = deriveControlSessionKey(id.privateKey, viewerStatic, myEph.priv, viewerEphPub);
    if (!key) { hostCrypto = null; return false; }
    hostCrypto = { peerId: viewerId, key, recvSeq: 0, dcRecvSeq: 0 };
    // Announce the P2P lane now that a key exists to seal with. The peer's
    // own hello (or this one echoed back) is what opens it in each
    // direction; until then everything rides the relay.
    void sendControlHello(viewerId, key);
    return true;
}

/** HOST: mint my ephemeral, send it in the grant, and derive the session key.
 *  Ends the session if the handshake can't complete (never sit "granted" with no
 *  key — that would be a state that accepts unauthenticated input). Returns my
 *  ephemeral public key to include in the ControlResponse. */
function beginHostCrypto(viewerId: number, viewerEphPub: string | undefined): string | null {
    if (!viewerEphPub) {
        // Old/naughty client with no handshake material — refuse (fail closed).
        setNotice('Secure control channel unavailable — control ended.');
        revokeControl();
        return null;
    }
    const myEph = generateControlEphemeral();
    const failClosed = () => {
        if (state.controlledBy?.userId === viewerId) {
            setNotice('Secure control channel unavailable — control ended.');
            revokeControl();
        }
    };
    startHostCrypto(viewerId, viewerEphPub, myEph)
        .then((ok) => { if (!ok) failClosed(); })
        .catch(failClosed); // never leave a granted session without a key
    return myEph.pubEncoded;
}

const listeners = new Set<(s: ControlState) => void>();
let wired = false;

function emit() {
    // Fresh object so React state setters see a new reference.
    state = { ...state };
    listeners.forEach((cb) => cb(state));
}

export function subscribeControl(cb: (s: ControlState) => void): () => void {
    listeners.add(cb);
    cb(state);
    return () => listeners.delete(cb);
}

export function getControlState(): ControlState {
    return state;
}

function setNotice(msg: string) {
    state.notice = msg;
    emit();
}

export function clearNotice() {
    if (state.notice !== null) {
        state.notice = null;
        emit();
    }
}

// --- Host-side injection pipeline (desktop only; no-ops elsewhere) ---
//
// Everything the granted viewer sends passes through here before it becomes real
// OS input: reject malformed payloads, coalesce high-frequency motion, cap the
// total event rate, and route to the native `inject_input` (which additionally
// dedupes held keys/buttons and bounds values).

export function validEvent(e: unknown): e is ControlEvent {
    if (!e || typeof e !== 'object') return false;
    const ev = e as Record<string, unknown>;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    switch (ev.t) {
        case 'move': return num(ev.x) && num(ev.y);
        case 'rmove': return num(ev.dx) && num(ev.dy);
        case 'wheel': return num(ev.dy);
        case 'down':
        case 'up': return typeof ev.button === 'number' && ev.button >= 0 && ev.button <= 2;
        case 'key': return typeof ev.code === 'string' && ev.code.length <= 32 && typeof ev.down === 'boolean';
        default: return false;
    }
}

// Rolling 1s event budget.
let evWindowStart = 0;
let evCount = 0;
function underRateCap(): boolean {
    const now = performance.now();
    if (now - evWindowStart > 1000) {
        evWindowStart = now;
        evCount = 0;
    }
    if (evCount >= MAX_EVENTS_PER_SEC) return false;
    evCount++;
    return true;
}

async function injectRaw(event: ControlEvent): Promise<void> {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('inject_input', { event });
    } catch (e) {
        console.warn('[control] inject_input failed:', e);
    }
}

// Incoming coalescing: keep only the latest absolute move and the summed
// relative delta between flushes; state changes (button/key/wheel) flush pending
// motion first (ordering) then inject immediately.
let inMove: ControlEvent | null = null;
let inRmoveDx = 0;
let inRmoveDy = 0;
let inRmovePending = false;
let inFlushTimer: ReturnType<typeof setTimeout> | null = null;
// Leading-edge gate for injection, mirroring the sender's: motion arriving
// after a quiet window injects immediately instead of waiting out a timer.
let lastInFlush = 0;

function flushIncoming() {
    if (inFlushTimer !== null) {
        clearTimeout(inFlushTimer);
        inFlushTimer = null;
    }
    lastInFlush = performance.now();
    if (inMove) {
        void injectRaw(inMove);
        inMove = null;
    }
    if (inRmovePending) {
        void injectRaw({ t: 'rmove', dx: inRmoveDx, dy: inRmoveDy });
        inRmoveDx = 0;
        inRmoveDy = 0;
        inRmovePending = false;
    }
}

function handleIncomingInput(event: ControlEvent) {
    // Strict binding: only inject while we're still actively sharing.
    if (getCurrentStreamingUserId() == null) return;
    if (!underRateCap()) return;
    if (event.t === 'move' || event.t === 'rmove') {
        if (event.t === 'move') {
            inMove = event;
        } else {
            inRmoveDx += event.dx;
            inRmoveDy += event.dy;
            inRmovePending = true;
        }
        // Leading edge: the viewer already paces motion (16ms moves, 8ms
        // rmove flushes), so arrivals in the steady state are at least a
        // window apart and deferring them again bought nothing — it just
        // added a flat 8ms before every injection. The window only engages
        // for genuine bursts (relay jitter bunching frames together).
        const since = performance.now() - lastInFlush;
        if (since >= 8) {
            flushIncoming();
        } else if (inFlushTimer === null) {
            inFlushTimer = setTimeout(flushIncoming, Math.max(0, 8 - since));
        }
        return;
    }
    flushIncoming(); // preserve ordering: motion lands before the click/key
    void injectRaw(event);
}

async function releaseInput() {
    inMove = null;
    inRmovePending = false;
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('release_control_input');
    } catch {
        /* best effort */
    }
}

// Map the shared surface to the correct monitor (multi-monitor / negative
// coords). Best-effort: match the capture resolution, else primary.
async function setupMonitorTarget() {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const ml = await invoke<{
            monitors: Array<{ index: number; left: number; top: number; width: number; height: number; primary: boolean }>;
            virt_left: number; virt_top: number; virt_width: number; virt_height: number;
        }>('list_monitors');
        const hostId = getCurrentStreamingUserId();
        const track = hostId != null ? getStreamData(hostId)?.stream?.getVideoTracks()[0] : null;
        const s = track?.getSettings();
        const near = (a: number, b: number) => Math.abs(a - b) <= 2;
        const chosen =
            (s?.width && s?.height
                ? ml.monitors.find((m) => near(m.width, s.width!) && near(m.height, s.height!))
                : undefined) ??
            ml.monitors.find((m) => m.primary) ??
            ml.monitors[0];
        const target = chosen
            ? {
                  left: chosen.left, top: chosen.top, width: chosen.width, height: chosen.height,
                  virt_left: ml.virt_left, virt_top: ml.virt_top,
                  virt_width: ml.virt_width, virt_height: ml.virt_height,
              }
            : null;
        await invoke('set_control_monitor', { target });
    } catch {
        /* fall back to primary-monitor mapping in native */
    }
}

async function clearMonitorTarget() {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_control_monitor', { target: null });
    } catch {
        /* best effort */
    }
}

// Inactivity timeout for an active host session.
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
function armInactivity() {
    clearInactivity();
    inactivityTimer = setTimeout(() => {
        if (state.controlledBy) {
            setNotice('Control ended after inactivity.');
            revokeControl();
        }
    }, INACTIVITY_MS);
}
function clearInactivity() {
    if (inactivityTimer !== null) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }
}

async function listAnticheat(): Promise<string[]> {
    if (!isTauri()) return [];
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<string[]>('list_anticheat_processes');
    } catch {
        return [];
    }
}

// Host kill-switch guard: while being controlled, a native low-level hook
// enforces (a) the user's custom kill-switch hotkey — always on, works even
// when a controlled game has focus — and (b) optionally, revoke-on-any-input.
async function startGuard() {
    if (!isTauri()) return;
    try {
        const { loadSettings } = await import('../components/settingsStore');
        const s = loadSettings();
        // The kill switch may be unbound (every binding is clearable now).
        // vk 0 tells the native guard there is no key to watch; the Stop
        // button and the any-input kill remain.
        const kk = s.remoteControlKillKey;
        const killMods = kk ? ((kk.ctrl ? 1 : 0) | (kk.alt ? 2 : 0) | (kk.shift ? 4 : 0)) : 0;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('start_control_guard', {
            anyInput: !!s.remoteControlAnyInputKill,
            killVk: kk ? (kk.keyCode | 0) : 0,
            killMods,
        });
    } catch (e) {
        console.warn('[control] start_control_guard failed (manual Stop still works):', e);
    }
}

async function stopGuard() {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_control_guard');
    } catch {
        /* best effort */
    }
}

// --- Viewer API ---

export function requestControl(hostUserId: number, hostUsername: string) {
    if (state.controlling) return; // already controlling / requesting someone
    const wait = cooldownRemainingMs(viewerDenials, hostUserId);
    if (wait > 0) {
        setNotice(`${hostUsername} declined recently — you can ask again in ${fmtCooldown(wait)}.`);
        return;
    }
    viewerEph = generateControlEphemeral(); // fresh per session
    state.controlling = { userId: hostUserId, username: hostUsername, status: 'requesting' };
    emit();
    wsClient.send({ type: 'ControlRequest', payload: { target_user: hostUserId, eph: viewerEph.pubEncoded } });
}

export function stopControlling() {
    const target = state.controlling;
    if (!target) return;
    wsClient.send({ type: 'ControlEnd', payload: { target_user: target.userId } });
    state.controlling = null;
    // Capability is per session on this side too — see endHostSession.
    forgetControlChannels(target.userId);
    viewerCrypto = null;
    viewerEph = null;
    controlHostCapture = null;
    rmoveAccum = { dx: 0, dy: 0 }; // drop unsent sub-pixel residual
    pendingAbsMove = null; // and the unsent trailing position
    // Give the watching-tuned jitter buffer back: zero-buffer is the right
    // trade only while pointing at things, and on a bad link it means
    // stutter for however long they keep watching.
    setScreenLatencyMinimised(target.userId, false);
    emit();
}

/** VIEWER: accept a host's offer of control — turns into a normal request the
 *  host auto-approves (it initiated the offer). */
export function acceptControlOffer() {
    const off = state.offer;
    if (!off || state.controlling) return;
    viewerEph = generateControlEphemeral();
    state.offer = null;
    state.controlling = { userId: off.userId, username: off.username, status: 'requesting' };
    // Make sure I'm watching their stream so the capture surface is on screen.
    selectStream(off.userId);
    emit();
    wsClient.send({ type: 'ControlRequest', payload: { target_user: off.userId, eph: viewerEph.pubEncoded } });
}

/** VIEWER: decline a control offer. */
export function declineControlOffer() {
    const off = state.offer;
    if (!off) return;
    wsClient.send({ type: 'ControlEnd', payload: { target_user: off.userId } });
    state.offer = null;
    emit();
}

/** True when I'm the viewer and my control session is live (capture should run). */
export function isControlActive(hostUserId: number): boolean {
    return state.controlling?.userId === hostUserId && state.controlling.status === 'active';
}

/**
 * FPS-mode delta scale: viewer CSS px → host source px. The stream renders
 * `object-fit: contain` inside its element, so the content on screen is
 * videoW * min(rectW/videoW, rectH/videoH) wide; one viewer pixel of mouse
 * travel must become videoW/displayedW host pixels for a full sweep to cover
 * the same arc it would locally. Falls back to 1 on degenerate sizes (video
 * metadata not loaded yet). Pure so tests can drive it.
 */
export function computeRmoveScale(videoW: number, videoH: number, rectW: number, rectH: number): number {
    if (!(videoW > 0) || !(videoH > 0) || !(rectW > 0) || !(rectH > 0)) return 1;
    const displayedW = videoW * Math.min(rectW / videoW, rectH / videoH);
    if (!Number.isFinite(displayedW) || !(displayedW > 0)) return 1;
    return videoW / displayedW;
}

// VIEWER: the host's capture pixel size, relayed once in the grant. FPS-mode
// delta scaling calibrates against THIS (a stable size) rather than the live
// decoded videoWidth — which shrinks when WebRTC downscales the stream under
// bandwidth/CPU pressure and would otherwise halve aim sensitivity mid-session.
// Null until a grant carries it (or the host is too old to send it — the viewer
// then falls back to videoWidth).
let controlHostCapture: { w: number; h: number } | null = null;

export function getControlHostCapture(): { w: number; h: number } | null {
    return controlHostCapture;
}

/** HOST: my shared capture's pixel size, for the viewer's FPS delta scaling.
 *  Read from the SOURCE track settings (the capture resolution), which — unlike
 *  the encoded/decoded frame the viewer sees — is unaffected by bandwidth/CPU
 *  adaptation. Null if unknown (the viewer then calibrates off live videoWidth). */
function hostCaptureDims(): { w?: number; h?: number } {
    const hostId = getCurrentStreamingUserId();
    if (hostId == null) return {};
    const s = getStreamData(hostId)?.stream?.getVideoTracks()[0]?.getSettings();
    if (s && s.width && s.height && s.width > 0 && s.height > 0) {
        return { w: Math.round(s.width), h: Math.round(s.height) };
    }
    return {};
}

/** Split an accumulated (possibly fractional) relative-move delta into the
 *  integer part to send now and the sub-pixel residual to carry into the next
 *  flush. Truncate-toward-zero + carry means slow low-sensitivity aiming
 *  (e.g. 0.25px per flush) accumulates instead of rounding away forever.
 *  Pure so tests can drive it. (`|| 0` normalizes -0.) */
export function splitRmoveDelta(acc: { dx: number; dy: number }): {
    send: { dx: number; dy: number };
    carry: { dx: number; dy: number };
} {
    const dx = Math.trunc(acc.dx) || 0;
    const dy = Math.trunc(acc.dy) || 0;
    return { send: { dx, dy }, carry: { dx: acc.dx - dx, dy: acc.dy - dy } };
}

let lastMoveSent = 0;
// The newest absolute move not yet sent. The old throttle DROPPED
// intermediate positions with no trailing flush, so the last move of a drag
// — and the position-sync move fired right before a click — could vanish
// inside the 16ms window, landing the click wherever the pointer used to be.
let pendingAbsMove: ControlEvent | null = null;
let absMoveTimer: ReturnType<typeof setTimeout> | null = null;
// Relative-move (FPS) deltas accumulate and flush on a timer so we sum motion
// (never drop it) and keep the relay light at high mouse poll rates. Deltas
// arrive pre-scaled (floats); we send whole pixels and carry the remainder.
let rmoveAccum = { dx: 0, dy: 0 };
let rmoveTimer: ReturnType<typeof setTimeout> | null = null;
// When the last rmove flush ran — the leading-edge gate. An isolated flick
// goes straight out instead of waiting the full window at BOTH ends.
let lastRmoveFlush = 0;

// Backpressure valve: while the socket holds more than this many unsent
// bytes, MOTION FLUSHES ARE HELD — the pending position keeps superseding and
// the delta accumulator keeps summing, so nothing is lost, it is just late.
// Holding at the FLUSH (not dropping in rawSend) is the load-bearing choice:
// the first version dropped inside rawSend, which binned deltas already
// drained from the accumulator (distance lost forever) and binned the
// positioning move the state-event ordering block had just flushed ahead of
// a click (click teleport). State events are never held.
const UPLINK_HIGH_WATER_BYTES = 64 * 1024;
function uplinkClear(): boolean {
    return wsClient.bufferedAmount() <= UPLINK_HIGH_WATER_BYTES;
}

/** Timer-driven flushes route through these: congested → hold and retry. */
function tryFlushRmove() {
    rmoveTimer = null;
    if (!uplinkClear()) {
        rmoveTimer = setTimeout(tryFlushRmove, 8);
        return;
    }
    flushRmove();
}
function tryFlushAbsMove() {
    absMoveTimer = null;
    if (!uplinkClear()) {
        absMoveTimer = setTimeout(tryFlushAbsMove, 8);
        return;
    }
    flushAbsMove();
}

function rawSend(event: ControlEvent) {
    const target = state.controlling;
    if (!target || target.status !== 'active') return;
    const cc = viewerCrypto;
    // Fail closed: without a pairwise key we do NOT fall back to plaintext.
    if (!cc || cc.peerId !== target.userId) return;
    const targetId = target.userId;
    // P2P FIRST (W5/R2): the DC when the peer has proved it understands
    // these frames, else the relay — which stays the permanent fallback and
    // the only path that always exists. The transport decides the SEQUENCE
    // NAMESPACE too (see the crypto state comment).
    const lane: CtlLane = laneFor(event.t);
    const viaDc = controlDcReady(targetId, lane);
    const seq = viaDc ? ++cc.dcSeq : ++cc.seq;
    const payload = JSON.stringify({ s: seq, e: event });
    sendChain = sendChain
        .then(async () => {
            if (viewerCrypto !== cc) return; // session torn down mid-flight
            if (viaDc) {
                const bytes = await sealControlBytes(cc.key, payload);
                if (sendControlFrame(targetId, lane, FRAME_SEALED_INPUT, bytes)) return;
                // The channel died between the check and the send: fall back
                // in place rather than dropping the event. Its DC sequence
                // number is spent — harmless, the namespaces are separate and
                // the host only requires STRICTLY INCREASING within each.
                dcFellBack(targetId, 'send failed');
            }
            const sealed = await sealControl(cc.key, payload);
            wsClient.send({ type: 'ControlInput', payload: { target_user: targetId, event: sealed } });
        })
        .catch(() => { /* drop on any seal/send error */ });
}

/** One place logs every fall-back so the field can tell "the DC never came
 *  up" from "it came up and died" — the P2P work's whole diagnostic. */
function dcFellBack(peerId: number, why: string): void {
    console.info(`[p2p-input] peer ${peerId}: using the relay (${why})`);
}

// --- P2P input transport (W5/R2) ---
//
// The hello is a SEALED frame under the session key: only a peer holding it
// can produce one, so the capability cannot be announced by the server or a
// bystander. Both roles send one when their session key exists, and either
// direction's arrival opens the lane.

async function sendControlHello(peerId: number, key: Uint8Array): Promise<void> {
    try {
        const bytes = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        sendHello(peerId, bytes);
    } catch { /* the relay keeps working */ }
}

/** Install the single inbound-frame consumer. Idempotent. */
function wireControlDc(): void {
    setControlFrameHandler((peerId, lane, frame) => {
        // Which side am I for THIS peer? A user can be host to one peer and
        // viewer to another at the same time.
        const asHost = hostCrypto && hostCrypto.peerId === peerId ? hostCrypto : null;
        const asViewer = viewerCrypto && viewerCrypto.peerId === peerId ? viewerCrypto : null;
        const key = asHost?.key ?? asViewer?.key;
        if (!key) return;
        if (frame.kind === FRAME_HELLO) {
            recvChain = recvChain.then(async () => {
                // A hello must OPEN under the session key: an unsealed or
                // forged one proves nothing and must not arm the transport.
                const plain = await openControlBytes(key, frame.payload);
                if (plain === null) return;
                markHelloSeen(peerId);
                console.info(`[p2p-input] peer ${peerId}: control data channel ready`);
            }).catch(() => undefined);
            return;
        }
        if (frame.kind !== FRAME_SEALED_INPUT) return;
        // Only the HOST injects, and only from the viewer it granted — the
        // same rule the relay path applies, restated here because this
        // transport does not pass through that handler.
        if (!asHost) return;
        const cc = asHost;
        recvChain = recvChain
            .then(async () => {
                if (hostCrypto !== cc) return; // torn down mid-flight
                const plain = await openControlBytes(cc.key, frame.payload);
                if (plain == null) return;
                let parsed: unknown;
                try { parsed = JSON.parse(plain); } catch { return; }
                const obj = parsed as { s?: unknown; e?: unknown };
                // The DC's OWN namespace — never the relay's counter.
                if (typeof obj.s !== 'number' || !Number.isInteger(obj.s) || obj.s <= cc.dcRecvSeq) return;
                cc.dcRecvSeq = obj.s;
                if (!validEvent(obj.e)) return;
                armInactivity();
                handleIncomingInput(obj.e);
            })
            .catch(() => { /* drop on any open/parse error */ });
        void lane;
    });
}

// Keep every SENT rmove within one native injection step. The current host
// splits a large delta into <=4000px steps itself, but a not-yet-upgraded host
// CLAMPS a single >4000px event — silently shortening fast flicks. Spreading
// the overflow across successive 8ms flushes lands each piece in a separate
// host coalescing window, so nothing is clipped either way. Mirrors STEP in
// remote_control.rs::inject.
const RMOVE_STEP = 4000;

function flushAbsMove() {
    if (absMoveTimer !== null) {
        clearTimeout(absMoveTimer);
        absMoveTimer = null;
    }
    if (pendingAbsMove !== null) {
        const ev = pendingAbsMove;
        pendingAbsMove = null;
        lastMoveSent = performance.now();
        rawSend(ev);
    }
}

function flushRmove() {
    rmoveTimer = null;
    // An EMPTY flush (the state-event ordering path runs unconditionally)
    // must not stamp — it would burn the leading edge for the next real
    // flick after every click.
    if (rmoveAccum.dx === 0 && rmoveAccum.dy === 0) return;
    // Stamp on every non-empty flush, sent or carried: a sub-pixel stream
    // then batches per window like it always did, while a real flick after a
    // quiet moment rides the leading edge in sendControlEvent.
    lastRmoveFlush = performance.now();
    const { send, carry } = splitRmoveDelta(rmoveAccum);
    const clampStep = (v: number) => Math.max(-RMOVE_STEP, Math.min(RMOVE_STEP, v));
    const sx = clampStep(send.dx);
    const sy = clampStep(send.dy);
    // Carry the sub-pixel residual AND any over-step overflow into the next flush.
    rmoveAccum = { dx: carry.dx + (send.dx - sx), dy: carry.dy + (send.dy - sy) };
    if (sx !== 0 || sy !== 0) {
        rawSend({ t: 'rmove', dx: sx, dy: sy });
    }
    // Drain leftover overflow promptly even if the pointer has stopped moving.
    if (rmoveTimer === null && (Math.abs(rmoveAccum.dx) >= 1 || Math.abs(rmoveAccum.dy) >= 1)) {
        rmoveTimer = setTimeout(tryFlushRmove, 8);
    }
}

export function sendControlEvent(event: ControlEvent) {
    const target = state.controlling;
    if (!target || target.status !== 'active') return;

    if (event.t === 'rmove') {
        rmoveAccum.dx += event.dx;
        rmoveAccum.dy += event.dy;
        // Leading edge: the first delta after a quiet moment goes straight
        // out — the unconditional defer cost every isolated flick 8ms here
        // and another 8ms on the host. A sustained stream still batches per
        // window, anchored on the last flush. A congested uplink holds the
        // accumulator instead (tryFlushRmove retries), losing nothing.
        const since = performance.now() - lastRmoveFlush;
        if (since >= 8 && uplinkClear()) {
            if (rmoveTimer !== null) {
                clearTimeout(rmoveTimer);
                rmoveTimer = null;
            }
            flushRmove();
        } else if (rmoveTimer === null) {
            rmoveTimer = setTimeout(tryFlushRmove, Math.max(0, 8 - since));
        }
        return;
    }
    // Absolute move: collapse to ~60/s, but never DROP the newest position —
    // it is held and trail-flushed, so the last move of a drag (and the
    // position-sync move ahead of a click) always lands.
    if (event.t === 'move') {
        // Relative motion queued BEFORE this absolute move goes first — mixed
        // trackpad/pointer transients must not let a position overtake the
        // deltas that preceded it. (Held under congestion like all motion.)
        if (rmoveTimer !== null && uplinkClear()) {
            clearTimeout(rmoveTimer);
            rmoveTimer = null;
            flushRmove();
        }
        pendingAbsMove = event;
        const since = performance.now() - lastMoveSent;
        if (since >= 16 && uplinkClear()) {
            flushAbsMove();
        } else if (absMoveTimer === null) {
            absMoveTimer = setTimeout(tryFlushAbsMove, Math.max(0, 16 - since));
        }
        return;
    }
    // Preserve ordering: flush any pending motion before a click/key/wheel —
    // UNCONDITIONALLY, past the congestion valve. Motion a state event
    // depends on is not stale, and a click landing at a position the wire
    // never saw is the disaster this whole block exists to prevent.
    if (rmoveTimer !== null) {
        clearTimeout(rmoveTimer);
        rmoveTimer = null;
    }
    flushRmove();
    flushAbsMove();
    rawSend(event);
}

// --- Host API ---

export async function respondToControlRequest(granted: boolean) {
    const req = state.incomingRequest;
    if (!req) return;
    state.incomingRequest = null;
    // A human answered: stop the auto-deny deadline racing this decision, and
    // let the window drop back behind the game.
    clearConsentAttention();
    // Re-render NOW, before the anti-cheat scan below. That scan enumerates
    // every running process, so the prompt used to stay fully painted while it
    // ran — the click looked ignored, and a second click hit the `!req` guard
    // and did nothing. (Deny felt instant only because it emits straight away.)
    emit();

    if (granted) {
        // Refuse while an anti-cheat is running: injected input won't work and
        // can get the host banned.
        const ac = await listAnticheat();
        if (ac.length > 0) {
            wsClient.send({ type: 'ControlResponse', payload: { target_user: req.userId, granted: false } });
            setNotice(`Control blocked — ${ac.join(', ')} is running (injected input risks a ban).`);
            return;
        }
        hostDenials.delete(req.userId); // granting wipes their denial ladder
        state.controlledBy = req;
        const viewerEphPub = pendingViewerEph?.userId === req.userId ? pendingViewerEph.ephPub : undefined;
        pendingViewerEph = null;
        const hostEphPub = beginHostCrypto(req.userId, viewerEphPub);
        if (!hostEphPub) return; // handshake material missing → beginHostCrypto revoked
        const cap = hostCaptureDims();
        wsClient.send({ type: 'ControlResponse', payload: { target_user: req.userId, granted: true, eph: hostEphPub, cap_w: cap.w, cap_h: cap.h } });
        void startGuard();
        void setupMonitorTarget();
        armInactivity();
        emit();
    } else {
        // Growing mute on re-requests: they only reach me again after the
        // cooldown (auto-denied silently until then).
        const wait = bumpDenial(hostDenials, req.userId);
        wsClient.send({ type: 'ControlResponse', payload: { target_user: req.userId, granted: false } });
        setNotice(`Denied — repeat requests from ${req.username} are auto-declined for ${fmtCooldown(wait)}.`);
        emit();
    }
}

/** HOST: end the active session (the banner's Stop button / kill switch). */
export function revokeControl() {
    const controller = state.controlledBy;
    if (!controller) return;
    wsClient.send({ type: 'ControlEnd', payload: { target_user: controller.userId } });
    state.controlledBy = null;
    endHostSession();
    emit();
}

/** Tear down all host-side control machinery (guard, held input, monitor, timers). */
function endHostSession() {
    clearInactivity();
    // Forget the P2P lanes with the key: capability is per SESSION, and a
    // hello from the last one must not arm the next.
    if (hostCrypto) forgetControlChannels(hostCrypto.peerId);
    hostCrypto = null;      // no key ⇒ any further ControlInput is dropped
    pendingViewerEph = null;
    void stopGuard();       // stops the LL hook AND releases held input natively
    void releaseInput();    // also clears JS coalesce buffers
    void clearMonitorTarget();
}

function clearOffered() {
    offeredTo = null;
    if (offerTimer !== null) {
        clearTimeout(offerTimer);
        offerTimer = null;
    }
}

/** HOST: proactively offer control of my shared screen to a specific viewer.
 *  Sends them an offer they can accept/decline; if they accept, their request is
 *  auto-approved (no second prompt for me). Only meaningful while I'm sharing on
 *  the desktop app. */
export function offerControl(viewerUserId: number, viewerUsername: string) {
    if (!isTauri() || getCurrentStreamingUserId() == null) {
        setNotice('Start sharing your screen (desktop app) before offering control.');
        return;
    }
    if (state.controlledBy || state.incomingRequest || offeredTo != null) {
        setNotice('You already have a control request or session in progress.');
        return;
    }
    offeredTo = viewerUserId;
    // The offer nudge: an unsolicited grant the viewer surfaces as an offer prompt.
    wsClient.send({ type: 'ControlResponse', payload: { target_user: viewerUserId, granted: true } });
    setNotice(`Offered screen control to ${viewerUsername} — waiting for them to accept.`);
    // Expire the offer if unanswered so a stale offeredTo can't auto-approve later.
    if (offerTimer !== null) clearTimeout(offerTimer);
    offerTimer = setTimeout(() => {
        if (offeredTo === viewerUserId && !state.controlledBy) {
            clearOffered();
            setNotice(`${viewerUsername} didn't take control — offer expired.`);
        }
    }, 45_000);
}

// --- WS wiring (call once at startup) ---

export function initRemoteControl() {
    if (wired) return;
    wired = true;
    wireControlDc();

    // HOST: a viewer wants control of my screen.
    wsClient.on('ControlRequested', async (msg: ServerMessage) => {
        const p = msg.payload as { from_user: number; from_username: string; eph?: string };
        // Can only grant if I'm actually sharing AND on the desktop app (only it
        // can inject), and the request must carry handshake material. Auto-deny
        // otherwise so the viewer isn't left hanging.
        const sharing = getCurrentStreamingUserId() != null;
        if (!sharing || !isTauri() || !p.eph) {
            wsClient.send({ type: 'ControlResponse', payload: { target_user: p.from_user, granted: false } });
            return;
        }
        // If I proactively offered this viewer control, their request IS the
        // acceptance — auto-approve it (no second prompt for me).
        if (offeredTo === p.from_user && !state.controlledBy) {
            // Enforce the SAME anti-cheat gate as the manual grant path (audit
            // M10): injected input won't work under an anti-cheat product and can
            // get the host banned, so refuse even on the auto-approve path.
            const ac = await listAnticheat();
            if (ac.length > 0) {
                clearOffered();
                wsClient.send({ type: 'ControlResponse', payload: { target_user: p.from_user, granted: false } });
                setNotice(`Control blocked — ${ac.join(', ')} is running (injected input risks a ban).`);
                emit();
                return;
            }
            clearOffered();
            state.controlledBy = { userId: p.from_user, username: p.from_username };
            const hostEphPub = beginHostCrypto(p.from_user, p.eph);
            if (!hostEphPub) return; // handshake failed → revoked
            const cap = hostCaptureDims();
            wsClient.send({ type: 'ControlResponse', payload: { target_user: p.from_user, granted: true, eph: hostEphPub, cap_w: cap.w, cap_h: cap.h } });
            void startGuard();
            void setupMonitorTarget();
            armInactivity();
            emit();
            return;
        }
        if (state.controlledBy || state.incomingRequest) {
            // Already controlled / another request pending — refuse (one at a time).
            wsClient.send({ type: 'ControlResponse', payload: { target_user: p.from_user, granted: false } });
            return;
        }
        // Denied recently — auto-deny WITHOUT showing the prompt, so repeat
        // requests can't spam the host. Growing window per bumpDenial. (The
        // offered-viewer branch above intentionally bypasses this.)
        if (cooldownRemainingMs(hostDenials, p.from_user) > 0) {
            wsClient.send({ type: 'ControlResponse', payload: { target_user: p.from_user, granted: false } });
            return;
        }
        // Keep the viewer's ephemeral until I decide; the grant completes the handshake.
        pendingViewerEph = { userId: p.from_user, ephPub: p.eph };
        state.incomingRequest = { userId: p.from_user, username: p.from_username };
        // SURFACE the window — visible on top of the game WITHOUT activating
        // it. The old path (unminimize + set_focus behind an always-on-top
        // toggle) was a forced foreground steal: it tabbed a borderless-
        // windowed game out on every request. "surface" keeps the game's
        // focus, keyboard and cursor clip; the prompt is still visible and an
        // OS notification + taskbar flash cover the case where it isn't seen.
        //
        // Still RATE-LIMITED, because this is triggered by an inbound PEER
        // message before any consent: even a no-activate topmost window over a
        // game is a griefable annoyance. After the first surface, later
        // requests only flash the taskbar.
        if (isTauri()) {
            const now = Date.now();
            const surface = now - lastAttentionAt > ATTENTION_COOLDOWN_MS;
            if (surface) lastAttentionAt = now;
            void import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke('attention_main_window', { mode: surface ? 'surface' : 'flash' }))
                .catch(() => { /* older build without the command */ });
            void (async () => {
                try {
                    const { isPermissionGranted, sendNotification } =
                        await import('@tauri-apps/plugin-notification');
                    if (await isPermissionGranted()) {
                        sendNotification({
                            title: `${p.from_username} wants control of your screen`,
                            body: 'Switch to Puca to allow or deny.',
                        });
                    }
                } catch { /* notification is best-effort */ }
            })();
        }
        // The mirror of removing the focus-steal: the host may honestly not
        // see the prompt now, so an unanswered request must resolve itself —
        // the viewer already handles granted:false (denial ladder + notice).
        if (consentDeadlineTimer !== null) clearTimeout(consentDeadlineTimer);
        consentDeadlineTimer = setTimeout(() => {
            consentDeadlineTimer = null;
            if (state.incomingRequest?.userId !== p.from_user) return;
            state.incomingRequest = null;
            if (pendingViewerEph?.userId === p.from_user) pendingViewerEph = null;
            // Enter the denial ladder like a human deny would: without it a
            // hostile viewer could re-request every 45s forever, each one
            // firing a notification (and a surface every cooldown window).
            // An honestly-missed prompt recovers — the ladder decays after
            // DENIAL_DECAY_MS of quiet.
            bumpDenial(hostDenials, p.from_user);
            wsClient.send({ type: 'ControlResponse', payload: { target_user: p.from_user, granted: false } });
            clearConsentAttention();
            emit();
        }, HOST_CONSENT_DEADLINE_MS);
        emit();
    });

    // VIEWER: the host answered my request — OR proactively offered me control.
    wsClient.on('ControlResponse', (msg: ServerMessage) => {
        const p = msg.payload as { from_user: number; granted: boolean; eph?: string; cap_w?: number; cap_h?: number };
        // A grant with no request of mine outstanding is an OFFER (the host chose
        // to hand me control). Surface it as an accept/decline prompt. (Offers
        // carry no eph — the handshake happens after I accept and send a request.)
        if (p.granted && (!state.controlling || state.controlling.userId !== p.from_user)) {
            if (state.controlling || state.offer) return; // busy — ignore extra offers
            // An explicit offer overrides any earlier denial history with them.
            viewerDenials.delete(p.from_user);
            const username = getStreamData(p.from_user)?.username ?? `User ${p.from_user}`;
            state.offer = { userId: p.from_user, username };
            emit();
            return;
        }
        if (!state.controlling || state.controlling.userId !== p.from_user) return;
        if (p.granted) {
            // A real grant must carry the host's ephemeral key; without it we
            // cannot establish the secure channel → treat as declined (fail closed).
            if (!p.eph) {
                setNotice('Secure control channel unavailable — control disabled.');
                // Restore even though this LOOKS like a pre-active path: a
                // stale grant can land while an earlier session is active
                // (host ended locally, its ControlEnd lost), and leaving the
                // minimised flag behind strands the receiver at zero-buffer
                // for the life of the tab.
                setScreenLatencyMinimised(p.from_user, false);
                state.controlling = null;
                viewerEph = null;
                emit();
                return;
            }
            const hostEph = p.eph;
            const hostId = p.from_user;
            viewerDenials.delete(hostId); // granted — forget the denial ladder
            // Stable host capture size for FPS delta calibration (see
            // computeRmoveScale). Absent from older hosts → fall back to videoWidth.
            controlHostCapture = (typeof p.cap_w === 'number' && typeof p.cap_h === 'number'
                && p.cap_w > 0 && p.cap_h > 0) ? { w: p.cap_w, h: p.cap_h } : null;
            state.controlling = { ...state.controlling, status: 'active' };
            // Driving now: drop the receiver's jitter buffer for THIS share —
            // the same latency fix the My Devices path ships (session.ts),
            // measured to matter there. Undone on every path that ends
            // control; plain watching keeps the browser's buffering.
            setScreenLatencyMinimised(hostId, true);
            emit();
            // Establish the per-session key before input flows; fail closed if we
            // can't (no identity / key changed / bad material ⇒ never send input).
            const failClosed = () => {
                if (state.controlling?.userId === hostId) {
                    setNotice('Secure control channel unavailable — control disabled.');
                    stopControlling();
                }
            };
            startViewerCrypto(hostId, hostEph)
                .then((ok) => { if (!ok) failClosed(); })
                .catch(failClosed);
        } else {
            // Start/grow the re-request cooldown for this host. (Auto-denies —
            // not sharing, busy, non-desktop — land here too; the ladder still
            // applies, and decays after DENIAL_DECAY_MS of quiet.)
            const wait = bumpDenial(viewerDenials, p.from_user);
            setNotice(`${state.controlling.username} declined control (or it isn't available). You can ask again in ${fmtCooldown(wait)}.`);
            // This branch is reachable while ACTIVE (the guard above is
            // status-agnostic, and the server fans a deny out to every conn —
            // e.g. this user requesting the same host from a second tab), so
            // it must give the jitter buffer back like every other ender.
            setScreenLatencyMinimised(p.from_user, false);
            state.controlling = null;
            emit();
        }
    });

    // HOST: an input event from the controlling viewer. Inject ONLY if it's from
    // the viewer we granted — never trust an unsolicited relay — and only after
    // it survives validation, coalescing, and the rate cap.
    wsClient.on('ControlInput', (msg: ServerMessage) => {
        const p = msg.payload as { from_user: number; event: string };
        if (!state.controlledBy || state.controlledBy.userId !== p.from_user) return;
        const cc = hostCrypto;
        // Fail closed: no pairwise key for this viewer ⇒ never inject.
        if (!cc || cc.peerId !== p.from_user) return;
        const sealed = p.event;
        recvChain = recvChain
            .then(async () => {
                if (hostCrypto !== cc) return; // torn down mid-flight
                // Forged/tampered payload ⇒ GCM open fails ⇒ drop (server can't inject).
                const plain = await openControl(cc.key, sealed);
                if (plain == null) return;
                let parsed: unknown;
                try { parsed = JSON.parse(plain); } catch { return; }
                const obj = parsed as { s?: unknown; e?: unknown };
                // Replay / reorder protection: strictly increasing sequence.
                if (typeof obj.s !== 'number' || !Number.isInteger(obj.s) || obj.s <= cc.recvSeq) return;
                cc.recvSeq = obj.s;
                if (!validEvent(obj.e)) return;
                armInactivity(); // any valid input keeps the session alive
                handleIncomingInput(obj.e);
            })
            .catch(() => { /* drop on any open/parse error */ });
    });

    // Either side ended the session.
    wsClient.on('ControlEnded', (msg: ServerMessage) => {
        const p = msg.payload as { from_user: number };
        teardownPartner(p.from_user, 'Control session ended.');
    });

    // A control partner going offline ends the session. Screen share happens in a
    // server voice channel, so both parties share that server and are therefore
    // in each other's presence audience — UserOffline reliably reaches us here.
    wsClient.on('UserOffline', (msg: ServerMessage) => {
        const p = msg.payload as { user_id: number };
        teardownPartner(p.user_id, 'The other person disconnected — control ended.');
    });

    if (typeof window !== 'undefined') {
        // Leaving voice / stopping the share tears down any session (voiceState
        // fires this — a window event avoids a circular import).
        window.addEventListener('voiceControlReset', () => resetRemoteControl());

        // The host's own WS dropping ends control and releases held input — no
        // relay means no more input, and we must not leave a key stuck down.
        window.addEventListener('wsClosed', () => {
            if (state.controlledBy || state.controlling) resetRemoteControl();
        });

        // Emergency hotkeys while the Puca window has focus: Escape always
        // revokes, and the user's configured kill-switch combo does too (this is
        // a fail-safe mirror of the native hook, which also covers the case
        // where a controlled GAME has focus and this listener can't fire).
        window.addEventListener('keydown', (e) => {
            if (!state.controlledBy) return;
            if (e.key === 'Escape') {
                setNotice('Remote control revoked (Esc).');
                revokeControl();
                return;
            }
            const kk = loadKillKey();
            if (kk && e.keyCode === kk.keyCode &&
                e.ctrlKey === kk.ctrl && e.altKey === kk.alt && e.shiftKey === kk.shift) {
                e.preventDefault();
                setNotice(`Remote control revoked (${kk.label}).`);
                revokeControl();
            }
        });
    }

    // If the kill-switch settings change WHILE a session is active, re-arm the
    // native guard so the new hotkey / any-input choice takes effect at once
    // (start_control_guard just updates the live config; no respawn).
    if (typeof window !== 'undefined') {
        window.addEventListener('settingsChanged', () => {
            if (state.controlledBy) void startGuard();
        });
    }

    // Host kill switch: native hook fires on any-input (opt-in) or the custom
    // kill-switch hotkey (always on, works even under a focused game).
    if (isTauri()) {
        import('@tauri-apps/api/event')
            .then(({ listen }) => {
                listen('host-input-detected', () => {
                    if (state.controlledBy) {
                        setNotice('You took over — remote control released.');
                        revokeControl();
                    }
                });
                listen('host-killswitch-hotkey', () => {
                    if (state.controlledBy) {
                        setNotice('Kill switch pressed — remote control released.');
                        revokeControl();
                    }
                });
            })
            .catch(() => { /* event API unavailable — manual Stop still works */ });
    }
}

/** The configured custom kill-switch hotkey, or null if settings unreadable. */
function loadKillKey(): { keyCode: number; ctrl: boolean; alt: boolean; shift: boolean; label: string } | null {
    try {
        const raw = localStorage.getItem('sovereign_settings');
        const s = raw ? JSON.parse(raw) : null;
        return s?.remoteControlKillKey ?? { keyCode: 27, ctrl: false, alt: false, shift: false, label: 'Esc' };
    } catch {
        return null;
    }
}

/** Clear whatever control relationship we have with `userId`, with a notice. */
function teardownPartner(userId: number, controllingNotice: string) {
    let changed = false;
    if (state.controlledBy?.userId === userId) {
        state.controlledBy = null;
        endHostSession();
        changed = true;
    }
    if (state.controlling?.userId === userId) {
        state.notice = controllingNotice;
        state.controlling = null;
        viewerCrypto = null;
        viewerEph = null;
        controlHostCapture = null;
        rmoveAccum = { dx: 0, dy: 0 };
        pendingAbsMove = null;
        setScreenLatencyMinimised(userId, false);
        changed = true;
    }
    if (state.incomingRequest?.userId === userId) {
        state.incomingRequest = null;
        if (pendingViewerEph?.userId === userId) pendingViewerEph = null;
        clearConsentAttention();
        changed = true;
    }
    if (state.offer?.userId === userId) {
        state.offer = null;
        changed = true;
    }
    if (offeredTo === userId) {
        clearOffered();
    }
    if (changed) emit();
}

/** Tear down all control state (e.g. when leaving voice / stopping the share). */
export function resetRemoteControl() {
    if (state.controlledBy) {
        wsClient.send({ type: 'ControlEnd', payload: { target_user: state.controlledBy.userId } });
        endHostSession();
    }
    if (state.controlling) {
        wsClient.send({ type: 'ControlEnd', payload: { target_user: state.controlling.userId } });
    }
    // Unconditional, NOT inside the if: reset is the last line of defence,
    // and the whole point is to also sweep up an entry some null-path
    // orphaned when state.controlling was already gone.
    clearAllScreenLatency();
    viewerCrypto = null;
    viewerEph = null;
    pendingViewerEph = null;
    controlHostCapture = null;
    rmoveAccum = { dx: 0, dy: 0 };
    pendingAbsMove = null;
    clearOffered();
    // A prompt can be pending at reset (logout mid-request): drop its
    // auto-deny timer and the surfaced window's TOPMOST bit with it, or the
    // timer fires into the reset state and the window stays above everything.
    clearConsentAttention();
    state = { incomingRequest: null, controlledBy: null, controlling: null, offer: null, notice: null };
    emit();
}
