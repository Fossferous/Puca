/**
 * Sharing one device with friends — the owner's management surface.
 *
 * The shape mirrors EditChannelModal's entity-picker-plus-scoped-permissions
 * pattern: pick a friend, choose what they get (screen access as a level,
 * files as an orthogonal toggle), see who already has what, revoke in place.
 *
 * Consent is mutual: creating a share here only INVITES — nothing goes live
 * until the friend accepts, and (separately) until the host device itself has
 * signed the grant. When this modal is open ON the host device the signature
 * happens inline; otherwise the host auto-signs the next time it hears about
 * an accepted invite (see autoSignShares), and the row here says so instead
 * of pretending the share is already usable.
 */
import { useCallback, useEffect, useState } from 'react';
import { listFriends, type Friend } from '../api/friends';
import { thisDeviceId, currentUserId, type VerifiedDevice } from '../api/devices';
import { signWithDeviceKey } from '../api/devices/deviceKey';
import {
    buildShareRecord,
    createShare,
    deleteShare,
    listDeviceShares,
    signShareGrant,
    type DeviceShare,
    type ShareCapability,
} from '../api/devices/shares';
import { CloseIcon } from './Icons';
import './DeviceShareModal.css';

type ScreenLevel = 'none' | 'view_only' | 'control';

function capsLabel(caps: string[]): string {
    const parts: string[] = [];
    if (caps.includes('control')) parts.push('full control');
    else if (caps.includes('view_only')) parts.push('view only');
    if (caps.includes('files')) parts.push('files');
    return parts.join(' + ') || 'nothing';
}

function statusLabel(s: DeviceShare, onHost: boolean): string {
    if (s.status === 'pending') return 'Invited — waiting for them to accept';
    if (s.status === 'rejected') return 'Declined';
    if (s.status === 'accepted' && !s.signed) {
        // Signing is a deliberate act ON the shared device — never automatic —
        // so a share invited from elsewhere waits for the owner to confirm it
        // there, not for the device to "come online and self-sign".
        return onHost
            ? 'Accepted — confirm below to activate'
            : 'Accepted — open Puca on the shared device to activate';
    }
    return 'Active';
}

