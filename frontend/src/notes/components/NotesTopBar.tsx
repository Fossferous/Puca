/**
 * The top bar: menu (drawer) button, the Notes mark, search, refresh, the
 * grid/list toggle, and the account button that opens AccountMenu.
 */
import { forwardRef } from 'react';
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
    return (
        <header className="notes-topbar">
            <button type="button" className="notes-iconbtn notes-menu-btn" aria-label="Open navigation" title="Menu" onClick={onMenu}>
                <MenuIcon />
            </button>
            <a className="notes-brand" href="#/" onClick={e => { e.preventDefault(); onHome(); }} aria-label="Púca Notes — all notes">
                <NoteIcon /> Notes <span className="notes-brand-sub">by Púca</span>
            </a>
            <div className="notes-search" role="search">
                <SearchIcon />
                <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    placeholder="Search notes"
                    aria-label="Search notes"
                    onChange={e => onQueryChange(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClearQuery(); (e.target as HTMLInputElement).blur(); }
                    }}
                />
                {query && (
                    <button type="button" className="notes-iconbtn small" aria-label="Clear search" title="Clear" onClick={onClearQuery}>
                        <CloseIcon size={16} />
                    </button>
                )}
            </div>
            <div className="notes-topbar-actions">
                <button type="button" className="notes-iconbtn" aria-label="Refresh" title="Refresh (r)" onClick={onRefresh} disabled={refreshing}>
                    {refreshing ? <span className="notes-spinner" /> : <RefreshIcon />}
                </button>
                <button
                    type="button"
                    className="notes-iconbtn"
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
