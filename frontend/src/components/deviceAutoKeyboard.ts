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
 * the press put the caret there: it landed in something typeable.
 *
 * THE HOST'S WORD, NEVER THE STAGE'S GUESS (2026-11-20, the owner: "a lot of
 * clicks seem to needlessly bring the keyboard up and change zoom"). The only
 * trigger is a caret the press made appear or move. There used to be a
 * second one, "near": a press on the line of a caret that did NOT move, within
 * 640 remote px of it, raised the keyboard at the press, for the empty search
 * box that already had the focus. Nothing on the host tells that tap from a
 * tap on the Back button beside an address bar, the Send or emoji button
 * beside a chat's message box, a search box's own magnifier, or a long press
 * on any of them; and a Chromium window (Chrome, Edge, every Electron app)
 * leaves its caret object on the line of the last text box it typed into,
 * hidden but still reported as a caret by an agent from before this change
 * (puca-input's msaa_caret), for as long as that window is in front, so every tap along that line raised the keyboard and
 * the zoom with it. A text box that already has the focus is opened with
 * the keyboard button.
 *
 * Pure, like deviceZoomFollow: every rule in here is arithmetic that can be
 * checked by hand.
 *
 * WHAT IS DELIBERATELY NOT A TRIGGER:
 *  - `src: 'field'` — tier 3's LAST resort is the focused element's bounding
 *    box, whatever that element is. A focused button, list or pane is reported
 *    as a "field" and is exactly the thing a tap that is NOT in a text box
 *    lands on. Only a measured caret counts.
 *  - Chromium's HIDDEN caret: `src: 'msaa'` 0 px wide (isMeasuredCaret), from
 *    an older host; a current one reports it as no caret.
 *  - a caret that does not move. See above: the press may have landed on
 *    anything beside it.
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
 *    something different, so "moved" cannot be judged. The caller already
 *    drops frames for a monitor it is not watching; this module treats a
 *    surface generation change as a baseline reset.
 *  - anything outside AUTO_KEYBOARD_WINDOW_MS of the press. A caret that
 *    appears seconds later is a page finishing loading, not the tap.
 *
 * DISTANCES ARE IN REMOTE PIXELS, NOT FRACTIONS. The caret arrives as
 * fractions of the captured surface, and since "every screen by default" that
 * surface is usually the multi-monitor composite. The caller passes the
 * surface's desktop size (`monitorRegions`-style geometry for the composite,
 * the one screen's size otherwise; 1920x1080 when the host reported none) and
 * the tolerances below are pixels on it.
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
    /** The host sampler's revision (the frame's `rev`); absent or null from
     *  an agent before 2026-11-20. See hideMayGoUnheard. */
    rev?: number | null;
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
 *  Firefox show it for a focused editable — it is driven by the text input
 *  state — and Chromium leaves it, hidden, where it was: isMeasuredCaret), or
 *  UIA's caret range. NOT 'field', for the reason in the header. */
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

export type AutoKeyboardVerdict =
    | { raise: true; reason: 'appeared' | 'moved' }
    | { raise: false; reason: 'no-press' | 'expired' | 'hidden' | 'not-a-caret' | 'surface-changed' | 'unchanged' | 'other-line' };

/** The caret-frame revision from which a host reports Chromium's hidden
 *  caret as no caret (`rev`, puca-agent's caret_wire.rs CARET_REPORT_REV; its
 *  test reads this line). */
export const CARET_REV_HIDDEN_MSAA = 2;

/** How long a close holds a raise for a caret whose hide may go unheard
 *  (hideMayGoUnheard): the stand-down every close had before 2026-11-20,
 *  together with "on the line of the caret at the close". */
export const AUTO_KEYBOARD_OLDER_HOST_CLOSE_MS = 5_000;

/** What the stage records when the person CLOSES the keyboard: its toolbar
 *  button, or Android's Back taking the soft keyboard down under the open
 *  bar. Nothing expires it, except for an older host's Chromium caret
 *  (heldByManualClose says what ends it). */
export interface ManualClose {
    /** Date.now() of the close. */
    at: number;
    /** The caret known at the close, or null: the line an older host's
     *  hold keeps to. */
    caret: CaretState | null;
}

/** Is `report` a measured caret (as opposed to hidden, a whole-field rect,
 *  Chromium's hidden caret, or the stage's own pointer stand-in)?
 *
 *  CHROMIUM'S HIDDEN CARET. Chrome, Edge and every Electron app draw their own
 *  caret and keep an MSAA caret object for screen readers and magnifiers
 *  (ui/accessibility/platform/ax_system_caret_win.cc). Shown, it is 1 px wide
 *  (HWNDMessageHandler::OnCaretBoundsChanged sets that width); when no text
 *  box has the focus, Hide() marks it invisible and zeroes its WIDTH, keeping
 *  its place and height, and accLocation still answers with that rect. An
 *  agent from before this change took it for a caret, so for as long as such
 *  a window is in front this end was told that a caret sits on the line of
 *  the last text box typed into there. 0 px wide is the shape of that; a
 *  shown one is never 0 wide. Such an agent sends that shape only where the
 *  1 px width change is worth a frame to it, a surface up to 2000 px wide (or
 *  as its first frame): wider, the shown caret simply stays, and
 *  hideMayGoUnheard is what copes with that. */
export function isMeasuredCaret(report: CaretState): boolean {
    if (!report.vis || report.src === null || !AUTO_KEYBOARD_CARET_SOURCES.has(report.src)) return false;
    if (report.src === 'msaa' && !(report.w > 0)) return false;
    return true;
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
        // The caret did not move. The press may have gone into the text box
        // that holds it (an empty one whose caret sits at its start) or onto
        // anything beside it, a button on its line included, and nothing on
        // the host tells those apart: no raise. See the header.
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

/**
 * Can the focus have left the text this caret is in without this end being
 * told? For an older host's Chromium caret, yes.
 *
 * Sticking (heldByManualClose) rests on the host saying when the focus leaves
 * the text: the caret goes (`vis:false`) or turns into something that is no
 * caret, and the next caret is then a text box TAKING the focus. Chromium's
 * caret object hides by going from 1 px wide to 0 in place. A host before
 * 2026-11-20 (no `rev`) reported that as a caret 0 px wide, which
 * isMeasuredCaret refuses — but its agent sends a frame only when something
 * moved by more than 1/2000 of the surface, and the width alone moves by 1 px,
 * so on a surface wider than 2000 px (a 2560 screen, every screen at once) the
 * hide is never sent at all. The caret stays measured here, on the line of a
 * text box that no longer has the focus, and the next text box tapped is a
 * caret that MOVED. A host with `rev` >= CARET_REV_HIDDEN_MSAA reports the
 * hidden caret as no caret, which is always sent.
 */
export function hideMayGoUnheard(caret: CaretState | null): boolean {
    return caret !== null && caret.vis && caret.src === 'msaa'
        && !(typeof caret.rev === 'number' && caret.rev >= CARET_REV_HIDDEN_MSAA);
}

/**
 * Does the person's close of the keyboard hold this raise back?
 *
 * Closing the keyboard is the one unambiguous "not now" the user can give,
 * and it STICKS: the panel covers half the screen, so "close it to read what
 * it covered, tap around in the text, watch it reopen (and the picture zoom
 * back in)" was the normal case, not the corner. While the focus stays in
 * text, a caret MOVED by a tap (in the same text box, or straight into
 * another one) is held back, however long after the close.
 *
 * What ends it (the caller drops the record):
 *  - ASKING — the keyboard opened by hand (its button, "Tap to type") or the
 *    soft keyboard coming up for any reason;
 *  - A TEXT BOX TAKING THE FOCUS — a measured caret where there was none
 *    (textBoxTookFocus): the focus had left the text and a text box took it,
 *    a different one or the same one again. A raise for that is 'appeared',
 *    which is never held;
 *  - the caret's surface changing (a monitor switch: the record is the
 *    tracking's, and tracking starts again).
 *
 * AN OLDER HOST'S CHROMIUM CARET (hideMayGoUnheard on the caret the tap
 * moved): the second of those may never come, so sticking there would hold
 * every Chromium text box off until the keyboard is opened by hand. Such a
 * raise keeps the rule every close had before 2026-11-20: held for 5 s, and
 * only on the line of the caret at the close (none known: the whole 5 s).
 */
export function heldByManualClose(input: {
    close: ManualClose | null;
    verdict: AutoKeyboardVerdict;
    /** The caret this end held before the report: the one the tap moved. */
    before: CaretState | null;
    report: CaretState;
    now: number;
    surface?: SurfaceSize | null;
}): boolean {
    const { close, verdict, before, report, now, surface } = input;
    if (close === null || !verdict.raise || verdict.reason !== 'moved') return false;
    if (!hideMayGoUnheard(before)) return true;
    // `!(a <= b)` so a NaN timestamp fails OPEN: a broken record must not hold
    // the feature off.
    if (!(now - close.at <= AUTO_KEYBOARD_OLDER_HOST_CLOSE_MS) || now < close.at) return false;
    if (!close.caret || !isMeasuredCaret(close.caret)) return true;
    // "On the line of the caret at the close": the press's own tolerance,
    // with the new caret's centre standing in for the finger.
    return pressOnCaretLine({ x: report.x, y: report.y + report.h / 2 }, close.caret, surface);
}

/** Did a text box take the focus between these two reports: no measured
 *  caret before (none known, hidden, a focused button's box, Chromium's
 *  hidden caret), a measured one now? Ends a ManualClose. */
export function textBoxTookFocus(before: CaretState | null, report: CaretState): boolean {
    return isMeasuredCaret(report) && !(before !== null && isMeasuredCaret(before));
}
