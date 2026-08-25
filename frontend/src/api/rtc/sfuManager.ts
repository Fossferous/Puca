// Tier-2 SFU path: LiveKit client wrapper that mirrors the mesh manager's
// callback surface, so VoicePanel/StreamStage/VoiceStage work unchanged.
//
// E2EE: the SFU forwards ciphertext only. The media group key is derived from
// the CHANNEL group key (deriveSfuMediaKey) and fed to LiveKit through a
// custom key provider at an epoch-mapped key index. Rotation = a fresh key at
// a new index (never ratchetKey(), which a departed member could replay
// forward). Joining is FAIL-CLOSED: no insertable-streams support or no
// channel key → no SFU call, never a plaintext one.

import {
    BaseKeyProvider,
    ConnectionState,
    Room,
    RoomEvent,
    Track,
    VideoPreset,
    VideoQuality,
    isE2EESupported,
    type RemoteParticipant,
    type RemoteTrack,
    type RemoteTrackPublication,
    type LocalTrackPublication,
} from 'livekit-client';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { apiClient } from '../client';
import { noiseDiagnostics } from '../noiseFilter';
import { ensureChannelKey } from '../channelKeys';
import { deriveSfuMediaKey } from '../e2ee';
import { registerScreenReceiver } from './receiverLatency';
import type { MediaE2eeReason, MediaE2eeStatus, RemoteStreamCallback } from './types';

interface SfuTokenResponse {
    url: string;
    token: string;
    identity: string;
    room: string;
    max_screen_shares: number;
}

// Simulcast ladder — keep in sync with the backend egress model (src/sfu.rs).
const CAM_LOW = new VideoPreset(320, 180, 150_000, 15);
const CAM_MID = new VideoPreset(640, 360, 500_000, 20);
const CAM_HIGH_BITRATE = 2_500_000;
const SHARE_BITRATE = 4_500_000;

/// LiveKit's frame-crypto keyring is 16 slots; epochs map onto it mod-16, so
/// the previous epoch's key survives the switchover window.
const KEYRING_SIZE = 16;
const EPOCH_POLL_MS = 30_000;
/// How long a decrypt failure keeps a participant marked unencrypted. MUST
/// exceed LiveKit's own error-emission suppression window: it throttles to 5
/// errors per 60 s per (identity, reason), so a peer whose frames NEVER decrypt
/// goes quiet for ~55 s at a stretch. A shorter hold would lapse during that
/// silence and flip the badge back to encrypted while every frame is still dropped.
/// Cleared early only by real recovery evidence (a new epoch key) or departure.
const ENCRYPTION_ERROR_HOLD_MS = 90_000;

/** `u<user id>#<per-connection nonce>` → user id (see backend sfu.rs). */
export function userIdFromIdentity(identity: string): number | null {
    const m = /^u(\d+)#/.exec(identity);
    return m ? Number(m[1]) : null;
}

/** Epoch-indexed shared-key provider (ExternalE2EEKeyProvider pins index 0). */
class EpochKeyProvider extends BaseKeyProvider {
    constructor() {
        // Same posture as ExternalE2EEKeyProvider: one shared room key, no
        // auto-ratchet (rotation is explicit, via the channel-key system).
        super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1 });
    }

    async setEpochKey(rawKey: Uint8Array, epoch: number): Promise<void> {
        const material = await crypto.subtle.importKey('raw', rawKey as BufferSource, 'HKDF', false, [
            'deriveBits',
            'deriveKey',
        ]);
        this.onSetEncryptionKey(material, undefined, epoch % KEYRING_SIZE);
    }
}

export class SfuManager {
    private room: Room | null = null;
    private channelId: number | null = null;
    // Unlimited until the join grant says otherwise. The backend defaults to
    // unlimited too (SFU_MAX_SCREEN_SHARES unset/0 → usize::MAX); the guard
    // where the grant is applied keeps a 0-on-the-wire from meaning "refuse
    // every share" (count >= 0 is always true).
    private maxScreenShares = Number.POSITIVE_INFINITY;
    private currentEpoch: number | null = null;
    /** When the media key last changed — used to measure the undecryptable window. */
    private lastEpochChangeAt = Date.now();
    private epochTimer: ReturnType<typeof setInterval> | null = null;
    /** Single-flight guard: concurrent connect() calls coalesce onto one join.
     *  Without it a double-join (auto-join effect racing a manual click) built
     *  TWO Rooms — the loser leaked forever, kept publishing the mic, and the
     *  winner subscribed it → the user heard themselves. */
    private connectPromise: Promise<void> | null = null;
    /** Own user id parsed from the granted identity — used to refuse rendering
     *  media from our OWN other connections (second device / leaked session). */
    private localUserId: number | null = null;

