/**
 * TAP A TEXT BOX, GET THE KEYBOARD — the decision, pinned.
 *
 * One pure function decides whether a caret report that arrives after a press
 * means "that press landed in something typeable", and a second decides, at
 * the press itself, whether the finger landed on a caret already there. Every
 * case below is a concrete story from the remote screen, and every "does not
 * raise" case has a positive-control sibling that differs in exactly one input
 * — a verdict that returned `raise:false` unconditionally would otherwise pass
 * half this file.
 *
 * REVERT-TO-RED, checked while writing these:
 *  - dropping the `isMeasuredCaret(before)` guard (comparing against ANY
 *    visible `before`) turns "a focused button before the press is not a caret
 *    that was already there" red — a 'field' before then has to MOVE to raise.
 *  - dropping 'field' from the rejected sources turns "a focused button is not
 *    a text box" red.
 *  - dropping the `near` rule turns "tapping the empty search box that already
 *    has focus" red (the caret does not move, so nothing else would raise).
 *  - dropping the horizontal limit from `pressNearCaret` turns "a toolbar button
 *    across the screen on the caret's line" red.
 *  - dropping the same-line test from 'appeared'/'moved' turns the title-bar
 *    and window-drag cases red.
 *  - measuring in fractions instead of pixels turns the composite cases red.
 */
import { describe, it, expect } from 'vitest';
import {
    ASSUMED_SURFACE, AUTO_KEYBOARD_MOVE_PX, AUTO_KEYBOARD_SAME_FIELD_PX,
    AUTO_KEYBOARD_SAME_LINE_MIN_PX, AUTO_KEYBOARD_WINDOW_MS,
    AUTO_KEYBOARD_CLOSE_HOLDOFF_MS,
    autoKeyboardVerdict, autoKeyboardVerdictAtPress, caretMoved, isMeasuredCaret,
    suppressedByManualClose,
    pressNearCaret, pressOnCaretLine,
    type CaretState, type Press,
} from '../components/deviceAutoKeyboard';

/** One 1920x1080 screen. */
const ONE = { w: 1920, h: 1080 };
/** A 1x18 px caret on it, 0.4 across and 0.3 down. */
const CARET: CaretState = {
    vis: true, x: 0.4, y: 0.3, w: 1 / 1920, h: 18 / 1080, src: 'win32', mon: 0, surf: 7,
};
const HIDDEN: CaretState = { vis: false, x: 0, y: 0, w: 0, h: 0, src: null, mon: 0, surf: 7 };
/** A focused BUTTON, as tier 3 reports it: the element's whole box. */
const FIELD: CaretState = { vis: true, x: 0.7, y: 0.9, w: 0.08, h: 0.03, src: 'field', mon: 0, surf: 7 };

const T0 = 1_000_000;
/** A press a little before `now`, on the caret's line, right on it. */
const PRESS: Press = { x: 0.4, y: 0.3 + 9 / 1080, at: T0 };
const NOW = T0 + 300;
/** The caret's vertical centre, as a fraction. */
const CY = 0.3 + 9 / 1080;

function verdict(over: Partial<Parameters<typeof autoKeyboardVerdict>[0]>) {
    return autoKeyboardVerdict({ press: PRESS, before: HIDDEN, report: CARET, now: NOW, surface: ONE, ...over });
}

describe('what counts as a measured caret', () => {
    it('the three caret tiers do; a whole-field rect, a hidden report and the pointer stand-in do not', () => {
        expect(isMeasuredCaret({ ...CARET, src: 'win32' })).toBe(true);
        expect(isMeasuredCaret({ ...CARET, src: 'msaa' })).toBe(true);
        expect(isMeasuredCaret({ ...CARET, src: 'uia' })).toBe(true);
        expect(isMeasuredCaret(FIELD)).toBe(false);
        expect(isMeasuredCaret(HIDDEN)).toBe(false);
        // The stage's own "place on where the finger aimed" stand-in carries no
        // source at all — it is a guess, not a measurement.
        expect(isMeasuredCaret({ ...CARET, src: null })).toBe(false);
    });
});

