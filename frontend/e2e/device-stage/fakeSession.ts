/**
 * A stand-in for src/api/devices/session.ts, so the REAL DeviceStage can be
 * driven in a real browser (vite.stageharness.config.ts swaps every import of
 * the session module for this file).
 *
 * It plays the HOST as the field logs show it behaving, not as anyone hopes it
 * does: a picture whose ENCODED size follows the agent's viewer fit
 * (composite.rs fit_step, the 500 ms FIT_SETTLE hysteresis, the first picture
 * applied at once), a monitor switch whose new frames reach the viewer over
 * the direct media path BEFORE the `monitor-active` confirm that rides the
 * relay (or after it — the order is a knob), a cursor-ownership ack, and a
 * caret channel the driver writes reports into.
 *
 * The picture is a canvas captureStream: each screen is painted in its own
 * colour with its name and a grid, so a screenshot says which screen, which
 * part of it and whether it is black.
 *
 * Everything the driver needs is on `window.__stage`.
 */
import type { CaretReport, DeviceControlSession } from '../../src/api/devices/session';
// The session layer declares the CONTROL keep-alive while a session lives
// (session.ts, setControlKeepAlive); the stand-in does the same, so the stage
// loaded into a debug APK raises the real "Device session active"
// notification, key buttons and all (android-shade-keys-live.mjs). In a
// browser it is a no-op.
import { setControlKeepAlive } from '../../src/api/mobileApp';
// ONE WINDOW: the real module's words and checks, and an icon the AGENT's own
// PNG writer made (crates/puca-agent window_pick.rs pins these exact bytes),
// so the walk proves a browser decodes what the agent sends.
import { windowEndWords, windowId, type RemoteWindow, type WindowEndReason } from '../../src/api/devices/windowPick';
import iconsRaw from './windowIcons.json?raw';

export const ALL_DISPLAYS = 255;
export type { CaretReport, DeviceControlSession };

type Listener = (s: DeviceControlSession[]) => void;
type Mon = { id: number; label: string; left: number; top: number; width: number; height: number };

/** A real three-screen desk, in the agent's (DXGI) order: a 1440p primary
 *  with a portrait screen either side, raised above it — the layout whose
 *  composite has empty (black) desktop above and below the primary.
 *
 *  A driver that needs another desk sets it before any page script:
 *  `addInitScript(m => { window.__stageMonitorsInit = m }, [...])` — the
 *  monitor-hop walk uses a screen on every side of the main one, so all four
 *  of its chips can be reached by panning. */
const MONITORS: Mon[] = (window as unknown as { __stageMonitorsInit?: Mon[] }).__stageMonitorsInit ?? [
    { id: 0, label: 'Main display', left: 0, top: 0, width: 2560, height: 1440 },
    { id: 1, label: 'Display 2', left: 2560, top: -700, width: 1440, height: 2560 },
    { id: 2, label: 'Display 3', left: -1440, top: -707, width: 1440, height: 2560 },
];
const COLOURS = ['#2a6fdb', '#2fa84f', '#c0392b', '#8e44ad', '#d35400'];

// --- one window (windowPick.ts) -------------------------------------------
type Win = RemoteWindow & { rect: { left: number; top: number; width: number; height: number } };
const BADGE = (JSON.parse(iconsRaw) as { badge: string }).badge;
const ICONS: Record<string, string> = { ibadge: BADGE };
/** The PC's open windows, front to back, each on a screen of the desk above:
 *  some with the agent's icon and some without (the viewer's own glyph), one
 *  minimised, one elevated, one on each portrait screen, and enough of them
 *  that the list scrolls and searching helps. */