export function DeviceShareModal({ device, onClose }: { device: VerifiedDevice; onClose: () => void }) {
    const [shares, setShares] = useState<DeviceShare[] | null>(null);
    const [friends, setFriends] = useState<Friend[] | null>(null);
    const [friendId, setFriendId] = useState<number | ''>('');
    const [screen, setScreen] = useState<ScreenLevel>('control');
    const [files, setFiles] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const onHost = thisDeviceId() === device.id;

    const refresh = useCallback(async () => {
        try {
            setShares(await listDeviceShares(device.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not load shares.');
        }
    }, [device.id]);

    useEffect(() => {
        void refresh();
        void listFriends().then(setFriends).catch(() => setFriends([]));
    }, [refresh]);

    const submit = async () => {
        if (friendId === '') return;
        const caps: ShareCapability[] = [];
        if (screen === 'control') caps.push('control');
        if (screen === 'view_only') caps.push('view_only');
        if (files) caps.push('files');
        if (caps.length === 0) {
            setError('Choose at least one thing to share.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const uid = currentUserId();
            if (uid == null) throw new Error('not signed in');
            // On the host itself the grant is signed inline — the invite is
            // connectable the moment the friend accepts. From any other
            // device it is created unsigned and the host confirms later.
            let grant: { record: string; sig: string } | undefined;
            if (onHost) {
                const { canonical } = buildShareRecord({
                    hostDevice: device.id,
                    ownerUser: uid,
                    granteeUser: friendId,
                    capabilities: caps,
                });
                grant = { record: canonical, sig: await signWithDeviceKey(canonical) };
            }
            await createShare(device.id, friendId, caps, grant);
            setFriendId('');
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not create the share.');
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (id: number) => {
        setBusy(true);
        setError(null);
        try {
            await deleteShare(id);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not revoke.');
        } finally {
            setBusy(false);
        }
    };

    /** Sign an accepted-but-unsigned share with THIS device's key — the
     *  deliberate host-side act that makes a share connectable. Only reachable
     *  when sitting at the shared device (onHost), showing exactly what is
     *  being granted. */
    const activate = async (s: DeviceShare) => {
        setBusy(true);
        setError(null);
        try {
            const uid = currentUserId();
            if (uid == null) throw new Error('not signed in');
            await signShareGrant(s, uid);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not activate the share.');
        } finally {
            setBusy(false);
        }
    };

    const existingFor = (id: number | '') =>
        id === '' ? undefined : shares?.find(s => s.grantee_user === id && s.status !== 'revoked');

    return (
        <div
            className="share-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={`Share ${device.name}`}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
        >
            <div className="share-modal">
                <header className="share-modal-header">
                    <h2>Share “{device.name}”</h2>
                    <button className="share-modal-close" onClick={onClose} aria-label="Close">
                        <CloseIcon size={18} />
                    </button>
                </header>

                {error && <div className="device-error" role="alert">{error}</div>}

                <p className="share-modal-hint">
                    A friend you share this device with can reach it from any of their
                    devices, with exactly the access you choose — until you (or they)
                    revoke it. They have to accept first, and revoking cuts off any
                    session in progress immediately.
                </p>

                <section className="share-modal-section">
                    <h3>Who has access</h3>
                    {shares === null && <div className="share-modal-empty">Loading…</div>}
                    {shares?.length === 0 && (
                        <div className="share-modal-empty">Nobody — this device is not shared.</div>
                    )}
                    {shares?.map(s => {
                        const needsActivation = s.status === 'accepted' && !s.signed;
                        return (
                            <div key={s.id} className="share-row">
                                <div className="share-row-main">
                                    <strong>{s.grantee_username ?? `user ${s.grantee_user}`}</strong>
                                    <span className="share-row-caps">{capsLabel(s.capabilities)}</span>
                                    <span className={`share-row-status share-row-status-${s.status}${s.status === 'accepted' && s.signed ? '-live' : ''}`}>
                                        {statusLabel(s, onHost)}
                                    </span>
                                </div>
                                <div className="share-row-actions">
                                    {/* Only the shared device itself can sign, and only as a
                                        deliberate act showing who/what is being granted. */}
                                    {needsActivation && onHost && (
                                        <button
                                            className="device-btn device-btn-primary"
                                            disabled={busy}
                                            onClick={() => void activate(s)}
                                            title={`Grant ${s.grantee_username ?? 'this user'} ${capsLabel(s.capabilities)}`}
                                        >
                                            Confirm &amp; activate
                                        </button>
                                    )}
                                    <button
                                        className="device-btn device-btn-danger"
                                        disabled={busy}
                                        onClick={() => void revoke(s.id)}
                                    >
                                        Revoke
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </section>

                <section className="share-modal-section">
                    <h3>Share with a friend</h3>
                    <div className="share-form">
                        <label className="share-form-field">
                            Friend
                            <select
                                value={friendId}
                                onChange={e => setFriendId(e.target.value === '' ? '' : Number(e.target.value))}
                            >
                                <option value="">Choose a friend…</option>
                                {friends?.map(f => (
                                    <option key={f.id} value={f.id}>{f.username}</option>
                                ))}
                            </select>
                        </label>
                        <fieldset className="share-form-field share-form-radios">
                            <legend>Screen</legend>
                            <label>
                                <input
                                    type="radio" name="share-screen" value="control"
                                    checked={screen === 'control'}
                                    onChange={() => setScreen('control')}
                                />
                                Full control — see the screen, use mouse and keyboard
                            </label>
                            <label>
                                <input
                                    type="radio" name="share-screen" value="view_only"
                                    checked={screen === 'view_only'}
                                    onChange={() => setScreen('view_only')}
                                />
                                View only — see the screen, no input
                            </label>
                            <label>
                                <input
                                    type="radio" name="share-screen" value="none"
                                    checked={screen === 'none'}
                                    onChange={() => setScreen('none')}
                                />
                                No screen access
                            </label>
                        </fieldset>
                        <label className="share-form-field share-form-check">
                            <input
                                type="checkbox"
                                checked={files}
                                onChange={e => setFiles(e.target.checked)}
                            />
                            Files — browse this device's files
                        </label>
                        {existingFor(friendId) && (
                            <p className="share-modal-hint share-modal-hint-warn">
                                They already have an invite or access — sharing again replaces
                                it, and they must accept again.
                            </p>
                        )}
                        {!onHost && (
                            <p className="share-modal-hint">
                                You are inviting from a different device. After they accept,
                                open Puca on “{device.name}” and confirm the share there —
                                only that device can activate it.
                            </p>
                        )}
                        <button
                            className="device-btn device-btn-primary"
                            disabled={busy || friendId === ''}
                            onClick={() => void submit()}
                        >
                            {existingFor(friendId) ? 'Replace share' : 'Send invite'}
                        </button>
                    </div>
                </section>
            </div>
        </div>
    );
}
