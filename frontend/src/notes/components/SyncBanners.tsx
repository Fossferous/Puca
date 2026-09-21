/**
 * The honest part of syncing: what did NOT sync, said once, in the grid's
 * status area (the same `.notes-status` bar the offline notice uses). Quiet
 * when everything is fine, and quiet for an old backend (colours and labels
 * then stay on this device, which is what they always did).
 */
import { WarningIcon } from '../../components/Icons';
import { acceptServerNotesPrefs, overwriteServerNotesPrefs, type PrefsSyncStatus } from '../model/notesPrefsSync';
import { useOutboxPending, useOutboxPendingMedia } from '../model/notesOutbox';
import '../sync.css';

export function PrefsSyncBanner({ status }: { status: PrefsSyncStatus }) {
    switch (status) {
        case 'too-large':
            return (
                <div className="notes-status error" role="status" data-sync="too-large">
                    <WarningIcon /> Your colours, labels and archive are too large to sync to your other devices. They are kept on this device; removing some labels will let them sync again.
                </div>
            );
        case 'unreadable':
            return (
                <div className="notes-status error" role="alert" data-sync="unreadable">
                    <WarningIcon /> The colours and labels saved to your account can’t be opened on this device (they were sealed by a different key).
                    <button type="button" onClick={overwriteServerNotesPrefs}>Use this device’s copy</button>
                </div>
            );
        case 'rollback':
            // Usually an operator restoring a backup. Without a way out every
            // device that saw a newer copy would stop syncing for good.
            return (
                <div className="notes-status error notes-status-choice" role="alert" data-sync="rollback">
                    <WarningIcon />
                    <span className="notes-status-text">
                        The server has an older copy of your colours, labels and archive than this device has already seen (a restored backup, perhaps), so it was not applied, and they are not syncing until you choose.
                        {' '}<em>Use the server’s copy</em> replaces this device’s with it; <em>Keep this device’s</em> replaces the server’s, on every device.
                    </span>
                    <span className="notes-status-actions">
                        <button type="button" data-action="accept-server" onClick={acceptServerNotesPrefs}>Use the server’s copy</button>
                        <button type="button" data-action="keep-mine" onClick={overwriteServerNotesPrefs}>Keep this device’s</button>
                    </span>
                </div>
            );
        default:
            return null;
    }
}

/** Edits made offline that have not reached the server yet. Pictures and
 *  files are named separately: they are the part that takes room on the
 *  device, and "3 changes" does not tell anyone a photo is still only here.
 *  "Or file", because a note holds any file now and the queue counts parked
 *  records, not their kind — calling a waiting PDF a picture would be a
 *  small lie in the one banner whose whole job is to be honest. */
export function OutboxBanner() {
    const pending = useOutboxPending();
    const media = useOutboxPendingMedia();
    if (pending === 0) return null;
    return (
        <div className="notes-status offline" role="status" data-sync="pending">
            <WarningIcon /> {pending} change{pending === 1 ? '' : 's'} not synced yet
            {media > 0 ? `, including ${media} picture${media === 1 ? '' : 's'} or file${media === 1 ? '' : 's'}` : ''}
            {' '}— kept on this device and sent when the connection is back.
        </div>
    );
}

/** The session ran out while the device was offline: Notes keeps showing
 *  what this device last saw instead of throwing the user out to a sign-in
 *  screen that cannot work without a connection. */
export function ExpiredOfflineBanner() {
    return (
        <div className="notes-status error" role="status" data-sync="expired-offline">
            <WarningIcon /> Your session has expired. You’re offline, so this is what this device last saw — sign in again when you’re back online to sync.
        </div>
    );
}
