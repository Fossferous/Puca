/**
 * The account popover: who is signed in, the appearance settings Notes shares
 * with Púca (same settings store — a theme picked here changes Púca too, and
 * vice versa), the export, the shortcuts help, and sign-out.
 */
import { useState } from 'react';
import { loadSettings, saveSettings } from '../../components/settingsStore';
import { DownloadIcon, HelpIcon, LogoutIcon, PopOutIcon, UploadIcon } from '../../components/Icons';
import { NotesLocationSettings } from '../native/NotesLocationSettings';
import { isMobile } from '../../api/platform';
import { type NotesSortMode } from '../model/notesPrefs';
import { NotesUpdateMenu } from './NotesUpdateMenu';

/** The Notes Android shell: no Púca page at `/` to open. */
const NATIVE = isMobile();

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'] as const;

interface AccountMenuProps {
    username: string;
    sort: NotesSortMode;
    onSort: (s: NotesSortMode) => void;
    onExportMarkdown: () => void;
    onExportJson: () => void;
    /** Android app only: the share sheet (undefined hides the item). */
    onShare?: () => void;
    onHelp: () => void;
    onSignOut: () => void;
    onSignOutEverywhere: () => void;
}

export function AccountMenu({ username, sort, onSort, onExportMarkdown, onExportJson, onShare, onHelp, onSignOut, onSignOutEverywhere }: AccountMenuProps) {
    const [settings, setSettings] = useState(loadSettings);
    const update = (patch: Partial<ReturnType<typeof loadSettings>>) => {
        const next = { ...loadSettings(), ...patch };
        saveSettings(next);
        setSettings(next);
    };
    return (
        <div className="notes-menu">
            <div className="notes-menu-head">
                <strong>{username}</strong>
                <span>Signed in with your Púca account</span>
            </div>
            <div className="notes-menu-row">
                <label htmlFor="notes-theme">Theme</label>
                <select id="notes-theme" value={settings.theme} onChange={e => update({ theme: e.target.value })}>
                    {THEMES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select>
            </div>
            <div className="notes-menu-row">
                <label htmlFor="notes-icons">Icons</label>
                <select id="notes-icons" value={settings.iconStyle} onChange={e => update({ iconStyle: e.target.value === 'classic' ? 'classic' : 'modern' })}>
                    <option value="modern">Modern</option>
                    <option value="classic">Classic</option>
                </select>
            </div>
            <div className="notes-menu-row">
                <label htmlFor="notes-textsize">Text size</label>
                <select id="notes-textsize" value={String(settings.fontScale ?? 100)} onChange={e => update({ fontScale: Number(e.target.value) })}>
                    {[90, 100, 110, 120, 130].map(s => <option key={s} value={s}>{s}%</option>)}
                </select>
            </div>
            <div className="notes-menu-row">
                <label htmlFor="notes-sort">Sort</label>
                <select id="notes-sort" value={sort} onChange={e => onSort(e.target.value as NotesSortMode)}>
                    <option value="puca">Púca order</option>
                    <option value="title">Title</option>
                    <option value="created">Newest first</option>
                </select>
            </div>
            <NotesLocationSettings />
            <div className="notes-menu-sep" />
            {/* In the Android app these write to Documents/Puca Notes (an
                Android WebView ignores the download attribute, so the browser
                path would save nothing) and Share opens the share sheet. */}
            <button type="button" className="notes-menu-item" onClick={onExportMarkdown}><DownloadIcon /> {NATIVE ? 'Save as Markdown' : 'Export notes as Markdown'}</button>
            <button type="button" className="notes-menu-item" onClick={onExportJson}><DownloadIcon /> {NATIVE ? 'Save as JSON' : 'Export notes as JSON'}</button>
            {onShare && <button type="button" className="notes-menu-item" onClick={onShare}><UploadIcon /> Share notes…</button>}
            <button type="button" className="notes-menu-item" onClick={onHelp}><HelpIcon /> Keyboard shortcuts</button>
            {!NATIVE && <a className="notes-menu-item" href="/" target="_blank" rel="noopener"><PopOutIcon /> Open Púca</a>}
            {NATIVE && <><div className="notes-menu-sep" /><NotesUpdateMenu /></>}
            <div className="notes-menu-sep" />
            <button type="button" className="notes-menu-item" onClick={onSignOut}><LogoutIcon /> Sign out</button>
            <button type="button" className="notes-menu-item danger" onClick={onSignOutEverywhere}><LogoutIcon /> Sign out of every device</button>
        </div>
    );
}