const WINDOWS: Win[] = (window as unknown as { __stageWindowsInit?: Win[] }).__stageWindowsInit ?? [
    { hwnd: 0x10010, pid: 4100, title: 'Quarterly report.docx - Word', app: 'Microsoft Word', icon: 'ibadge', monitor: 0, rect: { left: 200, top: 120, width: 1400, height: 900 } },
    { hwnd: 0x10020, pid: 4200, title: 'Inbox - Mail', app: 'Mail', monitor: 0, rect: { left: 900, top: 300, width: 1200, height: 800 } },
    { hwnd: 0x10030, pid: 4300, title: 'notes.txt - Notepad', app: 'Notepad', icon: 'ibadge', monitor: 1, rect: { left: 2660, top: -500, width: 900, height: 1300 } },
    { hwnd: 0x10040, pid: 4400, title: 'Task Manager', app: 'Task Manager', elevated: true, monitor: 0, rect: { left: 300, top: 300, width: 900, height: 700 } },
    { hwnd: 0x10050, pid: 4500, title: 'Calculator', app: 'Calculator', minimized: true, monitor: 0, rect: { left: 600, top: 200, width: 400, height: 600 } },
    { hwnd: 0x10060, pid: 4600, title: 'Púca release checklist — a very long tab title that does not fit on one line of the picker at all - Google Chrome', app: 'Google Chrome', icon: 'ibadge', monitor: 2, rect: { left: -1340, top: -600, width: 1200, height: 1800 } },
    { hwnd: 0x10070, pid: 4700, title: 'Valheim', app: 'valheim', monitor: 0, rect: { left: 0, top: 0, width: 2560, height: 1440 } },
    { hwnd: 0x10080, pid: 4800, title: 'Downloads - File Explorer', app: 'Windows Explorer', icon: 'ibadge', monitor: 0, rect: { left: 500, top: 400, width: 1000, height: 700 } },
    { hwnd: 0x10090, pid: 4900, title: 'Terminal', app: 'Windows Terminal', monitor: 0, rect: { left: 1200, top: 600, width: 1100, height: 650 } },
    { hwnd: 0x100a0, pid: 5000, title: 'Spotify Premium', app: 'Spotify', icon: 'ibadge', monitor: 1, rect: { left: 2600, top: 900, width: 1300, height: 800 } },
    { hwnd: 0x100b0, pid: 5100, title: 'Settings', app: 'Settings', monitor: 0, rect: { left: 700, top: 150, width: 1000, height: 760 } },
    { hwnd: 0x100c0, pid: 5200, title: 'Untitled - Paint', app: 'Paint', icon: 'ibadge', monitor: 0, rect: { left: 250, top: 250, width: 1300, height: 900 } },
];
const winById = (id: string) => WINDOWS.find(w => windowId(w) === id) ?? null;

// --- the agent's geometry, mirrored from crates/puca-agent/src/composite.rs ---
const MAX_COMPOSITE_W = 3840;
const MAX_COMPOSITE_H = 2160;
const MIN_FIT_EDGE = 320;
const FIT_SETTLE_MS = 500;

function unionBox(): { left: number; top: number; w: number; h: number } {
    const left = Math.min(...MONITORS.map(m => m.left));
    const top = Math.min(...MONITORS.map(m => m.top));
    const right = Math.max(...MONITORS.map(m => m.left + m.width));
    const bottom = Math.max(...MONITORS.map(m => m.top + m.height));
    return { left, top, w: right - left, h: bottom - top };
}
function compositeGeometry(uw: number, uh: number): { step: number; w: number; h: number } {
    const step = Math.max(Math.ceil(uw / MAX_COMPOSITE_W), Math.ceil(uh / MAX_COMPOSITE_H), 1);
    return { step, w: Math.max(2, Math.floor(uw / step) & ~1), h: Math.max(2, Math.floor(uh / step) & ~1) };
}
function fitStep(sw: number, sh: number, vw: number, vh: number): number {
    if (!sw || !sh || !vw || !vh) return 1;
    let step = Math.max(Math.floor(sw / vw), Math.floor(sh / vh), 1);
    while (step > 1 && (Math.floor(sw / step) < MIN_FIT_EDGE || Math.floor(sh / step) < MIN_FIT_EDGE)) step--;
    return step;
}
/** The shown window as the host reports it (`window-active`): its title and
 *  the part of it on its screen, made even as the agent's crop is. */
