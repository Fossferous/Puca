/**
 * "Voice hotkeys can't reach <game>" — shown while the window in front
 * belongs to a process running above Púca's integrity level (launched "as
 * administrator"). Windows routes none of that window's input to a lower
 * process: not to our hooks, not to raw input, not to the key-state table.
 * No capture method works and nothing in this app can change that, so the
 * honest thing is to say so where the user will see it, with the two real
 * fixes.
 *
 * Driven by the native feed's `global-hotkey-blocked` event (src-tauri's
 * hotkeys.rs probes the foreground process once a second while the feed is
 * live), so it only ever appears in a call with system-wide hotkeys armed —
 * and the user sees it the moment they come back to Púca wondering why the
 * mic stayed shut.
 *
 * Dismissal is per process: "I know about this game" must not silence the
 * warning for a different one.
 */
import { useEffect, useState } from 'react';
import { captureBlocker, onCaptureBlockerChange } from '../api/hotkeys';
import { WarningIcon, CloseIcon } from './Icons';
import './HotkeyBlockedBanner.css';

export function HotkeyBlockedBanner() {
    const [process, setProcess] = useState(captureBlocker);
    const [dismissedFor, setDismissedFor] = useState('');

    useEffect(() => onCaptureBlockerChange(setProcess), []);

    if (!process || process === dismissedFor) return null;

    return (
        <div className="hotkey-blocked-banner" role="status">
            <span className="hotkey-blocked-icon"><WarningIcon /></span>
            <div className="hotkey-blocked-text">
                <strong>Voice hotkeys can't reach {process}.</strong>
                <span> It runs as administrator, so Windows hides its keys from Púca. Run {process} normally, or start Púca as administrator too.</span>
            </div>
            <button
                className="hotkey-blocked-dismiss"
                aria-label="Dismiss"
                onClick={() => setDismissedFor(process)}
            >
                <CloseIcon size={16} />
            </button>
        </div>
    );
}
