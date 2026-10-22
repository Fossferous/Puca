import { useEffect, useState } from 'react';
import { listChannels, type Channel, type Role } from '../api/servers';
import { getChannelOverwrites, putChannelOverwrite, deleteChannelOverwrite } from '../api/channels';
import { PERMISSIONS } from '../api/permissionBits';
import { isOpenedFor, nextOverwrite } from './streamOnlyOverwrite';

// The role editor's "Automated streaming" section (docs/STREAM_ONLY.md).
//
// Two RESTRICTING bits, both enforced by the server: STREAM_ONLY caps every
// holder to seeing, joining and screen sharing in the voice channels opened
// for this role (nothing else, no text anywhere, no channel keys but those);
// NO_RECEIVE means nobody's audio or video is sent to them. Only the owner or
// an administrator may change either (role_handlers refuses everyone else
// silently by keeping the role's bits), and never on @everyone.
//
// "Opened for this role" is an ordinary channel overwrite of this role that
// allows Connect; the list below writes exactly that, so the Permissions tab
// of the channel shows the same thing.

interface Props {
    serverId: string;
    role: Role;
    editPermissions: number;
    onToggle: (key: 'STREAM_ONLY' | 'NO_RECEIVE') => void;
    /** Owner or administrator: the only editors the server lets change these. */
    canRestrict: boolean;
}

interface VoiceRow {
    channel: Channel;
    overwrite?: { allow: number; deny: number };
}

export function StreamOnlyRoleSection({ serverId, role, editPermissions, onToggle, canRestrict }: Props) {
    const savedStreamOnly = (role.permissions & PERMISSIONS.STREAM_ONLY) !== 0;
    const [rows, setRows] = useState<VoiceRow[] | null>(null);
    const [busy, setBusy] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!savedStreamOnly || !canRestrict) return;
        let cancelled = false;
        (async () => {
            try {
                const voice = (await listChannels(serverId)).filter(c => c.channel_type === 1);
                const loaded = await Promise.all(voice.map(async channel => {
                    const ows = await getChannelOverwrites(channel.id);
                    const mine = ows.find(o => o.role_id === role.id);
                    return { channel, overwrite: mine ? { allow: mine.allow, deny: mine.deny } : undefined };
                }));
                if (!cancelled) setRows(loaded);
            } catch {
                if (!cancelled) setError('Could not load the voice channels.');
            }
        })();
        return () => { cancelled = true; };
    }, [serverId, role.id, savedStreamOnly, canRestrict]);

    if (role.is_default || role.name === 'Owner') return null;

    const toggleChannel = async (row: VoiceRow) => {
        const open = !isOpenedFor(row.overwrite?.allow);
        const next = nextOverwrite(row.overwrite, open);
        setBusy(row.channel.id);
        setError(null);
        try {
            if (next) await putChannelOverwrite(row.channel.id, role.id, next.allow, next.deny);
            else await deleteChannelOverwrite(row.channel.id, role.id);
            setRows(prev => prev?.map(r => r.channel.id === row.channel.id ? { ...r, overwrite: next ?? undefined } : r) ?? null);
        } catch {
            setError(`Could not change ${row.channel.name}.`);
        } finally {
            setBusy(null);
        }
    };

    const has = (bit: number) => (editPermissions & bit) !== 0;

    return (
        <div className="permission-category stream-only-section" data-testid="role-automated-streaming">
            <h4>Automated Streaming</h4>
            <p className="role-hint">
                For an account that only streams into calls. Enforced by the server: it can see,
                join and share its screen in the voice channels you open below, and nothing else —
                no text channels, no messages, no invites.
            </p>
            {!canRestrict && (
                <p className="role-hint">Only the server owner or an administrator can change these.</p>
            )}
            <div className="permission-list">
                <label className="permission-item">
                    <input
                        type="checkbox"
                        data-testid="role-stream-only"
                        checked={has(PERMISSIONS.STREAM_ONLY)}
                        onChange={() => onToggle('STREAM_ONLY')}
                        disabled={!canRestrict}
                    />
                    <div className="permission-info">
                        <span className="permission-label">Stream only</span>
                        <span className="permission-desc">Members with this role can only join and screen share in the voice channels opened for it</span>
                    </div>
                </label>
                <label className="permission-item">
                    <input
                        type="checkbox"
                        data-testid="role-no-receive"
                        checked={has(PERMISSIONS.NO_RECEIVE)}
                        onChange={() => onToggle('NO_RECEIVE')}
                        disabled={!canRestrict}
                    />
                    <div className="permission-info">
                        <span className="permission-label">No receive</span>
                        <span className="permission-desc">Nobody's audio or video is sent to members with this role; everyone still sees their stream</span>
                    </div>
                </label>
            </div>
            {canRestrict && has(PERMISSIONS.STREAM_ONLY) && !savedStreamOnly && (
                <p className="role-hint">Save the role, then choose the voice channels it may stream in.</p>
            )}
            {canRestrict && savedStreamOnly && (
                <div className="stream-only-channels">
                    <h4>Voice channels this role may stream in</h4>
                    {error && <div className="role-error">{error}</div>}
                    {rows === null && !error && <div className="role-loading">Loading...</div>}
                    {rows !== null && rows.length === 0 && <p className="role-hint">This server has no voice channels yet.</p>}
                    <div className="permission-list">
                        {rows?.map(row => (
                            <label key={row.channel.id} className="permission-item">
                                <input
                                    type="checkbox"
                                    data-testid="role-stream-channel"
                                    data-channel-id={row.channel.id}
                                    checked={isOpenedFor(row.overwrite?.allow)}
                                    onChange={() => void toggleChannel(row)}
                                    disabled={busy !== null}
                                />
                                <div className="permission-info">
                                    <span className="permission-label">{row.channel.name}</span>
                                </div>
                            </label>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