function activeShown() {
    const w = state.activeWindow ? winById(state.activeWindow) : null;
    if (!w) return null;
    const r = shownRect(w);
    return { hwnd: w.hwnd, pid: w.pid, title: w.title, app: w.app, width: r.width, height: r.height };
}
/** The window's part on its own screen, even (window_pick.rs crop_for). */
function shownRect(w: Win): { left: number; top: number; width: number; height: number } {
    const m = MONITORS.find(x => x.id === w.monitor)!;
    const left = Math.max(w.rect.left, m.left), top = Math.max(w.rect.top, m.top);
    const right = Math.min(w.rect.left + w.rect.width, m.left + m.width);
    const bottom = Math.min(w.rect.top + w.rect.height, m.top + m.height);
    return { left, top, width: Math.max(2, (right - left) & ~1), height: Math.max(2, (bottom - top) & ~1) };
}

/** The capture's native picture size (before the viewer fit). */
function nativeSize(monitor: number): { w: number; h: number } {
    const shown = state.activeWindow ? winById(state.activeWindow) : null;
    if (shown && shown.monitor === monitor) {
        const r = shownRect(shown);
        return { w: r.width, h: r.height };
    }
    if (monitor === ALL_DISPLAYS) {
        const u = unionBox();
        const g = compositeGeometry(u.w, u.h);
        return { w: g.w, h: g.h };
    }
    const m = MONITORS.find(x => x.id === monitor)!;
    return { w: m.width, h: m.height };
}

// --- state -------------------------------------------------------------------
const listeners = new Set<Listener>();
const caretSubs = new Map<string, Set<(r: CaretReport) => void>>();
const SID = 'ds-harness';

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d')!;
let stream: MediaStream | null = null;

const knobs = {
    /** ms from set-monitor to the capture committing (new frames). */
    commitMs: 150,
    /** ms from the commit to the relay's monitor-active confirm. */
    confirmMs: 250,
    /** The host acks cursor ownership (false = an armed host that dropped it). */
    ackCursor: true,
    /** The agent reports its pointer's shape once it hands the pointer over,
     *  as a current one does (false = one too old to, which the stage then
     *  hands the pointer back to). */
    sendsShapes: true,
    /** Follow the agent's viewer fit at all (false = always native). */
    fit: true,
    /** Hold every set-monitor until the driver lets it go
     *  (`__stage.releaseSwitch()`; commitMs runs from then): a host as slow
     *  as the driver needs it to be, so what the driver does between the
     *  request and the switch does not race a timer against the machine's
     *  speed. */
    holdSwitch: false,
    /** The host offers one window on its own (false = a host from before it,
     *  the sign-in screen or a view-only share: the NEGATIVE CONTROL). */
    windows: true,
    /** How the host answers a window list: 'ok', 'fail' (it says why), or
     *  'silent' (it never answers, as an agent that hung would not). */
    windowList: 'ok' as 'ok' | 'fail' | 'silent',
    /** ms from the ask to the list, and from the list to its icons. */
    windowListMs: 120,
    iconsMs: 150,
    /** A choice the host refuses, with this reason (null = it shows it). */
    windowRefusal: null as string | null,
    /** ms from a choice to the host's confirmation. */
    windowMs: 200,
};
// A driver that needs a knob from the very first hand-over (an agent too old
// to send shapes, from the session's start) sets it before any page script:
// `addInitScript(() => { window.__stageKnobsInit = { sendsShapes: false } })`.
Object.assign(knobs, (window as unknown as { __stageKnobsInit?: Partial<typeof knobs> }).__stageKnobsInit ?? {});