    // --- E2EE evidence for the badge (fail-closed: unknown ⇒ not encrypted) ---
    /** Worker-acked: our own frame ENcryptor is live (RoomEvent.
     *  ParticipantEncryptionStatusChanged for the local participant). */
    private localE2eeActive = false;
    /** identity → worker-acked DEcryptor state for remote participants. */
    private cryptorEnabled = new Map<string, boolean>();
    /** identity → last RoomEvent.EncryptionError (key mismatch/tampering —
     *  those frames are dropped by the cryptor, so media is truly blocked). */
    private encryptionErrorAt = new Map<string, number>();
    /** Held so the EncryptionError handler can trigger an immediate epoch
     *  refresh instead of waiting out the 30 s poll. */
    private keyProvider: EpochKeyProvider | null = null;

    private micPub: LocalTrackPublication | null = null;
    private cameraPub: LocalTrackPublication | null = null;
    private sharePubs: LocalTrackPublication[] = [];

    /** Per-user merged screen-share stream (video + optional share audio). */
    private shareStreams = new Map<number, MediaStream>();
    private focusedUserId: number | null = null;
    /** User ids whose SCREEN SHARE this viewer opted to watch. Streams are
     *  opt-in: the room connects with autoSubscribe:false and syncSubscriptions
     *  subscribes share video/audio only for these users (mics and cameras are
     *  always subscribed — voice must flow and cameras render in the tiles). */
    private watchedVideo = new Set<number>();

    // Callback surface mirroring api/rtc/manager.ts so VoicePanel wires both
    // transports identically.
    private onRemoteStream: RemoteStreamCallback | null = null;
    private onScreenShareStream: RemoteStreamCallback | null = null;
    private onCameraStream: RemoteStreamCallback | null = null;
    /** Fires when a user's camera TRACK is genuinely gone from LiveKit
     *  (unpublish/unsubscribe) — the authoritative "camera ended" signal the
     *  WS CameraStopped broadcast cannot provide (it also fires on a mere WS
     *  blip while the publication lives on). */
    private onCameraEnded: ((userId: number) => void) | null = null;
    private onPeerDisconnected: ((userId: number, terminal: boolean) => void) | null = null;
    private onDisconnected: (() => void) | null = null;
    private onActiveSpeakers: ((userIds: number[]) => void) | null = null;

    setOnRemoteStream(cb: RemoteStreamCallback | null) { this.onRemoteStream = cb; }
    setOnScreenShareStream(cb: RemoteStreamCallback | null) { this.onScreenShareStream = cb; }
    setOnCameraStream(cb: RemoteStreamCallback | null) { this.onCameraStream = cb; }
    setOnCameraEnded(cb: ((userId: number) => void) | null) { this.onCameraEnded = cb; }
    setOnPeerDisconnected(cb: ((userId: number, terminal: boolean) => void) | null) { this.onPeerDisconnected = cb; }
    setOnDisconnected(cb: (() => void) | null) { this.onDisconnected = cb; }
    setOnActiveSpeakers(cb: ((userIds: number[]) => void) | null) { this.onActiveSpeakers = cb; }

    get connected(): boolean {
        return this.room?.state === ConnectionState.Connected;
    }

    /**
     * Join the channel's SFU room. `micTrack` is the mesh-acquired mic track
     * (same noise-suppression pipeline); publishing the SAME track means the
     * existing mute path (track.enabled=false) silences the SFU publication
     * with zero extra wiring. Concurrent calls coalesce; a same-channel call
     * while already connected is a no-op.
     */
    async connect(channelId: number, micTrack: MediaStreamTrack | null): Promise<void> {
        // Wait out any in-flight join (loop: a third caller may queue behind us).
        while (this.connectPromise) {
            await this.connectPromise;
        }
        // The earlier join may already have put us where we're going.
        if (this.room && this.channelId === channelId && this.connected) return;

        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        this.connectPromise = gate;
        try {
            await this.doConnect(channelId, micTrack);
        } finally {
            if (this.connectPromise === gate) this.connectPromise = null;
            release();
        }
    }

