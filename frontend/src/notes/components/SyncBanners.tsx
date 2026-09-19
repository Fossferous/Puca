/**
 * The honest part of syncing: what did NOT sync, said once, in the grid's
 * status area (the same `.notes-status` bar the offline notice uses). Quiet
 * when everything is fine, and quiet for an old backend (colours and labels
 * then stay on this device, which is what they always did).
 */
import { WarningIcon } from '../../components/Icons';
import { overwriteServerNotesPrefs, type PrefsSyncStatus } from '../model/notesPrefsSync';

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
            return (
                <div className="notes-status error" role="alert" data-sync="rollback">
                    <WarningIcon /> The server offered an older copy of your colours and labels than this device has already seen, so it was not applied.
                </div>
            );
        default:
            return null;
    }
}
