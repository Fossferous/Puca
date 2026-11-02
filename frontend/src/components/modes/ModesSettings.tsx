import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useChannels, useServerModes } from '../../hooks/queries';
import { BackgroundRefused, prepareBackground } from '../../api/modeLook';
import { accentTokens, createMode, deleteMode, shownWithParent, updateMode, type ModeEdit, type ServerMode } from '../../api/serverModes';
import type { Channel } from '../../api/servers';
import { uploadFile } from '../../api/uploads';
import { statusOf } from '../../api/client';
import { AuthedImg } from '../AuthedImg';
import { FolderIcon, HashIcon, MoonIcon, SpeakerIcon, TrashIcon, UploadIcon } from '../Icons';
import './ModesSettings.css';

/** What the color input starts from when a mode has no accent yet. */
const DEFAULT_ACCENT = '#7a1f3d';

/** The server's refusals are written to be read. */
function saveError(e: unknown, fallback: string): string {
    const status = statusOf(e);
    const text = e instanceof Error && e.message ? e.message : '';
    return status === 400 || status === 403 || status === 409 || status === 413 ? text || fallback : fallback;
}

interface ModeCardProps {
    serverId: string;
    mode: ServerMode;
    channels: Channel[];
    isActive: boolean;
    /** May this reader turn the mode off? Deleting the one that is on does. */
    canSwitch: boolean;
}

