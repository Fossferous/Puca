/**
 * The top bar: menu (drawer) button, the Notes mark, search, refresh, the
 * grid/list toggle, and the account button that opens AccountMenu.
 *
 * `searching` (the field focused or holding text) is what lets the field have
 * the row on a phone: notes.css hides the mark, Refresh and the grid/list
 * switch then, keeping the menu and the account button. Without it the field
 * was 20 px wide on a 411 px phone once the Clear button appeared beside it
 * (and narrower still on a 360 px one, before any), and in a field that
 * narrow Android's keyboard in the WebView puts the caret back at the START
 * after every letter: "milk" went in as "klmi", and Backspace, at position
 * 0, deleted nothing, so a search could not be taken back. Measured on an
 * emulator with Gboard: a bare input breaks at 32 px and is fine from 36 px.
 *
 * Clear keeps the field focused WHEN IT HAD THE CARET, so the bar does not
 * collapse under a typing finger: collapsing would put the grid/list switch
 * where Clear was, and a second tap there would change the view. Pressed
 * with the field not focused (a desktop click after leaving it, a phone that
 * tapped elsewhere and put its keyboard down), Clear leaves the focus alone,
 * so Notes' and Púca's single-key shortcuts keep working and no keyboard pops
 * up. Android's Back hides the keyboard WITHOUT taking the focus from the
 * field, so after Back the field still has the caret and Clear brings the
 * keyboard back (measured on the emulator). Escape still clears and leaves.
 *
 * Two more cases of the same rule. Clear pressed from the KEYBOARD (Tab to
 * it, Enter or Space) or by a screen reader is a click no pointer press led
 * to (isVirtualClick below): the button it is on is about to go, so the focus
 * goes back to the field instead of falling to the page, where the next Tab
 * would start from the top. And a tap on Clear with the field left takes no
 * focus, but the bar holds its shape for CLEAR_HOLD_MS so it does not
 * collapse under the finger: a quick second tap there (within the hold) lands
 * in the search box, which a press on the pill focuses, and not on the
 * grid/list switch. A deliberate second tap after the hold meets the bar
 * as it then is.
 */
import { forwardRef, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { CloseIcon, GridIcon, ListLayoutIcon, MenuIcon, NoteIcon, RefreshIcon, SearchIcon } from '../../components/Icons';

/** How long the bar keeps its searching shape after a tap on Clear that put
 *  no caret back: longer than a second tap of a double tap. */
const CLEAR_HOLD_MS = 400;

/**
 * A click on Clear that no finger or mouse made: Enter or Space on the
 * focused button, or a screen reader's activation. The first three checks
 * are react-aria's isVirtualClick (@react-aria/utils, isVirtualEvent.ts):
 *  - Firefox's `mozInputSource` 0: JAWS and NVDA there;
 *  - on Android, a click carrying a pointer type is TalkBack's only when it
 *    still reports the button held (`buttons` 1); a real tap's click comes
 *    with it released. `detail` is not read there: TalkBack's varies;
 *  - elsewhere, `detail` 0 with no pointer type: the keyboard, and most
 *    screen readers;
 *  - and ours: no pointerdown on this button since the last click (`pressed`
 *    false). Every real tap and mouse click on it has one.
 * NOT verified with a real screen reader: jsdom pins each check; Tab, then
 * Enter or Space, was measured in real Chromium, and real taps on the
 * Android emulator.
 */
function isVirtualClick(e: ReactMouseEvent, pressed: boolean): boolean {
    const native = e.nativeEvent as MouseEvent & { pointerType?: string; mozInputSource?: number };
    if (native.mozInputSource === 0 && native.isTrusted) return true;
    if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) && native.pointerType) {
        if (e.buttons === 1) return true;
    } else if (e.detail === 0 && !native.pointerType) {
        return true;
    }
    return !pressed;
}

interface NotesTopBarProps {
    query: string;
    onQueryChange: (q: string) => void;
    onClearQuery: () => void;
    view: 'grid' | 'list';
    onToggleView: () => void;
    refreshing: boolean;
    onRefresh: () => void;
    onMenu: () => void;
    onHome: () => void;
    accountInitial: string;
    onAccount: (anchor: HTMLElement) => void;
}

