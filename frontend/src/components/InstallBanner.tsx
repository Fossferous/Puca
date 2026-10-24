/**
 * "Install Púca" — the other half of the download page's "Install Púca as an app"
 * button (api/installPrompt.ts has the rules). Small, at the top, and only after
 * that button sent the visitor here: the tap on Install below is what calls the
 * browser's own install prompt. Never inside the desktop or Android app, never in
 * a window that is already an installed app, and gone for good once dismissed.
 */
import { useSyncExternalStore } from 'react';
import { dismissInstallBanner, getInstallState, runInstallPrompt, subscribeInstallState } from '../api/installPrompt';
import { CloseIcon, DownloadIcon } from './Icons';
import './InstallBanner.css';

export function InstallBanner() {
    const { visible } = useSyncExternalStore(subscribeInstallState, getInstallState, getInstallState);
    if (!visible) return null;
    return (
        <div className="install-banner" role="region" aria-label="Install Púca">
            <span className="install-banner-icon" aria-hidden="true"><DownloadIcon size={18} /></span>
            <div className="install-banner-text">
                <strong>Install Púca</strong>
                <span> as an app: its own window and icon.</span>
            </div>
            <button
                type="button"
                className="install-banner-action"
                data-testid="install-banner-install"
                onClick={() => { void runInstallPrompt(); }}
            >
                Install
            </button>
            <button
                type="button"
                className="install-banner-dismiss"
                data-testid="install-banner-dismiss"
                aria-label="Dismiss"
                onClick={() => dismissInstallBanner()}
            >
                <CloseIcon size={16} />
            </button>
        </div>
    );
}
