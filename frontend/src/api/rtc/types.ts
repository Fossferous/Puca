export type UserId = number;

import type { MediaCryptoState } from './mediaCrypto';
import type { ControlEphemeral } from '../e2ee';

/**
 * Why a peer's media is or isn't end-to-end encrypted. Drives the per-
 * participant lock/warning indicator in the voice UI so a downgrade (a peer
 * that can't do media E2EE, or a signalling server that stripped/altered the
 * capability) is visible instead of silent.
 */
export type MediaE2eeReason =
    | 'encrypted'          // active: frames are E2E encrypted with a verified peer
    | 'negotiating'        // handshake in flight; not yet decided
    | 'local-unsupported'  // THIS device/browser lacks insertable streams (e.g. iOS/Safari/Firefox)
    | 'peer-unsupported'   // the other peer didn't advertise media-E2EE capability
    | 'peer-unencrypted'   // SFU: participant PUBLISHED media not flagged E2EE (modified/foreign client) — refused, not rendered
    | 'verification-failed'  // peer advertised, but the tag didn't verify (possible tampering)
    | 'fingerprint-mismatch'; // the DTLS certificate the connection presents is not the one the peer pinned (a connection substituted on the path)

export interface MediaE2eeStatus {
    userId: UserId;
    encrypted: boolean;
    reason: MediaE2eeReason;
    /** Require-E2EE (fail-closed) is active: when true AND encrypted is false,
     *  this peer's media is BLOCKED (muted) rather than carried unencrypted. */
    enforced: boolean;
    /** Whether the DTLS certificate this connection presents is the one the
     *  peer pinned under the pairwise key: 'bound' (verified), 'unbound' (the
     *  peer's app predates the pin), 'mismatch' (substituted on the path), or
     *  'unverified' (our own key material not ready). Independent of frame
     *  encryption. Absent on the SFU tier, where the server terminates DTLS by
     *  design and frames carry the end-to-end guarantee instead. */
    dtls?: 'bound' | 'unbound' | 'mismatch' | 'unverified';
}

export interface PeerConnection {
    userId: UserId;
    connection: RTCPeerConnection;
    /** Random id minted with each RTCPeerConnection and sent in every
     *  offer/answer envelope. Lets the remote side detect that we REBUILT our
     *  pc (leave/rejoin, ICE-failure rebuild, stuck-pair recovery) and replace
     *  its own — applying a fresh pc's offer to a stale one throws the
     *  "m-lines order" InvalidAccessError and leaves the pair silent. */
    connId: string;
    /** Latest connId seen from the remote side (null until one arrives; stays
     *  null for old clients that don't send it). A DIFFERENT value on an
     *  incoming offer means they rebuilt → we tear down and answer fresh. */
    remoteConnId: string | null;
    remoteStream: MediaStream | null;
    /** Perfect-negotiation: true while we're creating/setting a local offer. */
    makingOffer: boolean;
    /** Perfect-negotiation: the polite peer yields (rolls back) on an offer
     *  collision; the impolite peer's offer wins. Fixed per peer by id order. */
    polite: boolean;
    /** Perfect-negotiation: set while we're applying a remote ANSWER, so a
     *  simultaneous incoming offer isn't mistaken for a collision. */
    isSettingRemoteAnswerPending: boolean;
    /** Perfect-negotiation: true when we (impolite) dropped the peer's colliding
     *  offer — its ICE candidates are then expected to fail and are swallowed. */
    ignoreOffer: boolean;
    /** Media-E2EE: mutable state shared with the frame transforms. The `key` is
     *  the forward-secret SESSION key, set only after a verified peer ephemeral. */
    mediaCrypto: MediaCryptoState;
    /** Peer's pinned (TOFU) identity public key — one half of the session-key DH. */
    mediaStaticPub: string | null;
    /** Static pairwise media key (identity DH), used only to MAC/verify the
     *  ephemeral-binding tag — NOT to encrypt frames. */
    mediaStaticKeyRaw: Uint8Array | null;
    /** Our per-connection media ephemeral keypair (provides forward secrecy). */
    mediaEph: ControlEphemeral | null;
    /** Our media-ready MAC over our own ephemeral — advertised in SDP. */
    mediaReadyTag: string | null;
    /** See MediaE2eeStatus.dtls. */
    dtlsPin: 'bound' | 'unbound' | 'mismatch' | 'unverified';
    /** Why media is / isn't E2E encrypted for this peer (drives the UI badge). */
    mediaE2eeReason: MediaE2eeReason;
}

export type RemoteStreamCallback = (userId: UserId, stream: MediaStream) => void;
/** `terminal` = we've given up on this peer (vs a transient ICE blip that
 *  routinely self-recovers). Only a terminal loss may tear down their tiles. */
export type PeerDisconnectedCallback = (userId: UserId, terminal: boolean) => void;
export type ConnectionStateCallback = (userId: UserId, state: RTCPeerConnectionState) => void;
