/**
 * The account popover: who is signed in, the appearance settings Keep shares
 * with Púca (same settings store — a theme picked here changes Púca too, and
 * vice versa), the export, the shortcuts help, and sign-out.
 */
import { useState } from 'react';
import { loadSettings, saveSettings } from '../../components/settingsStore';
import { DownloadIcon, HelpIcon, LogoutIcon, PopOutIcon } from '../../components/Icons';
import { type KeepSortMode } from '../model/keepPrefs';

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'] as const;

interface AccountMenuProps {
    username: string;
    sort: KeepSortMode;
    onSort: (s: KeepSortMode) => void;
    onExportMarkdown: () => void;
    onExportJson: () => void;
    onHelp: () => void;
    onSignOut: () => void;
    onSignOutEverywhere: () => void;
}

export function AccountMenu({ username, sort, onSort, onExportMarkdown, onExportJson, onHelp, onSignOut, onSignOutEverywhere }: AccountMenuProps) {
    const [settings, setSettings] = useState(loadSettings);
    const update = (patch: Partial<ReturnType<typeof loadSettings>>) => {
        const next = { ...loadSettings(), ...patch };
        saveSettings(next);
        setSettings(next);
    };
    return (
        <div className="keep-menu">
            <div className="keep-menu-head">
                <strong>{username}</strong>
                <span>Signed in with your Púca account</span>
            </div>
            <div className="keep-menu-row">
                <label htmlFor="keep-theme">Theme</label>
                <select id="keep-theme" value={settings.theme} onChange={e => update({ theme: e.target.value })}>
                    {THEMES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select>
            </div>
            <div className="keep-menu-row">
                <label htmlFor="keep-icons">Icons</label>
                <select id="keep-icons" value={settings.iconStyle} onChange={e => update({ iconStyle: e.target.value === 'classic' ? 'classic' : 'modern' })}>
                    <option value="modern">Modern</option>
                    <option value="classic">Classic</option>
                </select>
            </div>
            <div className="keep-menu-row">
                <label htmlFor="keep-textsize">Text size</label>
                <select id="keep-textsize" value={String(settings.fontScale ?? 100)} onChange={e => update({ fontScale: Number(e.target.value) })}>
                    {[90, 100, 110, 120, 130].map(s => <option key={s} value={s}>{s}%</option>)}
                </select>
            </div>
            <div className="keep-menu-row">
                <label htmlFor="keep-sort">Sort</label>
                <select id="keep-sort" value={sort} onChange={e => onSort(e.target.value as KeepSortMode)}>
                    <option value="puca">Púca order</option>
                    <option value="title">Title</option>
                    <option value="created">Newest first</option>
                </select>
            </div>
            <div className="keep-menu-sep" />
            <button type="button" className="keep-menu-item" onClick={onExportMarkdown}><DownloadIcon /> Export notes as Markdown</button>
            <button type="button" className="keep-menu-item" onClick={onExportJson}><DownloadIcon /> Export notes as JSON</button>
            <button type="button" className="keep-menu-item" onClick={onHelp}><HelpIcon /> Keyboard shortcuts</button>
            <a className="keep-menu-item" href="/" target="_blank" rel="noopener"><PopOutIcon /> Open Púca</a>
            <div className="keep-menu-sep" />
            <button type="button" className="keep-menu-item" onClick={onSignOut}><LogoutIcon /> Sign out</button>
            <button type="button" className="keep-menu-item danger" onClick={onSignOutEverywhere}><LogoutIcon /> Sign out of every device</button>
        </div>
    );
}
