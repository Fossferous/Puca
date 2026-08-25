/**
 * Human-readable explanations for media-E2EE downgrades, shown in the voice
 * panel's (i) tooltip. Kept pure (no React, no manager state) so the exact
 * user-facing wording is unit-testable.
 */
import type { MediaE2eeReason } from './types';

/**
 * Explain, in one sentence, why a peer's live media is not end-to-end
 * encrypted. `peerName` is the other participant's display name. `enforced` is
 * whether require-E2EE (fail-closed) is on — when true, the downgrade means the
 * peer's media is BLOCKED (muted), not merely carried over transport. Returns
 * null when the reason is `encrypted` (nothing to explain).
 */
export function mediaE2eeExplanation(reason: MediaE2eeReason, peerName: string, enforced = false): string | null {
    switch (reason) {
        case 'encrypted':
            return null;
        case 'negotiating':
            return `Setting up encryption with ${peerName}…`;
        case 'local-unsupported':
            return enforced
                ? `This device or browser can’t end-to-end encrypt live media (no WebRTC Encoded Transform API — e.g. Safari/iOS or Firefox). Because encryption is required for this call, media is blocked here. Use the desktop app.`
                : `This device or browser can’t end-to-end encrypt live media (it lacks the WebRTC Encoded Transform API — e.g. Safari/iOS or Firefox). Voice is still protected in transit (DTLS-SRTP), but the server could in principle access it.`;
        case 'peer-unsupported':
            return enforced
                ? `${peerName}’s app or device can’t end-to-end encrypt media. Because encryption is required for this call, their audio and video are blocked. Ask them to use the desktop app.`
                : `${peerName}’s app or device can’t end-to-end encrypt media, so this connection falls back to transport encryption only.`;
        case 'peer-unencrypted':
            // One wording regardless of `enforced`: the SFU receive path refuses
            // unencrypted publications unconditionally.
            return `${peerName} is sending media that isn’t end-to-end encrypted (an out-of-date or modified app). Their audio and video are blocked here.`;
        case 'verification-failed':
            return enforced
                ? `Couldn’t verify encryption with ${peerName} — the handshake didn’t check out (an out-of-date client, or something on the network altering the connection). Because encryption is required for this call, their media is blocked.`
                : `Couldn’t verify encryption with ${peerName} — the encryption handshake didn’t check out. This can mean an out-of-date client, or that something on the network altered the connection. Staying transport-only to be safe.`;
    }
}
