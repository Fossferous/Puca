/**
 * The lite build's stand-in for api/remoteControl.ts.
 *
 * Remote control is not in this artifact — neither the My Devices kind nor the
 * in-call kind where a viewer of your screen share is granted your mouse and
 * keyboard. The lite desktop shell does not even compile the input-injection
 * commands this module would invoke.
 *
 * This is not an empty module. Three PRESERVED components — StreamStage,
 * StreamPip and UserContextMenu — legitimately reference control state while
 * rendering a normal screen share, so they need a module with real semantics:
 * "no control is offered, requested, or active, ever". They then render their
 * ordinary no-control UI, which is exactly the intended lite behaviour.
 *
 * vite.config.ts aliases './api/remoteControl' here when VITE_ENABLE_RC is
 * false, so the real module and its ~1400 lines never enter the module graph.
 *
 * Keep this file's exported surface a SUPERSET of what the preserved
 * components import; the lite build fails loudly on a missing export rather
 * than silently rendering undefined, and the module-graph assertion in
 * vite.config.ts is what catches the reverse mistake.
 */

/**
 * Mirrors the real ControlState FIELD FOR FIELD, always in its inactive shape.
 *
 * The field names have to match the real module's exactly, and this is load-
 * bearing in a way typecheck cannot enforce: `npm run typecheck` compiles
 * against the REAL remoteControl.ts (there is no alias in tsc/vitest, only in
 * the Vite build), so a shape that drifts here is NOT caught by the type
 * checker. It would surface only at runtime in a lite build, as `undefined`
 * where a preserved caller read a field this stub forgot. Keeping the shapes
 * identical means every read a preserved component makes resolves to `null`,
 * which is exactly "no control anywhere" — the correct lite behaviour.
 */
export interface ControlState {
    /** HOST: a viewer asking to control my screen — never, in this build. */
    incomingRequest: { userId: number; username: string } | null;
    /** HOST: the viewer controlling my screen — never, in this build. */
    controlledBy: { userId: number; username: string } | null;
    /** VIEWER: the host I'm controlling / requesting — never, in this build. */
    controlling: { userId: number; username: string; status: 'requesting' | 'active' } | null;
    /** VIEWER: a host offering me control — never, in this build. */
    offer: { userId: number; username: string } | null;
    /** Transient toast notice — never raised, in this build. */
    notice: string | null;
}

const INACTIVE: ControlState = {
    incomingRequest: null,
    controlledBy: null,
    controlling: null,
    offer: null,
    notice: null,
};

export function getControlState(): ControlState {
    return INACTIVE;
}

/**
 * Never fires. Returns an unsubscribe so callers' cleanup paths are unchanged.
 *
 * Deliberately does NOT invoke the callback: state never changes, and an
 * immediate synchronous call would be a behavioural difference from the real
 * module, which only emits on transitions.
 */
export function subscribeControl(_cb: (s: ControlState) => void): () => void {
    return () => { /* nothing subscribed */ };
}

export function requestControl(_hostUserId: number, _hostUsername: string): void {
    /* control cannot be requested in this build */
}

export function stopControlling(): void {
    /* nothing can be under control in this build */
}

export function offerControl(_viewerUserId: number, _viewerUsername: string): void {
    /* control cannot be offered in this build */
}

export function sendControlEvent(_event: unknown): void {
    /* no peer is ever under control, so there is nothing to send to */
}

/** No control session means no host capture geometry to map a pointer onto. */
export function getControlHostCapture(): { w: number; h: number } | null {
    return null;
}

// Pure geometry, and the one thing here that is NOT a no-op: StreamStage
// letterbox-fits a stream into its tile whether or not control is possible.
// Re-exported from the shared module rather than copied — a copy of it in this
// file was wrong (it returned the fit-scale, not its inverse) and nothing would
// have caught that, since the real module's test does not import this one.
export { computeRmoveScale } from './rmoveScale';