describe('a press that puts a caret where there was none', () => {
    it('raises: nothing before, a system caret after, on the finger\'s line', () => {
        expect(verdict({ before: null })).toEqual({ raise: true, reason: 'appeared' });
        expect(verdict({ before: HIDDEN })).toEqual({ raise: true, reason: 'appeared' });
    });

    it('raises for each caret tier (an Electron/Chromium field answers through MSAA)', () => {
        expect(verdict({ report: { ...CARET, src: 'msaa' } })).toEqual({ raise: true, reason: 'appeared' });
        expect(verdict({ report: { ...CARET, src: 'uia' } })).toEqual({ raise: true, reason: 'appeared' });
    });

    it('raises for a URL bar: the caret lands at the END of the text, far from the finger, same line', () => {
        // Tap at x=0.15 of the bar; Chrome selects all and the caret sits at
        // the end of a long URL, x=0.55. Same row.
        const press = { x: 0.15, y: CY, at: T0 };
        expect(verdict({ press, report: { ...CARET, x: 0.55 } })).toEqual({ raise: true, reason: 'appeared' });
    });

    it('does NOT raise for a tap on a window\'s TITLE BAR that brings an editor forward', () => {
        // Explorer focused, no caret. The user taps Notepad's title bar at
        // y=0.05; the window activates and its caret shows up at y=0.3 — many
        // lines away from the finger. That is a window the tap raised, not a
        // field the tap entered.
        const press = { x: 0.4, y: 0.05, at: T0 };
        expect(verdict({ press, before: HIDDEN, report: CARET })).toEqual({ raise: false, reason: 'other-line' });
        // Positive control: the same tap on the caret's line raises.
        expect(verdict({ press: { ...press, y: CY }, before: HIDDEN, report: CARET })).toEqual({ raise: true, reason: 'appeared' });
    });

    it('a focused button before the press is not "a caret that was already there"', () => {
        // Tier 3 had been reporting a focused button's box; the tap moves focus
        // into a text field. The caret APPEARED — it is not judged as "moved
        // from the button", which would need it to be far enough away.
        expect(verdict({ before: FIELD })).toEqual({ raise: true, reason: 'appeared' });
    });

    it('does NOT raise for a focused button — a whole-field rect is not a text box', () => {
        const press = { x: 0.74, y: 0.915, at: T0 };
        expect(verdict({ press, report: FIELD })).toEqual({ raise: false, reason: 'not-a-caret' });
        // Positive control: the identical report with a caret tier raises.
        expect(verdict({ press, report: { ...FIELD, src: 'uia' } })).toEqual({ raise: true, reason: 'appeared' });
    });

    it('never raises on the caret going away', () => {
        expect(verdict({ before: CARET, report: HIDDEN })).toEqual({ raise: false, reason: 'hidden' });
    });
});