const state = {
    activeMonitor: ALL_DISPLAYS as number,
    /** What the capture is producing right now (switches lead the confirm). */
    capturing: ALL_DISPLAYS as number,
    cursorOwned: false,
    viewSize: null as { w: number; h: number } | null,
    step: null as number | null,
    pendingStep: null as { step: number; since: number } | null,
    unattended: true,
    // The no-screen messages (no-screen-stage-real-browser.mjs): waiting for
    // the first picture, the host's virtual-screen notice, and an ended
    // session's error.
    awaitingMedia: false,
    hostScreen: null as 'virtual-starting' | null,
    peerName: null as string | null,
    endedWith: null as string | null,
    // The desktop walk (device-stage-desktop-real-browser.mjs): the host's
    // pointer shape while this end draws the pointer, and an elevated window.
    remoteCursor: null as string | null,
    inputBlocked: null as string | null,
    // The host's one-line notice (a display turned off, say), which a phone
    // shows in its feedback line (the monitor-hop walk).
    powerNotice: null as string | null,
    // Something the host refused while the session goes on (an input it
    // could not inject, say): the session's error with the session still
    // active, red in the phone's feedback line (the monitor-hop walk).
    hostError: null as string | null,
    // ONE WINDOW: what the host confirmed it shows (a windowId), the list as
    // the viewer last asked for it, the host's note, and whether the window's
    // program is in front.
    activeWindow: null as string | null,
    windowList: null as null | { rid: string; loading: boolean; windows: RemoteWindow[]; icons: Record<string, string>; error: string | null },
    windowNotice: null as string | null,
    windowFront: true,
};

const log: Array<Record<string, unknown>> = [];
const inputs: unknown[] = [];
const viewSizes: Array<{ w: number; h: number; at: number }> = [];
const monitorRequests: Array<{ monitor: number; at: number }> = [];
const encodedSizes: Array<{ w: number; h: number; at: number; capturing: number }> = [];
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);

function session(): DeviceControlSession {
    return {
        id: SID, role: 'controller', peerDevice: 'dev-host',
        phase: state.endedWith === null ? 'active' : 'ended',
        stream, captureSize: null, error: state.endedWith ?? state.hostError,
        peerName: state.peerName, hostScreen: state.hostScreen,
        monitors: MONITORS.map(m => ({ ...m })),
        activeMonitor: state.activeMonitor,
        unattended: state.unattended,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false, audioHub: false,
        privacyActive: false, cursorOwned: state.cursorOwned, reconnecting: false,
        awaitingMedia: state.awaitingMedia, mediaRestarting: false, secureDesktop: false, cursorClipped: false,
        // The stand-in's caret channel is open from the start: the shape it
        // says (or, with `sendsShapes` off, does not) rides that.
        remoteCursor: state.remoteCursor, caretOpen: true, inputBlocked: state.inputBlocked, pointerCaptured: false,
        shareUser: null, viewOnly: false, powerNotice: state.powerNotice,
        windowsSupported: knobs.windows,
        activeWindow: activeShown(),
        windowList: state.windowList,
        windowNotice: state.windowNotice,
        windowFront: state.windowFront,
    } as unknown as DeviceControlSession;
}
function emit(): void {
    const snap = [session()];
    for (const l of listeners) l(snap);
}

/** Recompute the encoded size the way the agent's pump does on each frame. */
function wantedStep(): number {
    if (!knobs.fit || !state.viewSize) return 1;
    const n = nativeSize(state.capturing);
    return fitStep(n.w, n.h, state.viewSize.w, state.viewSize.h);
}
function decideStep(): number {
    const wanted = wantedStep();
    if (state.step === null) { state.step = wanted; state.pendingStep = null; return wanted; }
    if (wanted === state.step) { state.pendingStep = null; return state.step; }
    const t = performance.now();
    if (!state.pendingStep || state.pendingStep.step !== wanted) state.pendingStep = { step: wanted, since: t };
    if (t - state.pendingStep.since >= FIT_SETTLE_MS) { state.step = wanted; state.pendingStep = null; }
    return state.step;
}

