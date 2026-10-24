/**
 * "Calls on this device are now end-to-end encrypted" — shown once, after
 * settingsStore's migrateRequireMediaE2eeStandardPath switched "Require
 * encryption for calls" on in a Firefox or Safari profile (the iPhone and
 * iPad Home Screen app included) where it was off.
 *
 * It was off there, mostly, because it had to be: before those browsers
 * could encrypt a mesh call, the setting on meant nobody could be heard. A
 * setting someone switched off on purpose is not switched back on silently,
 * so this says what changed, why, and where to change it back. It stays until
 * dismissed — on the next launch too — and never shows again after that.
 */
import { useState } from 'react';
import { callEncryptionNoticePending, dismissCallEncryptionNotice } from './settingsStore';
import { ShieldCheckIcon, CloseIcon } from './Icons';
import './CallEncryptionNotice.css';

export function CallEncryptionNotice() {
    const [pending, setPending] = useState(callEncryptionNoticePending);
    if (!pending) return null;
    const dismiss = () => {
        dismissCallEncryptionNotice();
        setPending(false);
    };
    return (
        <div className="call-encryption-notice" role="status">
            <span className="call-encryption-notice-icon"><ShieldCheckIcon /></span>
            <div className="call-encryption-notice-text">
                <strong>Calls on this device are now end-to-end encrypted,</strong>
                <span> so “Require encryption for calls” is on again. You can change it in Settings → Privacy &amp; Safety.</span>
            </div>
            <button className="call-encryption-notice-dismiss" aria-label="Dismiss" onClick={dismiss}>
                <CloseIcon size={16} />
            </button>
        </div>
    );
}
