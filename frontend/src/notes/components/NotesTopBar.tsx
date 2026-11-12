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
 * Clear keeps the field focused, so the bar does not collapse under the
 * finger: collapsing would put the grid/list switch where Clear was, and a
 * second tap there would change the view. Escape still clears and leaves.
 */
import { forwardRef, useCallback, useRef, useState } from 'react';
import { CloseIcon, GridIcon, ListLayoutIcon, MenuIcon, NoteIcon, RefreshIcon, SearchIcon } from '../../components/Icons';

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
    const searching = focused || query !== '';
    const input = useRef<HTMLInputElement | null>(null);
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
            <div className="notes-search" role="search">
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
                    <button type="button" className="notes-iconbtn small" aria-label="Clear search" title="Clear" onClick={() => { onClearQuery(); input.current?.focus(); }}>
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