function paint(): void {
    const step = decideStep();
    const n = nativeSize(state.capturing);
    const w = Math.max(2, Math.floor(n.w / step) & ~1);
    const h = Math.max(2, Math.floor(n.h / step) & ~1);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        encodedSizes.push({ w, h, at: now(), capturing: state.capturing });
        log.push({ at: now(), ev: 'encoded', w, h, capturing: state.capturing });
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    // Desktop px -> canvas px for the surface being captured.
    let ox: number, oy: number, sx: number, sy: number;
    const shownWin = state.activeWindow ? winById(state.activeWindow) : null;
    if (shownWin && shownWin.monitor === state.capturing) {
        // ONE WINDOW: the agent sends the window's part of its screen. Drawn
        // as a window — a dark title bar with its title over a light page —
        // so a screenshot says which window, and that it is one.
        const r = shownRect(shownWin);
        sx = w / r.width; sy = h / r.height;
        ctx.fillStyle = '#f3f3f3';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, w, 44 * sy);
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(10, Math.round(22 * sy))}px sans-serif`;
        ctx.fillText(shownWin.title.slice(0, 60), 16 * sx, 30 * sy);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = Math.max(1, sx);
        for (let gx = 0; gx <= r.width; gx += 100) { ctx.beginPath(); ctx.moveTo(gx * sx, 44 * sy); ctx.lineTo(gx * sx, h); ctx.stroke(); }
        for (let gy = 44; gy <= r.height; gy += 100) { ctx.beginPath(); ctx.moveTo(0, gy * sy); ctx.lineTo(w, gy * sy); ctx.stroke(); }
        return;
    }
    if (state.capturing === ALL_DISPLAYS) {
        const u = unionBox();
        ox = u.left; oy = u.top; sx = w / u.w; sy = h / u.h;
    } else {
        const m = MONITORS.find(x => x.id === state.capturing)!;
        ox = m.left; oy = m.top; sx = w / m.width; sy = h / m.height;
    }
    for (const m of MONITORS) {
        const x = (m.left - ox) * sx, y = (m.top - oy) * sy, mw = m.width * sx, mh = m.height * sy;
        ctx.fillStyle = COLOURS[m.id];
        ctx.fillRect(x, y, mw, mh);
        // A grid every 160 desktop px, so a zoomed screenshot shows where it is.
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = Math.max(1, sx);
        for (let gx = 0; gx <= m.width; gx += 160) { ctx.beginPath(); ctx.moveTo(x + gx * sx, y); ctx.lineTo(x + gx * sx, y + mh); ctx.stroke(); }
        for (let gy = 0; gy <= m.height; gy += 160) { ctx.beginPath(); ctx.moveTo(x, y + gy * sy); ctx.lineTo(x + mw, y + gy * sy); ctx.stroke(); }
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(120 * sx)}px sans-serif`;
        ctx.fillText(m.label, x + 40 * sx, y + 200 * sy);
        // A text field near the bottom-left of each screen, as a caret target.
        ctx.fillStyle = '#fff';
        ctx.fillRect(x + 100 * sx, y + (m.height - 400) * sy, 800 * sx, 60 * sy);
    }
}

function ensureStream(): MediaStream {
    if (!stream) {
        paint();
        stream = canvas.captureStream(30);
        setInterval(paint, 33);
    }
    return stream;
}

