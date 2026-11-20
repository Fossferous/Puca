/**
 * TAP A TEXT BOX, GET THE KEYBOARD — the decision, pinned.
 *
 * One pure function decides whether a caret report that arrives after a press
 * means "that press put the caret there": it landed in something typeable.
 * Every case below is a concrete story from the remote screen, and every "does
 * not raise" case has a positive-control sibling that differs in exactly one
 * input — a verdict that returned `raise:false` unconditionally would
 * otherwise pass half this file.
 *
 * 2026-11-20 (the owner: "a lot of clicks seem to needlessly bring the
 * keyboard up and change zoom"): a caret that does NOT move never raises (the
 * old "near" rule raised for every button on its line), Chromium's hidden
 * caret is no caret, and the person's close of the keyboard holds a raise
 * for a caret the tap moved along the line it was closed on, until a text box
 * takes the focus (review of the branch: on that line only; another line is
 * a tap straight into another text box, and goes through).
 *
 * REVERT-TO-RED, checked while writing these:
 *  - dropping the `isMeasuredCaret(before)` guard (comparing against ANY
 *    visible `before`) turns "a focused button before the press is not a caret
 *    that was already there" red — a 'field' before then has to MOVE to raise.
 *  - dropping 'field' from the rejected sources turns "a focused button is not
 *    a text box" red.
 *  - putting the `near` rule back (a press within 640 px on the line of an
 *    unmoved caret raises) turns "a button beside a focused text box" red.
 *  - dropping the 0-px-wide msaa rule from isMeasuredCaret turns the Chromium
 *    hidden-caret cases red.
 *  - dropping the same-line test from 'appeared'/'moved' turns the title-bar
 *    and window-drag cases red.
 *  - measuring in fractions instead of pixels turns the stacked-layout case red.
 *  - letting heldByManualClose hold on EVERY line (as it did on 2026-11-20
 *    before review) turns "a caret the tap moved to ANOTHER line goes
 *    through" red; letting it hold nothing, or let a current host's caret go
 *    after 5 s, turns "along the line it was closed on" red; dropping its
 *    surface check turns "a report from another surface" red.
 *  - letting it hold an OLDER host's Chromium caret for good (as it did on
 *    2026-11-20 before review) turns "an older host's Chromium caret" red;
 *    keying that rule on the close's caret instead of the one the tap moved
 *    turns its window-switch case red.
 *  - letting imeCloseTakenBack take back the button's close as well turns
 *    "one of those right AFTER a fall" red (and the stage's button control).
 */
import { describe, it, expect } from 'vitest';
import {
    ASSUMED_SURFACE, AUTO_KEYBOARD_MOVE_PX,
    AUTO_KEYBOARD_SAME_LINE_MIN_PX, AUTO_KEYBOARD_WINDOW_MS,
    AUTO_KEYBOARD_OLDER_HOST_CLOSE_MS, CARET_REV_HIDDEN_MSAA, IME_FALL_LIFECYCLE_MS,
    autoKeyboardVerdict, caretMoved, heldByManualClose, hideMayGoUnheard, imeCloseTakenBack,
    imeFallIsAClose, isMeasuredCaret, pressOnCaretLine, textBoxTookFocus,
    type AutoKeyboardVerdict, type CaretState, type ManualClose, type Press,
} from '../components/deviceAutoKeyboard';

/** One 1920x1080 screen. */
const ONE = { w: 1920, h: 1080 };
/** A 1x18 px caret on it, 0.4 across and 0.3 down. */
const CARET: CaretState = {
    vis: true, x: 0.4, y: 0.3, w: 1 / 1920, h: 18 / 1080, src: 'win32', mon: 0, surf: 7,
};
const HIDDEN: CaretState = { vis: false, x: 0, y: 0, w: 0, h: 0, src: null, mon: 0, surf: 7 };
/** Chromium's caret object once a page took the focus from the text box it
 *  was in: msaa, 0 px wide, still on that text box's line. */