function ModeCard({ serverId, mode, channels, isActive, canSwitch }: ModeCardProps) {
    const queryClient = useQueryClient();
    const [saved, setSaved] = useState(false);
    // Each field is what was typed here, or undefined for "as stored". So another
    // manager's save, or this card's own background upload (which saves at once
    // and refetches), changes what is shown without losing an unsaved edit.
    const [draft, setDraft] = useState<{
        name?: string;
        channelIds?: number[];
        homeId?: number | null;
        accent?: string | null;
        autoOff?: boolean;
    }>({});
    const name = draft.name ?? mode.name;
    const channelIds = draft.channelIds ?? mode.channel_ids;
    const homeId = draft.homeId === undefined ? mode.home_channel_id : draft.homeId;
    const accent = draft.accent === undefined ? mode.accent_color : draft.accent;
    const autoOff = draft.autoOff ?? mode.auto_off;
    const edit = (change: typeof draft) => {
        setSaved(false);
        setDraft(prev => ({ ...prev, ...change }));
    };
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const fileInput = useRef<HTMLInputElement>(null);

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: keys.modes(serverId) });
        void queryClient.invalidateQueries({ queryKey: keys.channels(serverId) });
    };

    const sameChannels = channelIds.length === mode.channel_ids.length && channelIds.every(id => mode.channel_ids.includes(id));
    const dirty = name.trim() !== mode.name || !sameChannels || homeId !== mode.home_channel_id
        || accent !== mode.accent_color || autoOff !== mode.auto_off;

    const save = async () => {
        setBusy(true);
        setError('');
        setSaved(false);
        // Only what changed, so this save cannot undo another manager's.
        const changes: ModeEdit = {};
        if (name.trim() !== mode.name) changes.name = name;
        // Only ids still on the server: a channel deleted since the list was read has no
        // row here to untick, and the server would refuse the whole save for it.
        if (!sameChannels) changes.channel_ids = channelIds.filter(id => channels.some(c => c.id === id));
        if (homeId !== mode.home_channel_id) changes.home_channel_id = homeId ?? 0;
        if (accent !== mode.accent_color) changes.accent_color = accent ?? '';
        if (autoOff !== mode.auto_off) changes.auto_off = autoOff;
        try {
            await updateMode(serverId, mode.id, changes);
            setDraft({});
            setSaved(true);
            refresh();
        } catch (e) {
            setError(saveError(e, 'Could not save this mode.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        const warning = isActive
            ? `Delete ${mode.name}? It is on right now: anyone in its voice channels will be disconnected. Its channels and their messages are kept.`
            : `Delete ${mode.name}? Its channels and their messages are kept, and show all the time from now on.`;
        if (!confirm(warning)) return;
        setBusy(true);
        setError('');
        try {
            await deleteMode(serverId, mode.id);
            refresh();
        } catch (e) {
            setError(saveError(e, 'Could not delete this mode.'));
            setBusy(false);
        }
    };

    const pickBackground = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true);
        setError('');
        setSaved(false);
        try {
            const prepared = await prepareBackground(file);
            const uploaded = await uploadFile(prepared);
            await updateMode(serverId, mode.id, { background_file_id: uploaded.id });
            refresh();
        } catch (e) {
            setError(e instanceof BackgroundRefused ? e.message : saveError(e, 'Could not set that background.'));
        } finally {
            setBusy(false);
            if (fileInput.current) fileInput.current.value = '';
        }
    };

    const clearBackground = async () => {
        setBusy(true);
        setError('');
        try {
            await updateMode(serverId, mode.id, { background_file_id: '' });
            refresh();
        } catch (e) {
            setError(saveError(e, 'Could not remove the background.'));
        } finally {
            setBusy(false);
        }
    };

    const toggleChannel = (id: number, on: boolean) => {
        edit({ channelIds: on ? [...channelIds, id] : channelIds.filter(c => c !== id) });
    };

    const pickable = channels.filter(c => !c.is_afk);
    const parentOf = (c: Channel) => (c.parent_id == null ? undefined : channels.find(p => p.id === c.parent_id));
    // Each collection followed by what is under it, so a row reads as part of it.
    const inTreeOrder = (rows: Channel[]) => rows.flatMap(c => {
        if (c.parent_id != null && rows.some(p => p.id === c.parent_id)) return [];
        return [c, ...rows.filter(sub => sub.parent_id === c.id)];
    });
    const text = inTreeOrder(pickable.filter(c => c.channel_type !== 1));
    const voice = inTreeOrder(pickable.filter(c => c.channel_type === 1));
    // A main channel must be somewhere people can follow while this mode is on: one of
    // its own, ticked here or by its collection, or one that is always listed.
    const homeChoices = voice.filter(c => {
        const parent = parentOf(c);
        return c.id === homeId || channelIds.includes(c.id) || (parent && channelIds.includes(parent.id))
            || shownWithParent(c, channels, mode.id);
    });

    const preview = accent ? accentTokens(accent, []) : null;

    const row = (c: Channel) => {
        const parent = parentOf(c);
        const withCollection = !!parent && channelIds.includes(parent.id);
        return (
            <label key={c.id} className={`mode-channel ${parent ? 'mode-channel-sub' : ''}`}>
                <input
                    type="checkbox"
                    checked={channelIds.includes(c.id) || withCollection}
                    disabled={withCollection}
                    onChange={e => toggleChannel(c.id, e.target.checked)}
                    aria-label={`${c.name} belongs to ${mode.name}`}
                />
                <span className="mode-channel-icon" aria-hidden="true">
                    {c.channel_type === 1 ? <SpeakerIcon /> : c.channel_type === 2 ? <FolderIcon /> : <HashIcon />}
                </span>
                <span className="mode-channel-name">{c.name}</span>
                {parent && <span className="mode-channel-parent">{withCollection ? `with ${parent.name}` : `in ${parent.name}`}</span>}
            </label>
        );
    };

    return (
        <section className="mode-card" data-testid="mode-card" aria-label={mode.name}>
            <div className="form-group">
                <label htmlFor={`mode-name-${mode.id}`}>Name</label>
                <input
                    id={`mode-name-${mode.id}`}
                    type="text"
                    value={name}
                    maxLength={64}
                    onChange={e => edit({ name: e.target.value })}
                />
                {isActive && <span className="setting-help mode-on-now">On right now.</span>}
            </div>

            <div className="form-group">
                <span className="mode-field-label">Channels that show only while this mode is on</span>
                {pickable.length === 0 && <span className="setting-help">This server has no channels to add yet.</span>}
                {voice.length > 0 && <div className="mode-channel-list" role="group" aria-label="Voice channels">{voice.map(row)}</div>}
                {text.length > 0 && <div className="mode-channel-list" role="group" aria-label="Text channels">{text.map(row)}</div>}
                {channels.some(c => c.channel_type === 2) && (
                    <span className="setting-help">A collection's subchannels show and hide with it.</span>
                )}
                {channels.some(c => c.is_afk) && (
                    <span className="setting-help"><MoonIcon size={13} /> The AFK channel can't belong to a mode: idle members are moved into it.</span>
                )}
            </div>

            <div className="form-group">
                <label htmlFor={`mode-home-${mode.id}`}>Main voice channel</label>
                <select
                    id={`mode-home-${mode.id}`}
                    value={homeId ?? ''}
                    onChange={e => edit({ homeId: e.target.value ? Number(e.target.value) : null })}
                >
                    <option value="">None</option>
                    {homeChoices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <span className="setting-help">
                    Where the Join button goes when this mode starts, and where Call everyone to it brings people.
                </span>
            </div>

            <div className="form-group">
                <span className="mode-field-label">Background</span>
                <div className="mode-background-row">
                    {mode.background_file_id
                        ? <AuthedImg fileId={mode.background_file_id} alt="" className="mode-background-preview" />
                        : <span className="mode-background-preview mode-background-empty">None</span>}
                    <div className="mode-background-actions">
                        <button type="button" className="secondary-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
                            <UploadIcon /> {mode.background_file_id ? 'Replace' : 'Choose a picture'}
                        </button>
                        {mode.background_file_id && (
                            <button type="button" className="secondary-btn" disabled={busy} onClick={() => void clearBackground()}>Remove</button>
                        )}
                    </div>
                    <input
                        ref={fileInput}
                        type="file"
                        hidden
                        accept="image/jpeg,image/png,image/webp"
                        aria-label={`Background picture for ${mode.name}`}
                        onChange={e => void pickBackground(e.target.files?.[0])}
                    />
                </div>
                <span className="setting-help">
                    Shown behind the chat in its own colours. Each person's device darkens or lightens it only as
                    far as messages need to stay readable on their theme. Stored
                    unencrypted, like the server icon: whoever runs this server can see it. Anyone can turn
                    server backgrounds off in their own settings, and High Contrast hides them.
                </span>
            </div>

            <div className="form-group">
                <span className="mode-field-label">Accent colour</span>
                <div className="mode-accent-row">
                    <input
                        type="color"
                        aria-label={`Accent colour for ${mode.name}`}
                        value={accent ?? DEFAULT_ACCENT}
                        onChange={e => edit({ accent: e.target.value })}
                    />
                    {accent ? (
                        <>
                            <span className="mode-accent-sample" style={preview ? { background: preview.primary } : undefined}>Sample</span>
                            <button type="button" className="secondary-btn" onClick={() => edit({ accent: null })}>No accent</button>
                        </>
                    ) : <span className="setting-help mode-accent-none">No accent: everyone keeps their theme's colour.</span>}
                </div>
                <span className="setting-help">
                    Recolours buttons and highlights while this mode is on. It is lightened or darkened for each
                    person's theme so button labels stay readable, so it can look a little different from this
                    sample.
                </span>
            </div>

            <div className="form-group">
                <label className="toggle-row">
                    <span>Turn off when empty</span>
                    <input
                        type="checkbox"
                        checked={autoOff}
                        onChange={e => edit({ autoOff: e.target.checked })}
                        aria-label={`Turn ${mode.name} off when empty`}
                    />
                    <span className="toggle-switch"></span>
                </label>
                <span className="setting-help">
                    Turns off by itself once its voice channels have been empty for 30 minutes. It only starts
                    counting after someone has been in them.
                </span>
            </div>

            {error && <div className="notice error" role="alert">{error}</div>}
            {saved && !dirty && <div className="notice success" role="status">Saved.</div>}

            <div className="mode-card-actions">
                <button type="button" className="primary-btn" disabled={busy || !dirty || !name.trim()} onClick={() => void save()}>
                    Save
                </button>
                <button type="button" className="danger-btn" disabled={busy || (isActive && !canSwitch)} onClick={() => void remove()}>
                    <TrashIcon /> Delete mode
                </button>
            </div>
            {isActive && !canSwitch && (
                <span className="setting-help">This mode is on. Deleting it would turn it off, which takes the Switch Modes permission.</span>
            )}
        </section>
    );
}

interface ModesSettingsProps {
    serverId: string;
}

/**
 * Server Settings, Modes (docs/SERVER_MODES.md). Whoever holds Manage Channels
 * defines the modes here; who may switch one on is a separate permission, and the
 * switch itself lives in the channel list.
 */
export function ModesSettings({ serverId }: ModesSettingsProps) {
    const queryClient = useQueryClient();
    const { data, isLoading, isError } = useServerModes(serverId, true);
    const { data: channels = [] } = useChannels(serverId);
    const [newName, setNewName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const add = async () => {
        const name = newName.trim();
        // Enter repeats while it is held, and only the button is disabled.
        if (!name || busy) return;
        setBusy(true);
        setError('');
        try {
            await createMode(serverId, { name });
            setNewName('');
            void queryClient.invalidateQueries({ queryKey: keys.modes(serverId) });
        } catch (e) {
            setError(saveError(e, 'Could not create that mode.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="settings-section modes-settings" data-testid="modes-settings">
            <h2>Modes</h2>
            <p className="setting-help modes-intro">
                A mode is a set of channels that only show in the channel list while it is on, with an optional
                background and accent colour. One mode is on at a time. Turning a mode off disconnects everyone in
                its voice channels; messages in its text channels are kept and come back with it.
            </p>
            <p className="setting-help modes-intro">
                A mode tidies the list. It does not keep anyone out: anyone allowed to see a channel can still
                open it from a mention, a notification or a link, and people on an older version of Púca see every
                channel. To keep someone out of a channel, use its permissions. Who can switch modes is the Switch
                Modes permission in Roles.
            </p>

            {isLoading && <p className="setting-help">Loading...</p>}
            {isError && <div className="notice error" role="alert">Could not load this server's modes.</div>}

            {data && !data.can_edit && (
                <p className="setting-help">You need the Manage Channels permission to change modes.</p>
            )}

            {data?.can_edit && (
                <>
                    <div className="mode-add">
                        <input
                            type="text"
                            value={newName}
                            maxLength={64}
                            placeholder="Blood on the Clocktower"
                            aria-label="New mode name"
                            onChange={e => setNewName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void add(); }}
                        />
                        <button type="button" className="primary-btn" disabled={busy || !newName.trim()} onClick={() => void add()}>
                            Add mode
                        </button>
                    </div>
                    {error && <div className="notice error" role="alert">{error}</div>}
                    {data.modes.map(mode => (
                        <ModeCard
                            key={mode.id}
                            serverId={serverId}
                            mode={mode}
                            channels={channels}
                            isActive={data.active_mode_id === mode.id}
                            canSwitch={data.can_switch}
                        />
                    ))}
                </>
            )}

            {data && !data.can_edit && data.modes.map(mode => (
                <div key={mode.id} className="mode-card">
                    <strong>{mode.name}</strong>
                    {data.active_mode_id === mode.id && <span className="setting-help mode-on-now"> On right now.</span>}
                </div>
            ))}
        </div>
    );
}