export const NotesTopBar = forwardRef<HTMLInputElement, NotesTopBarProps>(function NotesTopBar(
    { query, onQueryChange, onClearQuery, view, onToggleView, refreshing, onRefresh, onMenu, onHome, accountInitial, onAccount },
    searchRef,
) {
    const [focused, setFocused] = useState(false);
    /** A tap on Clear that put no caret back holds the bar's shape briefly. */
    const [held, setHeld] = useState(false);
    const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (heldTimer.current) clearTimeout(heldTimer.current); }, []);
    const searching = focused || query !== '' || held;
    const input = useRef<HTMLInputElement | null>(null);
    /** A pointer press on Clear is under way (pointerdown seen, no click yet),
     *  and whether it began with the caret in the field. Reset by the click
     *  that reads them and by pointercancel; NOT by pointerleave, which a
     *  touch screen fires after pointerup and before the click, on every tap. */
    const clearPressed = useRef(false);
    const clearFromField = useRef(false);
    const setInput = useCallback((el: HTMLInputElement | null) => {
        input.current = el;
        if (typeof searchRef === 'function') searchRef(el);
        else if (searchRef) searchRef.current = el;
    }, [searchRef]);
    return (
        <header className={`notes-topbar${searching ? ' searching' : ''}`}>
            <button type="button" className="notes-iconbtn notes-menu-btn" aria-label="Open navigation" title="Menu" onClick={onMenu}>
                <MenuIcon />
            </button>
            <a className="notes-brand" href="#/" onClick={e => { e.preventDefault(); onHome(); }} aria-label="Púca Notes — all notes">
                <NoteIcon /> Notes <span className="notes-brand-sub">by Púca</span>
            </a>
            {/* A press anywhere on the pill types into it. Before it is focused
                the bar is laid out as before, so on a 360 px phone the input
                itself is 20 px of the pill (measured; 0 at 330 px) and a tap on the
                magnifier or the padding used to focus nothing. Mousedown, not
                pointerdown: on a touch screen it comes after the finger lifts,
                inside the tap's user gesture, so Android raises the keyboard
                for the focus. The default is prevented so the press does not
                blur a field that already has the caret. Clear is a button and
                keeps its own press. */}
            <div
                className="notes-search"
                role="search"
                onMouseDown={e => {
                    const t = e.target as Element;
                    if (t === input.current || t.closest('button')) return;
                    e.preventDefault();
                    input.current?.focus();
                }}
            >
                <SearchIcon />
                <input
                    ref={setInput}
                    type="search"
                    value={query}
                    placeholder="Search notes"
                    aria-label="Search notes"
                    onChange={e => onQueryChange(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onKeyDown={e => {
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClearQuery(); (e.target as HTMLInputElement).blur(); }
                    }}
                />
                {query && (
                    <button
                        type="button"
                        className="notes-iconbtn small"
                        aria-label="Clear search"
                        title="Clear"
                        // Whether the caret was in the field when the press began
                        // (pointerdown comes before the button takes the focus).
                        onPointerDown={() => { clearPressed.current = true; clearFromField.current = document.activeElement === input.current; }}
                        onPointerCancel={() => { clearPressed.current = false; clearFromField.current = false; }}
                        onClick={e => {
                            // The keyboard's or a screen reader's click puts the focus back;
                            // a pointer's does when its press began with the caret in the field.
                            const back = isVirtualClick(e, clearPressed.current) || clearFromField.current;
                            clearPressed.current = false;
                            clearFromField.current = false;
                            onClearQuery();
                            if (back) { input.current?.focus(); return; }
                            if (heldTimer.current) clearTimeout(heldTimer.current);
                            setHeld(true);
                            heldTimer.current = setTimeout(() => { heldTimer.current = null; setHeld(false); }, CLEAR_HOLD_MS);
                        }}
                    >
                        <CloseIcon size={16} />
                    </button>
                )}
            </div>
            <div className="notes-topbar-actions">
                <button type="button" className="notes-iconbtn notes-topbar-spare" aria-label="Refresh" title="Refresh (r)" onClick={onRefresh} disabled={refreshing}>
                    {refreshing ? <span className="notes-spinner" /> : <RefreshIcon />}
                </button>
                <button
                    type="button"
                    className="notes-iconbtn notes-topbar-spare"
                    aria-label={view === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
                    title={view === 'grid' ? 'List view' : 'Grid view'}
                    onClick={onToggleView}
                >
                    {view === 'grid' ? <ListLayoutIcon /> : <GridIcon />}
                </button>
                <button type="button" className="notes-iconbtn" aria-label="Account and settings" title="Account" onClick={e => onAccount(e.currentTarget)}>
                    <span className="notes-avatar">{accountInitial}</span>
                </button>
            </div>
        </header>
    );
});
