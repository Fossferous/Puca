/**
 * OPEN THE SOFT KEYBOARD WHEN A TAP LANDS IN A TEXT BOX — the decision.
 *
 * On a phone controlling a PC, "tap a text field, start typing" is what every
 * native app does and what the stage could not: the keyboard was a toolbar
 * button, so every field cost an extra tap and a reach to the bottom bar. The
 * stage cannot hit-test the remote screen; what it CAN see is the remote text
 * caret, which the agent already reports on the `caret` data channel as
 * fractions of the captured surface (puca-input's caret sampler, tiers
 * Win32 → MSAA → UIA). So: a press goes out, and if a caret is there shortly
 * after that was not there before — or moved — ON THE LINE THE FINGER WENT TO,
 * the press landed in something typeable.
 *
 * Pure, like deviceZoomFollow: every rule in here is arithmetic that can be
 * checked by hand, and DeviceStage is never mounted in a test.
 *
 * WHAT IS DELIBERATELY NOT A TRIGGER:
 *  - `src: 'field'` — tier 3's LAST resort is the focused element's bounding
 *    box, whatever that element is. A focused button, list or pane is reported
 *    as a "field" and is exactly the thing a tap that is NOT in a text box
 *    lands on. Only a measured caret counts.
 *  - a caret that appears or moves on a DIFFERENT LINE from the press. Tapping
 *    a window's title bar or its taskbar button brings an editor forward and
 *    its caret with it; a console prints; a dialog steals focus on another
 *    screen. None of that is "the finger went into a text box", and every one
 *    of them would otherwise count as "appeared" or "moved" within the window.
 *    A tap INTO a field puts the caret on the tapped line (or leaves it on
 *    that line, for a select-all), so the line is the test — not the column,
 *    because a click into a URL bar parks the caret at the END of the text.
 *  - a `vis:false` report — the caret left; the keyboard is never auto-CLOSED.
 *    The caret also vanishes when focus moves to a window no tier can read
 *    (a terminal through the first two tiers, an elevated window a
 *    user-flavour agent may not query), and closing the keyboard mid-typing
 *    there would be worse than leaving it for the user to dismiss.
 *  - a report from another surface (`mon`/`surf` changed) — its fractions mean
 *    something different, so neither "moved" nor "near the tap" can be judged.
 *    The caller already drops frames for a monitor it is not watching; this
 *    module treats a surface generation change as a baseline reset.
 *  - anything outside AUTO_KEYBOARD_WINDOW_MS of the press. A caret that
 *    appears seconds later is a page finishing loading, not the tap.
 *
 * DISTANCES ARE IN REMOTE PIXELS, NOT FRACTIONS. The caret arrives as
 * fractions of the captured surface, and since "every screen by default" that
 * surface is usually the multi-monitor composite — a third of a 5760-wide
 * desktop is a whole monitor, not a text box. The caller passes the surface's
 * desktop size (`monitorRegions`-style geometry for the composite, the one
 * screen's size otherwise; 1920x1080 when the host reported none) and the
 * tolerances below are pixels on it.
 */

/** A caret report as the stage sees it — the wire shape minus `seq`. */
export interface CaretState {
    vis: boolean;
    /** Fractions 0..1 of the captured surface. Meaningless when !vis. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** 'win32' | 'msaa' | 'uia' | 'field' — which tier answered; null from the
     *  pointer fallback or an old report shape. */
    src: string | null;
    mon: number | null;
    surf: number | null;
}

/** Where and when the press went out, fractions of the same surface. */
export interface Press {
    x: number;
    y: number;
    /** Date.now() of the press. */
    at: number;
}

/** The captured surface's size in desktop pixels — what a fraction is OF. */
export interface SurfaceSize { w: number; h: number }

/** What to assume when the host never reported geometry (an old host, a
 *  webview host, a single screen with no `monitors` frame at all). */
export const ASSUMED_SURFACE: SurfaceSize = { w: 1920, h: 1080 };

