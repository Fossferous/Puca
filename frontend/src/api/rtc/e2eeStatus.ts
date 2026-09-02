/**
 * Human-readable explanations for media-E2EE downgrades, shown in the voice
 * panel's (i) tooltip. Kept pure (no React, no manager state) so the exact
 * user-facing wording is unit-testable.
 */
import type { MediaE2eeReason } from './types';

/** Which engines the mesh frame-encryption layer cannot run on: it uses the
 *  Chromium-only `createEncodedStreams`, so the standard `RTCRtpScriptTransform`
 *  engines (Firefox, Safari, iOS, the WebKit desktop shells) have no support. */
const NO_ENCODED_TRANSFORM = 'it has no WebRTC Encoded Transform API — Firefox, Safari and iOS';

/**
 * What a user on an unsupported engine can DO about it. Depends on who is
 * requiring encryption: a server policy leaves only the native apps, while the
 * user's own setting can be turned off — at the cost the sentence names, so
 * nobody flips it believing it merely "relaxes a check".
 */
function localUnsupportedRemedy(serverRequired: boolean): string {
    return serverRequired
        ? 'This server requires encrypted calls, so the way to join from here is the desktop or Android app.'
        : 'Use the desktop or Android app — or, to call from this browser anyway, turn off “Require encryption for calls” in Settings → Voice & Video; your voice and video then pass through the server in a form it can access.';
}

/**
 * Explain, in one sentence, why a peer's live media is not end-to-end
 * encrypted. `peerName` is the other participant's display name. `enforced` is
 * whether require-E2EE (fail-closed) is on — when true, the downgrade means the
 * peer's media is BLOCKED (muted), not merely carried over transport.
 * `serverRequired` says whether that enforcement is the SERVER's policy (the
 * user cannot turn it off) rather than their own setting. Returns null when the
 * reason is `encrypted` (nothing to explain).
 */
export function mediaE2eeExplanation(reason: MediaE2eeReason, peerName: string, enforced = false, serverRequired = false): string | null {
    switch (reason) {
        case 'encrypted':
            return null;
        case 'negotiating':
            return `Setting up encryption with ${peerName}…`;
        case 'local-unsupported':
            // Under enforcement the block is BOTH WAYS — the manager publishes
            // no local media and drops every inbound track — and it applies by
            // DEFAULT (requireMediaE2ee is on unless the user turned it off),
            // so a first-time Firefox/Safari user hits this with no idea why
            // nobody can hear them. Say exactly that, and exactly what changes it.
            return enforced
                ? `This device or browser can’t end-to-end encrypt live media (${NO_ENCODED_TRANSFORM}). Because encryption is required for this call, media is blocked both ways here: your microphone and camera are not sent, and nobody’s voice or video plays. ${localUnsupportedRemedy(serverRequired)}`
                : `This device or browser can’t end-to-end encrypt live media (${NO_ENCODED_TRANSFORM}). Voice is still protected in transit (DTLS-SRTP), but the server could in principle access it.`;
        case 'peer-unsupported':
            return enforced
                ? `${peerName}’s app or device can’t end-to-end encrypt media. Because encryption is required for this call, their audio and video are blocked. Ask them to use the desktop app.`
                : `${peerName}’s app or device can’t end-to-end encrypt media, so this connection falls back to transport encryption only.`;
        case 'peer-unencrypted':
            // One wording regardless of `enforced`: the SFU receive path refuses
            // unencrypted publications unconditionally.
            return `${peerName} is sending media that isn’t end-to-end encrypted (an out-of-date or modified app). Their audio and video are blocked here.`;
        case 'fingerprint-mismatch':
            return enforced
                ? `The connection to ${peerName} is not the one their app authenticated — something on the path substituted it. Because encryption is required for this call, their media is blocked.`
                : `The connection to ${peerName} is not the one their app authenticated — something on the path substituted it. Media is flowing over that connection; treat this call as not private.`;
        case 'verification-failed':
            return enforced
                ? `Couldn’t verify encryption with ${peerName} — the handshake didn’t check out (an out-of-date client, or something on the network altering the connection). Because encryption is required for this call, their media is blocked.`
                : `Couldn’t verify encryption with ${peerName} — the encryption handshake didn’t check out. This can mean an out-of-date client, or that something on the network altered the connection. Staying transport-only to be safe.`;
    }
}

export interface LocalMediaBlockInputs {
    /** Can THIS engine encrypt live media on the transport in use? Mesh:
     *  isMediaE2eeSupported(); SFU: livekit's probe (which also accepts the
     *  standard RTCRtpScriptTransform, so Firefox and Safari pass there). */
    supported: boolean;
    /** Is fail-closed enforcement on — the user's setting OR the server's? */
    required: boolean;
    /** Is it the SERVER requiring it (the user cannot turn it off)? */
    serverRequired: boolean;
    /** SFU channel: encrypted-only by construction; the join THROWS. */
    sfuMode: boolean;
}

/**
 * The notice to show BEFORE joining (and to keep showing while joined) when
 * this engine cannot satisfy the encryption that is required — or null when
 * nothing is blocked. Visible text, not a tooltip: the hover popup on the
 * E2EE badge only mounts once a peer is present, and nothing warned a user
 * on Firefox or Safari that pressing Join would put them in a call where
 * nobody can hear them.
 */
export function localMediaBlockNotice(i: LocalMediaBlockInputs): string | null {
    if (i.supported) return null;
    if (i.sfuMode) {
        return 'Calls in this channel are encrypted-only, and this browser can’t encrypt live media (no WebRTC Encoded Transform API). Joining will fail here — use the desktop or Android app.';
    }
    if (!i.required) return null;
    return `Voice is blocked in this browser: it can’t end-to-end encrypt live media (${NO_ENCODED_TRANSFORM}), and encryption is required for calls. If you join, your microphone and camera are not sent and nobody’s voice or video plays. ${localUnsupportedRemedy(i.serverRequired)}`;
}
