/**
 * The stage's pointer half of "Copy diagnostics" — what each mode reports.
 *
 * The field that matters most is the trackpad machine's phase: 'pinch' with a
 * single finger on the glass is the stranded-contact wedge, and reporting the
 * machine's state in a mode that never feeds it would invite exactly the wrong
 * reading, so it is null there.
 */
import { describe, it, expect } from 'vitest';
import { mouseModeOf, stageInputDiagnostics, type StageInputState } from '../api/devices/stageInputDiag';

const base: StageInputState = {
    isMobile: true, isMouseMode: true, fpsMode: false, controlEnabled: true,
    cursorOwned: true, cursorDrawn: true, stageContacts: 1,
    gesture: { phase: 'pinch', contacts: 2, surface: true },
};

describe('mouse mode', () => {
    it('names the four paths the stage actually takes', () => {
        expect(mouseModeOf({ isMobile: true, isMouseMode: true, fpsMode: false })).toBe('trackpad');
        expect(mouseModeOf({ isMobile: true, isMouseMode: false, fpsMode: false })).toBe('touch');
        // Game mode is desktop-only: the stage never takes it on a phone.
        expect(mouseModeOf({ isMobile: true, isMouseMode: true, fpsMode: true })).toBe('trackpad');
        expect(mouseModeOf({ isMobile: false, isMouseMode: true, fpsMode: true })).toBe('game');
        expect(mouseModeOf({ isMobile: false, isMouseMode: true, fpsMode: false })).toBe('desktop');
    });
});

describe('the report', () => {
    it('in trackpad mode carries the machine state, the finger count and who draws the pointer', () => {
        expect(stageInputDiagnostics(base)).toEqual({
            mouseMode: 'trackpad',
            controlEnabled: true,
            gesturePhase: 'pinch',
            gestureContacts: 2,
            gestureSurface: true,
            stageContacts: 1,
            cursorOwned: true,
            cursorDrawn: true,
        });
    });

    it('does not report the trackpad machine in a mode that never feeds it', () => {
        const touch = stageInputDiagnostics({ ...base, isMouseMode: false });
        expect(touch.mouseMode).toBe('touch');
        expect(touch.gesturePhase).toBeNull();
        expect(touch.gestureContacts).toBeNull();
        // Everything that is still true in touch mode is still reported.
        expect(touch.stageContacts).toBe(1);
        expect(touch.cursorOwned).toBe(true);
    });

    it('says when the pointer is owned but not drawn, and when control is paused', () => {
        const r = stageInputDiagnostics({ ...base, cursorDrawn: false, controlEnabled: false });
        expect(r.cursorOwned).toBe(true);
        expect(r.cursorDrawn).toBe(false);
        expect(r.controlEnabled).toBe(false);
    });
});