// --- the API the stage imports ---------------------------------------------
export function subscribeSessions(l: Listener): () => void {
    listeners.add(l);
    l([session()]);
    return () => { listeners.delete(l); };
}
export function activeSessions(): DeviceControlSession[] { return [session()]; }
export function subscribeCaret(sessionId: string, cb: (r: CaretReport) => void): () => void {
    if (!caretSubs.has(sessionId)) caretSubs.set(sessionId, new Set());
    caretSubs.get(sessionId)!.add(cb);
    return () => { caretSubs.get(sessionId)?.delete(cb); };
}
export function setCaretTracking(_sessionId: string, on: boolean): void { log.push({ at: now(), ev: 'caret-track', on }); }
export function setCursorOwned(_sessionId: string, owned: boolean): void {
    log.push({ at: now(), ev: 'set-cursor-owner', owned });
    if (!knobs.ackCursor) return;
    setTimeout(() => {
        state.cursorOwned = owned;
        // A current agent reports the shape at its next look (30 ms).
        if (owned && knobs.sendsShapes && state.remoteCursor === null) state.remoteCursor = 'default';
        emit();
    }, 80);
}
export function sendInput(_sessionId: string, event: unknown): boolean {
    inputs.push(event);
    return true;
}
let viewTimer: ReturnType<typeof setTimeout> | null = null;
export function sendViewSize(_sessionId: string, w: number, h: number): void {
    if (viewTimer) clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
        viewTimer = null;
        const last = viewSizes[viewSizes.length - 1];
        if (last && last.w === w && last.h === h) return;
        viewSizes.push({ w, h, at: now() });
        log.push({ at: now(), ev: 'view-size', w, h });
        state.viewSize = w && h ? { w, h } : null;
    }, 300);
}
/** Switches parked by `knobs.holdSwitch`, in the order they were asked for. */
const heldSwitches: Array<() => void> = [];
export function requestMonitor(_sessionId: string, monitor: number): void {
    monitorRequests.push({ monitor, at: now() });
    log.push({ at: now(), ev: 'set-monitor', monitor });
    // A screen chosen while a window is shown means that screen, whole (the
    // host app's set-monitor drops the window first).
    if (state.activeWindow) { state.activeWindow = null; emit(); }
    if (knobs.holdSwitch) heldSwitches.push(() => switchTo(monitor));
    else switchTo(monitor);
}
function switchTo(monitor: number): void {
    setTimeout(() => {
        // The capture commits: new frames flow at once over the media path.
        // The FitState is the STREAM's, not the capture's: the step in
        // force carries across a switch and a new one waits out the settle,
        // exactly as the field log shows (720x1280 first, native after).
        state.capturing = monitor;
        log.push({ at: now(), ev: 'commit', monitor });
        setTimeout(() => {
            state.activeMonitor = monitor;
            log.push({ at: now(), ev: 'monitor-active', monitor });
            emit();
        }, knobs.confirmMs);
    }, knobs.commitMs);
}
export function requestKeyframe(): boolean { return true; }

// --- one window -------------------------------------------------------------
export const windowRequests: Array<{ at: number; id: string | null }> = [];
let ridSeq = 0;
export function requestWindowList(_sessionId: string): void {
    if (!knobs.windows) return;
    const rid = `wl${++ridSeq}`;
    const prev = state.windowList;
    state.windowList = { rid, loading: true, error: null, windows: prev?.windows ?? [], icons: prev?.icons ?? {} };
    log.push({ at: now(), ev: 'list-windows', rid });
    emit();
    if (knobs.windowList === 'silent') return;
    setTimeout(() => {
        if (state.windowList?.rid !== rid) return;
        if (knobs.windowList === 'fail') {
            state.windowList = { ...state.windowList, loading: false, error: "Could not list that computer's windows: the agent was busy." };
            emit();
            return;
        }
        state.windowList = {
            ...state.windowList, loading: false,
            windows: WINDOWS.map(({ rect: _rect, ...w }) => w),
        };
        emit();
        setTimeout(() => {
            if (state.windowList?.rid !== rid) return;
            state.windowList = { ...state.windowList, icons: { ...ICONS } };
            emit();
        }, knobs.iconsMs);
    }, knobs.windowListMs);
}
export function chooseWindow(_sessionId: string, w: { hwnd: number; pid: number } | null): void {
    const id = w ? windowId(w) : null;
    windowRequests.push({ at: now(), id });
    log.push({ at: now(), ev: 'set-window', id });
    state.windowNotice = null;
    emit();
    setTimeout(() => {
        if (id && knobs.windowRefusal) {
            state.windowNotice = `Could not show that window: ${knobs.windowRefusal}.`;
            emit();
            return;
        }
        const target = id ? winById(id) : null;
        if (target) {
            // The host switches screens first, then crops.
            state.capturing = target.monitor ?? 0;
            state.activeMonitor = target.monitor ?? 0;
            state.step = null;
        }
        state.activeWindow = id;
        state.windowFront = true;
        emit();
    }, knobs.windowMs);
}
export function dismissWindowNotice(): void { state.windowNotice = null; emit(); }
/** The latency probe needs the agent's direct channel; the stand-in has none,
 *  so the chip shows the estimate, as it does against an older agent. */