describe('a press that moves an existing caret', () => {
    it('raises when the caret moved to the finger\'s line — a tap elsewhere in the same document', () => {
        const press = { x: 0.6, y: 0.5 + 9 / 1080, at: T0 };
        const moved = { ...CARET, x: 0.6, y: 0.5 };
        expect(verdict({ press, before: CARET, report: moved })).toEqual({ raise: true, reason: 'moved' });
        expect(caretMoved(CARET, moved, ONE)).toBe(true);
    });

    it('one character cell is a move; the agent\'s send epsilon is not', () => {
        // 8 px on a 1920-wide screen: a cell. 1 px: re-measurement noise.
        expect(caretMoved(CARET, { ...CARET, x: CARET.x + 8 / 1920 }, ONE)).toBe(true);
        expect(caretMoved(CARET, { ...CARET, x: CARET.x + 1 / 1920 }, ONE)).toBe(false);
        expect(AUTO_KEYBOARD_MOVE_PX).toBeLessThan(8);
    });

    it('does NOT raise when the caret moved but NOT to the finger — dragging a window by its title bar', () => {
        // Notepad's caret is at (0.4, 0.3). The user drags the window down by
        // its title bar (press at y=0.05): the caret moves with the window to
        // y=0.5 — nowhere near the finger, and not a tap into a field.
        const press = { x: 0.4, y: 0.05, at: T0 };
        expect(verdict({ press, before: CARET, report: { ...CARET, y: 0.5 } })).toEqual({ raise: false, reason: 'other-line' });
        // Positive control: the finger ON the new line — a tap into the text.
        expect(verdict({ press: { x: 0.4, y: 0.5 + 9 / 1080, at: T0 }, before: CARET, report: { ...CARET, y: 0.5 } }))
            .toEqual({ raise: true, reason: 'moved' });
    });

    it('does NOT raise for a tap somewhere else while the caret sits still', () => {
        // The caret is in an editor; the user taps a toolbar button two lines
        // above it. The caret does not move, the tap is not on its line.
        const press = { x: 0.4, y: 0.3 - 0.05, at: T0 };
        expect(verdict({ press, before: CARET, report: CARET })).toEqual({ raise: false, reason: 'unchanged' });
        // Positive control: the same press, a caret that then moved TO IT, raises.
        expect(verdict({ press, before: CARET, report: { ...CARET, y: 0.25 - 9 / 1080 } })).toEqual({ raise: true, reason: 'moved' });
    });
});

describe('a press on a field whose caret does not move', () => {
    it('raises AT THE PRESS: tapping the empty search box that already has focus', () => {
        // The caret sits at the start of an empty box; the finger lands 15% of
        // the screen (288 px) to the right of it, on the same line. Nothing on
        // the host changes, so no report will ever come — the press itself
        // must decide, from the caret the stage already knows about.
        const press = { x: 0.55, y: CY };
        expect(pressNearCaret(press, CARET, ONE)).toBe(true);
        expect(autoKeyboardVerdictAtPress({ press, known: CARET, surface: ONE })).toEqual({ raise: true, reason: 'near' });
        // And the report path agrees, should a report arrive anyway (a tier
        // flip re-sends the same caret under a different source).
        expect(verdict({ press: { ...press, at: T0 }, before: CARET, report: { ...CARET, src: 'msaa' } }))
            .toEqual({ raise: true, reason: 'near' });
    });

    it('at the press, nothing known or a non-caret known means no raise', () => {
        const press = { x: 0.4, y: CY };
        expect(autoKeyboardVerdictAtPress({ press, known: null, surface: ONE })).toEqual({ raise: false, reason: 'no-caret' });
        expect(autoKeyboardVerdictAtPress({ press, known: HIDDEN, surface: ONE })).toEqual({ raise: false, reason: 'no-caret' });
        // A focused button's box under the finger is not a text box.
        expect(autoKeyboardVerdictAtPress({ press: { x: 0.74, y: 0.915 }, known: FIELD, surface: ONE }))
            .toEqual({ raise: false, reason: 'no-caret' });
        // Positive control: the same box reported by a caret tier raises.
        expect(autoKeyboardVerdictAtPress({ press: { x: 0.74, y: 0.915 }, known: { ...FIELD, src: 'uia' }, surface: ONE }))
            .toEqual({ raise: true, reason: 'near' });
    });

    it('does NOT raise for a toolbar button across the screen on the caret\'s line', () => {
        // 640 px is the field width; 660 px away is across the screen.
        const press = { x: 0.4 + 660 / 1920, y: CY, at: T0 };
        expect(pressNearCaret(press, CARET, ONE)).toBe(false);
        expect(autoKeyboardVerdictAtPress({ press, known: CARET, surface: ONE })).toEqual({ raise: false, reason: 'elsewhere' });
        expect(verdict({ press, before: CARET, report: CARET })).toEqual({ raise: false, reason: 'unchanged' });
        // Positive control: 620 px away is still the field.
        const nearer = { ...press, x: 0.4 + 620 / 1920 };
        expect(pressNearCaret(nearer, CARET, ONE)).toBe(true);
        expect(autoKeyboardVerdictAtPress({ press: nearer, known: CARET, surface: ONE })).toEqual({ raise: true, reason: 'near' });
        expect(AUTO_KEYBOARD_SAME_FIELD_PX).toBe(640);
    });

    it('"the same line" is 1.5 caret heights, with a floor for a 1px-tall caret', () => {
        // 18 px * 1.5 = 27 px each way from the caret's centre.
        expect(pressOnCaretLine({ x: 0.4, y: CY + 26 / 1080 }, CARET, ONE)).toBe(true);
        expect(pressOnCaretLine({ x: 0.4, y: CY + 28 / 1080 }, CARET, ONE)).toBe(false);
        // A degenerate 1-row caret would have a 1.5 px tolerance — untappable —
        // so the 13 px floor takes over.
        const thin = { ...CARET, h: 1 / 1080 };
        expect(pressOnCaretLine({ x: 0.4, y: 0.3 + (AUTO_KEYBOARD_SAME_LINE_MIN_PX - 1) / 1080 }, thin, ONE)).toBe(true);
        expect(pressOnCaretLine({ x: 0.4, y: 0.3 + (AUTO_KEYBOARD_SAME_LINE_MIN_PX + 2) / 1080 }, thin, ONE)).toBe(false);
    });
});

