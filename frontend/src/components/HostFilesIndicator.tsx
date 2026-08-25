/**
 * The kill switch a phone can actually reach.
 *
 * While a peer is browsing this device's files, the desktop shows that in the
 * TRAY — which a phone does not have. Without a visible hand on the lever, a
 * grant made in a ten-second prompt quietly outlives the person's attention:
 * the browsing continues until the session ends and nothing on screen says
 * so. This banner is mounted app-wide (next to the consent prompts, above
 * every view condition) and shows only while a HOST session actually holds a
 * live file grant; Stop runs the same `revokeAllFileAccess` the tray uses,
 * whose sticky flag also stops a re-ask from silently re-granting.
 *
 * Extended for cross-user shares: a FRIEND's session on this machine shows
 * the banner for its whole duration whatever kind it is — screen control,
 * view-only, or files — naming the person (server-stamped username, never a
 * device id). The tray covers same-account control on desktop; a friend
 * connected under a share must be visible on every platform, because the
 * owner may not be the one at the keyboard. Stop for a share session ends
 * the session outright rather than only revoking files.
 */
import { useEffect, useState } from 'react';
import { subscribeSessions, revokeAllFileAccess, endSession } from '../api/devices/session';
import { FolderIcon } from './Icons';
import './HostFilesIndicator.css';

interface Notice {
    sessionId: string;
    label: string;
    activity: string;
    /** A cross-user share session: Stop ends the whole session. */
    isShare: boolean;
}

export function HostFilesIndicator() {
    const [notice, setNotice] = useState<Notice | null>(null);

    useEffect(() => subscribeSessions(all => {
        // A share session is shown whatever it is doing; a same-account one
        // only while it holds a live file grant (the tray owns the rest).
        const hosting = all.find(
            s => s.role === 'host' && s.phase !== 'ended'
                && (s.shareUser !== null || s.fileScopeKind !== null),
        );
        if (!hosting) {
            setNotice(null);
            return;
        }
        const browsing = hosting.fileScopeKind !== null;
        const activity = hosting.filesOnly || (browsing && hosting.shareUser === null)
            ? "is browsing this device's files"
            : hosting.viewOnly
                ? `is viewing this screen${browsing ? ' and browsing files' : ''}`
                : `is controlling this device${browsing ? ' and browsing files' : ''}`;
        setNotice({
            sessionId: hosting.id,
            label: hosting.shareUser?.username ?? hosting.peerDevice,
            activity,
            isShare: hosting.shareUser !== null,
        });
    }), []);

    if (notice === null) return null;

    return (
        <div className="host-files-indicator" role="status">
            <span className="host-files-indicator-text">
                <FolderIcon /> <strong>{notice.label}</strong> {notice.activity}
            </span>
            <button
                type="button"
                className="host-files-indicator-stop"
                onClick={() => {
                    if (notice.isShare) {
                        endSession(notice.sessionId, 'the person at that device ended the session');
                    } else {
                        revokeAllFileAccess();
                    }
                }}
            >
                Stop
            </button>
        </div>
    );
}