export function latencyProbeUsable(): boolean { return false; }
export function sendLatencyProbe(): boolean { return false; }
export function noteFramePresented(): void { /* no probes in flight */ }
export function subscribeLatency(): () => void { return () => { /* nothing to undo */ }; }
/** The desktop bar's live stats: a steady 60 fps LAN session, counters that
 *  advance with the clock so two readings give rates. */
export async function deviceStatsSample(): Promise<Record<string, unknown>> {
    const t = performance.now() / 1000;
    return {
        at: Date.now(), framesDecoded: Math.floor(t * 60), bytesReceived: Math.floor(t * 1_500_000),
        freezeCount: 0, totalDecodeTime: t * 60 * 0.002, jitterBufferDelay: t * 60 * 0.012,
        jitterBufferEmittedCount: Math.floor(t * 60), packetsLost: 0, packetsReceived: Math.floor(t * 1200),
        frameWidth: 1920, frameHeight: 1080, rttMs: 3, path: 'direct', lan: true, protocol: 'udp',
        decoder: 'D3D11VideoDecoder', hardwareDecode: true, inputLane: 'channel',
    };
}
export function endSession(): void { /* the harness never ends */ }
export async function sendClipboard(): Promise<string | null> { return null; }
export function sendStreamQuality(): void { /* not under test */ }
export function setPrivacyMode(): void { /* not under test */ }
export function sendPowerAction(): boolean { return true; }
/** One row, so a copy has something in it beside the stage's own state. */
export async function deviceDiagnosticsWindow(): Promise<Record<string, unknown>[]> { return [{ id: 'harness', fps: 60 }]; }
export function requestFileAccess(): void { /* not under test */ }
export async function connectToDevice(): Promise<string> { return SID; }

// --- the driver's handle ----------------------------------------------------
function pushCaret(r: Partial<CaretReport>): void {
    const full: CaretReport = {
        vis: true, x: 0, y: 0, w: 0, h: 0, src: 'msaa',
        mon: state.capturing, surf: 1, seq: null, ...r,
    };
    log.push({ at: now(), ev: 'caret', ...full });
    for (const cb of caretSubs.get(SID) ?? []) cb(full);
}
function transform(): { scale: number; x: number; y: number } | null {
    const el = document.querySelector('.device-stage-canvas') as HTMLElement | null;
    if (!el) return null;
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(el.style.transform);
    return m ? { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) } : null;
}

(window as unknown as Record<string, unknown>).__stage = {
    knobs, state, log, inputs, viewSizes, monitorRequests, encodedSizes, MONITORS,
    start(): void { ensureStream(); setControlKeepAlive(true); emit(); },
    /** The session ends, as the host hanging up does: the stage shows why,
     *  and the keep-alive's CONTROL reason goes, as session.ts lets it go. */
    end(why = 'the other side ended the session'): void {
        state.endedWith = why;
        setControlKeepAlive(false);
        emit();
    },
    emit, pushCaret, transform,
    windowRequests, WINDOWS,
    /** The shown window goes away by itself, as the host says it did (the
     *  agent's `Gone`): the picture is the whole screen again. */
    windowGone(reason: WindowEndReason): void {
        const w = state.activeWindow ? winById(state.activeWindow) : null;
        state.activeWindow = null;
        state.windowNotice = windowEndWords(reason, w?.title ?? null);
        emit();
    },
    /** Another program in front of the shown window (keys go there), or not. */
    setWindowFront(front: boolean): void { state.windowFront = front; emit(); },
    /** Let the switches `knobs.holdSwitch` parked go ahead. */
    releaseSwitch(): void { for (const go of heldSwitches.splice(0)) go(); },
    /** Force a capture as the host would after the passphrase (no confirm lag). */
    setActive(m: number): void { state.activeMonitor = m; state.capturing = m; state.step = null; emit(); },
    video(): { vw: number; vh: number; w: number; h: number } | null {
        const v = document.querySelector('video.device-stage-video') as HTMLVideoElement | null;
        return v ? { vw: v.videoWidth, vh: v.videoHeight, w: v.offsetWidth, h: v.offsetHeight } : null;
    },
    now,
};
