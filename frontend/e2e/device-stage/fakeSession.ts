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

export const ALL_DISPLAYS = 255;
export type { CaretReport, DeviceControlSession };

type Listener = (s: DeviceControlSession[]) => void;
type Mon = { id: number; label: string; left: number; top: number; width: number; height: number };

/** A real three-screen desk, in the agent's (DXGI) order: a 1440p primary
 *  with a portrait screen either side, raised above it — the layout whose
 *  composite has empty (black) desktop above and below the primary. */
const MONITORS: Mon[] = [
    { id: 0, label: 'Main display', left: 0, top: 0, width: 2560, height: 1440 },
    { id: 1, label: 'Display 2', left: 2560, top: -700, width: 1440, height: 2560 },
    { id: 2, label: 'Display 3', left: -1440, top: -707, width: 1440, height: 2560 },
];
const COLOURS = ['#2a6fdb', '#2fa84f', '#c0392b'];

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
/** The capture's native picture size (before the viewer fit). */
function nativeSize(monitor: number): { w: number; h: number } {
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
    /** Follow the agent's viewer fit at all (false = always native). */
    fit: true,
};

const state = {
    activeMonitor: ALL_DISPLAYS as number,
    /** What the capture is producing right now (switches lead the confirm). */
    capturing: ALL_DISPLAYS as number,
    cursorOwned: false,
    viewSize: null as { w: number; h: number } | null,
    step: null as number | null,
    pendingStep: null as { step: number; since: number } | null,
    unattended: true,
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
        id: SID, role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream, captureSize: null, error: null,
        monitors: MONITORS.map(m => ({ ...m })),
        activeMonitor: state.activeMonitor,
        unattended: state.unattended,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false, audioHub: false,
        privacyActive: false, cursorOwned: state.cursorOwned, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false, cursorClipped: false,
        shareUser: null, viewOnly: false, powerNotice: null,
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
    setTimeout(() => { state.cursorOwned = owned; emit(); }, 80);
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
export function requestMonitor(_sessionId: string, monitor: number): void {
    monitorRequests.push({ monitor, at: now() });
    log.push({ at: now(), ev: 'set-monitor', monitor });
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
export function endSession(): void { /* the harness never ends */ }
export async function sendClipboard(): Promise<string | null> { return null; }
export function sendStreamQuality(): void { /* not under test */ }
export function setPrivacyMode(): void { /* not under test */ }
export function sendPowerAction(): boolean { return true; }
export async function deviceDiagnosticsWindow(): Promise<Record<string, unknown>[]> { return []; }
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
    start(): void { ensureStream(); emit(); },
    emit, pushCaret, transform,
    /** Force a capture as the host would after the passphrase (no confirm lag). */
    setActive(m: number): void { state.activeMonitor = m; state.capturing = m; state.step = null; emit(); },
    video(): { vw: number; vh: number; w: number; h: number } | null {
        const v = document.querySelector('video.device-stage-video') as HTMLVideoElement | null;
        return v ? { vw: v.videoWidth, vh: v.videoHeight, w: v.offsetWidth, h: v.offsetHeight } : null;
    },
    now,
};
