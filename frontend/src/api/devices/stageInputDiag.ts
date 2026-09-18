/**
 * The stage's half of "Copy diagnostics" for pointer input.
 *
 * session.ts can say how many input events left the phone and of what kind;
 * only the stage knows WHY there might be none. A report of "the mouse does
 * nothing but the keyboard works" has several causes that look identical from
 * the host's logs, and each of these fields rules one in or out:
 *
 *  - `mouseMode`: trackpad sends moves only from the gesture machine; touch
 *    sends them from the finger; game mode sends relative deltas and only
 *    while the pointer is locked.
 *  - `gesturePhase` / `gestureContacts`: the trackpad machine in 'pinch' drops
 *    every move by design, so 'pinch' with one finger (or none) on the glass
 *    is a stranded contact, not a gesture.
 *  - `stageContacts`: the stage's own count of fingers; two stale ones make
 *    every drag a pinch-zoom of the picture.
 *  - `gesturePruned` / `gestureBlurCancels`: how often the wedge's two
 *    recoveries have ALREADY fired (a stranded contact pruned on the next
 *    touch; a blur, hide or mode switch that found fingers to drop). Both
 *    are silent by design, so after a recovery the phase looks healthy and
 *    only these say the wedge happened. Cumulative, and reported in every
 *    mode: they are history, not the machine's present state.
 *  - `cursorOwned` / `cursorDrawn`: once the host acks ownership it stops
 *    drawing its pointer and this end draws one. Owned but not drawn — or not
 *    owned in trackpad mode — is a pointer nobody can see, which reads exactly
 *    like one that does not move.
 *  - `controlEnabled`: "Pause control" silently drops every event.
 *
 * Pure, so the shape is pinned by a test without mounting the stage.
 */
import type { GestureDiag } from './touchGestures';

export interface StageInputState {
    isMobile: boolean;
    isMouseMode: boolean;
    fpsMode: boolean;
    controlEnabled: boolean;
    cursorOwned: boolean;
    cursorDrawn: boolean;
    stageContacts: number;
    gesture: GestureDiag;
}

export type MouseMode = 'trackpad' | 'touch' | 'game' | 'desktop';

export function mouseModeOf(s: Pick<StageInputState, 'isMobile' | 'isMouseMode' | 'fpsMode'>): MouseMode {
    // The stage's own precedence: game mode is a desktop-only path (a phone
    // never takes it), and on a phone the trackpad/touch choice decides.
    if (!s.isMobile) return s.fpsMode ? 'game' : 'desktop';
    return s.isMouseMode ? 'trackpad' : 'touch';
}

export function stageInputDiagnostics(s: StageInputState): Record<string, unknown> {
    const mouseMode = mouseModeOf(s);
    return {
        mouseMode,
        controlEnabled: s.controlEnabled,
        // Only the trackpad feeds the machine; in any other mode its state is
        // not evidence of anything, and reporting it would invite a misread.
        gesturePhase: mouseMode === 'trackpad' ? s.gesture.phase : null,
        gestureContacts: mouseMode === 'trackpad' ? s.gesture.contacts : null,
        gestureSurface: mouseMode === 'trackpad' ? s.gesture.surface : null,
        gesturePruned: s.gesture.pruned,
        gestureBlurCancels: s.gesture.blurCancels,
        stageContacts: s.stageContacts,
        cursorOwned: s.cursorOwned,
        cursorDrawn: s.cursorDrawn,
    };
}