describe('the tolerances are pixels of the surface, not fractions of it', () => {
    // Three 1920x1080 screens side by side: the every-screen default streams
    // a 5760x1080 composite, and the caret's fractions are of THAT.
    const THREE = { w: 5760, h: 1080 };
    /** A caret in a Notepad window on screen 1 at desktop x=576 (0.10). */
    const caret3 = { ...CARET, x: 576 / 5760, mon: 255 };

    it('a tap on a button on the NEXT screen is not "in the same field"', () => {
        // Desktop x=2534: 1958 px away — a different monitor — on the same row.
        // As a fraction that is 0.34, which a fraction-based third would pass.
        const press = { x: 2534 / 5760, y: CY };
        expect(pressNearCaret(press, caret3, THREE)).toBe(false);
        expect(autoKeyboardVerdictAtPress({ press, known: caret3, surface: THREE })).toEqual({ raise: false, reason: 'elsewhere' });
        // Positive control: 600 px away on the SAME screen is the field.
        const same = { x: (576 + 600) / 5760, y: CY };
        expect(pressNearCaret(same, caret3, THREE)).toBe(true);
    });

    it('and the line tolerance is the same pixels on a tall stacked layout', () => {
        // Two screens stacked: 1920x2160. 27 px is 27 px, not 0.025 of 2160.
        const TALL = { w: 1920, h: 2160 };
        const caretTall = { ...CARET, y: 0.15, h: 18 / 2160 };
        const cyTall = 0.15 + 9 / 2160;
        expect(pressOnCaretLine({ x: 0.4, y: cyTall + 26 / 2160 }, caretTall, TALL)).toBe(true);
        expect(pressOnCaretLine({ x: 0.4, y: cyTall + 28 / 2160 }, caretTall, TALL)).toBe(false);
    });

    it('with no geometry from the host, a 1920x1080 screen is assumed', () => {
        expect(ASSUMED_SURFACE).toEqual({ w: 1920, h: 1080 });
        const press = { x: 0.4 + 620 / 1920, y: CY };
        expect(pressNearCaret(press, CARET, null)).toBe(true);
        expect(pressNearCaret(press, CARET, undefined)).toBe(true);
        expect(pressNearCaret({ ...press, x: 0.4 + 660 / 1920 }, CARET, null)).toBe(false);
        // A degenerate size is "no geometry", not a division by zero.
        expect(pressNearCaret(press, CARET, { w: 0, h: 0 })).toBe(true);
    });
});

