/**
 * The honest part of syncing: what did NOT sync, said once, in the grid's
 * status area (the same `.notes-status` bar the offline notice uses). Quiet
 * when everything is fine.
 *
 * PrefsSyncBanner is shared chrome now — Púca's Tasks view meets the same
 * three states, because it writes the same document — so it lives in
 * components/notes/ and is re-exported here, leaving this the one place
 * Notes' shell imports its banners from.
 */
import { WarningIcon } from '../../components/Icons';
import { useOutboxPending, useOutboxPendingMedia } from '../model/notesOutbox';
import '../sync.css';

export { PrefsSyncBanner } from '../../components/notes/PrefsSyncBanner';

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