const CHROMIUM_HIDDEN: CaretState = { ...CARET, w: 0, src: 'msaa' };
/** A focused BUTTON, as tier 3 reports it: the element's whole box. */
const FIELD: CaretState = { vis: true, x: 0.7, y: 0.9, w: 0.08, h: 0.03, src: 'field', mon: 0, surf: 7 };
/** A Win32 caret on another line of the screen. */
const MOVED_WIN32: CaretState = { ...CARET, x: 0.3, y: 0.6 };

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

    it("Chromium's HIDDEN caret object (msaa, 0 px wide, left on the old line) is not a caret", () => {
        // ax_system_caret_win.cc: shown it is 1 px wide; Hide() zeroes the
        // width and keeps the place, and an older agent still reports it.
        expect(isMeasuredCaret(CHROMIUM_HIDDEN)).toBe(false);
        // POSITIVE CONTROL: the same caret shown, 1 px wide.
        expect(isMeasuredCaret({ ...CHROMIUM_HIDDEN, w: 1 / 1920 })).toBe(true);
        // A 0-wide caret from tier 1 (a real system caret can measure 0) is
        // still one: the rule is Chromium's caret object's, not every tier's.
        expect(isMeasuredCaret({ ...CARET, w: 0, src: 'win32' })).toBe(true);
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

describe('a press on the line of a caret that does not move raises nothing', () => {
    it('a button BESIDE a focused text box, on its line (Back beside an address bar, Send beside a message box)', () => {
        // The caret sits in the box; the finger lands to its right or to its
        // left, on the same line. The caret does not move: nothing on the host
        // says the press went into the box. (Before 2026-11-20 each of these
        // raised the keyboard: the old "near" rule, within 640 px on the
        // caret's line. So did the empty box itself, tapped again.)
        for (const dx of [288, -200, 600]) {
            const press = { x: 0.4 + dx / 1920, y: CY, at: T0 };
            expect(verdict({ press, before: CARET, report: CARET }), `${dx} px`).toEqual({ raise: false, reason: 'unchanged' });
            // A tier flip re-sending the same caret is no move either.
            expect(verdict({ press, before: CARET, report: { ...CARET, src: 'msaa' } })).toEqual({ raise: false, reason: 'unchanged' });
        }
        // POSITIVE CONTROL: the same press, and the caret MOVED to it (the tap
        // went into the text), raises.
        const press = { x: 0.4 + 288 / 1920, y: CY, at: T0 };
        expect(verdict({ press, before: CARET, report: { ...CARET, x: press.x } })).toEqual({ raise: true, reason: 'moved' });
    });

    it("a tap on the line Chromium's hidden caret was left on, the caret not moving", () => {
        const press = { x: 0.55, y: CY, at: T0 };
        expect(verdict({ press, before: CHROMIUM_HIDDEN, report: CHROMIUM_HIDDEN })).toEqual({ raise: false, reason: 'not-a-caret' });
    });

    it("a text box taking the focus back shows Chromium's caret again in place: that raises", () => {
        // Hidden (0 wide) at the box, then shown (1 px) at the same place: the
        // tap gave the box the focus. Judged against the hidden caret taken
        // for a real one, as before, it was "no move".
        const press = { x: 0.55, y: CY, at: T0 };
        const shown = { ...CHROMIUM_HIDDEN, w: 1 / 1920 };
        expect(verdict({ press, before: CHROMIUM_HIDDEN, report: shown })).toEqual({ raise: true, reason: 'appeared' });
        // POSITIVE CONTROL for the rule: after a real 1 px caret there, the
        // same report is no move.
        expect(verdict({ press, before: shown, report: shown })).toEqual({ raise: false, reason: 'unchanged' });
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
    it('the line tolerance is the same pixels on a tall stacked layout', () => {
        // Two screens stacked: 1920x2160. 27 px is 27 px, not 0.025 of 2160.
        const TALL = { w: 1920, h: 2160 };
        const caretTall = { ...CARET, y: 0.15, h: 18 / 2160 };
        const cyTall = 0.15 + 9 / 2160;
        expect(pressOnCaretLine({ x: 0.4, y: cyTall + 26 / 2160 }, caretTall, TALL)).toBe(true);
        expect(pressOnCaretLine({ x: 0.4, y: cyTall + 28 / 2160 }, caretTall, TALL)).toBe(false);
    });

    it('a move is pixels too: one cell on the three-screen composite is a move, the send epsilon is not', () => {
        const THREE = { w: 5760, h: 1080 };
        const c = { ...CARET, x: 576 / 5760, mon: 255 };
        expect(caretMoved(c, { ...c, x: (576 + 8) / 5760 }, THREE)).toBe(true);
        expect(caretMoved(c, { ...c, x: (576 + 2) / 5760 }, THREE)).toBe(false);
    });

    it('with no geometry from the host, a 1920x1080 screen is assumed', () => {
        expect(ASSUMED_SURFACE).toEqual({ w: 1920, h: 1080 });
        expect(pressOnCaretLine({ x: 0.4, y: CY + 26 / 1080 }, CARET, null)).toBe(true);
        expect(pressOnCaretLine({ x: 0.4, y: CY + 28 / 1080 }, CARET, undefined)).toBe(false);
        // A degenerate size is "no geometry", not a division by zero.
        expect(pressOnCaretLine({ x: 0.4, y: CY + 26 / 1080 }, CARET, { w: 0, h: 0 })).toBe(true);
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
        // fraction now, so "moved" is meaningless — and nothing raises.
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

describe('closing the keyboard sticks on its line', () => {
    const close: ManualClose = { at: T0, caret: CARET, by: 'button' };
    const moved: AutoKeyboardVerdict = { raise: true, reason: 'moved' };
    const appeared: AutoKeyboardVerdict = { raise: true, reason: 'appeared' };
    /** Further along the line it was closed on. */
    const ALONG: CaretState = { ...CARET, x: 0.5 };
    const held = (over: Partial<Parameters<typeof heldByManualClose>[0]>) => heldByManualClose({
        close, verdict: moved, before: CARET, report: ALONG, now: T0 + 6_000, surface: ONE, ...over,
    });

    it('a caret the tap MOVED along the line it was closed on is held back, however long after', () => {
        // The person closed the keyboard over a text box and taps along it
        // again (the address bar, the message box). (Before 2026-11-20 that
        // was held 5 s, and the keyboard came straight back up after it, and
        // the zoom with it.) The close record carries no clock to run out.
        expect(held({})).toBe(true);
        expect(held({ report: { ...CARET, x: 0.9 } })).toBe(true);
        expect(held({ close: { at: T0 - 3_600_000, caret: CARET, by: 'button' } })).toBe(true);
        // Within the line's tolerance (1.5 caret heights of its centre), a
        // text box beside it on that line included; and from a current host's
        // Chromium caret (rev 2), whose hide would have arrived.
        expect(held({ report: { ...CARET, x: 0.7, y: 0.3 + 20 / 1080 } })).toBe(true);
        const shown = { ...CARET, src: 'msaa', rev: CARET_REV_HIDDEN_MSAA };
        expect(held({ before: shown, report: { ...shown, x: 0.6 } })).toBe(true);
        // POSITIVE CONTROL: with no close standing, the same raise goes.
        expect(held({ close: null })).toBe(false);
    });

    it('a caret the tap moved to ANOTHER line goes through: a tap straight into another text box', () => {
        // Review of work/stage-taps: a form's next field, another app's text
        // after its taskbar button, a text box on the page after the address
        // bar. The host reports no gap between the two carets (one message
        // dispatch; its 1.2 s hold), so this is the only sign there is; held
        // on every line, the keyboard never came up by itself again until it
        // was opened by hand. Another line of the same document looks the
        // same, and raises too, as it did before 2026-11-20.
        expect(held({ report: MOVED_WIN32 })).toBe(false);
        expect(held({ report: MOVED_WIN32, close: { at: T0 - 3_600_000, caret: CARET, by: 'button' } })).toBe(false);
        expect(held({ report: { ...CARET, y: 0.3 + 30 / 1080 } })).toBe(false);
        const shown = { ...CARET, src: 'msaa', rev: CARET_REV_HIDDEN_MSAA };
        expect(held({ before: shown, report: { ...shown, x: 0.3, y: 0.6 } })).toBe(false);
        // Back's close the same.
        expect(held({ report: MOVED_WIN32, close: { ...close, by: 'ime' } })).toBe(false);
        expect(held({ close: { ...close, by: 'ime' } })).toBe(true);
    });

    it("a report from another surface than the close's caret is not compared with its line", () => {
        expect(held({ report: { ...ALONG, surf: 8 } })).toBe(false);
        expect(held({ report: { ...ALONG, mon: 1 } })).toBe(false);
        // CONTROL: an unknown surface on either side is not a mismatch.
        expect(held({ report: { ...ALONG, surf: null } })).toBe(true);
        expect(held({ close: { ...close, caret: { ...CARET, mon: null } } })).toBe(true);
    });

    it('no caret known at the close: every moved caret is held (the first caret after it ends the close)', () => {
        expect(held({ close: { ...close, caret: null }, report: MOVED_WIN32 })).toBe(true);
        expect(held({ close: { ...close, caret: HIDDEN }, report: MOVED_WIN32 })).toBe(true);
        expect(held({ close: { ...close, caret: FIELD }, report: MOVED_WIN32 })).toBe(true);
    });

    it('a text box TAKING the focus (a caret where there was none) is not held', () => {
        expect(held({ verdict: appeared, before: HIDDEN })).toBe(false);
    });

    it('no raise, nothing to hold', () => {
        expect(held({ verdict: { raise: false, reason: 'unchanged' } })).toBe(false);
    });

    it('what ends a close: a measured caret where there was none', () => {
        expect(textBoxTookFocus(null, CARET)).toBe(true);
        expect(textBoxTookFocus(HIDDEN, CARET)).toBe(true);
        expect(textBoxTookFocus(FIELD, CARET)).toBe(true);
        expect(textBoxTookFocus(CHROMIUM_HIDDEN, { ...CHROMIUM_HIDDEN, w: 1 / 1920 })).toBe(true);
        // …and not the caret moving within the text, nor leaving it, nor a
        // focused button, nor Chromium hiding its caret.
        expect(textBoxTookFocus(CARET, { ...CARET, y: 0.6 })).toBe(false);
        expect(textBoxTookFocus(CARET, HIDDEN)).toBe(false);
        expect(textBoxTookFocus(HIDDEN, FIELD)).toBe(false);
        expect(textBoxTookFocus(HIDDEN, CHROMIUM_HIDDEN)).toBe(false);
    });
});

describe('a fall of the soft keyboard is a close only when nothing else took it down', () => {
    // The native tier says the IME went down, never why. Back is the
    // person's close; the app sent to the background, the screen locking,
    // the phone turning and a system dialog taking the window's focus are
    // not, and a close sticks (review of work/stage-taps).
    const fall = (over: Partial<Parameters<typeof imeFallIsAClose>[0]>) => imeFallIsAClose({
        now: T0, hidden: false, lifecycleAt: null, ...over,
    });

    it('a fall with nothing else going on is Back', () => {
        expect(fall({})).toBe(true);
        expect(fall({ lifecycleAt: T0 - IME_FALL_LIFECYCLE_MS - 1 })).toBe(true);
        expect(fall({ lifecycleAt: T0 - 60_000 })).toBe(true);
    });

    it('a fall with the page hidden, or soon after the app, the focus or the screen turned, is not', () => {
        expect(fall({ hidden: true })).toBe(false);
        expect(fall({ hidden: true, lifecycleAt: T0 - 60_000 })).toBe(false);
        expect(fall({ lifecycleAt: T0 })).toBe(false);
        expect(fall({ lifecycleAt: T0 - IME_FALL_LIFECYCLE_MS })).toBe(false);
    });

    it('a broken time is no close (it must not hold the feature off)', () => {
        expect(fall({ lifecycleAt: Number.NaN })).toBe(false);
        expect(fall({ lifecycleAt: T0 + 10_000 })).toBe(false);
    });

    const back: ManualClose = { at: T0, caret: CARET, by: 'ime' };
    it('one of those right AFTER a fall takes its close back; long after, or after the button, it does not', () => {
        expect(imeCloseTakenBack(back, T0)).toBe(true);
        expect(imeCloseTakenBack(back, T0 + IME_FALL_LIFECYCLE_MS)).toBe(true);
        expect(imeCloseTakenBack(back, T0 + IME_FALL_LIFECYCLE_MS + 1)).toBe(false);
        expect(imeCloseTakenBack(back, T0 + 60_000)).toBe(false);
        // The button is the person's whatever follows.
        expect(imeCloseTakenBack({ ...back, by: 'button' }, T0)).toBe(false);
        expect(imeCloseTakenBack(null, T0)).toBe(false);
        // A broken time takes it back.
        expect(imeCloseTakenBack({ ...back, at: Number.NaN }, T0)).toBe(true);
    });
});

describe("an older host's Chromium caret: its hide may never arrive", () => {
    // A host before 2026-11-20 (no `rev`) on a surface wider than 2000 px: the
    // address bar was typed into (msaa, 1 px wide), the keyboard closed, a tap
    // on the page took the focus (Chromium hid its caret, 1 px to 0 in place,
    // and the agent sent nothing: under its 1/2000 epsilon), then a tap into
    // the address bar again. Here that last caret MOVED, along the line it was
    // closed on, from a caret still believed in. Sticking held it for good,
    // and the address bar after every page, until the keyboard was opened by
    // hand. (A text box on the page, on another line, raises on any host.)
    const OLD_BAR: CaretState = { ...CARET, src: 'msaa', w: 1 / 2560 };
    const OLD_BAR_AGAIN: CaretState = { ...OLD_BAR, x: 0.5 };
    const OLD_PAGE_BOX: CaretState = { ...OLD_BAR, x: 0.3, y: 0.6 };
    const close: ManualClose = { at: T0, caret: OLD_BAR, by: 'button' };
    const moved: AutoKeyboardVerdict = { raise: true, reason: 'moved' };
    const held = (over: Partial<Parameters<typeof heldByManualClose>[0]>) => heldByManualClose({
        close, verdict: moved, before: OLD_BAR, report: OLD_BAR_AGAIN, now: T0 + 6_000, surface: ONE, ...over,
    });

    it('which carets those are: msaa, shown, with no revision or one before CARET_REV_HIDDEN_MSAA', () => {
        expect(hideMayGoUnheard(OLD_BAR)).toBe(true);
        expect(hideMayGoUnheard({ ...OLD_BAR, rev: null })).toBe(true);
        expect(hideMayGoUnheard({ ...OLD_BAR, rev: CARET_REV_HIDDEN_MSAA - 1 })).toBe(true);
        // A current host reports Chromium's hidden caret as no caret.
        expect(hideMayGoUnheard({ ...OLD_BAR, rev: CARET_REV_HIDDEN_MSAA })).toBe(false);
        expect(hideMayGoUnheard({ ...OLD_BAR, rev: CARET_REV_HIDDEN_MSAA + 1 })).toBe(false);
        // Win32 and UIA carets go away when the focus leaves, on any host.
        expect(hideMayGoUnheard({ ...OLD_BAR, src: 'win32' })).toBe(false);
        expect(hideMayGoUnheard({ ...OLD_BAR, src: 'uia' })).toBe(false);
        expect(hideMayGoUnheard(HIDDEN)).toBe(false);
        expect(hideMayGoUnheard(null)).toBe(false);
    });

    it('after 5 s the address bar tapped again raises the keyboard, as every close did before', () => {
        expect(held({})).toBe(false);
        expect(held({ now: T0 + AUTO_KEYBOARD_OLDER_HOST_CLOSE_MS + 1 })).toBe(false);
        expect(held({ now: T0 + AUTO_KEYBOARD_OLDER_HOST_CLOSE_MS })).toBe(true);
        // CONTROL: the same story from a CURRENT host sticks (its hide would
        // have arrived as vis:false, and this would be 'appeared').
        expect(held({ before: { ...OLD_BAR, rev: 2 }, report: { ...OLD_BAR_AGAIN, rev: 2 } })).toBe(true);
    });

    it('within 5 s, held on the line it was closed on, not on another', () => {
        const soon = T0 + 2_000;
        expect(held({ now: soon })).toBe(true);
        expect(held({ now: soon, report: OLD_PAGE_BOX })).toBe(false);
        // No caret known at the close: the whole 5 s holds, and no longer.
        expect(held({ now: soon, close: { at: T0, caret: null, by: 'button' }, report: OLD_PAGE_BOX })).toBe(true);
        expect(held({ now: soon, close: { at: T0, caret: HIDDEN, by: 'button' }, report: OLD_PAGE_BOX })).toBe(true);
        expect(held({ close: { at: T0, caret: null, by: 'button' }, report: OLD_PAGE_BOX })).toBe(false);
    });

    it('it is the caret the tap MOVED that decides, not the one at the close', () => {
        // Closed over Notepad (a Win32 caret, which does go away); the focus
        // then went to Chrome's address bar on that line, then to the page,
        // then to the address bar again. The hide that went unheard is
        // Chrome's.
        expect(held({ close: { at: T0, caret: CARET, by: 'button' } })).toBe(false);
        // ...and the other way round: closed over the older host's Chromium
        // caret, then a Win32 caret moved along that line sticks.
        expect(held({ before: CARET, report: { ...CARET, x: 0.5 } })).toBe(true);
    });

    it('a broken close time fails open', () => {
        expect(held({ close: { at: Number.NaN, caret: OLD_BAR, by: 'button' }, now: T0 })).toBe(false);
        expect(held({ close: { at: T0 + 10_000, caret: OLD_BAR, by: 'button' }, now: T0 })).toBe(false);
    });
});