/** How long after a press a new caret is still credited to it.
 *
 *  The tier ladder on the host bounds this: tier 1 polls every 100 ms, tier 2
 *  is only tried after two tier-1 misses (~200 ms), tier 3 after two more
 *  tier-2 misses on a 500 ms clock — ~900 ms worst case on a UIA-only app,
 *  plus the relay's input latency (the press rides the WS relay; the report
 *  rides the direct data channel, so they do not share a clock) and the
 *  1200 ms CARET_HOLD means a caret that just appeared is reported at once.
 *  1500 ms covers all of that. Longer credits page loads and autofocus to a
 *  tap that had nothing to do with them. */
export const AUTO_KEYBOARD_WINDOW_MS = 1500;

/** The tiers whose report means "there is a measured caret": a real system
 *  caret (GetGUIThreadInfo), the MSAA caret object (Chromium, Electron,
 *  Firefox show it only for a focused editable — it is driven by the text
 *  input state), or UIA's caret range. NOT 'field', for the reason in the
 *  header. */
export const AUTO_KEYBOARD_CARET_SOURCES: ReadonlySet<string> = new Set(['win32', 'msaa', 'uia']);

/** A caret that moved less than this many remote px has not moved: under one
 *  character cell at any resolution (8 px on 1920), well over the agent's own
 *  send epsilon (1/2000 of the surface ≈ 1-3 px). */
export const AUTO_KEYBOARD_MOVE_PX = 4;

/** "The tap was on the caret's LINE": within this many caret heights of the
 *  caret's vertical centre. 1.5 lines absorbs the tap landing in the field's
 *  padding above or below the text. */
export const AUTO_KEYBOARD_SAME_LINE_HEIGHTS = 1.5;
/** …but never narrower than this many remote px, because a caret can be
 *  reported 1 px tall (a degenerate rect from a tier that only knows the
 *  point) and a 1-line tolerance on that would be untappable. About a line on
 *  a 1080-row screen. */
export const AUTO_KEYBOARD_SAME_LINE_MIN_PX = 13;
/** "The tap was in the caret's FIELD": within this many remote px of the
 *  caret, horizontally. A URL bar or search box is the case that needs it — a
 *  tap into it parks the caret at the END of the existing text, which can be
 *  a long way from the finger on the same line. A third of a 1920-wide screen
 *  is a generous text box and still excludes a toolbar button on the far side
 *  — and, measured in pixels, stays that size on a three-screen composite. */
export const AUTO_KEYBOARD_SAME_FIELD_PX = 640;

export type AutoKeyboardVerdict =
    | { raise: true; reason: 'appeared' | 'moved' | 'near' }
    | { raise: false; reason: 'no-press' | 'expired' | 'hidden' | 'not-a-caret' | 'surface-changed' | 'unchanged' | 'no-caret' | 'elsewhere' | 'other-line' };

/** Is `report` a measured caret (as opposed to hidden, a whole-field rect, or
 *  the stage's own pointer stand-in)? */
export function isMeasuredCaret(report: CaretState): boolean {
    return report.vis && report.src !== null && AUTO_KEYBOARD_CARET_SOURCES.has(report.src);
}

function size(surface: SurfaceSize | null | undefined): SurfaceSize {
    return surface && surface.w > 0 && surface.h > 0 ? surface : ASSUMED_SURFACE;
}

/** Did the caret move between two VISIBLE reports on the same surface? */
export function caretMoved(a: CaretState, b: CaretState, surface?: SurfaceSize | null): boolean {
    const s = size(surface);
    return Math.abs(a.x - b.x) * s.w > AUTO_KEYBOARD_MOVE_PX
        || Math.abs(a.y - b.y) * s.h > AUTO_KEYBOARD_MOVE_PX;
}

/** Is the press on the caret's LINE — within 1.5 caret heights (never less
 *  than a line's worth of pixels) of its vertical centre? */
export function pressOnCaretLine(press: { x: number; y: number }, caret: CaretState, surface?: SurfaceSize | null): boolean {
    const s = size(surface);
    const lineTolPx = Math.max(caret.h * s.h * AUTO_KEYBOARD_SAME_LINE_HEIGHTS, AUTO_KEYBOARD_SAME_LINE_MIN_PX);
    const cy = caret.y + caret.h / 2;
    return Math.abs(press.y - cy) * s.h <= lineTolPx;
}