    private async doConnect(channelId: number, micTrack: MediaStreamTrack | null): Promise<void> {
        if (this.room) await this.disconnect();
        // Start every join from zero evidence. disconnect() clears these, but a
        // join that FAILED after the worker acked (publish error, aborted
        // mid-connect) leaves this.room null — so the next doConnect skips the
        // disconnect above and would otherwise inherit a stale "our encryptor
        // is live" flag from a dead session.
        this.localE2eeActive = false;
        this.cryptorEnabled.clear();
        this.encryptionErrorAt.clear();

        if (!isE2EESupported()) {
            throw new Error('This device cannot join encrypted SFU calls (no insertable-streams support)');
        }

        // Fail closed BEFORE any media flows: no channel key → no call.
        const ck = await ensureChannelKey(channelId);
        if (!ck) {
            throw new Error('Channel encryption key unavailable — cannot join encrypted call');
        }

        const grant = await apiClient.get<SfuTokenResponse>(`/channels/${channelId}/sfu-token`);
        // 0 (or a missing field) means unlimited, never "refuse every share".
        this.maxScreenShares = grant.max_screen_shares > 0 ? grant.max_screen_shares : Number.POSITIVE_INFINITY;
        this.localUserId = userIdFromIdentity(grant.identity);

        const keyProvider = new EpochKeyProvider();
        this.keyProvider = keyProvider;
        const room = new Room({
            dynacast: true,
            adaptiveStream: false,
            e2ee: { keyProvider, worker: new E2EEWorker() },
            publishDefaults: {
                simulcast: true,
                videoCodec: 'vp8', // AV1/VP9 SVC is incompatible with E2EE
                videoEncoding: { maxBitrate: CAM_HIGH_BITRATE, maxFramerate: 30 },
                videoSimulcastLayers: [CAM_LOW, CAM_MID],
                screenShareEncoding: { maxBitrate: SHARE_BITRATE, maxFramerate: 60 },
                dtx: true,
                red: true,
            },
        });
        this.wireRoomEvents(room);
        // Claim the slot BEFORE the async connect so a hang-up arriving mid-join
        // has something to disconnect (disconnect() nulls this.room — we detect
        // that below and abort rather than resurrect a call the user left).
        this.room = room;
        this.channelId = channelId;

        try {
            await keyProvider.setEpochKey(deriveSfuMediaKey(ck.key, channelId, ck.epoch), ck.epoch);
            this.currentEpoch = ck.epoch;
            await room.setE2EEEnabled(true);
            // Subscriptions are explicit (opt-in streams): syncSubscriptions
            // decides per publication — mics/cameras always, screen shares only
            // for streamers the viewer chose to watch. autoSubscribe would
            // download every share whether or not anyone is watching.
            await room.connect(grant.url, grant.token, { autoSubscribe: false });

            if (this.room !== room) {
                // disconnect() ran while we were connecting: the user left.
                room.removeAllListeners(); // else its handlers keep writing our state
                await room.disconnect();
                return;
            }

            if (micTrack) {
                this.micPub = await room.localParticipant.publishTrack(micTrack, {
                    source: Track.Source.Microphone,
                    dtx: true,
                    red: true,
                    // Voice is mono. WebAudio-processed mic tracks (RNNoise)
                    // report channelCount 2 at publish time, which would make
                    // LiveKit negotiate stereo Opus — transmitting a left-only
                    // defect faithfully and doubling bitrate for nothing. Never
                    // set this in publishDefaults: screen-share game audio must
                    // stay stereo.
                    forceStereo: false,
                });
            }

            // Watch for channel-key epoch changes (member join/leave rotations).
            this.epochTimer = setInterval(() => void this.refreshEpochKey(keyProvider), EPOCH_POLL_MS);
            room.on(RoomEvent.ParticipantConnected, () => void this.refreshEpochKey(keyProvider));
            room.on(RoomEvent.ParticipantDisconnected, () => void this.refreshEpochKey(keyProvider));

            // Subscribe to what's already published (autoSubscribe is off);
            // later publications are handled by the wireRoomEvents hooks.
            this.syncSubscriptions();
        } catch (e) {
            // Never leak a half-built session (a leaked Room keeps publishing
            // the mic forever — the self-echo bug).
            if (this.room === room) {
                this.room = null;
                this.channelId = null;
                this.keyProvider = null;
            }
            room.removeAllListeners();
            await room.disconnect().catch(() => {});
            throw e;
        }
    }

    private async refreshEpochKey(keyProvider: EpochKeyProvider): Promise<void> {
        if (!this.channelId) return;
        try {
            const ck = await ensureChannelKey(this.channelId);
            if (ck && ck.epoch !== this.currentEpoch) {
                // Timestamped: the gap between a peer joining and this line is
                // exactly the window where their audio cannot be decrypted, and
                // it is the number to look at for "their mic took a minute".
                console.info(`[sfu-e2ee] epoch ${this.currentEpoch} -> ${ck.epoch} ` +
                    `after ${Date.now() - this.lastEpochChangeAt}ms`);
                this.lastEpochChangeAt = Date.now();
                await keyProvider.setEpochKey(deriveSfuMediaKey(ck.key, this.channelId, ck.epoch), ck.epoch);
                this.currentEpoch = ck.epoch;
                // Real recovery evidence: past decrypt failures were almost
                // certainly this epoch gap, so let peers prove themselves again
                // under the new key instead of serving out the full hold.
                this.encryptionErrorAt.clear();
            }
        } catch {
            // Transient fetch failure: keep the current epoch; the next poll retries.
        }
    }

