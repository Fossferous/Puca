/**
 * Human-readable explanations for media-E2EE downgrades, shown in the voice
 * panel's (i) tooltip. Kept pure (no React, no manager state) so the exact
 * user-facing wording is unit-testable.
 */
import type { MediaE2eeReason } from './types';

/** Which engines the frame-encryption layer cannot run on. Mesh calls take
 *  either Chromium's `createEncodedStreams` or the standard
 *  `RTCRtpScriptTransform` (Firefox 117+, Safari and iOS 15.4+ — mediaCrypto.ts
 *  mediaTransformApi), and the SFU's probe accepts the same two, so what is
 *  left is an older browser, or a web view built into some other app that
 *  offers neither. ("Can't run" rather than "has no": a browser whose
 *  transform worker would not start lands here too.) */
const NO_ENCODED_TRANSFORM = 'it can’t run the WebRTC Encoded Transform API — an older browser version, or a web view built into another app';

/**
 * What a user on an unsupported engine can DO about it. Depends on who is
 * requiring encryption: a server policy leaves only another client, while the
 * user's own setting can be turned off — at the cost the sentence names, so
 * nobody flips it believing it merely "relaxes a check".
 *
 * TWO THINGS THIS SENTENCE MUST GET RIGHT, because it is the only instruction
 * the user gets. The toggle lives in Settings → Privacy & Safety (its "Call
 * Encryption" block), NOT Voice & Video — sending someone to the wrong tab to
 * find a switch that is not there reads as the switch being gone. And the
 * remedy names WINDOWS, not "desktop": the macOS and Linux shells embed
 * WebKit, and whether theirs runs the API depends on the system's WebKit, so
 * "use the desktop app" may send a Linux user to the same failure. What every
 * user CAN do is open a current mainstream browser — all four run one of the
 * two APIs — so the remedy names those first, before the native apps.
 */
const ENCRYPTING_CLIENTS = 'an up-to-date Chrome, Edge, Firefox or Safari, or the Windows or Android app';

function localUnsupportedRemedy(serverRequired: boolean): string {
    return serverRequired
        ? `This server requires encrypted calls, so join from ${ENCRYPTING_CLIENTS}.`
        : `Use ${ENCRYPTING_CLIENTS} — or, to call from this browser anyway, turn off “Require encryption for calls” in Settings → Privacy & Safety; your voice and video then pass through the server in a form it can access.`;
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
            // so a first-time user of an older browser hits this with no idea
            // why nobody can hear them. Say exactly that, and exactly what
            // changes it.
            return enforced
                ? `This device or browser can’t end-to-end encrypt live media (${NO_ENCODED_TRANSFORM}). Because encryption is required for this call, media is blocked both ways here: your microphone, camera and screen share are not sent, and nobody’s voice or video plays. ${localUnsupportedRemedy(serverRequired)}`
                : `This device or browser can’t end-to-end encrypt live media (${NO_ENCODED_TRANSFORM}). Voice is still protected in transit (DTLS-SRTP), but the server could in principle access it.`;
        case 'peer-unsupported':
            return enforced
                ? `${peerName}’s app or device can’t end-to-end encrypt media. Because encryption is required for this call, their audio and video are blocked. Ask them to update Púca or their browser.`
                : `${peerName}’s app or device can’t end-to-end encrypt media, so this connection falls back to transport encryption only.`;
        case 'peer-unencrypted':
            // One wording regardless of `enforced`: the SFU receive path refuses
            // unencrypted publications unconditionally.
            return `${peerName} is sending media that isn’t end-to-end encrypted (an out-of-date or modified app). Their audio and video are blocked here.`;
        case 'fingerprint-mismatch':
            // One wording regardless of `enforced`: nothing goes to a
            // substituted connection or plays from it either way
            // (manager.ts holdMediaWith).
            return `The connection to ${peerName} is not the one their app authenticated — something on the path substituted it. Nothing is sent to them or played from them over it.`;
        case 'verification-failed':
            return enforced
                ? `Couldn’t verify encryption with ${peerName} — the handshake didn’t check out (an out-of-date client, or something on the network altering the connection). Because encryption is required for this call, their media is blocked.`
                : `Couldn’t verify encryption with ${peerName} — the encryption handshake didn’t check out. This can mean an out-of-date client, or that something on the network altered the connection. Staying transport-only to be safe.`;
    }
}

export interface LocalMediaBlockInputs {
    /** Can THIS engine encrypt live media on the transport in use? Mesh:
     *  isMediaE2eeSupported(); SFU: livekit's probe. Both accept Chromium's
     *  createEncodedStreams and the standard RTCRtpScriptTransform, so
     *  Firefox and Safari pass on either. */
    supported: boolean;
    /** Is fail-closed enforcement on — the user's setting OR the server's? */
    required: boolean;
    /** Is it the SERVER requiring it (the user cannot turn it off)? */
    serverRequired: boolean;
    /** SFU channel: encrypted-only by construction; the join THROWS. */
    sfuMode: boolean;
}

/**
 * The notice to show BEFORE joining (and to keep showing while joined), with
 * its severity. Visible text, not a tooltip: the hover popup on the E2EE badge
 * only mounts once a peer is present, and nothing warned a user on an engine
 * that cannot encrypt that pressing Join would put them in a call where
 * nobody can hear them.
 *
 *  - `blocked`: joining puts the user in a call where nothing plays (or, on
 *    an SFU channel, the join refuses). Opening the channel must not
 *    auto-join into that; a deliberate press of Join still may.
 *  - `warning`: the call goes ahead, transport-only — the user turned
 *    enforcement off on an engine that cannot encrypt.
 *  - null: nothing to say.
 */
export type LocalMediaNoticeLevel = 'blocked' | 'warning';

export function localMediaNotice(i: LocalMediaBlockInputs): { level: LocalMediaNoticeLevel; text: string } | null {
    if (i.supported) return null;
    if (i.sfuMode) {
        return {
            level: 'blocked',
            text: `Calls in this channel are encrypted-only, and this browser can’t encrypt live media (no WebRTC Encoded Transform API). Joining will fail here — use ${ENCRYPTING_CLIENTS}.`,
        };
    }
    if (!i.required) {
        // The user turned enforcement off on an engine that cannot encrypt.
        // Their choice — but said once, in plain sight, before Join, so "not
        // required" is never mistaken for "encrypted anyway".
        return {
            level: 'warning',
            text: `This call will not be end-to-end encrypted: this browser can’t encrypt live media (${NO_ENCODED_TRANSFORM}), and “Require encryption for calls” is off, so your voice and video pass through the server in a form it can access. For an encrypted call, use ${ENCRYPTING_CLIENTS}.`,
        };
    }
    return {
        level: 'blocked',
        text: `Voice is blocked in this browser: it can’t end-to-end encrypt live media (${NO_ENCODED_TRANSFORM}), and encryption is required for calls. If you join, your microphone, camera and screen share are not sent and nobody’s voice or video plays. ${localUnsupportedRemedy(i.serverRequired)}`,
    };
}

/** The blocking cases of `localMediaNotice`, as text; null when the call may
 *  go ahead (including the transport-only warning, which does not block). */
export function localMediaBlockNotice(i: LocalMediaBlockInputs): string | null {
    const n = localMediaNotice(i);
    return n && n.level === 'blocked' ? n.text : null;
}
