import { wsClient } from '../websocket';
import { getRtcConfigAsync } from './config';
import {
    CTL_STATE_LABEL, forgetControlChannels, registerControlChannel,
} from './controlDc';
import { withRelayOnlyIfRequested } from '../iceConfig';
import { MediaManager } from './media';
import { getActiveIdentity, deriveMediaKey, mediaReadyTag, deriveMediaSessionKey, generateControlEphemeral } from '../e2ee';
import { resolvePinnedIdentityKey } from '../keyVerification';
import { registerScreenReceiver } from './receiverLatency';
import { AnnouncedVideoGate } from './announcedVideo';

export { classifyRemoteVideo } from './announcedVideo';
import {
    isMediaE2eeSupported,
    importMediaKey,
    attachSenderTransform,
    attachReceiverTransform,
    advertiseE2ee,
    extractE2ee,
    type MediaCryptoState,
    type RemoteMediaCap,
    advertiseDtlsPin, verifyDtlsPin,
} from './mediaCrypto';
import type {
    UserId,
    PeerConnection,
    RemoteStreamCallback,
    PeerDisconnectedCallback,
    ConnectionStateCallback,
    MediaE2eeReason,
    MediaE2eeStatus,
} from './types';

/** Offer/answer travel as an opaque JSON string relayed by the server; these
 *  extra fields ride alongside the SDP. Old clients ignore them (dictionary
 *  conversion drops unknown members), so the envelope stays interoperable. */
type SignalEnvelope = RTCSessionDescriptionInit & {
    /** Sender's per-RTCPeerConnection id (see PeerConnection.connId). */
    connId?: string;
    /** On answers: the connId of the pc whose offer this answers, so a late
     *  answer aimed at a pc we've since replaced is dropped, not applied. */
    answerTo?: string;
};

/** Random per-pc id. randomUUID needs a secure context — every real target
 *  (https prod, Tauri, Capacitor) is one, but keep a fallback for dev. */