    async disconnect(): Promise<void> {
        if (this.epochTimer) {
            clearInterval(this.epochTimer);
            this.epochTimer = null;
        }
        const room = this.room;
        this.room = null;
        this.channelId = null;
        this.currentEpoch = null;
        this.localUserId = null;
        this.micPub = null;
        this.cameraPub = null;
        this.sharePubs = [];
        this.shareStreams.clear();
        this.focusedUserId = null;
        this.watchedVideo.clear();
        this.localE2eeActive = false;
        this.cryptorEnabled.clear();
        this.encryptionErrorAt.clear();
        this.keyProvider = null;
        if (room) {
            room.removeAllListeners();
            await room.disconnect();
        }
    }

    // --- local media -------------------------------------------------------

    /**
     * Swap the published mic track for a fresh one (used when the noise-suppression
     * mode changes mid-call — reacquireAudioTrack stops the old track and mints a
     * new one). Without this the mesh's replaceTrack only rewired mesh peers, so on
     * an SFU call the LiveKit publication kept an ended track and the user went
     * silent to the whole room. Republish under the same source.
     */
    async replaceMicTrack(newTrack: MediaStreamTrack): Promise<void> {
        if (!this.room) return;
        if (this.micPub?.track) {
            await this.room.localParticipant.unpublishTrack(this.micPub.track.mediaStreamTrack, false);
        }
        this.micPub = await this.room.localParticipant.publishTrack(newTrack, {
            source: Track.Source.Microphone,
            dtx: true,
            red: true,
            forceStereo: false, // mono voice — see the initial mic publish
        });
    }

    /** Swap the published camera track (mid-call camera flip). No-op if no camera. */
    async replaceCameraTrack(newTrack: MediaStreamTrack): Promise<void> {
        if (!this.room || !this.cameraPub) return;
        if (this.cameraPub.track) {
            await this.room.localParticipant.unpublishTrack(this.cameraPub.track.mediaStreamTrack, true);
        }
        this.cameraPub = await this.room.localParticipant.publishTrack(newTrack, {
            source: Track.Source.Camera,
            simulcast: true,
        });
    }

    async publishCamera(track: MediaStreamTrack): Promise<void> {
        if (!this.room) return;
        this.cameraPub = await this.room.localParticipant.publishTrack(track, {
            source: Track.Source.Camera,
            simulcast: true,
        });
    }

    async unpublishCamera(): Promise<void> {
        if (this.room && this.cameraPub?.track) {
            await this.room.localParticipant.unpublishTrack(this.cameraPub.track.mediaStreamTrack, true);
        }
        this.cameraPub = null;
    }

    /** Live screen-shares in the room (local + remote) — backs the share cap. */
    activeScreenShareCount(): number {
        if (!this.room) return 0;
        let count = this.room.localParticipant
            .getTrackPublications()
            .filter((p) => p.source === Track.Source.ScreenShare).length;
        for (const p of this.room.remoteParticipants.values()) {
            count += [...p.trackPublications.values()].filter(
                (pub) => pub.source === Track.Source.ScreenShare,
            ).length;
        }
        return count;
    }

    /**
     * Publish a screen-share stream (video + optional audio), capped at
     * SHARE_BITRATE. Refuses past the room share cap — the admission budget
     * charges shares at full rate, so exceeding it would push the node over
     * its uplink envelope.
     */
    async startScreenShare(stream: MediaStream): Promise<void> {
        if (!this.room) throw new Error('Not connected to SFU');
        if (this.activeScreenShareCount() >= this.maxScreenShares) {
            throw new Error(`Share limit reached (${this.maxScreenShares} concurrent screen shares)`);
        }
        const video = stream.getVideoTracks()[0];
        if (video) {
            this.sharePubs.push(
                await this.room.localParticipant.publishTrack(video, {
                    source: Track.Source.ScreenShare,
                    simulcast: false,
                    // H.264 is hardware-accelerated on almost every device and
                    // produces noticeably smoother output for fast-motion content
                    // (games) than VP8, which is CPU-only on most machines.
                    videoCodec: 'h264',
                    videoEncoding: {
                        maxBitrate: SHARE_BITRATE,
                        maxFramerate: 60,
                    },
                    // Under congestion, drop quality (resolution) not framerate.
                    // A choppy game stream is worse than a blurry one.
                    degradationPreference: 'maintain-framerate',
                }),
            );
        }
        const audio = stream.getAudioTracks()[0];
        if (audio) {
            this.sharePubs.push(
                await this.room.localParticipant.publishTrack(audio, {
                    source: Track.Source.ScreenShareAudio,
                    dtx: true,
                }),
            );
        }
    }