/** Was the press close enough to this caret to have been a tap INTO the text
 *  box it sits in? Same line, and within a text box's width. */
export function pressNearCaret(press: { x: number; y: number }, caret: CaretState, surface?: SurfaceSize | null): boolean {
    if (!pressOnCaretLine(press, caret, surface)) return false;
    const s = size(surface);
    return Math.abs(press.x - caret.x) * s.w <= AUTO_KEYBOARD_SAME_FIELD_PX;
}

/**
 * AT THE PRESS: is the finger landing on the caret that is ALREADY there?
 *
 * This is the one case no report can decide. A tap into a field that already
 * has focus — an empty search box whose caret sits at its start, a page that
 * autofocused its input — changes nothing on the host, the agent (which reports
 * only on change) stays silent, and waiting for a report would wait for ever.
 * The stage knows the caret's current state (`known`, the last report while
 * tracking, for THIS surface — the caller hands over null across a monitor
 * switch), so the answer is available the moment the press goes out — and that
 * moment is INSIDE the tap gesture, where a focus() raises the IME without any
 * native help at all.
 */
export function autoKeyboardVerdictAtPress(input: {
    press: { x: number; y: number };
    known: CaretState | null;
    surface?: SurfaceSize | null;
}): AutoKeyboardVerdict {
    const { press, known, surface } = input;
    if (!known || !isMeasuredCaret(known)) return { raise: false, reason: 'no-caret' };
    if (pressNearCaret(press, known, surface)) return { raise: true, reason: 'near' };
    return { raise: false, reason: 'elsewhere' };
}

/**
 * ON A REPORT: is this report the consequence of the last press?
 *
 * `before` is the last report the stage had accepted BEFORE this one — with the
 * channel tracking continuously it is the remote caret's state at the moment of
 * the press. null = nothing known yet this session.
 */
export function autoKeyboardVerdict(input: {
    press: Press | null;
    before: CaretState | null;
    report: CaretState;
    now: number;
    surface?: SurfaceSize | null;
}): AutoKeyboardVerdict {
    const { press, before, report, now, surface } = input;
    if (!press) return { raise: false, reason: 'no-press' };
    // `!(a <= b)` so a NaN timestamp fails closed rather than crediting forever.
    if (!(now - press.at <= AUTO_KEYBOARD_WINDOW_MS) || now < press.at) {
        return { raise: false, reason: 'expired' };
    }
    if (!report.vis) return { raise: false, reason: 'hidden' };
    if (!isMeasuredCaret(report)) return { raise: false, reason: 'not-a-caret' };
    if (before && isMeasuredCaret(before)) {
        // Fractions of a different surface cannot be compared to these, and
        // the press was aimed at the old one.
        if ((before.surf !== null && report.surf !== null && before.surf !== report.surf)
            || (before.mon !== null && report.mon !== null && before.mon !== report.mon)) {
            return { raise: false, reason: 'surface-changed' };
        }
        if (caretMoved(before, report, surface)) {
            // It moved — to the finger's line, or somewhere else entirely (a
            // window brought forward, a console printing)?
            return pressOnCaretLine(press, report, surface)
                ? { raise: true, reason: 'moved' }
                : { raise: false, reason: 'other-line' };
        }
        // The caret did not move — an already-focused field, tapped again (an
        // empty search box whose caret sits at the start; a page that
        // autofocused its input). A tap ON that field still deserves the
        // keyboard; a tap elsewhere while that caret sits there does not.
        if (pressNearCaret(press, report, surface)) return { raise: true, reason: 'near' };
        return { raise: false, reason: 'unchanged' };
    }
    // No MEASURED caret before the press and one after it: the press put it
    // there — if it is where the finger went. A hidden report, a whole-'field'
    // rect (a focused button) or the stage's own pointer stand-in before the
    // press all count as "no caret was there" — none of them is a measured
    // caret. A caret appearing on another line is a window the tap activated,
    // not a field the tap entered.
    return pressOnCaretLine(press, report, surface)
        ? { raise: true, reason: 'appeared' }
        : { raise: false, reason: 'other-line' };
}