function newConnId(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export class WebRTCManager {
    public media: MediaManager;
    private peers: Map<UserId, PeerConnection> = new Map();
    // In-flight peer builds, keyed by userId. getOrCreatePeer awaits the ICE
    // config (a real async gap) BEFORE it inserts into `peers`, so two callers
    // for the same user (a callUser racing an incoming offer, or doubled
    // StreamStarted handlers on a reconnect storm) could each build a separate
    // RTCPeerConnection and the second `peers.set` would orphan the first —
    // which keeps running its per-frame media-E2EE encrypt transform forever
    // (a monotonic CPU leak over a long call). This map makes creation atomic:
    // concurrent callers share ONE in-flight build.
    private peerCreation: Map<UserId, Promise<RTCPeerConnection>> = new Map();
    // Serializes live noise-mode swaps (see reapplyNoiseMode).
    private noiseSwapChain: Promise<void> = Promise.resolve();
    private onRemoteStream: RemoteStreamCallback | null = null;
    private onPeerDisconnected: PeerDisconnectedCallback | null = null;
    private onConnectionStateChange: ConnectionStateCallback | null = null;
    private pendingCandidates: Map<UserId, RTCIceCandidateInit[]> = new Map();
    // Per-peer signaling queue: serializes setRemoteDescription/answer so two
    // descriptions arriving back-to-back can't interleave their state changes.
    private signalingChains: Map<UserId, Promise<void>> = new Map();
    private onScreenShareStream: RemoteStreamCallback | null = null;
    private onCameraStream: RemoteStreamCallback | null = null;
    // Fired when the share ends on its own (shared window closed, or the
    // captured game exited) so the UI can run its full stop flow (WS
    // broadcast + state), not just tear down media.
    private onScreenShareEnded: (() => void) | null = null;

    // Reconnection state
    private reconnectAttempts: Map<UserId, number> = new Map();
    private reconnectTimeouts: Map<UserId, number> = new Map();
    // Pending "stuck pair" recovery checks, keyed by userId (see
    // scheduleStuckPeerRecovery) — deduped so a burst of failures schedules one.
    private stuckRecoveryTimers: Map<UserId, number> = new Map();
    // Consecutive stuck-pair rebuilds per user since the last healthy signal
    // (a successfully applied description, or 'connected'). Caps the
    // rebuild→re-offer cycle so a dead or hopelessly-incompatible peer can't
    // drive it forever.
    private stuckRebuilds: Map<UserId, number> = new Map();
    private readonly MAX_STUCK_REBUILDS = 4;
    // Per-user teardown generation, bumped by every teardownPeer. An in-flight
    // getOrCreatePeer build captures it at start and re-checks after its
    // awaits: a bump means this peer was torn down mid-build (leave, connId
    // rebuild, recovery), so the build must self-abort instead of resurrecting
    // the peer — the voiceEpoch guard alone can't see per-peer teardowns.
    private peerGeneration: Map<UserId, number> = new Map();
    private readonly MAX_RECONNECT_ATTEMPTS = 3;
    private onReconnecting: ((userId: UserId, attempt: number) => void) | null = null;

    /** Users the WS says are screen-sharing right now. Authoritative for
     *  classifying an incoming video track when the peer sends no audio (a
     *  listen-only sender never pins a "voice stream"). */
    /** Which peers the server has announced as sharing / on camera, plus any
     *  video that arrived ahead of its announcement. Mesh receivers render
     *  only announced video (B7): the VIDEO/STREAM bits are enforced on the
     *  announcement, so a track with none behind it is held, never shown. */
    private videoGate = new AnnouncedVideoGate<{ stream: MediaStream; receiver: RTCRtpReceiver }>();

    /** Our own user id — set on joining voice. Used for deterministic
     *  perfect-negotiation politeness (higher id = polite = yields on glare). */
    private localUserId: UserId | null = null;
    /** True between joining and leaving a voice channel. Incoming descriptions
     *  are dropped when false so a description relayed just after we left can't
     *  fabricate a peer + re-acquire the mic. */
    private inVoice = false;
    /** Bumped on every closeAll — a queued description captured before we left
     *  re-checks this after its awaits and aborts instead of resurrecting a peer
     *  (clearing signalingChains can't detach an already-scheduled .then). */
    private voiceEpoch = 0;

    // Media-E2EE: senders/receivers we've already attached a frame transform to
    // (createEncodedStreams may only be called once each).
    private transformedSenders = new WeakSet<RTCRtpSender>();
    private transformedReceivers = new WeakSet<RTCRtpReceiver>();

    /** Prepare this peer's media-E2EE material: resolve their pinned identity key,
     *  derive the static pairwise key (used only to MAC the ephemeral), generate
     *  our per-call ephemeral, and compute the tag we advertise. The frame key
     *  itself is derived later, once we've verified the peer's ephemeral (see
     *  enableMediaWithRemote). Best-effort — any failure leaves media transport-only. */
    private async setupMediaKey(userId: UserId): Promise<void> {
        const existing = this.peers.get(userId);
        if (!existing) return;
        // The pairwise key is derived on EVERY engine: it pins the DTLS certificate
        // (advertiseDtlsPin) whether or not frames can be encrypted here. The
        // ephemeral and the media-ready tag only exist where they can.
        const wantFrames = isMediaE2eeSupported();
        if (existing.mediaStaticKeyRaw && (!wantFrames || existing.mediaReadyTag)) return; // already set up
        try {
            const identity = getActiveIdentity();
            // TOFU-pinned key (fails closed if the server swapped it since first use).
            const pub = identity ? await resolvePinnedIdentityKey(userId) : null;
            const raw = identity && pub ? deriveMediaKey(identity, pub) : null;
            const peer = this.peers.get(userId);
            if (!raw || !pub || !peer) return;
            peer.mediaStaticPub = pub;
            peer.mediaStaticKeyRaw = raw;
            if (!wantFrames) return;
            if (!peer.mediaEph) peer.mediaEph = generateControlEphemeral(); // per-connection, in-memory only
            // Tag binds OUR ephemeral under the static key; advertising it proves we
            // hold the identity key AND lets the peer detect a tampered ephemeral.
            peer.mediaReadyTag = mediaReadyTag(raw, peer.mediaEph.pubEncoded);
        } catch (e) {
            console.warn('[media-e2ee] key setup failed (staying transport-only):', e);
        }
    }

    /**
     * Verify the DTLS pin in a remote description against the fingerprint it
     * presents. 'unbound' (an older peer) keeps today's behaviour; 'mismatch'
     * is a connection substituted on the path and is remembered on the peer
     * so enableMediaWithRemote never enables over it.
     */
    private verifyRemoteDtls(userId: UserId, sdp: string): void {
        const peer = this.peers.get(userId);
        if (!peer) return;
        // Latched for the life of the peer: a later description that merely
        // drops the attribute must not clear a substitution already seen.
        if (peer.dtlsPin === 'mismatch') return;
        if (!peer.mediaStaticKeyRaw) { peer.dtlsPin = 'unverified'; return; }
        const result = verifyDtlsPin(sdp, peer.mediaStaticKeyRaw);
        if (result === 'mismatch') { // first sighting: the latch above returns on every later call
            console.warn(`[media-e2ee] peer ${userId}: the DTLS fingerprint in the description does not match the pin — connection substituted on the path`);
        }
        peer.dtlsPin = result;
        if (result === 'mismatch') {
            peer.mediaCrypto.enabled = false;
            peer.mediaCrypto.key = null;
            peer.mediaE2eeReason = 'fingerprint-mismatch';
            this.emitMediaE2ee(userId);
        }
    }

    /** Whether media E2EE is actually active for a peer (exposed so the UI can
     *  show it — a downgrade by a malicious server is then observable). */
    isMediaEncrypted(userId: UserId): boolean {
        return this.peers.get(userId)?.mediaCrypto.enabled ?? false;
    }

    /** Per-peer media-E2EE status + the REASON, so the voice UI can show a
     *  lock/warning and explain a downgrade (peer can't do it, our device
     *  can't, or the capability failed to verify). */
    mediaE2eeStatus(userId: UserId): MediaE2eeStatus | null {
        const peer = this.peers.get(userId);
        if (!peer) return null;
        // A local inability to do insertable streams overrides everything —
        // no peer can be encrypted if we can't run the transforms at all —
        // EXCEPT a substituted connection: the DTLS pin exists precisely for
        // the engines without frame encryption, so a mismatch must outrank
        // "this device can't encrypt" or it would be invisible where it matters.
        const reason: MediaE2eeReason = peer.dtlsPin === 'mismatch'
            ? 'fingerprint-mismatch'
            : !isMediaE2eeSupported()
                ? 'local-unsupported'
                : peer.mediaE2eeReason;
        return { userId, encrypted: peer.mediaCrypto.enabled, reason, enforced: this.requireMediaE2ee, dtls: peer.dtlsPin };
    }

    /** Fail-closed enforcement: when on, media is exchanged only with peers
     *  where E2EE is active; others are muted. Applies live to current peers. */
    private requireMediaE2ee = false;
    setRequireMediaE2ee(enabled: boolean): void {
        if (this.requireMediaE2ee === enabled) return;
        this.requireMediaE2ee = enabled;
        for (const [userId, peer] of this.peers) {
            peer.mediaCrypto.requireE2ee = enabled;
            this.emitMediaE2ee(userId);
        }
    }
    isRequireMediaE2ee(): boolean { return this.requireMediaE2ee; }

    /** Per-peer media-E2EE status for every current peer (drives the detailed
     *  "why is this downgraded" breakdown in the voice UI). */
    allMediaE2eeStatuses(): MediaE2eeStatus[] {
        const out: MediaE2eeStatus[] = [];
        for (const [userId] of this.peers) {
            const s = this.mediaE2eeStatus(userId);
            if (s) out.push(s);
        }
        return out;
    }

    /** Aggregate media-E2EE status across all peers, for a call-wide indicator.
     *  supported=false ⇒ this browser can't do media E2EE at all (e.g. iOS).
     *  enforced=true ⇒ require-E2EE is on, so unencrypted peers are muted. */
    mediaEncryptionSummary(): { total: number; encrypted: number; supported: boolean; enforced: boolean } {
        let total = 0, encrypted = 0;
        for (const [, peer] of this.peers) {
            total++;
            if (peer.mediaCrypto.enabled) encrypted++;
        }
        return { total, encrypted, supported: isMediaE2eeSupported(), enforced: this.requireMediaE2ee };
    }

    /** Notify the UI whenever a peer's media-E2EE status changes. */
    private onMediaE2eeChange: ((status: MediaE2eeStatus) => void) | null = null;
    setOnMediaE2eeChange(cb: (status: MediaE2eeStatus) => void) { this.onMediaE2eeChange = cb; }
    private emitMediaE2ee(userId: UserId): void {
        const s = this.mediaE2eeStatus(userId);
        if (s) this.onMediaE2eeChange?.(s);
    }

    /**
     * Verify the peer's advertised capability and, if it checks out, derive the
     * forward-secret session key and turn encryption on. The tag must equal the
     * MAC of the received ephemeral under our static pairwise key — so a server
     * that tampers with (or strips) the ephemeral fails verification and we stay
     * transport-only (never a mismatched key that would corrupt media). The
     * session key = HKDF(ephemeral-DH ‖ static-DH): the static half preserves
     * confidentiality even under tampering, the ephemeral half gives forward
     * secrecy against a later identity-key compromise.
     */
    private async enableMediaWithRemote(userId: UserId, remote: RemoteMediaCap | null): Promise<void> {
        const peer = this.peers.get(userId);
        if (!peer) return;
        if (peer.dtlsPin === 'mismatch') {
            // Never derive a session key over a connection that is not the one
            // the peer authenticated. Under enforcement every frame is dropped
            // (mediaCrypto fails closed on enabled=false); without it the status
            // says loudly that this call is not private.
            peer.mediaCrypto.enabled = false;
            peer.mediaCrypto.key = null;
            peer.mediaE2eeReason = 'fingerprint-mismatch';
            this.emitMediaE2ee(userId);
            return;
        }
        // The peer never advertised a media-E2EE capability → it can't decrypt
        // our frames, so we stay transport-only. Distinguish "peer can't" from
        // "we can't": if OUR own key material is missing while we DO support
        // insertable streams, that's a transient negotiating state.
        if (!remote) {
            peer.mediaE2eeReason = isMediaE2eeSupported() ? 'peer-unsupported' : 'local-unsupported';
            this.emitMediaE2ee(userId);
            return;
        }
        if (!peer.mediaStaticKeyRaw || !peer.mediaEph || !peer.mediaStaticPub) {
            // Our pairwise key isn't ready yet — handshake still settling.
            if (!peer.mediaCrypto.enabled) { peer.mediaE2eeReason = 'negotiating'; this.emitMediaE2ee(userId); }
            return;
        }
        const expected = mediaReadyTag(peer.mediaStaticKeyRaw, remote.ephemeralPubEncoded);
        if (remote.tag !== expected) {
            // Peer advertised, but the tag doesn't verify against the ephemeral —
            // a signalling server may have stripped/substituted it. Fail closed
            // (transport-only) AND flag it loudly for the user.
            console.warn(`[media-e2ee] peer ${userId} tag/ephemeral mismatch — staying transport-only`);
            peer.mediaE2eeReason = 'verification-failed';
            this.emitMediaE2ee(userId);
            return;
        }
        const identity = getActiveIdentity();
        if (!identity) { peer.mediaE2eeReason = 'negotiating'; this.emitMediaE2ee(userId); return; }
        const sessionRaw = deriveMediaSessionKey(
            identity.privateKey, peer.mediaStaticPub, peer.mediaEph.priv, remote.ephemeralPubEncoded,
        );
        if (!sessionRaw) { peer.mediaE2eeReason = 'verification-failed'; this.emitMediaE2ee(userId); return; }
        peer.mediaCrypto.key = await importMediaKey(sessionRaw);
        if (!peer.mediaCrypto.enabled) {
            peer.mediaCrypto.enabled = true;
            peer.mediaE2eeReason = 'encrypted';
            console.log(`[media-e2ee] ENABLED (forward-secret session key) for peer ${userId}`);
            this.emitMediaE2ee(userId);
        }
    }

    /** Attach the encrypt transform to a sender we haven't wired yet. */
    private wireSender(userId: UserId, sender: RTCRtpSender): void {
        if (!isMediaE2eeSupported() || this.transformedSenders.has(sender)) return;
        const peer = this.peers.get(userId);
        if (!peer) return;
        this.transformedSenders.add(sender);
        attachSenderTransform(sender, peer.mediaCrypto);
    }

    constructor() {
        this.media = new MediaManager();
        this.setupSignalingHandlers();
    }

    setLocalUserId(id: UserId) {
        this.localUserId = id;
        this.inVoice = true;
    }

    /** The "polite" peer rolls back on an offer collision; the "impolite" peer
     *  ignores the colliding offer. Deterministic tie-break by user id so both
     *  sides always agree on who yields. Defaults to polite if id unknown. */
    private isPolite(remote: UserId): boolean {
        return this.localUserId === null ? true : this.localUserId > remote;
    }

    /** Perfect-negotiation offer, driven by `onnegotiationneeded`. Uses the
     *  arg-less setLocalDescription (implicit createOffer) and the `makingOffer`
     *  flag so a simultaneous incoming offer is resolved by the collision logic
     *  in handleIncomingDescription rather than by bailing (which used to just
     *  drop a needed renegotiation and lose late-added tracks).
     *
     *  Runs ONLY as a task on the per-peer signaling chain (see the
     *  onnegotiationneeded wiring), serialized with incoming descriptions.
     *  Unserialized, it interleaved with the incoming-offer handler and its
     *  arg-less setLocalDescription executed in 'have-remote-offer' — minting
     *  an ANSWER that shipped in an offer envelope, whose chain of confusions
     *  ended in a duplicate answer, an InvalidStateError on the remote, and a
     *  forced rebuild of a healthy call (reproduced by
     *  e2e/perfect-negotiation-2peer.mjs). */
    private async makeOffer(userId: UserId, pc: RTCPeerConnection): Promise<void> {
        const peer = this.peers.get(userId);
        // Torn down or rebuilt while this task waited in the queue.
        if (!peer || peer.connection !== pc) return;
        // Ensure our media-ready tag exists BEFORE flagging makingOffer, so the
        // glare window (during which the impolite peer ignores incoming offers)
        // is only the actual setLocalDescription, not the crypto setup.
        await this.setupMediaKey(userId);
        // Offer only from 'stable'. Anything else means an outstanding
        // negotiation (our un-answered offer, a wedge, or a close mid-await) —
        // an arg-less setLocalDescription there would NOT create the offer we
        // mean to send. Bailing is lossless: when the pc returns to stable the
        // browser re-evaluates the negotiation-needed flag and re-fires
        // onnegotiationneeded if tracks still need negotiating.
        if (pc.signalingState !== 'stable') return;
        try {
            await this.setupMediaKey(userId); // the DTLS pin (and media tag) ride the offer
            peer.makingOffer = true;
            await pc.setLocalDescription(); // implicit offer; safe under glare
            // The peer may have been REPLACED while we awaited (connId rebuild,
            // recovery): an offer minted on a superseded pc must not hit the
            // wire — the remote would commit to a dead session.
            if (this.peers.get(userId)?.connection !== pc) return;
            const local = pc.localDescription;
            if (!local) return;
            // Tripwire: everything above should make a non-offer impossible,
            // but shipping one would poison the remote's signaling state — the
            // failure mode this function is guarded against. Never send it.
            if (local.type !== 'offer') {
                console.warn(`[WebRTC] implicit local description for ${userId} is a ${local.type}, not an offer — not sending`);
                return;
            }
            // Advertise the media-E2EE tag in the SDP we SEND (munging the string,
            // not the local description — some stacks strip unknown attributes).
            const sdp = advertiseDtlsPin(advertiseE2ee(local.sdp, peer.mediaReadyTag, peer.mediaEph?.pubEncoded ?? null), peer.mediaStaticKeyRaw);
            console.log(`[WebRTC] offer -> ${userId} connId=${peer.connId.slice(0, 8)} mlines=${(sdp.match(/^m=/gm) ?? []).length}`);
            wsClient.sendOffer(userId, JSON.stringify({ type: local.type, sdp, connId: peer.connId }));
            // Offerer-side watchdog: if no answer ever lands (peer wedged
            // stable-but-deaf on an old client, offer lost in a WS flap, peer
            // gone), this pc sits in have-local-offer with ICE never starting —
            // no failure event will fire on its own. The soft check bails once
            // we reach 'stable' (i.e. the answer arrived in time).
            this.scheduleStuckPeerRecovery(userId);
        } catch (e) {
            console.error('[WebRTC] makeOffer failed:', e);
        } finally {
            peer.makingOffer = false;
        }
    }

    private setupSignalingHandlers() {
        // Both offers and answers go through one perfect-negotiation handler
        // (the SDP's own `type` field distinguishes them). Serialized per peer
        // so two descriptions can't interleave their state transitions.
        wsClient.on('Offer', (msg) => {
            const payload = msg.payload as { from_user: UserId; sdp: string };
            this.enqueueDescription(payload.from_user, payload.sdp);
        });

        wsClient.on('Answer', (msg) => {
            const payload = msg.payload as { from_user: UserId; sdp: string };
            this.enqueueDescription(payload.from_user, payload.sdp);
        });

        wsClient.on('IceCandidate', (msg) => {
            const payload = msg.payload as { from_user: UserId; candidate: string };
            this.handleIncomingIceCandidate(payload.from_user, payload.candidate);
        });
    }

    // ================== Delegate methods to MediaManager ==================

    getVideoStreamForPreview() {
        return this.media.getLocalStreamSync();
    }

    getCameraStream() {
        const stream = this.media.getLocalStreamSync();
        if (stream && stream.getVideoTracks().length > 0) {
            return stream;
        }
        return null;
    }

    getScreenShareStreamForPreview() {
        return this.media.getScreenShareStreamSync();
    }

    getVideoStream() {
        const stream = this.media.getLocalStreamSync();
        if (!stream) return null;
        const tracks = stream.getVideoTracks();
        return tracks.length > 0 ? tracks[0] : null;
    }

    isScreenSharing() {
        return this.media.isScreenSharing();
    }

    isVideoEnabled() {
        return this.media.isVideoEnabled();
    }

    setAudioEnabled(enabled: boolean) {
        this.media.getLocalStreamSync()?.getAudioTracks().forEach(track => {
            track.enabled = enabled;
        });
    }

    setVideoEnabled(enabled: boolean) {
        this.media.getLocalStreamSync()?.getVideoTracks().forEach(track => {
            track.enabled = enabled;
        });
    }

    isAudioEnabled(): boolean {
        const audioTrack = this.media.getLocalStreamSync()?.getAudioTracks()[0];
        return audioTrack?.enabled ?? false;
    }

    /** True when we joined without a microphone (listen-only). */
    isListenOnly(): boolean {
        return this.media.isListenOnly();
    }

    /** Driven by the ScreenShareStarted/Stopped WS events. `streamId` is the
     *  announced share stream id, when the sharer's client and the server are
     *  new enough to carry it. */
    setPeerSharing(userId: UserId, sharing: boolean, streamId: string | null = null): void {
        if (sharing) this.videoGate.announceShare(userId, streamId);
        else this.videoGate.stopShare(userId);
        this.releaseHeldVideo(userId);
    }

    /** Driven by the CameraStarted/Stopped WS events — a peer's camera video
     *  is rendered only while one is in effect (B7). */
    setPeerCamera(userId: UserId, on: boolean): void {
        if (on) this.videoGate.announceCamera(userId);
        else this.videoGate.stopCamera(userId);
        this.releaseHeldVideo(userId);
    }

    private deliverVideo(userId: UserId, kind: 'camera' | 'screen', stream: MediaStream, receiver: RTCRtpReceiver): void {
        if (kind === 'camera') {
            this.onCameraStream?.(userId, stream);
            return;
        }
        // Remote control drops this receiver's jitter buffer while the share
        // is being driven; ontrack is the mesh path's only moment with the
        // receiver in hand. With an announced id, only the REAL share's
        // receiver can land here — the listen-only-sharer's camera no longer
        // overwrites it.
        registerScreenReceiver(userId, receiver);
        this.onScreenShareStream?.(userId, stream);
    }

    /** An announcement changed for this peer: hand over any video that was
     *  held for it (see AnnouncedVideoGate). */
    private releaseHeldVideo(userId: UserId): void {
        const voiceId = this.peers.get(userId)?.remoteStream?.id ?? null;
        const released = this.videoGate.release(userId, (sid) => ({
            isVoiceStream: voiceId !== null && sid === voiceId,
            micPinned: voiceId !== null,
        }));
        for (const r of released) {
            console.log(`[WebRTC] releasing held ${r.kind} video from ${userId} — now announced`);
            this.deliverVideo(userId, r.kind, r.payload.stream, r.payload.receiver);
        }
    }

    /** Acquire the camera WITHOUT publishing it: the track reaches peers only
     *  after the server accepts the CameraStart announcement (B7). Returns the
     *  live camera track — the existing one if the camera is already on. */
    async acquireCamera(): Promise<MediaStreamTrack | null> {
        const existing = this.media.getLocalStreamSync()?.getVideoTracks().find(t => t.readyState === 'live');
        if (existing) return existing;
        return this.media.toggleVideo(true);
    }

    /** Publish an acquired camera track to every peer that does not carry it yet. */
    publishCameraTrack(track: MediaStreamTrack): void {
        const localStream = this.media.getLocalStreamSync();
        if (!localStream) return;
        for (const [userId, peer] of this.peers) {
            if (peer.connection.getSenders().some(s => s.track === track)) continue;
            // addTrack fires onnegotiationneeded → offer (no manual makeOffer).
            this.wireSender(userId, peer.connection.addTrack(track, localStream));
        }
    }

    async getLocalStream(audio = true, video = false): Promise<MediaStream> {
        return this.media.getLocalStream(audio, video);
    }

    stopLocalStream() {
        this.media.stopLocalStream();
    }

    createSilenceSentinel(stream: MediaStream, onSilent: (silent: boolean) => void) {
        return this.media.createSilenceSentinel(stream, onSilent);
    }

    /** See MediaManager.onMicTrackSwapped — rebuild any source node you hold over the local mic track. */
    onMicTrackSwapped(fn: () => void): () => void {
        return this.media.onMicTrackSwapped(fn);
    }

    /** See MediaManager.rawMicState — device-level truth about the open mic. */
    rawMicState() {
        return this.media.rawMicState();
    }

    /** The current local stream (processed mic + optional camera), or null. */
    getLocalStreamSync(): MediaStream | null {
        return this.media.getLocalStreamSync();
    }

    createVoiceActivityDetector(stream: MediaStream, onSpeaking: (isSpeaking: boolean) => void, threshold = 0.01) {
        return this.media.createVoiceActivityDetector(stream, onSpeaking, threshold);
    }

    // ================== Peer connection & track orchestration ==================

    async toggleVideo(enable: boolean): Promise<MediaStream | null> {
        const newTrack = await this.media.toggleVideo(enable);
        const localStream = this.media.getLocalStreamSync();

        if (newTrack) {
            for (const [userId, peer] of this.peers) {
                if (localStream) {
                    // addTrack fires onnegotiationneeded → offer (no manual makeOffer).
                    this.wireSender(userId, peer.connection.addTrack(newTrack, localStream));
                }
            }
        }
        return localStream;
    }

    async switchCamera(currentFacingMode: 'user' | 'environment'): Promise<MediaStream | null> {
        const newTrack = await this.media.switchCamera(currentFacingMode);
        const localStream = this.media.getLocalStreamSync();

        if (newTrack && localStream) {
            // Never grab the screen-share video sender: while sharing with the
            // camera on, "first video sender" IS the screen share — replacing
            // its track would swap the outgoing stream for the camera feed.
            const screenVideo = new Set<MediaStreamTrack>(this.media.getScreenShareStreamSync()?.getVideoTracks() ?? []);
            for (const [userId, peer] of this.peers) {
                const senders = peer.connection.getSenders();
                const videoSender = senders.find(s =>
                    s.track?.kind === 'video' && !screenVideo.has(s.track));

                if (videoSender) {
                    // replaceTrack needs no renegotiation.
                    await videoSender.replaceTrack(newTrack);
                } else {
                    // addTrack fires onnegotiationneeded → offer (no manual makeOffer).
                    this.wireSender(userId, peer.connection.addTrack(newTrack, localStream));
                }
            }
            return localStream;
        }
        return null;
    }

    setOnScreenShareEnded(callback: (() => void) | null) {
        this.onScreenShareEnded = callback;
    }

    /** End the share through the UI's full stop flow when registered
     *  (broadcasts + state); otherwise just tear down media. */
    endScreenShareFromSource(): void {
        if (this.onScreenShareEnded) {
            this.onScreenShareEnded();
        } else {
            this.stopScreenShare();
        }
    }

    async getScreenShareStream(config?: { width?: number, height?: number, fps?: number, audio?: boolean }): Promise<MediaStream> {
        const stream = await this.media.getScreenShareStream(config);
        // Fires when the source vanishes (shared window closed) or the user
        // hits the browser's own stop control.
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
            this.endScreenShareFromSource();
        });
        return stream;
    }

    /**
     * Attach the per-app ("game only") audio track to the screen-share stream
     * so it travels with the video (receivers group them by stream identity).
     * Must be called before addScreenShareToPeers().
     */
    addGameAudioToScreenShare(track: MediaStreamTrack): void {
        const stream = this.media.getScreenShareStreamSync();
        if (!stream) {
            track.stop();
            return;
        }
        stream.addTrack(track);
    }

    stopScreenShare() {
        // Capture the screen tracks BEFORE stopping so we can find + remove the
        // exact senders carrying them (matching by track identity, never by kind
        // — the mic/camera senders must survive).
        const screen = this.media.getScreenShareStreamSync();
        const screenTracks = new Set<MediaStreamTrack>(screen?.getTracks() ?? []);
        const wasSharing = this.media.stopScreenShare();
        // End the native per-app capture if it was running (no-op otherwise).
        import('../appAudio').then(m => m.stopGameAudio()).catch(() => { /* desktop only */ });
        if (wasSharing) {
            console.log('[WebRTC] Stopping screen share');
            // removeTrack each screen sender → onnegotiationneeded → a renegotiation
            // that marks those m-lines inactive, so receivers' tracks end cleanly.
            for (const [, peer] of this.peers) {
                peer.connection.getSenders().forEach(sender => {
                    if (sender.track && screenTracks.has(sender.track)) {
                        try { peer.connection.removeTrack(sender); } catch { /* peer closing */ }
                    }
                });
            }
        }
    }

    async addScreenShareToPeers(): Promise<void> {
        const stream = this.media.getScreenShareStreamSync();
        if (!stream) return;

        // addScreenShareTracks' addTrack calls fire onnegotiationneeded on each
        // peer → a glare-safe offer. This is the path that must reach a late
        // joiner and the peer we're answering when a share starts mid-call.
        for (const [userId, peer] of this.peers) {
            await this.addScreenShareTracks(userId, peer.connection, stream);
        }
    }

    /**
     * Add every current local track (mic/camera + screen share) to a peer that
     * doesn't already have it, applying the gaming encoding tuning to any
     * screen-share video sender. Used on every path that (re)builds a peer —
     * first call, incoming offer, late join and reconnect — so late joiners and
     * reconnecting peers always receive a properly-tuned screen share.
     */
    private async addLocalMediaToPeer(userId: UserId, pc: RTCPeerConnection): Promise<void> {
        const localStream = this.media.getLocalStreamSync();
        // FAIL CLOSED when enforcement is on and this device cannot encrypt.
        //
        // `requireE2ee` is only ever consulted INSIDE the encrypt/decrypt
        // transforms, and `wireSender` declines to attach one when the browser
        // has no Encoded Transform API (Safari/iOS, Firefox, WKWebView). So
        // without this guard the enforcement setting was a NO-OP on exactly the
        // browsers that need it: the tracks were added, no transform wrapped
        // them, and the raw encoder output went out over plain DTLS-SRTP —
        // while `mediaE2eeExplanation('local-unsupported', enforced)` told the
        // user in as many words "Because encryption is required for this call,
        // media is blocked here". This makes that sentence true. The SFU path
        // already fails closed the same way (sfuManager.ts, isE2EESupported).
        //
        // Blocked, not disconnected: the user stays in the channel with the
        // roster and text intact and no media in either direction, which is the
        // same shape as a peer-unsupported block.
        if (this.requireMediaE2ee && !isMediaE2eeSupported()) {
            console.warn(`[media-e2ee] not publishing to ${userId}: encryption required but unsupported here`);
            const peer = this.peers.get(userId);
            if (peer) {
                peer.mediaE2eeReason = 'local-unsupported';
                this.emitMediaE2ee(userId);
            }
            return;
        }
        if (localStream) {
            const existing = pc.getSenders();
            localStream.getTracks().forEach(track => {
                if (!existing.some(s => s.track === track)) {
                    const sender = pc.addTrack(track, localStream);
                    this.wireSender(userId, sender); // media-E2EE encrypt transform
                }
            });
        }
        // LISTEN-ONLY: with no local track, nothing ever fires
        // onnegotiationneeded, so this pc would sit in `stable` with zero
        // m-lines and never offer — silently breaking the "the joiner
        // initiates to everyone already here" invariant whenever the remote
        // still holds a stale peer entry for us. An explicit recvonly audio
        // transceiver makes us negotiate normally and tells the peer to send.
        const hasLocalAudio = !!localStream?.getAudioTracks().length;
        const hasAudioTransceiver = pc.getTransceivers()
            .some(t => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio');
        if (!hasLocalAudio && !hasAudioTransceiver) {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        const screen = this.media.getScreenShareStreamSync();
        if (screen) await this.addScreenShareTracks(userId, pc, screen);
    }

    /** Add screen-share tracks to a peer (deduped) and tune the video sender. */
    private async addScreenShareTracks(userId: UserId, pc: RTCPeerConnection, stream: MediaStream): Promise<void> {
        const existing = pc.getSenders();
        for (const track of stream.getTracks()) {
            if (existing.some(s => s.track === track)) continue;
            const sender = pc.addTrack(track, stream);
            this.wireSender(userId, sender); // media-E2EE encrypt transform
            if (track.kind === 'video') await this.tuneScreenShareSender(sender);
        }
    }

    /** Apply gaming-oriented encoding parameters to a screen-share video sender. */
    private async tuneScreenShareSender(sender: RTCRtpSender, maxBitrate = 8_000_000): Promise<void> {
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                // Some browsers require encodings to exist before setParameters.
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = maxBitrate;
            params.encodings[0].maxFramerate = 60;
            // Prefer smooth motion over crisp detail under constraint. Cast to
            // any: `degradationPreference` isn't in every TS DOM lib version.
            (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate';
            await sender.setParameters(params);
        } catch (err) {
            console.warn('[WebRTC] Could not tune screen-share encoding:', err);
        }
    }

    /** Re-acquire the mic with the current noise-suppression mode and swap it
     *  onto every peer (used when the user changes the mode while in voice). */
    async reapplyNoiseMode(): Promise<void> {
        // Serialize: two rapid mode changes must not interleave their Web Audio
        // graph builds/teardowns (module-level graph state in noiseFilter.ts).
        const run = this.noiseSwapChain.then(() => this.doReapplyNoiseMode());
        this.noiseSwapChain = run.catch(() => undefined);
        return run;
    }

    private async doReapplyNoiseMode(): Promise<void> {
        const res = await this.media.reacquireAudioTrack();
        if (!res) return;
        const { oldTrack, newTrack } = res;
        // Replace the MIC sender only, matched by track identity — never by
        // kind: a screen share with audio adds a second audio sender whose
        // game/system audio must not be clobbered by a noise-mode change.
        const screenAudio = new Set<MediaStreamTrack>(this.media.getScreenShareStreamSync()?.getAudioTracks() ?? []);
        for (const [, peer] of this.peers) {
            const senders = peer.connection.getSenders();
            const micSender =
                (oldTrack ? senders.find(s => s.track === oldTrack) : undefined) ??
                senders.find(s => s.track?.kind === 'audio' && !screenAudio.has(s.track));
            if (micSender) await micSender.replaceTrack(newTrack).catch(() => { /* peer gone */ });
        }
    }

    setOnRemoteStream(callback: RemoteStreamCallback) { this.onRemoteStream = callback; }
    setOnScreenShareStream(callback: RemoteStreamCallback) { this.onScreenShareStream = callback; }
    setOnCameraStream(callback: RemoteStreamCallback) { this.onCameraStream = callback; }
    setOnPeerDisconnected(callback: PeerDisconnectedCallback) { this.onPeerDisconnected = callback; }
    setOnConnectionStateChange(callback: ConnectionStateCallback) { this.onConnectionStateChange = callback; }
    setOnReconnecting(callback: (userId: UserId, attempt: number) => void) { this.onReconnecting = callback; }

    /**
     * Recover a peer wedged in a bad signaling state. Covers two shapes:
     * (a) a thrown setRemoteDescription mid-handshake leaves the pc non-stable
     *     with no answer sent while ICE stays 'connected' (no failure event
     *     ever fires), and
     * (b) an offer WE sent that never gets an answer (peer wedged
     *     stable-but-deaf on an old client, offer lost in a WS flap, peer
     *     died) leaves the pc in have-local-offer with ICE never starting.
     * After a grace period, if the pc is still non-stable, close it and
     * re-initiate from THIS side regardless of id order: the fresh
     * offer carries a new connId so an updated remote replaces its pc to
     * match, and simultaneous rebuilds resolve as ordinary glare. (Waiting on
     * the lower id here used to deadlock — the lower side's pc could look
     * healthy and never offer.)
     * Rebuilds are capped via stuckRebuilds; the counter resets on any
     * successfully applied description or a 'connected' transition.
     */
    private scheduleStuckPeerRecovery(userId: UserId): void {
        if (this.stuckRecoveryTimers.has(userId)) return; // already scheduled
        const scheduledEpoch = this.voiceEpoch;
        // Bind the check to THIS pc: if the peer is rebuilt before the timer
        // fires (connId rebuild, reconnect), the fresh pc must not be judged
        // by its predecessor's failure.
        const pcAtSchedule = this.peers.get(userId)?.connection ?? null;
        const timer = window.setTimeout(() => {
            this.stuckRecoveryTimers.delete(userId);
            if (this.voiceEpoch !== scheduledEpoch || !this.inVoice) return;
            const peer = this.peers.get(userId);
            if (!peer || peer.connection !== pcAtSchedule) return; // already rebuilt
            if (peer.connection.signalingState === 'stable') return; // recovered on its own
            const rebuilds = (this.stuckRebuilds.get(userId) ?? 0) + 1;
            if (rebuilds > this.MAX_STUCK_REBUILDS) {
                // The peer is dead or hopelessly incompatible — stop churning.
                // A future StreamStarted/offer for them starts a clean slate.
                console.warn(`[WebRTC] Peer ${userId} still unrecoverable after ${rebuilds - 1} rebuilds — giving up`);
                this.stuckRebuilds.delete(userId); // fresh budget if they truly return
                this.closePeer(userId);
                this.onPeerDisconnected?.(userId, true); // terminal: gave up on this peer
                return;
            }
            this.stuckRebuilds.set(userId, rebuilds);
            console.warn(`[WebRTC] Peer ${userId} unrecoverable (state=${peer.connection.signalingState}) — rebuilding (attempt ${rebuilds})`);
            this.closePeer(userId);
            void this.callUser(userId);
        }, 3000);
        this.stuckRecoveryTimers.set(userId, timer);
    }

    private async attemptReconnection(userId: UserId): Promise<void> {
        const attempts = (this.reconnectAttempts.get(userId) || 0) + 1;
        this.reconnectAttempts.set(userId, attempts);

        if (attempts > this.MAX_RECONNECT_ATTEMPTS) {
            this.onPeerDisconnected?.(userId, true); // terminal: out of retries
            this.reconnectAttempts.delete(userId);
            return;
        }

        // FIRST failure: ICE restart on the SAME pc, never a teardown. A pc
        // can reach connectionState 'failed' with media still flowing — ICE
        // stuck in 'checking' because the only workable pair never validated
        // (observed live: a VPN egress that hairpins STUN requests but eats
        // the responses, with the mDNS host pair unresolved). Rebuilding
        // destroys the working tracks (tiles/audio churn on every peer);
        // restartIce() renegotiates credentials within the pc via the normal
        // onnegotiationneeded → makeOffer path (same connId, so the remote
        // applies it as a plain renegotiation). If the restart's checks fail
        // again, the next 'failed' TRANSITION re-enters here with attempts=2.
        //
        // The transition cannot be relied on alone: connectionstatechange is
        // edge-triggered, and a failure an ICE restart cannot cure (terminal
        // DTLS transport) leaves connectionState PINNED at 'failed' — clean
        // signaling, no second event, ladder never escalates. So the rung
        // carries its own deadline: still 'failed' on the SAME pc after 10s →
        // re-enter the ladder (attempts is still 1 in the map, so this lands
        // on the rebuild rung). The deadline shares reconnectTimeouts, so
        // teardown/'connected' cleanup cancels it like any rebuild timer.
        if (attempts === 1) {
            const peer = this.peers.get(userId);
            if (peer && peer.connection.connectionState !== 'closed') {
                console.warn(`[WebRTC] ICE failure for ${userId} — trying restartIce on the live pc first`);
                this.onReconnecting?.(userId, attempts);
                try {
                    peer.connection.restartIce();
                    const pcAtRestart = peer.connection;
                    const restartEpoch = this.voiceEpoch;
                    const existing = this.reconnectTimeouts.get(userId);
                    if (existing) clearTimeout(existing);
                    const deadline = window.setTimeout(() => {
                        this.reconnectTimeouts.delete(userId);
                        if (this.voiceEpoch !== restartEpoch || !this.inVoice) return;
                        const now = this.peers.get(userId);
                        if (!now || now.connection !== pcAtRestart) return; // already rebuilt/torn down
                        if (now.connection.connectionState !== 'failed') return; // restart worked (or still trying)
                        console.warn(`[WebRTC] restartIce for ${userId} did not recover in 10s — escalating to rebuild`);
                        void this.attemptReconnection(userId);
                    }, 10_000);
                    this.reconnectTimeouts.set(userId, deadline);
                    return;
                } catch { /* fall through to the rebuild path */ }
            }
        }

        const delay = Math.pow(2, attempts - 1) * 1000;
        this.onReconnecting?.(userId, attempts);

        const existingTimeout = this.reconnectTimeouts.get(userId);
        if (existingTimeout) clearTimeout(existingTimeout);

        // Capture the epoch so a reconnect scheduled before a room change (AFK
        // move / channel switch bumps voiceEpoch in closeAll) can't fire after
        // it — that stale callUser used to re-mesh the user into the OLD room
        // ("moved to AFK but still hears the previous channel").
        const scheduledEpoch = this.voiceEpoch;
        const timeout = window.setTimeout(async () => {
            this.reconnectTimeouts.delete(userId);
            if (this.voiceEpoch !== scheduledEpoch || !this.inVoice) return;
            try {
                const oldPeer = this.peers.get(userId);
                if (oldPeer) {
                    // Defense in depth vs the orphaned-timer race: never
                    // demolish a pc that recovered while we waited.
                    if (oldPeer.connection.connectionState === 'connected') return;
                    console.warn(`[WebRTC] ICE-failure reconnect ${attempts} for ${userId} — rebuilding pc`);
                    oldPeer.connection.close();
                    this.peers.delete(userId);
                    // This path does NOT go through closePeer, and
                    // pc.close() closes data channels WITHOUT firing their
                    // close events — so without this the registry kept a
                    // channel from the dead connection with its capability
                    // still armed, and the rebuilt pc inherited a hello its
                    // far end never sent.
                    if (__RC_ENABLED__) forgetControlChannels(userId);
                }
                await this.callUser(userId);
            } catch {
                this.attemptReconnection(userId);
            }
        }, delay);

        this.reconnectTimeouts.set(userId, timeout);
    }

    private async createPeerConnection(userId: UserId): Promise<RTCPeerConnection> {
        const config = await getRtcConfigAsync();
        // Privacy: "Hide my IP in calls" now lives in ONE helper used by every
        // path that opens a peer connection — this one, My Devices sessions and
        // peer-to-peer file transfer. It was inline here and nowhere else, so
        // the setting hid the user's IP from a voice peer while the other two
        // handed it over regardless.
        const effectiveConfig: RTCConfiguration = withRelayOnlyIfRequested(config);
        // `encodedInsertableStreams` MUST be set at construction for
        // createEncodedStreams() to be available on senders/receivers.
        const pc = new RTCPeerConnection(
            isMediaE2eeSupported()
                ? ({ ...effectiveConfig, encodedInsertableStreams: true } as RTCConfiguration)
                : effectiveConfig,
        );

        // P2P INPUT LANES (W5/R2 — see rtc/controlDc.ts). Created AT
        // CONSTRUCTION, before any offer: a channel added later renegotiates
        // the pc, and these must cost zero extra ICE (max-bundle means they
        // share the existing transport). Both sides create; the registry
        // keeps one channel per lane and closes the loser. remoteControl
        // gates real input on a sealed app-level HELLO, never on these being
        // open — an open channel proves SCTP, not that the peer understands
        // the frames.
        // Behind the FOLDED LITERAL: a lite build has no remote control, so it
        // neither opens the lane nor carries rtc/controlDc (rc-exclusion-guard
        // fails the build if the real module enters the graph).
        if (__RC_ENABLED__) try {
            registerControlChannel(userId, pc.createDataChannel(CTL_STATE_LABEL, { ordered: true }));
        } catch (e) {
            // A runtime without data channels keeps the relay path — the
            // permanent fallback, not a degraded mode.
            console.warn('[WebRTC] control data channels unavailable:', e);
        }
        pc.ondatachannel = (ev) => {
            if (__RC_ENABLED__ && ev.channel.label === CTL_STATE_LABEL) registerControlChannel(userId, ev.channel);
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                wsClient.sendIceCandidate(userId, JSON.stringify(event.candidate));
            }
        };
        // One stuck-checking probe per pc, re-armed per 'checking' episode: a
        // timer surviving into a LATER episode would dump that episode's pairs
        // at the wrong moment and read as a fresh stall.
        let stuckCheckTimer: number | null = null;
        pc.oniceconnectionstatechange = () => {
            console.log(`[WebRTC] ice ${userId}: ${pc.iceConnectionState}`);
            if (stuckCheckTimer !== null) {
                clearTimeout(stuckCheckTimer);
                stuckCheckTimer = null;
            }
            // Stuck-checking post-mortem: if we are STILL checking 5s in, dump
            // the live candidate pairs while they exist (they are pruned by
            // the time the pc reaches 'failed').
            if (pc.iceConnectionState === 'checking') {
                stuckCheckTimer = window.setTimeout(() => {
                    stuckCheckTimer = null;
                    if (pc.iceConnectionState !== 'checking') return;
                    void pc.getStats().then((stats) => {
                        const cands = new Map<string, Record<string, unknown>>();
                        stats.forEach((s) => {
                            if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
                                cands.set(s.id, s as unknown as Record<string, unknown>);
                            }
                        });
                        const lines: string[] = [];
                        stats.forEach((s) => {
                            if (s.type === 'candidate-pair') {
                                const p = s as unknown as Record<string, unknown>;
                                const l = cands.get(p.localCandidateId as string);
                                const r = cands.get(p.remoteCandidateId as string);
                                lines.push(`state=${p.state} nom=${p.nominated} reqS=${p.requestsSent} respR=${p.responsesReceived} reqR=${p.requestsReceived} respS=${p.responsesSent} l=${l?.candidateType}/${l?.address ?? '?'}:${l?.port} r=${r?.candidateType}/${r?.address ?? '?'}:${r?.port}`);
                            }
                        });
                        console.warn(`[WebRTC] STUCK-CHECKING pairs for ${userId}: ${lines.join(' || ') || '(no candidate pairs)'}`);
                    }).catch(() => { /* pc gone */ });
                }, 5000);
            }
        };

        // Perfect negotiation: any track add/remove (join, screen share, camera,
        // noise-mode add) fires this — we make a glare-safe offer. This is what
        // lets tracks a peer adds WHILE answering get negotiated (an answer can't
        // add m-lines; the follow-up offer scheduled here does).
        // ENQUEUED, not run directly: makeOffer must never interleave with an
        // incoming description mid-application — an arg-less setLocalDescription
        // racing a remote offer mints an ANSWER instead of the intended offer
        // (see makeOffer's doc comment for the resulting failure chain).
        pc.onnegotiationneeded = () => {
            this.enqueueSignalingTask(userId, () => this.makeOffer(userId, pc));
        };

        pc.ontrack = (event) => {
            console.log(`[WebRTC] Received remote track from user ${userId}: ${event.track.kind}`);

            const peer = this.peers.get(userId);
            if (!peer) return;

            // Media-E2EE: decrypt incoming frames (no-op passthrough until enabled).
            if (isMediaE2eeSupported() && event.receiver && !this.transformedReceivers.has(event.receiver)) {
                this.transformedReceivers.add(event.receiver);
                attachReceiverTransform(event.receiver, peer.mediaCrypto);
            }

            // The receive half of the same fail-closed rule as
            // addLocalMediaToPeer. A decrypt transform is what normally DROPS
            // unencrypted inbound frames while enforcement is on, and it cannot
            // attach without the Encoded Transform API — so on those browsers
            // inbound media would otherwise be rendered unconditionally. Drop
            // the track instead of surfacing it; both halves of the pair have
            // to hold or "blocked" only means blocked in one direction.
            if (this.requireMediaE2ee && !isMediaE2eeSupported()) {
                console.warn(`[media-e2ee] dropping inbound track from ${userId}: encryption required but unsupported here`);
                peer.mediaE2eeReason = 'local-unsupported';
                this.emitMediaE2ee(userId);
                return;
            }

            // Classify by STREAM IDENTITY, not track contents. Mic (and camera)
            // tracks always travel in the sender's localStream; screen-share
            // tracks travel in the separate screen stream. The mic track is
            // always negotiated first (addLocalMediaToPeer adds localStream
            // before screen tracks), so the first audio track to arrive pins
            // which remote stream is "voice". A video stream that merely
            // contains audio is NOT a camera — a screen share with system audio
            // also looks like that.
            const stream = event.streams[0] ?? new MediaStream([event.track]);
            const isVoiceStream = peer.remoteStream !== null && stream.id === peer.remoteStream.id;

            if (event.track.kind === 'video') {
                // Render only what the server has ANNOUNCED for this peer
                // (B7): the VIDEO/STREAM bits are enforced on the
                // announcement, so a track with no announcement behind it is
                // held — and released the moment the announcement lands (the
                // reload/reconnect race where the track beats the frame).
                const kind = this.videoGate.offer(
                    userId,
                    { streamId: stream.id, isVoiceStream, micPinned: peer.remoteStream !== null },
                    { stream, receiver: event.receiver },
                );
                if (kind === 'held') {
                    console.log(`[WebRTC] holding video from ${userId} until the server announces it`);
                } else {
                    this.deliverVideo(userId, kind, stream, event.receiver);
                }
            } else if (event.track.kind === 'audio') {
                // An ANNOUNCED share stream is never the voice stream,
                // whatever arrives first. Without this mirror of the video
                // rule, a LISTEN-ONLY sharer's share audio (which arrives
                // before their share video) got pinned as their "voice"
                // stream — and once the video branch above started filing
                // their share correctly, the same audio played through BOTH
                // the voice element and the share tile's graph, doubled.
                const announcedShare = this.videoGate.shareId(userId);
                if (announcedShare != null && stream.id === announcedShare) {
                    this.onScreenShareStream?.(userId, stream);
                } else if (peer.remoteStream === null || isVoiceStream) {
                    peer.remoteStream = stream;
                    this.onRemoteStream?.(userId, stream);
                } else {
                    // System/screen audio — it belongs to the screen-share
                    // stream, NOT the voice element (which it used to clobber).
                    // Re-notify so viewers rebind now that audio exists.
                    this.onScreenShareStream?.(userId, stream);
                }
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[WebRTC] conn ${userId}: ${pc.connectionState}`);
            this.onConnectionStateChange?.(userId, pc.connectionState);
            if (pc.connectionState === 'failed') {
                // Post-mortem BEFORE the pc is torn down: which pairs existed
                // and which direction went dark (requests/responses per pair).
                void pc.getStats().then((stats) => {
                    const cands = new Map<string, Record<string, unknown>>();
                    stats.forEach((s) => {
                        if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
                            cands.set(s.id, s as unknown as Record<string, unknown>);
                        }
                    });
                    const lines: string[] = [];
                    stats.forEach((s) => {
                        if (s.type === 'candidate-pair') {
                            const p = s as unknown as Record<string, unknown>;
                            const l = cands.get(p.localCandidateId as string);
                            const r = cands.get(p.remoteCandidateId as string);
                            lines.push(`state=${p.state} nom=${p.nominated} reqS=${p.requestsSent} respR=${p.responsesReceived} reqR=${p.requestsReceived} respS=${p.responsesSent} l=${l?.candidateType}/${l?.address ?? '?'}:${l?.port} r=${r?.candidateType}/${r?.address ?? '?'}:${r?.port}`);
                        }
                    });
                    console.warn(`[WebRTC] FAILED-pc pairs for ${userId}: ${lines.join(' || ') || '(no candidate pairs)'}`);
                }).catch(() => { /* pc gone */ });
                this.attemptReconnection(userId);
            } else if (pc.connectionState === 'connected') {
                this.reconnectAttempts.delete(userId);
                // CANCEL, not just forget: deleting the handle without
                // clearTimeout orphaned an armed rebuild timer, which then
                // fired and destroyed the just-recovered pc (reachable when
                // the REMOTE's restartIce renegotiates our failed pc back to
                // health while our own attempts>=2 backoff is pending).
                const pending = this.reconnectTimeouts.get(userId);
                if (pending) clearTimeout(pending);
                this.reconnectTimeouts.delete(userId);
                this.stuckRebuilds.delete(userId); // healthy — reset the rebuild budget
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                // NOT terminal: ICE 'disconnected' recovers on its own all the
                // time. Tearing the peer's tiles down here would flicker them
                // away mid-call.
                this.onPeerDisconnected?.(userId, false);
            }
        };

        const mediaCrypto: MediaCryptoState = { key: null, enabled: false, requireE2ee: this.requireMediaE2ee };
        this.peers.set(userId, {
            userId, connection: pc, connId: newConnId(), remoteConnId: null,
            remoteStream: null, makingOffer: false, mediaCrypto,
            polite: this.isPolite(userId), isSettingRemoteAnswerPending: false, ignoreOffer: false,
            mediaStaticPub: null, mediaStaticKeyRaw: null, mediaEph: null, mediaReadyTag: null, dtlsPin: 'unverified',
            mediaE2eeReason: isMediaE2eeSupported() ? 'negotiating' : 'local-unsupported',
        });
        // Derive the pairwise media key in the background (best-effort; also
        // awaited before we advertise in an offer/answer).
        void this.setupMediaKey(userId);
        return pc;
    }

    private async getOrCreatePeer(userId: UserId): Promise<RTCPeerConnection> {
        const existing = this.peers.get(userId);
        if (existing) return existing.connection;
        // Coalesce concurrent builds for the same user onto one promise, so the
        // async gap inside createPeerConnection (awaiting the ICE config) can't
        // let two callers each construct a peer and orphan one of them.
        const inflight = this.peerCreation.get(userId);
        if (inflight) return inflight;
        const epoch = this.voiceEpoch;
        const gen = this.peerGeneration.get(userId) ?? 0;
        const build = (async () => {
            const pc = await this.createPeerConnection(userId);
            // If we left voice — or THIS peer was torn down (per-peer
            // generation bump) — while awaiting the ICE config, then
            // createPeerConnection just re-inserted a peer that teardown
            // believed gone — undo it and abort so it can't linger as an
            // orphaned, still-encrypting pc negotiating with a departed user.
            if (this.voiceEpoch !== epoch || !this.inVoice
                || (this.peerGeneration.get(userId) ?? 0) !== gen) {
                pc.close();
                if (this.peers.get(userId)?.connection === pc) this.peers.delete(userId);
                throw new Error('peer build superseded (left voice or peer torn down)');
            }
            // Add our local media exactly once, at creation. The resulting track
            // adds fire onnegotiationneeded → the initial offer (perfect
            // negotiation), so no path needs to call makeOffer explicitly.
            await this.addLocalMediaToPeer(userId, pc);
            return pc;
        })();
        this.peerCreation.set(userId, build);
        try {
            return await build;
        } finally {
            this.peerCreation.delete(userId);
        }
    }

    async callUser(userId: UserId): Promise<void> {
        console.log(`Initiating call to user ${userId}`);
        // Creating the peer adds local media, which triggers onnegotiationneeded
        // → offer. EITHER side may call this (the joiner meshes with everyone,
        // the lower id initiates on StreamStarted, and recovery re-initiates
        // from whichever side detected the wedge) — a double offer is ordinary
        // glare, resolved by perfect-negotiation politeness. No-op when a peer
        // entry already exists. Fire-and-forget at the call sites, so swallow
        // the benign "build superseded" abort instead of leaking a rejection.
        try {
            await this.getOrCreatePeer(userId);
        } catch (err) {
            console.debug(`[WebRTC] callUser(${userId}) aborted:`, err);
        }
    }

    private async flushPendingCandidates(fromUser: UserId, pc: RTCPeerConnection) {
        const pending = this.pendingCandidates.get(fromUser) || [];
        for (const candidate of pending) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                // Was a silent `/* stale */` swallow — which hid a lost HOST
                // candidate for the length of a whole debugging session. A
                // genuinely stale candidate warning is cheap; a silently
                // missing one costs a working ICE pair.
                console.warn(`[WebRTC] buffered addIceCandidate from ${fromUser} failed:`, e);
            }
        }
        this.pendingCandidates.delete(fromUser);
    }

    /** Append a task to a peer's signaling chain. EVERYTHING that touches a
     *  pc's signaling state (setLocalDescription/setRemoteDescription) must run
     *  through here — incoming descriptions AND our own makeOffer — so state
     *  reads inside a task can't be invalidated by a concurrent transition
     *  (a classic source of "wrong state" throws + duplicate descriptions). */
    private enqueueSignalingTask(userId: UserId, task: () => Promise<void>): void {
        const prev = this.signalingChains.get(userId) ?? Promise.resolve();
        const next = prev
            .catch(() => { /* isolate failures between tasks */ })
            .then(task)
            .catch(e => console.warn('[WebRTC] signaling task error:', e)); // keep the chain resolved (no unhandled rejection)
        this.signalingChains.set(userId, next);
    }

    /** Serialize incoming descriptions per peer — two offers/answers landing
     *  close together must apply one at a time or their signaling-state
     *  transitions race. */
    private enqueueDescription(fromUser: UserId, sdpJson: string): void {
        this.enqueueSignalingTask(fromUser, () => this.handleIncomingDescription(fromUser, sdpJson));
    }

    /**
     * Unified perfect-negotiation handler for both offers and answers (MDN
     * pattern). The polite peer rolls back its own pending offer on a collision;
     * the impolite peer ignores the colliding remote offer. After applying an
     * offer we answer it; onnegotiationneeded (not this handler) drives our own
     * offers, so tracks added while answering are picked up by a follow-up offer.
     */
    private async handleIncomingDescription(fromUser: UserId, sdpJson: string): Promise<void> {
        const envelope = JSON.parse(sdpJson) as SignalEnvelope;
        const description: RTCSessionDescriptionInit = { type: envelope.type, sdp: envelope.sdp };
        console.log(`[WebRTC] recv ${description.type} <- ${fromUser} connId=${envelope.connId?.slice(0, 8) ?? '-'} answerTo=${envelope.answerTo?.slice(0, 8) ?? '-'} mlines=${(envelope.sdp?.match(/^m=/gm) ?? []).length} state=${this.peers.get(fromUser)?.connection.signalingState ?? 'no-peer'}`);
        // Only a genuine incoming OFFER, while we're actually in voice, may
        // create a peer. A stray/late/duplicate ANSWER (or any description that
        // raced a departure) must NOT fabricate a phantom peer — doing so would
        // re-add our mic, fire an unsolicited offer, and leak a dead connection.
        if (!this.inVoice) return;
        const epoch = this.voiceEpoch;
        let existing = this.peers.get(fromUser);
        if (!existing && description.type !== 'offer') return;

        // A late answer aimed at a pc we've since replaced (rejoin/rebuild
        // minted a new connId) must not be applied to the fresh pc — it
        // answers an offer that pc never made.
        if (existing && description.type === 'answer' && envelope.answerTo
            && envelope.answerTo !== existing.connId) {
            console.warn(`[WebRTC] Dropping stale answer from ${fromUser} (for a replaced connection)`);
            return;
        }

        // An answer landing on a STABLE pc has nothing left to answer: either
        // our offer was already answered (a duplicate — e.g. an old client that
        // double-sent), or we rolled back under glare and the answer crossed
        // the rollback on the wire. Applying it can only throw InvalidStateError
        // — and that error used to trigger a forced rebuild of a perfectly
        // healthy call. Drop it; if the peer still has tracks we need, the
        // browser's negotiation-needed re-check produces a fresh offer.
        if (existing && description.type === 'answer'
            && existing.connection.signalingState === 'stable') {
            console.warn(`[WebRTC] Dropping answer from ${fromUser} on a stable pc (nothing pending — duplicate or crossed a rollback)`);
            return;
        }

        // A peer that rebuilt its RTCPeerConnection (leave/rejoin, ICE-failure
        // rebuild, stuck-pair recovery) offers from a FRESH pc. Applying that
        // to our old pc is doomed — classically the "m-lines order doesn't
        // match" InvalidAccessError, which leaves our pc stable-but-deaf (the
        // watchdog sees 'stable' and thinks it recovered). A changed connId
        // detects the rebuild deterministically: replace our pc and answer
        // from a fresh one. Must run BEFORE glare logic — politeness state of
        // a pc negotiating with a dead counterpart is meaningless.
        if (existing && description.type === 'offer' && envelope.connId
            && existing.remoteConnId && existing.remoteConnId !== envelope.connId) {
            console.warn(`[WebRTC] Peer ${fromUser} rebuilt its connection — rebuilding ours to match`);
            this.teardownPeer(fromUser, /* keepSignalingChain */ true);
            existing = undefined;
        } else if (!existing) {
            // Diagnostic: creating a peer from an incoming offer is normal on join,
            // but after an AFK move / channel switch it can mean an OLD-room peer is
            // resurrecting us into the channel we just left. If this logs a user id
            // that isn't in the current channel right after a move, that's the
            // "moved to AFK but still hear the old channel" resurrection.
            console.warn(`[RESURRECT] creating peer ${fromUser} from incoming offer; inVoice=${this.inVoice} epoch=${this.voiceEpoch}`);
        }
        const pc = existing ? existing.connection : await this.getOrCreatePeer(fromUser);
        // getOrCreatePeer awaited the ICE config; if we left voice (or this peer
        // was torn down) meanwhile, abort rather than proceed on a stale peer.
        if (this.voiceEpoch !== epoch || !this.peers.has(fromUser)) return;
        const peer = this.peers.get(fromUser);
        if (!peer) return;
        // Track the remote pc's id so the NEXT rebuild is detectable. Old
        // clients never send one — remoteConnId stays null and the legacy
        // watchdog path below covers them.
        if (envelope.connId) peer.remoteConnId = envelope.connId;
        const remoteCap = extractE2ee(description.sdp || '');

        // Glare detection. We're "ready" for a remote offer only in a stable
        // state and not mid-offer ourselves (or already awaiting a remote answer).
        const readyForOffer =
            !peer.makingOffer &&
            (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) {
            console.warn(`[WebRTC] Ignoring colliding offer from ${fromUser} (impolite)`);
            return;
        }

        try {
            peer.isSettingRemoteAnswerPending = description.type === 'answer';
            // For the polite peer under collision this implicitly rolls back our
            // own local offer, so setting the remote offer always succeeds.
            await pc.setRemoteDescription(description);
            peer.isSettingRemoteAnswerPending = false;
        } catch (e) {
            peer.isSettingRemoteAnswerPending = false;
            console.error(`[WebRTC] setRemoteDescription(${description.type}) failed:`, e);
            if (description.type === 'offer' && pc.signalingState === 'stable') {
                // A failed OFFER on a pc that is *still stable* isn't a wedged
                // handshake — the remote is offering from a pc fundamentally
                // incompatible with ours (its fresh pc vs our old m-line
                // history; typically an old client that rebuilt without a
                // connId). Counter-offering here can DEADLOCK: that remote sits
                // in have-local-offer waiting for an answer, and if impolite it
                // ignores our counter as a collision. It wants an ANSWER — so
                // rebuild now and answer the very offer we're holding.
                await this.rebuildAndAnswer(fromUser, envelope, epoch);
                return;
            }
            // Wedged mid-handshake (classically the m-lines throw during
            // glare): the ICE/DTLS transport stays 'connected', so the
            // connectionstatechange watchdog never fires — schedule a rebuild
            // of just this peer. (Answers can no longer fail on a 'stable' pc —
            // they are dropped before ever reaching setRemoteDescription — so
            // every state left here is genuinely non-stable and the soft
            // check's it-recovered bail is the right filter.)
            this.scheduleStuckPeerRecovery(fromUser);
            return;
        }
        // A description applied cleanly — this pairing is healthy again, so any
        // stuck-rebuild budget spent on it is forgiven.
        this.stuckRebuilds.delete(fromUser);
        await this.flushPendingCandidates(fromUser, pc);

        if (description.type === 'offer') {
            await this.setupMediaKey(fromUser); // tag ready to advertise in the answer
            await pc.setLocalDescription(); // implicit answer
            const local = pc.localDescription;
            if (local) {
                // Tripwire twin of makeOffer's: an answer envelope must carry an
                // ANSWER. Shipping anything else re-creates the duplicate-
                // description confusion this path is guarded against; bail and
                // let the watchdog rebuild if the handshake is truly wedged.
                if (local.type !== 'answer') {
                    console.warn(`[WebRTC] implicit local description for ${fromUser} is a ${local.type}, not an answer — not sending`);
                    this.scheduleStuckPeerRecovery(fromUser);
                    return;
                }
                const sdp = advertiseDtlsPin(advertiseE2ee(local.sdp, peer.mediaReadyTag, peer.mediaEph?.pubEncoded ?? null), peer.mediaStaticKeyRaw);
                // answerTo echoes the offer's connId so the offerer can drop
                // this answer if it has replaced that pc in the meantime.
                wsClient.sendAnswer(fromUser, JSON.stringify({
                    type: local.type, sdp, connId: peer.connId, answerTo: envelope.connId,
                }));
            }
        }

        // The DTLS pin first: a substituted connection is decided here, before
        // frame encryption is even considered.
        this.verifyRemoteDtls(fromUser, description.sdp || '');
        // Verify the peer's ephemeral-bound tag and, if valid, derive the
        // forward-secret session key and enable — see enableMediaWithRemote.
        await this.enableMediaWithRemote(fromUser, remoteCap);
    }

    /**
     * Replace our pc with a fresh one and answer the incompatible offer we're
     * already holding (see the stable-offer-failure branch above). Runs inside
     * the per-peer signaling chain, so keepSignalingChain must stay true.
     * Budgeted by stuckRebuilds so a peer whose offers NEVER apply (malformed,
     * or a pathological old client) can't drive an endless rebuild loop.
     */
    private async rebuildAndAnswer(fromUser: UserId, envelope: SignalEnvelope, epoch: number): Promise<void> {
        const rebuilds = (this.stuckRebuilds.get(fromUser) ?? 0) + 1;
        if (rebuilds > this.MAX_STUCK_REBUILDS) {
            console.warn(`[WebRTC] Giving up on ${fromUser} after ${rebuilds - 1} rebuild-and-answer attempts`);
            this.stuckRebuilds.delete(fromUser);
            this.closePeer(fromUser);
            return;
        }
        this.stuckRebuilds.set(fromUser, rebuilds);
        console.warn(`[WebRTC] Incompatible offer from ${fromUser} on a stable pc — rebuilding and ANSWERING it (attempt ${rebuilds})`);
        this.teardownPeer(fromUser, /* keepSignalingChain */ true);
        let pc: RTCPeerConnection;
        try {
            pc = await this.getOrCreatePeer(fromUser);
        } catch {
            return; // left voice (or superseded again) mid-build
        }
        if (this.voiceEpoch !== epoch || this.peers.get(fromUser)?.connection !== pc) return;
        const peer = this.peers.get(fromUser);
        if (!peer) return;
        if (envelope.connId) peer.remoteConnId = envelope.connId;
        try {
            await pc.setRemoteDescription({ type: envelope.type, sdp: envelope.sdp });
        } catch (e) {
            // Even a fresh pc rejects it — hand off to the watchdog.
            console.error('[WebRTC] rebuilt pc still rejects the offer:', e);
            this.scheduleStuckPeerRecovery(fromUser);
            return;
        }
        this.stuckRebuilds.delete(fromUser); // applied cleanly — healthy again
        await this.flushPendingCandidates(fromUser, pc);
        await this.setupMediaKey(fromUser);
        await pc.setLocalDescription(); // implicit answer
        const local = pc.localDescription;
        if (local) {
            // Same tripwire as the main answer path: never ship a non-answer
            // in an answer envelope.
            if (local.type !== 'answer') {
                console.warn(`[WebRTC] implicit local description for ${fromUser} is a ${local.type}, not an answer — not sending`);
                this.scheduleStuckPeerRecovery(fromUser);
                return;
            }
            const sdp = advertiseDtlsPin(advertiseE2ee(local.sdp, peer.mediaReadyTag, peer.mediaEph?.pubEncoded ?? null), peer.mediaStaticKeyRaw);
            wsClient.sendAnswer(fromUser, JSON.stringify({
                type: local.type, sdp, connId: peer.connId, answerTo: envelope.connId,
            }));
        }
        this.verifyRemoteDtls(fromUser, envelope.sdp || '');
        await this.enableMediaWithRemote(fromUser, extractE2ee(envelope.sdp || ''));
    }

    private async handleIncomingIceCandidate(fromUser: UserId, candidateJson: string) {
        const candidate = JSON.parse(candidateJson) as RTCIceCandidateInit;
        const peer = this.peers.get(fromUser);
        if (peer && peer.connection.remoteDescription) {
            try {
                await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                // A candidate for an offer we (impolite) ignored is expected to
                // fail; only surface unexpected errors.
                if (!peer.ignoreOffer) console.warn('[WebRTC] addIceCandidate failed:', err);
            }
        } else {
            if (!this.pendingCandidates.has(fromUser)) this.pendingCandidates.set(fromUser, []);
            this.pendingCandidates.get(fromUser)!.push(candidate);
        }
    }

    closePeer(userId: UserId) {
        this.teardownPeer(userId);
    }

    /** Close and forget a peer. keepSignalingChain=true is for callers running
     *  INSIDE the per-peer signaling chain (the connId rebuild path): deleting
     *  the chain entry from within it would let a description arriving
     *  mid-rebuild start a second handler running concurrently with ours. */
    private teardownPeer(userId: UserId, keepSignalingChain = false): void {
        // Bump FIRST: any in-flight build for this user re-checks the
        // generation after its awaits and self-aborts (closes its pc, removes
        // its own insert) instead of resurrecting the peer we're tearing down
        // — including builds still pre-insert, which the voiceEpoch guard
        // alone can't catch for a per-peer teardown.
        this.peerGeneration.set(userId, (this.peerGeneration.get(userId) ?? 0) + 1);
        const peer = this.peers.get(userId);
        if (peer) {
            peer.connection.close();
            this.peers.delete(userId);
        }
        // Held video rode this pc; the announcements are server state and stay.
        this.videoGate.forgetHeld(userId);
        // The control lanes die with the pc; forget them so a rebuilt peer
        // starts from "no capability" rather than inheriting a hello that
        // belonged to a connection that no longer exists.
        if (__RC_ENABLED__) forgetControlChannels(userId);
        if (!keepSignalingChain) this.signalingChains.delete(userId);
        this.pendingCandidates.delete(userId);
        this.peerCreation.delete(userId);
        // Cancel any pending reconnect so it can't rebuild this peer.
        const t = this.reconnectTimeouts.get(userId);
        if (t) clearTimeout(t);
        this.reconnectTimeouts.delete(userId);
        this.reconnectAttempts.delete(userId);
        const st = this.stuckRecoveryTimers.get(userId);
        if (st) clearTimeout(st);
        this.stuckRecoveryTimers.delete(userId);
    }

    closeAll() {
        this.inVoice = false;
        this.videoGate.reset();
        this.voiceEpoch++;
        this.peers.forEach((peer) => peer.connection.close());
        this.peers.clear();
        this.signalingChains.clear();
        this.pendingCandidates.clear();
        // In-flight builds see the bumped voiceEpoch and self-abort (close the
        // pc, don't re-insert) — drop our handles so nothing awaits them.
        this.peerCreation.clear();
        // Cancel every pending reconnect — a stale timer firing after a room
        // change would re-offer to an OLD-room peer and re-mesh us into the
        // channel we just left (the "moved to AFK but still hear the old
        // channel" bug). Previously these were never cleared here.
        this.reconnectTimeouts.forEach((t) => clearTimeout(t));
        this.reconnectTimeouts.clear();
        this.reconnectAttempts.clear();
        this.stuckRecoveryTimers.forEach((t) => clearTimeout(t));
        this.stuckRecoveryTimers.clear();
        this.stuckRebuilds.clear();
        this.peerGeneration.clear();
        this.media.stopLocalStream();
        this.media.stopScreenShare();
        this.media.closeVadContext();
    }

    /** Whether ANY peer entry exists for this user (connected or not). Drives
     *  the "initiate if unmeshed" join logic in VoicePanel: no entry means no
     *  negotiation is even in flight, so SOMEONE must offer — us. */
    hasPeer(userId: UserId): boolean {
        return this.peers.has(userId);
    }

    isConnectedTo(userId: UserId): boolean {
        return this.peers.get(userId)?.connection.connectionState === 'connected';
    }

    getConnectedPeers(): UserId[] {
        return Array.from(this.peers.entries())
            .filter(([_, peer]) => peer.connection.connectionState === 'connected')
            .map(([userId]) => userId);
    }

    /**
     * Mesh twin of sfuManager's voiceDiagnostics: per-peer signaling + RTP
     * truth, readable AT THE MOMENT something is wrong from a user's own
     * DevTools (`__pucaMeshDiag()`). Voice problems are transient and
     * invisible after the fact — bytesSent/framesEncoded per outbound track
     * and bytesReceived/framesDecoded per inbound track say WHICH side of a
     * silent/black track is lying.
     *
     * Outbound VIDEO additionally reports `limit` (qualityLimitationReason:
     * 'cpu' means the ENCODER is starved — the "stream is laggy until the
     * game is tabbed out" signature — vs 'bandwidth' for a network cap),
     * `limitDurations` (seconds spent in each state) and `encoder`
     * (encoderImplementation: libvpx = software, MediaFoundation/NVENC =
     * hardware); inbound video reports `decoder`. A 2026-08-20 field report
     * could not be attributed because these were dropped here.
     */
    async meshDiagnostics(): Promise<Record<string, unknown>[]> {
        const out: Record<string, unknown>[] = [];
        for (const [userId, peer] of this.peers) {
            const pc = peer.connection;
            const rtp: Record<string, unknown>[] = [];
            try {
                const stats = await pc.getStats();
                stats.forEach((s) => {
                    if (s.type === 'outbound-rtp' || s.type === 'inbound-rtp') {
                        const r = s as unknown as Record<string, unknown>;
                        rtp.push({
                            dir: s.type, kind: r.kind,
                            bytes: r.bytesSent ?? r.bytesReceived,
                            frames: r.framesEncoded ?? r.framesDecoded,
                            fps: r.framesPerSecond,
                            // undefined for audio (and pre-first-frame); the
                            // spread keeps audio entries free of noise keys.
                            ...(r.qualityLimitationReason !== undefined && {
                                limit: r.qualityLimitationReason,
                                limitDurations: r.qualityLimitationDurations,
                            }),
                            ...(r.encoderImplementation !== undefined && { encoder: r.encoderImplementation }),
                            ...(r.decoderImplementation !== undefined && { decoder: r.decoderImplementation }),
                        });
                    }
                });
            } catch { /* pc closed mid-iteration */ }
            out.push({
                userId,
                connId: peer.connId.slice(0, 8),
                signaling: pc.signalingState,
                connection: pc.connectionState,
                senders: pc.getSenders().map(s => s.track
                    ? `${s.track.kind}:${s.track.readyState}${s.track.enabled ? '' : ':disabled'}`
                    : 'null'),
                rtp,
            });
        }
        return out;
    }
}