    async stopScreenShare(): Promise<void> {
        if (!this.room) return;
        for (const pub of this.sharePubs) {
            if (pub.track) {
                await this.room.localParticipant.unpublishTrack(pub.track.mediaStreamTrack, false);
            }
        }
        this.sharePubs = [];
    }

    // --- subscription / layer policy ---------------------------------------

    /**
     * Focus policy (§5.2 of the SFU design): the focused user's video pulls the
     * HIGH simulcast layer, everyone else's stays LOW. StreamStage calls this
     * via voiceState when its focus changes.
     */
    setFocusedRemote(userId: number | null): void {
        this.focusedUserId = userId;
        if (!this.room) return;
        for (const participant of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(participant.identity);
            const quality = uid !== null && uid === userId ? VideoQuality.HIGH : VideoQuality.LOW;
            for (const pub of participant.trackPublications.values()) {
                // Only subscribed publications: with autoSubscribe off,
                // setVideoQuality on an unsubscribed pub warn-logs uselessly.
                if (pub.kind === 'video' && pub.isSubscribed) pub.setVideoQuality(quality);
            }
        }
    }

    /**
     * Whether this user still has a live participant in the LiveKit room.
     * VoicePanel uses it to ignore a server StreamStopped for a peer whose
     * media session is demonstrably alive (their app WS blipped, LiveKit
     * didn't): tearing down their audio element would silence them
     * PERMANENTLY, because in an SFU room the element is only ever created on
     * a TrackSubscribed — which never re-fires for a surviving session.
     */
    hasParticipant(userId: number): boolean {
        if (!this.room) return false;
        for (const p of this.room.remoteParticipants.values()) {
            if (userIdFromIdentity(p.identity) === userId) return true;
        }
        return false;
    }

    /** Whether the user still has a live CAMERA publication in the LiveKit
     *  room. Used to ignore a CameraStopped that was really just the sender's
     *  WS blipping (server releases media claims on disconnect) — tearing the
     *  tile down then loses the feed permanently, exactly like the audio
     *  case. A genuine camera-off unpublishes first, so this reads false. */
    hasCameraPublication(userId: number): boolean {
        if (!this.room) return false;
        for (const p of this.room.remoteParticipants.values()) {
            if (userIdFromIdentity(p.identity) !== userId) continue;
            for (const pub of p.trackPublications.values()) {
                if (pub.source === Track.Source.Camera) return true;
            }
        }
        return false;
    }

    /**
     * Set which users' screen shares this viewer is watching, then reconcile
     * LiveKit subscriptions. Driven by VoicePanel's selectedStreams sync
     * effect, so every Watch / stop-watching click starts or stops the actual
     * download — not just the rendering.
     */
    setWatchedVideo(userIds: Iterable<number>): void {
        this.watchedVideo = new Set(userIds);
        this.syncSubscriptions();
    }

    /**
     * Reconcile every remote publication against policy (the room connects
     * with autoSubscribe:false): mics and cameras always subscribed — voice
     * must flow and cameras render in the voice-stage tiles — screen share
     * video+audio only for users in watchedVideo. Own-uid participants (a
     * second device / unreaped session) and participants dropped by the E2EE
     * fail-closed path stay unsubscribed.
     */
    private syncSubscriptions(): void {
        if (!this.room) return;
        for (const participant of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(participant.identity);
            if (uid === null || uid === this.localUserId) continue;
            // dropUnencryptedParticipant unsubscribed them for a reason; only
            // a fresh worker ack (cryptorEnabled → true) re-admits.
            if (this.cryptorEnabled.get(participant.identity) === false) continue;
            for (const pub of participant.trackPublications.values()) {
                const wanted =
                    pub.source === Track.Source.Microphone ||
                    pub.source === Track.Source.Camera ||
                    ((pub.source === Track.Source.ScreenShare ||
                        pub.source === Track.Source.ScreenShareAudio) &&
                        this.watchedVideo.has(uid));
                try {
                    // Unconditional: setSubscribed sets DESIRED state while
                    // isSubscribed reports ACTUAL (track present). Gating on
                    // the getter let an unwatch issued before the track
                    // arrived be skipped — leaking the subscription.
                    pub.setSubscribed(wanted);
                } catch { /* track vanished mid-iteration */ }
            }
        }
    }

