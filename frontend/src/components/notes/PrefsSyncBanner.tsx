/**
 * What did NOT sync of the colours, labels and archive — said once, above
 * whichever grid the user is looking at. Shared chrome: Púca Notes shows it
 * over its note grid and Púca's Tasks view over its tab bar, because either
 * front door can write the document and so either can meet these states.
 * Quiet when everything is fine, and quiet for an old backend (colours and
 * labels then stay on this device, which is what they always did).
 */
import { WarningIcon } from '../Icons';
import { acceptServerNotesPrefs, overwriteServerNotesPrefs, type PrefsSyncStatus } from '../../notes/model/notesPrefsSync';

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
