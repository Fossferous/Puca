/**
 * The account popover: who is signed in, the appearance settings Notes shares
 * with Púca (same settings store — a theme picked here changes Púca too, and
 * vice versa), the reminder times, the export, the shortcuts help, and
 * sign-out.
 *
 * The reminder times are the ONE control for what Morning, Afternoon and
 * Evening mean on an item and what a new reminder starts at. They are sealed
 * into the account's Notes document with the colours and labels, so they
 * follow the account; the server never sees them.
 */
import { useState } from 'react';
import { loadSettings, saveSettings } from '../../components/settingsStore';
import { DownloadIcon, HelpIcon, LogoutIcon, PopOutIcon, UploadIcon } from '../../components/Icons';
import { NotesLocationSettings } from '../native/NotesLocationSettings';
import { NotesTileSetting } from '../native/NotesTileSetting';
import { isMobile } from '../../api/platform';
import { type ReminderTimes } from '../../api/reminderTimes';
import { type NotesSortMode } from '../model/notesPrefs';
import { NotesUpdateMenu } from './NotesUpdateMenu';

/** The Notes Android shell: no Púca page at `/` to open. */
const NATIVE = isMobile();

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'] as const;

const TIME_ROWS: { key: keyof ReminderTimes; id: string; label: string }[] = [
    { key: 'morning', id: 'notes-remind-morning', label: 'Morning' },
    { key: 'afternoon', id: 'notes-remind-afternoon', label: 'Afternoon' },
    { key: 'evening', id: 'notes-remind-evening', label: 'Evening' },
    { key: 'default', id: 'notes-remind-default', label: 'New reminders at' },
];

interface AccountMenuProps {
    username: string;
    sort: NotesSortMode;
    onSort: (s: NotesSortMode) => void;
    times: ReminderTimes;
    onTimes: (patch: Partial<ReminderTimes>) => void;
    onExportMarkdown: () => void;
    onExportJson: () => void;
    /** Android app only: the share sheet (undefined hides the item). */
    onShare?: () => void;
    onHelp: () => void;
    onSignOut: () => void;
    onSignOutEverywhere: () => void;
}

export function AccountMenu({ username, sort, onSort, times, onTimes, onExportMarkdown, onExportJson, onShare, onHelp, onSignOut, onSignOutEverywhere }: AccountMenuProps) {
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
                    <option value="edited">Recently edited</option>
                </select>
            </div>
            <div className="notes-menu-sep" />
            {TIME_ROWS.map(r => (
                <div className="notes-menu-row" key={r.id}>
                    <label htmlFor={r.id}>{r.label}</label>
                    <input
                        id={r.id}
                        type="time"
                        value={times[r.key]}
                        onChange={e => onTimes({ [r.key]: e.target.value } as Partial<ReminderTimes>)}
                    />
                </div>
            ))}
            <div className="notes-menu-hint">
                Morning, Afternoon and Evening are the one-tap times on an item, and Snooze’s Tomorrow uses your morning.
                They follow your account, sealed — the server never sees them.
            </div>
            <NotesLocationSettings />
            <NotesTileSetting />
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