    /**
     * FAIL-CLOSED, CONTINUOUSLY: stop rendering a participant whose frame
     * decryptor LiveKit just disabled. That happens when any publication of
     * theirs is flagged Encryption_Type.NONE — and the decryptor is per
     * PARTICIPANT, so from that moment ALL of their tracks (including ones we
     * already attached under the subscribe-time guard) would pass through to
     * the output as plaintext. Unsubscribe and tear down what's rendered; they
     * are re-admitted only by a fresh TrackSubscribed that passes the guard.
     */
    private dropUnencryptedParticipant(identity: string): void {
        const uid = userIdFromIdentity(identity);
        if (uid === null || uid === this.localUserId) return;
        console.warn('[sfu] participant is publishing unencrypted media — dropping their tracks:', identity);
        const participant = this.room?.remoteParticipants.get(identity);
        for (const pub of participant?.trackPublications.values() ?? []) {
            try { pub.setSubscribed(false); } catch { /* already gone */ }
        }
        this.shareStreams.delete(uid);
        this.onScreenShareStream?.(uid, new MediaStream());
        this.onPeerDisconnected?.(uid, true); // LiveKit only fires this after its own retries
    }

    // --- E2EE status (shape/semantics mirror api/rtc/manager.ts) -----------

    /** FAIL-CLOSED per-connection verdict: encrypted only on positive
     *  evidence — no recent decrypt errors, every publication flagged
     *  encrypted, at least one publication, our encryptor live, and the
     *  worker acked a decryptor for this identity. Unknown ⇒ not encrypted.
     *  (A pub-less participant reads 'negotiating' indefinitely — accepted:
     *  that's the fail-closed direction, never a false lock.) */
    /**
     * Everything known about why voice is or is not working right now.
     *
     * All of this was already computed for the lock badge and thrown away, so a
     * user whose mic "does not work" had nothing to report but the symptom.
     * Exposed on `window.__pucaVoiceDiag()` so it can be read from
     * DevTools at the moment the problem is happening, which is the only time
     * the state is meaningful.
     *
     * `reason` per peer is the useful field:
     *   negotiating         — key/decryptor not ready yet (the "takes a minute" case)
     *   verification-failed — frames arriving but failing to decrypt: EPOCH MISMATCH
     *   peer-unencrypted    — they are publishing in the clear
     *   encrypted           — working
     */
    async voiceDiagnostics(): Promise<Record<string, unknown>> {
        const room = this.room;
        // Outbound RTP truth per local publication (mic / camera / share),
        // same entry shape as meshDiagnostics so the two paths read side by
        // side. `limit` (qualityLimitationReason) names the starved resource
        // directly — 'cpu' means the ENCODER is starved (the "stream is laggy
        // until the game is tabbed out" signature), 'bandwidth' a network cap
        // — and `encoder` (encoderImplementation) says software (libvpx) vs
        // hardware (MediaFoundation/NVENC).
        const localRtp: Record<string, unknown>[] = [];
        for (const pub of room?.localParticipant.trackPublications.values() ?? []) {
            const sender = pub.track?.sender;
            if (!sender) continue;
            try {
                const stats = await sender.getStats();
                stats.forEach((s) => {
                    if (s.type !== 'outbound-rtp') return;
                    const r = s as unknown as Record<string, unknown>;
                    localRtp.push({
                        source: String(pub.source), kind: r.kind,
                        // Simulcast (camera) yields one entry per layer.
                        ...(r.rid !== undefined && { rid: r.rid }),
                        bytes: r.bytesSent, frames: r.framesEncoded, fps: r.framesPerSecond,
                        // undefined for audio (and pre-first-frame); the
                        // spread keeps audio entries free of noise keys.
                        ...(r.qualityLimitationReason !== undefined && {
                            limit: r.qualityLimitationReason,
                            limitDurations: r.qualityLimitationDurations,
                        }),
                        ...(r.encoderImplementation !== undefined && { encoder: r.encoderImplementation }),
                    });
                });
            } catch { /* sender detached mid-iteration */ }
        }
        return {
            connected: !!room,
            localRtp,
            // Noise-suppression state. "RNNoise isn't working" reports had no
            // evidence to attach before this: read `noise.modeNeedsGraph` with
            // `noise.graphLive` — true/false together means the graph failed to
            // build and NOTHING is suppressing, because native NS is off in the
            // ML modes.
            noise: noiseDiagnostics(),
            channelId: this.channelId,
            myEpoch: this.currentEpoch,
            msSinceEpochChange: Date.now() - this.lastEpochChangeAt,
            myEncryptorLive: this.localE2eeActive,
            myMicPublished: !!this.micPub,
            myMicMuted: this.micPub?.isMuted ?? null,
            peers: room ? [...room.remoteParticipants.values()].map(p => {
                const verdict = this.participantE2ee(p);
                const failedAt = this.encryptionErrorAt.get(p.identity);
                return {
                    identity: p.identity,
                    reason: verdict.reason,
                    encrypted: verdict.encrypted,
                    decryptorAcked: this.cryptorEnabled.get(p.identity) ?? false,
                    msSinceDecryptError: failedAt ? Date.now() - failedAt : null,
                    publications: [...p.trackPublications.values()].map(pub => ({
                        source: String(pub.source),
                        subscribed: pub.isSubscribed,
                        muted: pub.isMuted,
                        encrypted: pub.isEncrypted,
                    })),
                };
            }) : [],
        };
    }