describe('the press window', () => {
    it('credits a caret inside the window to the press, and not one after it', () => {
        expect(verdict({ now: T0 + AUTO_KEYBOARD_WINDOW_MS })).toEqual({ raise: true, reason: 'appeared' });
        expect(verdict({ now: T0 + AUTO_KEYBOARD_WINDOW_MS + 1 })).toEqual({ raise: false, reason: 'expired' });
    });

    it('no press, no raise — a caret appearing on its own (a page autofocusing) is not a tap', () => {
        expect(verdict({ press: null })).toEqual({ raise: false, reason: 'no-press' });
    });

    it('a report that predates the press is not its consequence', () => {
        expect(verdict({ now: T0 - 1 })).toEqual({ raise: false, reason: 'expired' });
    });

    it('a NaN clock fails closed', () => {
        expect(verdict({ now: Number.NaN })).toEqual({ raise: false, reason: 'expired' });
    });
});

describe('a different surface', () => {
    it('a report from after a monitor switch is not compared to a caret from before it', () => {
        // Same fractions, new surface generation: the SAME caret is a different
        // fraction now, so "moved"/"near" are meaningless — and nothing raises.
        expect(verdict({ before: CARET, report: { ...CARET, x: 0.6, surf: 8 } }))
            .toEqual({ raise: false, reason: 'surface-changed' });
        expect(verdict({ before: CARET, report: { ...CARET, x: 0.6, mon: 1 } }))
            .toEqual({ raise: false, reason: 'surface-changed' });
        // Positive control: same surface, that move (to the finger's line) raises.
        const press = { x: 0.6, y: CY, at: T0 };
        expect(verdict({ press, before: CARET, report: { ...CARET, x: 0.6 } })).toEqual({ raise: true, reason: 'moved' });
    });

    it('an unknown surface on either side is not a mismatch', () => {
        const press = { x: 0.6, y: CY, at: T0 };
        expect(verdict({ press, before: { ...CARET, surf: null }, report: { ...CARET, x: 0.6 } }))
            .toEqual({ raise: true, reason: 'moved' });
    });
});

describe('the manual-close holdoff', () => {
    const close = { caret: CARET, at: T0 };
    const held = (over: Partial<Parameters<typeof suppressedByManualClose>[0]>) =>
        suppressedByManualClose({ close, caret: CARET, now: NOW, surface: ONE, ...over });

    it('a raise on the line the keyboard was closed over is swallowed', () => {
        expect(held({})).toBe(true);
    });

    it('a raise on a DIFFERENT line is fresh intent and passes', () => {
        // Two line-tolerances below the close caret: clearly another field.
        const other = { ...CARET, y: CARET.y + (3 * AUTO_KEYBOARD_SAME_LINE_MIN_PX) / 1080 };
        expect(held({ caret: other })).toBe(false);
    });

    it('the holdoff expires on its own', () => {
        expect(held({ now: T0 + AUTO_KEYBOARD_CLOSE_HOLDOFF_MS + 1 })).toBe(false);
        // POSITIVE CONTROL: one ms inside the window it still holds.
        expect(held({ now: T0 + AUTO_KEYBOARD_CLOSE_HOLDOFF_MS - 1 })).toBe(true);
    });

    it('no record, no holdoff', () => {
        expect(held({ close: null })).toBe(false);
    });

    it('a close with NO known caret holds the whole window — there is nothing to compare', () => {
        const blind = { caret: null, at: T0 };
        expect(held({ close: blind })).toBe(true);
        const other = { ...CARET, y: 0.9 };
        expect(held({ close: blind, caret: other })).toBe(true);
        expect(held({ close: blind, now: T0 + AUTO_KEYBOARD_CLOSE_HOLDOFF_MS + 1 })).toBe(false);
    });

    it('a NaN close timestamp fails OPEN — it must not hold the feature off forever', () => {
        expect(held({ close: { caret: CARET, at: NaN } })).toBe(false);
    });
});
