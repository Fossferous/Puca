import { useEffect, useState } from 'react';
import { activeSessions, endSession, subscribeSessions, type DeviceControlSession } from '../api/devices/session';
import { DeviceFileManager } from './DeviceFileManager';
import { DeviceDownloadStrip } from './DeviceDownloads';
import './DeviceFileBrowser.css';

/**
 * The file browser as its own surface, with no screen behind it.
 *
 * WHY THIS EXISTS SEPARATELY FROM DeviceStage. Browsing a device's files used to
 * require opening that device's SCREEN first: the only way in was a "Files"
 * button on the stage's top bar, so the picture had to be up before the file
 * panel could be. For the case the feature is most wanted for — reaching your
 * own machine that nobody is sitting at — that is backwards, and on a phone it
 * was impossible, because the whole bar holding that button is desktop-only.
 *
 * It turned out to be a mounting problem rather than a transport one. The `files`
 * data channel is created in the ordinary connect flow, independently of the
 * video track, and `DeviceFileManager` only ever needed a session id with that
 * channel open. So this claims the file-only sessions, mounts the same manager,
 * and never renders a video element. DeviceStage skips the same sessions.
 *
 * Reached from the device row in the Devices tab rather than from a session
 * toolbar, which is also what makes it work on a phone: that list already
 * renders there.
 */
export function DeviceFileBrowser() {
    const [sessions, setSessions] = useState<DeviceControlSession[]>(() => activeSessions());

    useEffect(() => subscribeSessions(setSessions), []);

    // Only the controller side, only file-only sessions, and only while live.
    // A host session shows its own indicator; the stage owns everything else.
    const session = sessions.find(
        s => s.role === 'controller' && s.filesOnly && s.phase !== 'ended',
    ) ?? null;

    if (!session) return null;

    const close = () => endSession(session.id, 'closed the file browser');

    return (
        <div className="device-file-browser" role="dialog" aria-modal="true" aria-label="Device files">
            <div className="dfb-panel">
                <div className="dfb-peer">
                    {session.phase === 'connecting'
                        ? `Connecting to ${session.peerDevice}…`
                        : session.peerDevice}
                </div>
                {session.error && <div className="dfb-error">{session.error}</div>}
                <DeviceFileManager sessionId={session.id} onClose={close} />
                {/* This panel is a full-viewport overlay ABOVE the app-wide
                    downloads tray (2050 vs 1500), so without this strip a
                    download started here shows no progress until the panel
                    closes. Docked under the listing, scoped to this session. */}
                <DeviceDownloadStrip sessionId={session.id} />
            </div>
        </div>
    );
}