    private participantE2ee(p: RemoteParticipant): { encrypted: boolean; reason: MediaE2eeReason } {
        const failedAt = this.encryptionErrorAt.get(p.identity);
        if (failedAt !== undefined && Date.now() - failedAt < ENCRYPTION_ERROR_HOLD_MS) {
            return { encrypted: false, reason: 'verification-failed' };
        }
        const pubs = [...p.trackPublications.values()];
        if (pubs.some((pub) => !pub.isEncrypted)) {
            return { encrypted: false, reason: 'peer-unencrypted' };
        }
        if (!this.localE2eeActive || pubs.length === 0 || this.cryptorEnabled.get(p.identity) !== true) {
            return { encrypted: false, reason: 'negotiating' };
        }
        return { encrypted: true, reason: 'encrypted' };
    }

    /** Per-user statuses for the voice UI (same shape as webrtcManager.allMediaE2eeStatuses). */
    allMediaE2eeStatuses(): MediaE2eeStatus[] {
        if (!this.room) return [];
        const byUser = new Map<number, { encrypted: boolean; reason: MediaE2eeReason }>();
        for (const p of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(p.identity);
            if (uid === null || uid === this.localUserId) continue;
            const s = this.participantE2ee(p);
            const prev = byUser.get(uid);
            // Multi-connection users collapse to one row; worst connection wins.
            if (!prev || (prev.encrypted && !s.encrypted)) byUser.set(uid, s);
        }
        return [...byUser.entries()].map(([userId, s]) => ({ userId, encrypted: s.encrypted, reason: s.reason, enforced: true }));
    }

    /** Call-wide aggregate (same shape as webrtcManager.mediaEncryptionSummary).
     *  enforced is ALWAYS true: SFU calls are encrypted-only by design — join
     *  fails closed and unencrypted remote publications are refused. */
    mediaEncryptionSummary(): { total: number; encrypted: number; supported: boolean; enforced: boolean } {
        const statuses = this.allMediaE2eeStatuses();
        return {
            total: statuses.length,
            encrypted: statuses.filter((s) => s.encrypted).length,
            supported: isE2EESupported(),
            enforced: true,
        };
    }

    // --- room events ---------------------------------------------------------

    private wireRoomEvents(room: Room): void {
        room
            .on(RoomEvent.TrackSubscribed, (track, pub, participant) =>
                this.handleTrackSubscribed(track, pub, participant),
            )
            .on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
                const uid = userIdFromIdentity(participant.identity);
                if (uid === null) return;
                if (pub.source === Track.Source.ScreenShare) {
                    this.shareStreams.delete(uid);
                }
                // A camera unpublish is the real end-of-camera signal (the WS
                // CameraStopped can be a false positive on a WS blip).
                if (pub.source === Track.Source.Camera && uid !== this.localUserId) {
                    this.onCameraEnded?.(uid);
                }
            })
            .on(RoomEvent.ParticipantDisconnected, (participant) => {
                this.cryptorEnabled.delete(participant.identity);
                this.encryptionErrorAt.delete(participant.identity);
                const uid = userIdFromIdentity(participant.identity);
                if (uid === null || uid === this.localUserId || !this.room) return;
                // Only report the USER gone when their last connection left.
                const stillHere = [...this.room.remoteParticipants.values()].some(
                    (p) => userIdFromIdentity(p.identity) === uid,
                );
                if (!stillHere) {
                    this.shareStreams.delete(uid);
                    this.onPeerDisconnected?.(uid, true); // LiveKit only fires this after its own retries
                }
            })
            .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
                const ids = speakers
                    .map((s) => userIdFromIdentity(s.identity))
                    .filter((id): id is number => id !== null);
                this.onActiveSpeakers?.(ids);
            })
            .on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled, participant) => {
                // Genuine worker ack: the e2ee worker echoes each enable back,
                // i.e. positive evidence the encryptor (local) / decryptor
                // (remote identity) is actually installed.
                if (!participant || participant.identity === room.localParticipant.identity) {
                    this.localE2eeActive = enabled;
                    return;
                }
                this.cryptorEnabled.set(participant.identity, enabled);
                // Deliberately do NOT clear encryptionErrorAt here: LiveKit
                // re-posts an 'enable' ack on every TrackPublished from that
                // participant, so a peer whose media never decrypts could wipe
                // its own downgrade just by starting a camera. Only a fresh
                // epoch (refreshEpochKey) or leaving clears it.
                if (!enabled) this.dropUnencryptedParticipant(participant.identity);
                // Recovery: a re-acked decryptor re-admits them — with
                // autoSubscribe off nothing else would ever re-subscribe.
                else this.syncSubscriptions();
            })
            .on(RoomEvent.EncryptionError, (error, participant) => {
                console.error('[sfu] encryption error:', error);
                if (participant) this.encryptionErrorAt.set(participant.identity, Date.now());
                // Usually an epoch-key mismatch: refresh now instead of waiting
                // out the 30 s poll. Idempotent; throttled upstream (~1/s).
                if (this.keyProvider) void this.refreshEpochKey(this.keyProvider);
            })
            .on(RoomEvent.Disconnected, () => {
                this.onDisconnected?.();
            })
            // autoSubscribe is off: every path that surfaces a new publication
            // (or rebuilds the session) must re-reconcile subscriptions.
            .on(RoomEvent.TrackPublished, () => this.syncSubscriptions())
            .on(RoomEvent.ParticipantConnected, () => this.syncSubscriptions())
            .on(RoomEvent.Reconnected, () => this.syncSubscriptions());
    }

    private handleTrackSubscribed(
        track: RemoteTrack,
        pub: RemoteTrackPublication,
        participant: RemoteParticipant,
    ): void {
        const uid = userIdFromIdentity(participant.identity);
        if (uid === null) return;
        // NEVER render media from our own user id: a "remote" participant with
        // our uid is our own other connection (second device, or a session
        // LiveKit hasn't reaped yet) — attaching it plays the user's own mic
        // back to them.
        if (uid === this.localUserId) return;
        // FAIL-CLOSED receive: every legitimate SFU publication is E2EE (join
        // refuses otherwise). A pub flagged Encryption_Type.NONE (modified/
        // foreign client, or tampered trackInfo) would PLAY AS PLAINTEXT —
        // LiveKit disables that participant's decryptor and passes frames
        // through. Refuse to render; the badge shows them as unencrypted.
        if (!pub.isEncrypted) return;

        switch (pub.source) {
            case Track.Source.Microphone:
                this.onRemoteStream?.(uid, new MediaStream([track.mediaStreamTrack]));
                break;
            case Track.Source.Camera: {
                pub.setVideoQuality(uid === this.focusedUserId ? VideoQuality.HIGH : VideoQuality.LOW);
                this.onCameraStream?.(uid, new MediaStream([track.mediaStreamTrack]));
                break;
            }
            case Track.Source.ScreenShare: {
                pub.setVideoQuality(uid === this.focusedUserId ? VideoQuality.HIGH : VideoQuality.MEDIUM);
                // Remote control needs the receiver in hand to drop its
                // jitter buffer while this share is being DRIVEN (and give it
                // back after) — this subscription is the only moment the SFU
                // path holds the RTCRtpReceiver.
                if (track.kind === Track.Kind.Video) {
                    registerScreenReceiver(uid, track.receiver);
                }
                const stream = this.shareStreams.get(uid) ?? new MediaStream();
                stream.addTrack(track.mediaStreamTrack);
                this.shareStreams.set(uid, stream);
                this.onScreenShareStream?.(uid, stream);
                break;
            }
            case Track.Source.ScreenShareAudio: {
                const stream = this.shareStreams.get(uid) ?? new MediaStream();
                stream.addTrack(track.mediaStreamTrack);
                this.shareStreams.set(uid, stream);
                // Re-emit so the existing element picks up the added audio track.
                this.onScreenShareStream?.(uid, stream);
                break;
            }
            default:
                break;
        }
    }
}

export const sfuManager = new SfuManager();

// Debug hook. Voice problems are transient and invisible after the fact, so the
// state has to be readable AT THE MOMENT it is wrong — from a user's own
// DevTools, without a build or a second person. Run:
//     await __pucaVoiceDiag()
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__pucaVoiceDiag =
        () => sfuManager.voiceDiagnostics();
}
