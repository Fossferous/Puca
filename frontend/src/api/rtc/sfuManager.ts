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
    ParticipantEvent,
    Room,
    RoomEvent,
    Track,
    VideoPreset,
    VideoQuality,
    isE2EESupported,
    setLogLevel,
    type RemoteParticipant,
    type RemoteTrack,
    type RemoteTrackPublication,
    type LocalTrackPublication,
} from 'livekit-client';
import { hasHardwareH264, negotiatedH264Profile, preferHardwareH264ForSender } from './h264Profiles';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { apiClient } from '../client';
import { noiseDiagnostics } from '../noiseFilter';
import { ensureChannelKey } from '../channelKeys';
import { CTL_SFU_TOPIC, deliverSfuControlFrame } from './controlDc';
import type { EncodeSample } from './shareHealth';
import { ShareAdapter, SHARE_ADAPT_INTERVAL_MS } from './shareAdapt';
import { LEGACY_SHARE_KBPS, shareBitrateKbps } from './shareBitrate';
import {
    isSoftwareEncoder, ladderEncodings, ladderRungs, rememberedShareLadder, shareWantsLadder,
    type LadderRung, type ShareLadderMode,
} from './shareLadder';
import type { RtpEndpoint } from './streamStats';
import { deriveSfuMediaKey } from '../e2ee';
import { registerScreenReceiver } from './receiverLatency';
import { loadSettings } from '../../components/settingsStore';
import { receiverHints, summariseInboundAudio, videoSendExtras, summariseRtcStats, summariseRtcStatsDelta, type InboundAudioHealth, type RtcLatencySummary } from './statsSummary';
import type { MediaE2eeReason, MediaE2eeStatus, RemoteStreamCallback } from './types';

interface SfuTokenResponse {
    url: string;
    token: string;
    identity: string;
    room: string;
    max_screen_shares: number;
    /** The most one share may send on this node, kbps (src/sfu.rs
     *  `share_ceiling_kbps`). Absent from a server that predates it. */
    max_share_kbps?: number;
}

/**
 * Which simulcast layer to subscribe a remote video track at.
 *
 * WHY AN UNFOCUSED CAMERA IS NOT `LOW`. It was, and nothing ever raised it:
 * `setFocusedRemote` is called only by StreamStage, the SCREEN-SHARE stage,
 * while the only surface that renders remote cameras is VoiceStage, which
 * focuses nobody. So `focusedUserId` stayed null for the whole of every call
 * and every camera sat on the bottom rung — 320x180 at 150 kbps and 15 fps —
 * upscaled into a tile up to 640x360 CSS px. With dynacast on, the server then
 * tells the publisher to stop encoding the layers nobody subscribed, so those
 * pixels were never produced at all: this is not a subscription preference the
 * renderer could work around. It is the whole of "why does the webcam look so
 * much worse than Discord", whose default is 720p30.
 *
 * MEDIUM is 640x360, which is exactly what the grid gives a tile in a small
 * call, so this asks for the picture actually being displayed and no more. In a
 * bigger grid the tiles really are ~320px wide, so the low rung is right there
 * and the head count is the honest input — see the parameter list.
 *
 * THE SERVER'S ADMISSION ARITHMETIC MUST AGREE: `room_egress_kbps` in
 * src/sfu.rs charges every non-focus subscriber for this rung. Raising it here
 * alone would make the node admit seats whose real egress it under-counted, so
 * CAM_MID_KBPS moved with it in the same change.
 */
export function subscribedQuality(
    source: Track.Source,
    focused: boolean,
    participants: number,
    // How many screen shares this viewer is watching (only read for a share).
    watchedShares = 1,
): VideoQuality {
    if (focused) return VideoQuality.HIGH;
    // A share is the thing people are actually looking at, and its text is
    // unreadable at the bottom rung (SHARE_LOW, 640x360 — this sentence used
    // to say 320x180, which is CAM_LOW and has never been offered for a
    // share). It already asked for MEDIUM at subscribe time; keeping that here
    // stops a focus change silently demoting one, which the old shared ternary
    // did.
    //
    // HIGH WHILE ONE OR TWO SHARES ARE WATCHED (2026-10-21). Only Focus view
    // focuses anyone; the default grid gives one watched share the whole stage
    // and two of them half each, and a share sent at several sizes then
    // arrived at its middle rung (720p, measured in the real app by
    // e2e/share-ladder-live-sfu.mjs) instead of the full picture. That never
    // showed while shares were one size, and Automatic now ladders most
    // hardware-encoded ones. Asking for HIGH is a ceiling, not a demand:
    // LiveKit still gives a viewer whose link cannot carry it a smaller rung,
    // which is what the ladder is for. Admission already charges every watcher
    // the top (src/sfu.rs room_egress_kbps). Three or more in a grid are small
    // tiles, and the middle rung is the picture they show.
    if (source === Track.Source.ScreenShare) {
        return watchedShares <= 2 ? VideoQuality.HIGH : VideoQuality.MEDIUM;
    }
    // A camera's rung follows the size its tile is actually rendered at, which
    // the voice grid derives from the head count (VoiceStage.css: one or two
    // people share a 640px-wide column, three or more get ~300-360px each).
    // So: MEDIUM (640x360) for a small call, LOW (320x180) for a grid, which is
    // roughly the tile size either way and keeps egress inside the node budget.
    return participants <= GRID_MID_MAX_PARTICIPANTS ? VideoQuality.MEDIUM : VideoQuality.LOW;
}

// Simulcast ladder — keep in sync with the backend egress model (src/sfu.rs).
const CAM_LOW = new VideoPreset(320, 180, 150_000, 15);
const CAM_MID = new VideoPreset(640, 360, 500_000, 20);
const CAM_HIGH_BITRATE = 2_500_000;
/// At or below this head count the voice grid gives each tile a wide column, so
/// an unfocused camera is subscribed at the MID rung. Above it the tiles are
/// ~320px and the low rung is the right picture. Mirrored by the backend's
/// admission arithmetic (`room_egress_kbps`, src/sfu.rs) — the two must agree
/// or the node admits seats whose egress it under-counted.
const GRID_MID_MAX_PARTICIPANTS = 4;

/// The two rungs published BELOW a screen share's full picture, lowest first
/// (the order `screenShareSimulcastLayers` documents).
///
/// WHY A SHARE NEEDS A LADDER AT ALL. Until now shares were published
/// `simulcast: false` — one encoding, and therefore nothing smaller for the
/// server to give a subscriber who cannot carry it. Everything LiveKit does for
/// a struggling viewer is choosing a lower layer, so with one layer it has no
/// move to make: the viewer is sent the same bytes as everyone else and loses
/// whatever their bottleneck drops. Measured from a real call on 2026-09-08,
/// one viewer on a weak link watching a 1080p share:
///
///   size 1920x1080, fps 2, framesReceived 12 in 5 s, framesDropped 0,
///   packetsLost 899, nack 394, freezeMs 8481, decodeMs 2.6 (hardware)
///
/// Nothing was wrong with their machine — the decoder was idle at 2.6 ms a
/// frame — and nothing had adapted on their behalf. The frames simply never
/// arrived whole. Two smaller rungs give the server something to fall back to.
///
/// WHY IT IS OFF BY DEFAULT ANYWAY. The measurement that justified it
/// (frontend/e2e/share-ramp-2pc.mjs: h264 sustaining three rungs at 56/56/16
/// fps where VP8 collapsed to 19/7/4) was taken in headless Edge, which used a
/// HARDWARE H.264 encoder. Until 2026-09-16 the shipped app never got one:
/// every `stream-diag` line in the field read `encoder=OpenH264`, because the
/// negotiation landed on Constrained Baseline, the one profile Chromium's
/// hardware factory does not claim (h264Profiles.ts has the measurement and
/// the fix). Machines with a hardware encoder now get it; machines without
/// one still pay three software encodes for the ladder, and those are the
/// ones already reporting that sharing makes their game stutter. So the
/// ladder stayed offered, not imposed.
///
/// 2026-10-21: AUTOMATIC FOR HARDWARE ENCODERS. With the share's bitrate
/// following its quality (10 Mbps for 1080p60), more viewers are below a
/// one-size share and freeze. Measured with the app's own encoder choice:
/// three rungs on NVENC cost no CPU limit. So `shareLadder` defaults to
/// Automatic: a ladder when the machine offers a hardware encoder AND the
/// share sends more than 4.5 Mbps, still never on a software-only machine
/// (shareLadder.ts; the software fallback is startSoftwareWatch below).
///
/// THE TOP RUNG IS THE SHARE'S OWN BITRATE (shareBitrate.ts, held to the
/// server's `max_share_kbps`), and a subscriber only ever receives ONE rung,
/// so the backend's per-subscriber charge (the node's share ceiling, src/sfu.rs
/// `room_egress_kbps`) stays the correct worst case.
///
/// 640x360 AND NOT 480x270, WHICH IS WHAT THIS WAS. Chromium refuses to use a
/// hardware encoder below 360 lines, on purpose and regardless of the card:
/// `kForceSoftwareForRtcLowResolutions` in rtc_video_encoder.cc, whose
/// `force_sw_height` is 360 (270 for AV1). Measured 2026-09-09 on an RTX 4080
/// SUPER with a real capture, H.264, bitrate pinned so congestion could not be
/// the explanation:
///
///     1280x720  -> NVIDIA H.264 Encoder MFT
///     640x360   -> NVIDIA H.264 Encoder MFT
///     576x324   -> OpenH264          (and downscaled again, to 384x216)
///     480x270   -> OpenH264          (downscaled to 320x180)
///
/// and with `--disable-features=ForceSoftwareForRtcLowResolutions` as a
/// positive control, ALL FIVE moved to the hardware encoder. So the old bottom
/// rung was software by design on every machine, forever, and one step up
/// makes it hardware-eligible for nothing. The rule exists because hardware
/// encoders look bad at tiny sizes — which is an argument for staying above
/// the line, not below it.
///
/// THE RUNGS NOW LIVE IN shareLadder.ts (LADDER_LOW is this 640x360), with the
/// middle rung chosen by the capture: 720p at 2.5 Mbps from a 1080-line
/// capture up, 540p below. Measured 2026-10-21: a 6 Mbps viewer of a 10 Mbps
/// share settled on 720p @ ~57 fps with it, against 540p with the old rung.
/// And the ladder is no longer only opt-in: see `shareLadder` in
/// settingsStore.ts and shareLadder.ts for when Automatic turns it on.
const preset = (r: LadderRung) => new VideoPreset(r.width, r.height, r.kbps * 1000, r.fps);
/** The rungs below the full picture for a capture of this size, lowest first. */
function ladderPresets(width: number, height: number): VideoPreset[] {
    return ladderRungs(width, height).map(preset);
}

/** Does this machine offer a hardware H.264 encoder? The SENDER's capabilities
 *  carry a High-profile entry only when one is there (h264Profiles.ts). */
export function machineHasHardwareH264(): boolean {
    try {
        const caps = typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function'
            ? RTCRtpSender.getCapabilities('video')
            : null;
        return !!caps && hasHardwareH264(caps.codecs);
    } catch {
        return false;
    }
}

/** How often an Automatic ladder's encoder is checked after it starts, how
 *  many software readings drop the ladder, how many hardware readings end the
 *  watch, and when it gives up waiting for a name at all. */
const SOFTWARE_WATCH_MS = 3000;
const SOFTWARE_READS = 2;
const HARDWARE_READS = 3;
const SOFTWARE_WATCH_MAX_MS = 60_000;

/**
 * Everything about how a screen share is published, as a value.
 *
 * Pulled out of `startScreenShare` so the contract can be asserted without a
 * live room and a real track — the same reason `subscribedQuality` is a
 * function rather than an expression inside the subscribe handler. Every field
 * here has a measurement or an incident behind it; the test next door pins the
 * ones that would fail silently.
 */
export function screenSharePublishOptions(
    // DEFAULTED FROM THE SETTING rather than passed by the caller: one call
    // site today, and a second one that forgot to read it would silently
    // publish the ladder for someone who had NOT turned it on. Tests pass the
    // value explicitly.
    //
    // `=== true`, not `!== false`: the default is OFF, so an absent or
    // malformed stored value must read as off. The inverted form was correct
    // while the default was on and would now quietly opt everyone in.
    //
    // Unset = the setting's own answer (shareLadder.ts): Always, Never, or
    // Automatic — a ladder only on a machine with a hardware H.264 encoder
    // and a share above 4.5 Mbps.
    simulcast?: boolean,
    // The share's ceiling, bps: what its quality may spend (shareBitrate.ts),
    // already held to the server's. The default is what a share sent before
    // the bitrate followed the quality.
    maxBitrate: number = LEGACY_SHARE_KBPS * 1000,
    // The capture's size, which picks the ladder's middle rung.
    capture: { width: number; height: number } = { width: 1920, height: 1080 },
) {
    const ladder = simulcast ?? shareWantsLadder(
        rememberedShareLadder(loadSettings()), machineHasHardwareH264(), maxBitrate / 1000,
    );
    const opts: {
        source: Track.Source;
        simulcast: boolean;
        screenShareSimulcastLayers?: VideoPreset[];
        videoCodec: 'h264';
        screenShareEncoding: { maxBitrate: number; maxFramerate: number };
        degradationPreference: 'maintain-framerate' | 'maintain-resolution';
    } = {
        source: Track.Source.ScreenShare,
        // Three rungs, so the server has something to give a viewer who cannot
        // take the full picture. See shareLadder.ts — and `shareLadder` in
        // settingsStore.ts for when that happens and who can decline the cost.
        simulcast: ladder,
        // H.264 because it is the cheapest thing this engine will encode for
        // fast-motion content, and — since 2026-09-16 — because it is the one
        // codec here that CAN be hardware-accelerated: with the High profile
        // leading the offer (preferHardwareH264, h264Profiles.ts) a machine
        // with an NVENC/AMF/QuickSync encoder uses it. Before that every field
        // log read `encoder=OpenH264`, a profile-negotiation accident, not a
        // property of the app. VP8 is software on every Windows machine and
        // markedly worse: 19 fps against h264's 56 on the same ladder and
        // machine.
        videoCodec: 'h264' as const,
        // `screenShareEncoding`, NOT `videoEncoding`: for a ScreenShare source
        // livekit-client replaces videoEncoding with screenShareEncoding
        // (computeVideoEncodings, publishUtils.ts) and falls back to the
        // room's publishDefaults for it. Until 2026-10-20 this field was
        // `videoEncoding`, ignored, and the cap really came from the room
        // defaults — which happened to hold the same 4.5 Mbps.
        screenShareEncoding: {
            maxBitrate,
            maxFramerate: 60,
        },
        // Under congestion, drop quality (resolution) not framerate.
        // A choppy game stream is worse than a blurry one.
        //
        // WORTH KNOWING WHAT THIS COSTS AT A LOW CAP. Measured with
        // frontend/e2e/encode-cost.mjs at the old single 4.5 Mbps cap: 1080p60
        // and 1440p60 could not hold their resolution under this preference
        // and settled at 1280x720. The cap now follows the quality
        // (shareBitrate.ts), on a server whose ceiling allows it.
        degradationPreference: 'maintain-framerate',
    };
    // WITHOUT A LADDER PÚCA PICKS THE RESOLUTION (shareAdapt.ts), so libwebrtc
    // must hold whatever it was given and spend a shortage on frames instead.
    // Left on 'maintain-framerate' it shrank a collapsed share to 310x180 and
    // kept it there (2026-10-05), and it would shrink the picture again under
    // every rung Púca chose. A laddered share keeps it: LiveKit fixes those
    // rungs as ratios of the source, which Púca must not rescale.
    if (!ladder) opts.degradationPreference = 'maintain-resolution';
    // Omitted rather than sent alongside `simulcast: false`: the rungs would
    // be ignored, and a publish that carries layers it is not using is the
    // shape someone later reads as "simulcast is on".
    if (ladder) opts.screenShareSimulcastLayers = ladderPresets(capture.width, capture.height);
    return opts;
}

/**
 * Encode the share at `height` lines out of a `sourceHeight`-line capture,
 * holding that resolution (shareAdapt.ts), at no more than `maxKbps` when
 * given (shareBitrate.ts). The capture itself is untouched: the person's own
 * preview, a clip and a later live quality change all still see the full
 * picture.
 */
export async function applyShareHeight(sender: RTCRtpSender, sourceHeight: number, height: number, maxKbps?: number): Promise<void> {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    if (!params.encodings || params.encodings.length === 0) return;
    params.encodings[0].scaleResolutionDownBy = Math.max(1, sourceHeight / height);
    if (maxKbps !== undefined) params.encodings[0].maxBitrate = maxKbps * 1000;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
}

/** The single-layer share sender's current cap, bps, or undefined. */
function senderMaxBitrate(sender: RTCRtpSender): number | undefined {
    try {
        return sender.getParameters().encodings?.[0]?.maxBitrate;
    } catch {
        return undefined;
    }
}

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

/** The shape `publicationsHaveLadder` needs: enough of a LocalTrackPublication
 *  to find the sender's encodings, and nothing else. */
export interface LadderProbe {
    kind: unknown;
    track?: { sender?: { getParameters(): { encodings?: unknown[] } } | null } | null;
}

/**
 * Does any of these publications carry more than one encoding?
 *
 * Lifted out of the class so the decision can be tested without a live room —
 * it decides how a running share follows a re-cap (its rungs re-sized in
 * place, or the share published again: retuneShare) and keeps the one-size
 * resolution picker off a ladder, and it FAILS OPEN: every answer that is not
 * a positive sighting of a ladder is `false`. (Wrongly false now costs a
 * re-publish, a second of held picture; it used to permit a re-cap that took
 * the rungs under 360 lines.) That direction is deliberate but only safe because the caller now
 * reads LIVE publications; when it read a stale snapshot, a reconnect turned
 * "cannot see a ladder" into "there is no ladder" while three rungs were on the
 * wire. Keep the two properties together: live input, and a test that a real
 * ladder is actually seen.
 */
export function publicationsHaveLadder(pubs: Iterable<LadderProbe>): boolean {
    for (const pub of pubs) {
        if (pub.kind !== Track.Kind.Video) continue;
        const sender = pub.track?.sender;
        if (!sender) continue;
        try {
            if ((sender.getParameters().encodings ?? []).length > 1) return true;
        } catch { /* sender detached mid-read */ }
    }
    return false;
}

/** `TrackSource.MICROPHONE` in @livekit/protocol (the grant's canPublishSources
 *  carries these proto values). livekit-client does not re-export the enum;
 *  sfuSpeakGrant.test.ts pins this against it. */
export const MIC_PROTO_SOURCE = 2;

/**
 * May this grant publish a MICROPHONE? The same rule livekit-client applies
 * before it throws PublishTrackError 403 (LocalParticipant.hasPermissionsToPublish):
 * canPublish, and either no source list or one that names the microphone.
 * The backend mints the microphone source from SPEAK only (sfu.rs
 * publish_sources), so a member without SPEAK gets canPublish=true with
 * [camera, screen_share, ...] when they keep VIDEO/STREAM — checking
 * canPublish alone would still 403. No permissions yet = not allowed, as
 * livekit-client itself treats it.
 */
export function micPublishAllowed(
    perms: { canPublish?: boolean; canPublishSources?: readonly number[] } | undefined | null,
): boolean {
    if (!perms || !perms.canPublish) return false;
    const sources = perms.canPublishSources ?? [];
    return sources.length === 0 || sources.includes(MIC_PROTO_SOURCE);
}

/**
 * May this grant subscribe to anything? False for a NO_RECEIVE member
 * (docs/STREAM_ONLY.md), whose join token says canSubscribe: false and whom
 * LiveKit forwards nothing; their client then asks for nothing either. An
 * absent grant (not joined yet) or field reads as allowed, as LiveKit's own
 * default is.
 */
export function subscribeAllowed(perms: { canSubscribe?: boolean } | undefined | null): boolean {
    return perms?.canSubscribe !== false;
}

/**
 * Keep the mute / push-to-talk gate shut while livekit-client publishes a
 * microphone track. Returns the release.
 *
 * Púca gates the mic with MediaStreamTrack.enabled (VoicePanel applyMicGate
 * -> setAudioEnabled). livekit-client wraps a published MediaStreamTrack in a
 * fresh LocalAudioTrack whose constructor re-syncs `enabled` to ITS OWN mute
 * state (LocalTrack.setMediaStreamTrack: `enabled = !this.isMuted`), and a
 * new LocalAudioTrack is unmuted. So every publish of a shut mic opened it:
 * measured live (headless Edge, fake devices) on 2026-10-08, a push-to-talk
 * member joining an SFU call went out ENABLED and stayed so until their
 * first key press (the listener received audio energy 1.66, an open mic
 * 1.59, push-to-talk on mesh 0: e2e/sfu-mic-gate-live.mjs), and a muted
 * member's mic re-published mid-call (noise mode, a lost device, following
 * the OS default) was open until VoicePanel re-gated it after the publish.
 *
 * While held, the gate can close but not open: a write of `false` goes
 * through (a mute during the publish), a write of `true` is dropped
 * (livekit-client's re-sync, or a push-to-talk press during the publish,
 * which VoicePanel re-asserts as soon as the publish is done). A track whose
 * `enabled` is not the platform's prototype accessor is left alone.
 */
export function holdMicGateWhilePublishing(track: MediaStreamTrack): () => void {
    if (Object.prototype.hasOwnProperty.call(track, 'enabled')) return () => { /* already held, or not a real track */ };
    let proto: object | null = Object.getPrototypeOf(track);
    let desc: PropertyDescriptor | undefined;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'enabled'))) proto = Object.getPrototypeOf(proto);
    const get = desc?.get;
    const set = desc?.set;
    if (!get || !set) return () => { /* nothing to hold */ };
    Object.defineProperty(track, 'enabled', {
        configurable: true,
        enumerable: true,
        get() { return get.call(track); },
        set(on: boolean) { if (!on || get.call(track)) set.call(track, on); },
    });
    return () => { delete (track as unknown as { enabled?: boolean }).enabled; };
}

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
    /** The node's ceiling for one share, kbps (SfuTokenResponse.max_share_kbps).
     *  0 = the server named none: shareBitrateKbps then keeps the old cap. */
    private maxShareKbps = 0;
    private currentEpoch: number | null = null;
    /** Our sender is parked on a throwaway key because ensureChannelKey
     *  refused the current epoch (see refreshEpochKey). */
    private senderMutedByKeyRefusal = false;
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
    /**
     * The screen-share publications THIS CLIENT currently has, read from the
     * room every time.
     *
     * THIS USED TO BE A SNAPSHOT ARRAY (`sharePubs`), pushed to at publish time
     * and cleared at stop. That is wrong across a LiveKit reconnect: a signal
     * restart makes the client republish every local track, which unpublishes
     * the old publication — its last act being `publication.setTrack(undefined)`
     * — and constructs a NEW LocalTrackPublication the snapshot never learns
     * about. Nothing here subscribes to `LocalTrackPublished`, and the
     * `Reconnected` handler only syncs REMOTE subscriptions.
     *
     * So after one Wi-Fi blip mid-share, every entry in the snapshot had a
     * detached track and all three readers silently changed behaviour:
     * `shareEncodeSample` returned null forever (the CPU-limit watch stopped
     * sampling and would never speak again), `shareHasLadder` returned false
     * while a three-rung ladder was live (so the guard protecting SHARE_LOW
     * from being re-capped under Chromium's 360-line floor failed OPEN), and
     * `stopScreenShare` unpublished the stale objects and left the real share
     * running.
     *
     * `activeScreenShareCount` above was already doing it this way. This is the
     * same read, and it cannot go stale because it holds nothing.
     *
     * THE MIC AND CAMERA HAD THE IDENTICAL BUG and are fixed the same way — a
     * held `cameraPub` whose track a reconnect had detached made
     * `unpublishCamera` skip its `unpublishTrack` guard entirely and then null
     * the field, so turning the camera OFF left the republished camera
     * publishing to the room with no handle left to stop it.
     */
    private localPubs(...sources: Track.Source[]): LocalTrackPublication[] {
        return (this.room?.localParticipant.getTrackPublications() ?? [])
            .filter((p) => sources.includes(p.source)) as LocalTrackPublication[];
    }

    private localSharePubs(): LocalTrackPublication[] {
        return this.localPubs(Track.Source.ScreenShare, Track.Source.ScreenShareAudio);
    }

    /** Per-user merged screen-share stream (video + optional share audio). */
    private shareStreams = new Map<number, MediaStream>();
    private focusedUserId: number | null = null;
    /** Cameras held at a rung by a surface that is showing one large (the
     *  stream stage's rail, when a tile is fullscreened). Cleared per user when
     *  that surface releases; survives a track re-subscribe, which is the case
     *  it exists for. */
    private pinnedCameras = new Map<number, VideoQuality>();
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

    /** Listeners told whenever who is in the room, or whether we are
     *  connected to it, may have changed (dfPause.ts: a participant can hear
     *  us from the moment they connect; a reconnecting room is unknown). */
    private participantsListeners = new Set<() => void>();

    /** Hear participants connect and leave, and the room connect, reconnect
     *  or drop. Returns the unsubscribe. */
    onParticipantsChanged(fn: () => void): () => void {
        this.participantsListeners.add(fn);
        return () => { this.participantsListeners.delete(fn); };
    }

    private participantsChanged(): void {
        this.participantsListeners.forEach(fn => { try { fn(); } catch (e) { console.warn('[sfu] participants listener failed:', e); } });
    }

    /**
     * Join the channel's SFU room. `micTrack` is the mesh-acquired mic track
     * (same noise-suppression pipeline); publishing the SAME track means the
     * existing mute path (track.enabled=false) silences the SFU publication
     * with zero extra wiring. Concurrent calls coalesce; a same-channel call
     * while already connected is a no-op.
     */
    async connect(channelId: number, micTrack: MediaStreamTrack | null): Promise<{ micAllowed: boolean }> {
        // Wait out any in-flight join (loop: a third caller may queue behind us).
        while (this.connectPromise) {
            await this.connectPromise;
        }
        // The earlier join may already have put us where we're going.
        if (this.room && this.channelId === channelId && this.connected) return { micAllowed: this.micAllowed() };

        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        this.connectPromise = gate;
        try {
            await this.doConnect(channelId, micTrack);
        } finally {
            if (this.connectPromise === gate) this.connectPromise = null;
            release();
        }
        // Read from the LIVE grant, never a field the join set: a coalesced
        // second caller must get the same answer as the first.
        return { micAllowed: this.micAllowed() };
    }

    /** Does the current session's grant allow publishing a microphone (SPEAK)? */
    micAllowed(): boolean {
        return micPublishAllowed(this.room?.localParticipant.permissions);
    }

    private async doConnect(channelId: number, micTrack: MediaStreamTrack | null): Promise<void> {
        if (this.room) await this.disconnect();
        // Start every join from zero evidence. disconnect() clears these, but a
        // join that FAILED after the worker acked (publish error, aborted
        // mid-connect) leaves this.room null — so the next doConnect skips the
        // disconnect above and would otherwise inherit a stale "our encryptor
        // is live" flag from a dead session.
        this.localE2eeActive = false;
        this.senderMutedByKeyRefusal = false;
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
        this.maxShareKbps = typeof grant.max_share_kbps === 'number' ? grant.max_share_kbps : 0;
        this.localUserId = userIdFromIdentity(grant.identity);

        const keyProvider = new EpochKeyProvider();
        this.keyProvider = keyProvider;
        // LiveKit's default level is `info`, which prints a full stats object to
        // the console every 30 s for the whole call, plus chatter on every
        // track event. The app's own logs say what matters; keep LiveKit to
        // warnings and errors.
        setLogLevel('warn');
        const room = new Room({
            dynacast: true,
            adaptiveStream: false,
            e2ee: { keyProvider, worker: new E2EEWorker() },
            publishDefaults: {
                simulcast: true,
                videoCodec: 'vp8', // AV1/VP9 SVC is incompatible with E2EE
                videoEncoding: { maxBitrate: CAM_HIGH_BITRATE, maxFramerate: 30 },
                videoSimulcastLayers: [CAM_LOW, CAM_MID],
                // Only a fallback: every share publishes its own
                // (screenSharePublishOptions).
                screenShareEncoding: { maxBitrate: LEGACY_SHARE_KBPS * 1000, maxFramerate: 60 },
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

            // A member without SPEAK gets a grant with no microphone source, and
            // livekit-client throws 403 on the publish — which used to take the
            // WHOLE join down with it, so they could not even listen. Publish
            // only what the grant allows; the caller learns the verdict from
            // connect()'s result and releases the mic it opened.
            if (micTrack && micPublishAllowed(room.localParticipant.permissions)) {
                // A push-to-talk or muted member's mic stays shut through the
                // publish (holdMicGateWhilePublishing).
                const releaseGate = holdMicGateWhilePublishing(micTrack);
                try {
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
                } finally {
                    releaseGate();
                }
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
            if (!ck) {
                // null now means "the current epoch must NOT be encrypted under"
                // — the server rolled the channel back, or membership changed
                // and the rotation could not be minted (audit C-01). Keeping
                // the cryptor on the old key would publish the rest of the call
                // under exactly the key rotation exists to retire. FAIL CLOSED
                // ON SEND ONLY: move our sender onto a throwaway key at the NEXT
                // ring slot, so nothing we publish can be opened by anyone,
                // while the real key stays in its own slot and peers' frames
                // (which name their slot) still decrypt. The next poll that
                // yields a real key restores the sender, even at the same epoch.
                if (this.currentEpoch !== null && !this.senderMutedByKeyRefusal) {
                    console.warn('[sfu-e2ee] channel key refused (rolled back or rotation blocked) — ' +
                        'publishing under a throwaway key until the next poll yields a real one');
                    await keyProvider.setEpochKey(crypto.getRandomValues(new Uint8Array(32)), this.currentEpoch + 1);
                    this.senderMutedByKeyRefusal = true;
                }
                return;
            }
            if (this.senderMutedByKeyRefusal && ck.epoch === this.currentEpoch) {
                // Same epoch as before the refusal: put the sender back on the
                // real key (the slot still holds it; this re-selects it).
                await keyProvider.setEpochKey(deriveSfuMediaKey(ck.key, this.channelId, ck.epoch), ck.epoch);
                this.senderMutedByKeyRefusal = false;
                console.info('[sfu-e2ee] channel key available again — sender restored');
                return;
            }
            if (ck && ck.epoch !== this.currentEpoch) {
                this.senderMutedByKeyRefusal = false;
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
        this.stopShareAdapt();
        this.stopSoftwareWatch();
        if (this.epochTimer) {
            clearInterval(this.epochTimer);
            this.epochTimer = null;
        }
        const room = this.room;
        this.room = null;
        this.channelId = null;
        this.currentEpoch = null;
        this.senderMutedByKeyRefusal = false;
        this.localUserId = null;
        this.micPub = null;
        this.cameraPub = null;
        this.shareStreams.clear();
        this.focusedUserId = null;
        this.watchedVideo.clear();
        this.localE2eeActive = false;
        this.cryptorEnabled.clear();
        this.encryptionErrorAt.clear();
        this.keyProvider = null;
        // The room is gone (its listeners are removed below, so its own
        // ConnectionStateChanged never reaches us).
        if (room) this.participantsChanged();
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
        // No SPEAK: never unpublish-then-fail. The publish below would 403 and
        // leave the call with no mic publication at all while the UI believed
        // it had swapped one in.
        if (!this.micAllowed()) return;
        // Live lookup, same reason as unpublishCamera: a stale handle here left
        // the OLD publication up and added a second one, so the room heard the
        // dead track.
        for (const pub of this.localPubs(Track.Source.Microphone)) {
            if (pub.track) {
                await this.room.localParticipant.unpublishTrack(pub.track.mediaStreamTrack, false);
            }
        }
        // The new track carries the gate (reacquireAudioTrack stamps it);
        // keep a shut one shut through the publish (holdMicGateWhilePublishing).
        const releaseGate = holdMicGateWhilePublishing(newTrack);
        try {
            this.micPub = await this.room.localParticipant.publishTrack(newTrack, {
                source: Track.Source.Microphone,
                dtx: true,
                red: true,
                forceStereo: false, // mono voice — see the initial mic publish
            });
        } finally {
            releaseGate();
        }
    }

    /** Take our microphone off the SFU (SPEAK revoked mid-call). The caller
     *  stops the capture itself; this only ends the publication. */
    async unpublishMic(): Promise<void> {
        if (!this.room) return;
        for (const pub of this.localPubs(Track.Source.Microphone)) {
            if (pub.track) {
                await this.room.localParticipant.unpublishTrack(pub.track.mediaStreamTrack, false).catch(() => { /* already gone */ });
            }
        }
        this.micPub = null;
    }

    /** Swap the published camera track (mid-call camera flip). No-op if no camera. */
    async replaceCameraTrack(newTrack: MediaStreamTrack): Promise<void> {
        if (!this.room || !this.cameraPub) return;
        for (const pub of this.localPubs(Track.Source.Camera)) {
            if (pub.track) {
                await this.room.localParticipant.unpublishTrack(pub.track.mediaStreamTrack, true);
            }
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
        // EVERY live camera publication, not the one we happen to be holding.
        // The held handle is detached after a reconnect (see localPubs), and
        // the old guard `this.cameraPub?.track` then skipped the unpublish and
        // nulled the field — leaving the camera streaming to the room after the
        // person had turned it off, with nothing left to stop it.
        for (const pub of this.localPubs(Track.Source.Camera)) {
            if (pub.track) {
                await this.room?.localParticipant.unpublishTrack(pub.track.mediaStreamTrack, true);
            }
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
     * Publish a screen-share stream (video + optional audio), capped at what
     * its quality may spend (shareBitrate.ts) on this server. Refuses past the
     * room share cap — the admission budget charges shares at full rate, so
     * exceeding it would push the node over its uplink envelope.
     */
    async startScreenShare(stream: MediaStream): Promise<void> {
        if (!this.room) throw new Error('Not connected to SFU');
        if (this.activeScreenShareCount() >= this.maxScreenShares) {
            throw new Error(`Share limit reached (${this.maxScreenShares} concurrent screen shares)`);
        }
        const video = stream.getVideoTracks()[0];
        // Read at publish time, so changing it takes effect on the next share
        // rather than the next launch.
        this.shareLadderMode = rememberedShareLadder(loadSettings());
        this.shareLadderFellBack = false;
        if (video) await this.publishShareVideo(video, this.wantsLadder(video));
        const audio = stream.getAudioTracks()[0];
        if (audio) await this.publishShareAudio(audio);
    }

    /** The ladder setting the running share started with, and whether an
     *  Automatic ladder was dropped because its encoder was software. */
    private shareLadderMode: ShareLadderMode = 'auto';
    private shareLadderFellBack = false;
    /** One re-publish or re-tune at a time: two live changes clicked quickly
     *  must not interleave their unpublish and publish. */
    private shareOp: Promise<unknown> = Promise.resolve();

    /** Should the share of `video` go out at several sizes right now? */
    private wantsLadder(video: MediaStreamTrack): boolean {
        if (this.shareLadderFellBack) return false;
        return shareWantsLadder(this.shareLadderMode, machineHasHardwareH264(), this.shareBitrateFor(video));
    }

    private async publishShareVideo(video: MediaStreamTrack, ladder: boolean): Promise<void> {
        if (!this.room) return;
        const set = video.getSettings();
        const opts = screenSharePublishOptions(ladder, this.shareBitrateFor(video) * 1000, {
            width: set.width ?? 0,
            height: set.height ?? 0,
        });
        await this.room.localParticipant.publishTrack(video, opts);
        if (!opts.simulcast) this.startShareAdapt();
        else if (this.shareLadderMode === 'auto') this.startSoftwareWatch();
    }

    private async publishShareAudio(audio: MediaStreamTrack): Promise<void> {
        if (!this.room) return;
        await this.room.localParticipant.publishTrack(audio, {
            source: Track.Source.ScreenShareAudio,
            dtx: true,
        });
    }

    /**
     * Publish the running share again, as one size or as a ladder. A sender's
     * NUMBER of encodings is fixed when it is negotiated, so going between one
     * size and three needs a new publication; viewers re-subscribe to it by
     * themselves (they watch a USER, syncSubscriptions) and see about a second
     * of the old frame.
     *
     * THE AUDIO GOES WITH IT. A viewer's share stream is rebuilt when the
     * video is unsubscribed (TrackUnsubscribed drops it), so a video-only
     * re-publish would leave every viewer — this version and older ones —
     * with the picture back and the sound gone. Publishing the audio again
     * re-adds it to the rebuilt stream on any client.
     */
    private republishShare(ladder: boolean): Promise<void> {
        const run = this.shareOp.then(async () => {
            const room = this.room;
            if (!room) return;
            const pubs = this.localSharePubs();
            const video = pubs.find(p => p.kind === Track.Kind.Video)?.track?.mediaStreamTrack;
            const audio = pubs.find(p => p.kind === Track.Kind.Audio)?.track?.mediaStreamTrack;
            if (!video) return;
            this.stopShareAdapt();
            this.stopSoftwareWatch();
            for (const t of [video, audio]) {
                if (t) await room.localParticipant.unpublishTrack(t, false);
            }
            if (this.room !== room) return;
            await this.publishShareVideo(video, ladder);
            if (audio && video.readyState === 'live') await this.publishShareAudio(audio);
        });
        this.shareOp = run.catch(() => undefined);
        return run;
    }

    /**
     * Bring the running share in line with its capture after a live quality
     * change (shareHealthLive.ts): what it may spend, whether it should be a
     * ladder, and the size of each rung.
     *
     * A ladder that stays a ladder is re-sized IN PLACE: the rungs are ratios
     * of the capture fixed at publish (`scaleResolutionDownBy`), and setting
     * new ones on the same encodings is invisible to viewers. Re-capping the
     * capture without this shrank every rung with it, and took the bottom one
     * under the 360 lines below which Chromium will not encode in hardware —
     * which is why a laddered share used to refuse live changes outright.
     * Going between one size and three re-publishes (republishShare). A share
     * of one size that stays one size needs nothing here: its resolution
     * picker reads the capture and the cap on its next tick.
     *
     * Returns false when there is no SFU share to tune.
     */
    async retuneShare(): Promise<boolean> {
        if (!this.room) return false;
        const pub = this.localSharePubs().find(p => p.kind === Track.Kind.Video);
        const video = pub?.track?.mediaStreamTrack;
        if (!pub || !video) return false;
        // The setting as it is NOW: someone who changes it and then the
        // quality has asked for the new behaviour.
        this.shareLadderMode = rememberedShareLadder(loadSettings());
        const want = this.wantsLadder(video);
        const has = publicationsHaveLadder([pub]);
        if (want !== has) {
            await this.republishShare(want);
            return true;
        }
        if (!has) return true;
        const run = this.shareOp.then(() => this.resizeLadderInPlace(pub.track?.sender, video));
        this.shareOp = run.catch(() => undefined);
        await run;
        return true;
    }

    private async resizeLadderInPlace(sender: RTCRtpSender | undefined, video: MediaStreamTrack): Promise<void> {
        if (!sender) return;
        const set = video.getSettings();
        const want = ladderEncodings(set.width ?? 0, set.height ?? 0, this.shareBitrateFor(video));
        const params = sender.getParameters();
        for (const enc of params.encodings ?? []) {
            const w = want.find(x => x.rid === enc.rid);
            if (!w) continue;
            // `active` is left alone: dynacast turns rungs on and off by
            // whether anyone is watching them.
            enc.scaleResolutionDownBy = w.scaleResolutionDownBy;
            enc.maxBitrate = w.maxBitrate;
            enc.maxFramerate = w.maxFramerate;
        }
        await sender.setParameters(params);
    }

    /** The Automatic ladder's encoder check (SOFTWARE_WATCH_MS above). */
    private softwareWatch: ReturnType<typeof setInterval> | null = null;

    /**
     * Watch an AUTOMATIC ladder's encoder for its first readings, and drop the
     * ladder if it turns out to be software.
     *
     * Automatic decides on the machine's capabilities (a High-profile entry
     * means a hardware encoder is installed), and that can still end in
     * OpenH264: a driver that fails to open, an encoder already busy with a
     * recording. Three software encodes are what Automatic exists to avoid, so
     * the share goes back to one size for the rest of its life. Always is the
     * person's own choice and is not second-guessed.
     */
    private startSoftwareWatch(): void {
        this.stopSoftwareWatch();
        let soft = 0;
        let hard = 0;
        const started = Date.now();
        const timer = setInterval(() => {
            void (async () => {
                if (this.softwareWatch !== timer) return;
                if (Date.now() - started > SOFTWARE_WATCH_MAX_MS) { this.stopSoftwareWatch(); return; }
                const names = await this.shareEncoderNames();
                if (this.softwareWatch !== timer || names.length === 0) return;
                if (names.some(isSoftwareEncoder)) {
                    soft++;
                    hard = 0;
                } else {
                    hard++;
                    soft = 0;
                }
                if (hard >= HARDWARE_READS) { this.stopSoftwareWatch(); return; }
                if (soft >= SOFTWARE_READS) {
                    this.stopSoftwareWatch();
                    this.shareLadderFellBack = true;
                    console.warn('[share] the automatic ladder is encoding in software; sending one size instead');
                    try { await this.republishShare(false); } catch { /* the share ended meanwhile */ }
                }
            })();
        }, SOFTWARE_WATCH_MS);
        this.softwareWatch = timer;
    }

    private stopSoftwareWatch(): void {
        if (this.softwareWatch) clearInterval(this.softwareWatch);
        this.softwareWatch = null;
    }

    /** The encoder named by every video rung of the local share (empty until
     *  frames are encoded, and in a page that is not capturing). */
    private async shareEncoderNames(): Promise<string[]> {
        const names: string[] = [];
        for (const pub of this.localSharePubs()) {
            if (pub.kind !== Track.Kind.Video) continue;
            const sender = pub.track?.sender;
            if (!sender) continue;
            try {
                (await sender.getStats()).forEach((s) => {
                    const r = s as unknown as Record<string, unknown>;
                    if (r.type === 'outbound-rtp' && r.kind === 'video' && typeof r.encoderImplementation === 'string') {
                        names.push(r.encoderImplementation);
                    }
                });
            } catch { /* sender detached */ }
        }
        return names;
    }

    /**
     * One reading of the local screen share's encode health, or null when this
     * transport is not carrying a share.
     *
     * Deliberately much lighter than `voiceDiagnostics`: it is polled every few
     * seconds for the whole life of a share, on a machine that is by
     * definition already busy, so it reads only the share's own sender and
     * keeps two fields. See shareHealth.ts for what is done with them.
     *
     * WITH A LADDER there is one outbound-rtp entry per rung. Any rung being
     * CPU-limited counts, because the rungs are encoded by the same machine —
     * a starved bottom rung is not a smaller problem than a starved top one.
     */
    async shareEncodeSample(): Promise<EncodeSample | null> {
        let sample: EncodeSample | null = null;
        for (const pub of this.localSharePubs()) {
            if (pub.kind !== Track.Kind.Video) continue;
            const sender = pub.track?.sender;
            if (!sender) continue;
            try {
                const stats = await sender.getStats();
                stats.forEach((s) => {
                    if (s.type !== 'outbound-rtp') return;
                    const r = s as unknown as Record<string, unknown>;
                    if (r.kind !== 'video') return;
                    const row: EncodeSample = {
                        limit: r.qualityLimitationReason as string | undefined,
                        encoder: r.encoderImplementation as string | undefined,
                    };
                    if (!sample || (row.limit === 'cpu' && sample.limit !== 'cpu')) sample = row;
                });
            } catch { /* sender detached mid-read */ }
        }
        return sample;
    }

    /** The bitrate (kbps) this server lets a share of `track`'s capture send. */
    private shareBitrateFor(track: MediaStreamTrack): number {
        const set = track.getSettings();
        return shareBitrateKbps(set.width ?? 0, set.height ?? 0, set.frameRate ?? 0, this.maxShareKbps);
    }

    /** The running single-layer share's resolution picker (shareAdapt.ts). */
    private shareAdapt: {
        timer: ReturnType<typeof setInterval>;
        adapter: ShareAdapter | null;
        sender: RTCRtpSender | null;
        busy: boolean;
    } | null = null;

    private startShareAdapt(): void {
        this.stopShareAdapt();
        const st = { timer: setInterval(() => { void this.shareAdaptTick(st); }, SHARE_ADAPT_INTERVAL_MS), adapter: null, sender: null, busy: false };
        this.shareAdapt = st;
        // At once, not in 2 s: the start rung must be in place before the first
        // keyframe has gone far (shareAdapt.ts, WHY IT STARTS AT 540p).
        void this.shareAdaptTick(st);
    }

    private stopShareAdapt(): void {
        if (this.shareAdapt) clearInterval(this.shareAdapt.timer);
        this.shareAdapt = null;
    }

    /**
     * One reading of the share's sender, and whatever the adapter asks for.
     *
     * The publication is looked up live on every tick rather than held: a
     * reconnect republishes every local track (see `localPubs`), and a held
     * sender would go on adapting an object nobody sends from. A NEW sender
     * starts a new adapter, at the start rung, because its estimate and its
     * counters start over too.
     */
    private async shareAdaptTick(st: NonNullable<SfuManager['shareAdapt']>): Promise<void> {
        if (st.busy || this.shareAdapt !== st) return;
        st.busy = true;
        try {
            const pub = this.localSharePubs().find(p => p.kind === Track.Kind.Video);
            const sender = pub?.track?.sender;
            const mst = pub?.track?.mediaStreamTrack;
            if (!pub || !sender || !mst || publicationsHaveLadder([pub])) return;
            const set = mst.getSettings();
            const sourceHeight = typeof set.height === 'number' && set.height > 0 ? set.height : 1080;
            const fps = typeof set.frameRate === 'number' && set.frameRate > 0 ? set.frameRate : 30;
            // Read every tick: a live quality change (or a window resized)
            // changes what the share may spend, not only its size.
            const maxKbps = this.shareBitrateFor(mst);
            if (st.sender !== sender || !st.adapter) {
                const adapter = new ShareAdapter({ sourceHeight, fps, maxKbps });
                await applyShareHeight(sender, sourceHeight, adapter.currentHeight, maxKbps);
                // A probe left running on the previous sender (a reconnect
                // republished the track) must not outlive it: the new adapter
                // starts out of probe mode.
                if (mst.contentHint === 'detail') { try { mst.contentHint = 'motion'; } catch { /* not supported */ } }
                // Only once the rung is really in place, so a refused
                // setParameters is retried rather than believed.
                st.adapter = adapter;
                st.sender = sender;
                return;
            }
            const adapter = st.adapter;
            const resized = adapter.resize(sourceHeight, fps, maxKbps);
            // Also when only the ceiling moved (a resize to the same rung), or
            // something else put the sender's own back: a track swap makes
            // livekit-client re-apply the cap it published with.
            if (resized.height !== undefined || senderMaxBitrate(sender) !== maxKbps * 1000) {
                await applyShareHeight(sender, sourceHeight, adapter.currentHeight, maxKbps);
            }
            let out: Record<string, unknown> | null = null;
            (await sender.getStats()).forEach((r) => {
                const row = r as Record<string, unknown>;
                if (row.type === 'outbound-rtp' && row.kind === 'video') out = row;
            });
            const o = out as Record<string, unknown> | null;
            if (!o || typeof o.targetBitrate !== 'number' || typeof o.bytesSent !== 'number' || typeof o.framesEncoded !== 'number') return;
            const act = adapter.step({
                atMs: performance.now(),
                targetKbps: o.targetBitrate / 1000,
                bytesSent: o.bytesSent,
                framesEncoded: o.framesEncoded,
                limit: typeof o.qualityLimitationReason === 'string' ? o.qualityLimitationReason : 'none',
            });
            if (act.contentHint) { try { mst.contentHint = act.contentHint; } catch { /* not supported */ } }
            if (act.height !== undefined) await applyShareHeight(sender, sourceHeight, act.height, maxKbps);
        } catch {
            // Sender detached mid-tick, or setParameters refused: the adapter
            // may now believe in a rung that is not on the wire. Start over at
            // the start rung on the next tick rather than drift.
            st.adapter = null;
            st.sender = null;
        } finally {
            st.busy = false;
        }
    }

    /**
     * Does the RUNNING share actually have a simulcast ladder?
     *
     * Read from the sender's own encodings rather than from `shareSimulcast`,
     * because the setting says what the NEXT share will do and this question is
     * about the one already on the wire. Somebody who turns the setting on
     * mid-share has not grown extra rungs on it, and somebody who turns it off
     * has not lost the ones it was published with.
     *
     * It is also the only transport-correct answer: a mesh call has no
     * publications here at all, so it returns false and a mesh share stays
     * re-cappable — which the setting alone could not express.
     */
    shareHasLadder(): boolean {
        return publicationsHaveLadder(this.localSharePubs());
    }

    async stopScreenShare(): Promise<void> {
        this.stopShareAdapt();
        this.stopSoftwareWatch();
        if (!this.room) return;
        for (const pub of this.localSharePubs()) {
            if (pub.track) {
                await this.room.localParticipant.unpublishTrack(pub.track.mediaStreamTrack, false);
            }
        }
    }

    // --- subscription / layer policy ---------------------------------------

    /**
     * Focus policy (§5.2 of the SFU design): the focused user's video pulls the
     * HIGH simulcast layer. What everyone ELSE gets is decided per source by
     * `subscribedQuality`, because a camera tile and a screen share are not the
     * same picture at the same size — see that function.
     *
     * StreamStage calls this via voiceState when its focus changes.
     */
    /** Pin ONE remote camera to a rung, or release it back to the policy.
     *
     *  Why this exists separately from `setFocusedRemote`: that one is the
     *  screen-share stage's focus and moves EVERY video publication of the
     *  chosen user. A camera being enlarged — fullscreened out of the rail — is
     *  a different question about a different track, and answering it with the
     *  stage's focus would change which SHARE is on the high rung as a side
     *  effect.
     *
     *  Without this, fullscreening a camera showed a 640x360 picture blown up
     *  to the whole display: the feature would look broken at the exact moment
     *  someone leaned in to look.
     */
    setCameraQuality(userId: number, quality: VideoQuality | null): void {
        if (quality === null) this.pinnedCameras.delete(userId);
        else this.pinnedCameras.set(userId, quality);
        if (!this.room) return;
        for (const participant of this.room.remoteParticipants.values()) {
            if (userIdFromIdentity(participant.identity) !== userId) continue;
            for (const pub of participant.trackPublications.values()) {
                if (pub.source !== Track.Source.Camera || !pub.isSubscribed) continue;
                pub.setVideoQuality(
                    quality
                    ?? subscribedQuality(pub.source, userId === this.focusedUserId, this.participantCount()),
                );
            }
        }
    }

    /** Everyone in the room, us included — what the grid sizes its tiles by. */
    private participantCount(): number {
        return (this.room?.remoteParticipants.size ?? 0) + 1;
    }

    setFocusedRemote(userId: number | null): void {
        this.focusedUserId = userId;
        if (!this.room) return;
        for (const participant of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(participant.identity);
            const focused = uid !== null && uid === userId;
            for (const pub of participant.trackPublications.values()) {
                // Only subscribed publications: with autoSubscribe off,
                // setVideoQuality on an unsubscribed pub warn-logs uselessly.
                if (pub.kind === 'video' && pub.isSubscribed) {
                    const pinned = pub.source === Track.Source.Camera && uid !== null
                        ? this.pinnedCameras.get(uid)
                        : undefined;
                    pub.setVideoQuality(
                        pinned ?? subscribedQuality(pub.source, focused, this.participantCount(), this.watchedVideo.size),
                    );
                }
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

    /**
     * Every user with a live participant in the LiveKit room right now — the
     * people whose media can be reaching this client regardless of what the
     * WS roster says. The clip buffer's declared-participants record unions
     * this with the roster on every observation, so a peer whose LiveKit
     * session outlives their roster row (the `hasParticipant` case above)
     * keeps an OPEN presence span for as long as they are actually audible.
     * Empty outside an SFU room.
     */
    participantUserIds(): number[] {
        if (!this.room) return [];
        const out = new Set<number>();
        for (const p of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(p.identity);
            if (uid !== null) out.add(uid);
        }
        return [...out];
    }

    /** Each remote participant as [user id, identity]. The identity
     *  (`u<id>#<nonce>`) is minted per token request - once per join - so a
     *  new one for the same user is a new device or a rejoin (dfPause.ts);
     *  LiveKit's own reconnects reuse the token, and keep it. */
    participantSessions(): Array<[number, string]> {
        if (!this.room) return [];
        const out: Array<[number, string]> = [];
        for (const p of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(p.identity);
            if (uid !== null) out.push([uid, `sfu:${p.identity}`]);
        }
        return out;
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
        const before = this.watchedVideo.size;
        this.watchedVideo = new Set(userIds);
        this.syncSubscriptions();
        // The rung a share asks for depends on how many are watched
        // (subscribedQuality): re-ask for the ones already subscribed.
        if (before !== this.watchedVideo.size) this.setFocusedRemote(this.focusedUserId);
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
        // NO RECEIVE: the grant itself says so (and LiveKit enforces it).
        const receives = subscribeAllowed(this.room.localParticipant.permissions);
        for (const participant of this.room.remoteParticipants.values()) {
            const uid = userIdFromIdentity(participant.identity);
            if (uid === null || uid === this.localUserId) continue;
            // dropUnencryptedParticipant unsubscribed them for a reason; only
            // a fresh worker ack (cryptorEnabled → true) re-admits.
            if (this.cryptorEnabled.get(participant.identity) === false) continue;
            for (const pub of participant.trackPublications.values()) {
                const wanted = receives && (
                    pub.source === Track.Source.Microphone ||
                    pub.source === Track.Source.Camera ||
                    ((pub.source === Track.Source.ScreenShare ||
                        pub.source === Track.Source.ScreenShareAudio) &&
                        this.watchedVideo.has(uid)));
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
    /** Last stats per remote audio receiver, so each health read is a window. */
    private audioHealthPrev = new Map<string, RTCStatsReport>();

    /**
     * How every incoming voice is holding up since the previous call
     * (healthLog.ts reads this once a minute). Keyed by user id; a receiver
     * gone since the last read drops its baseline.
     */
    async inboundAudioHealth(): Promise<Array<InboundAudioHealth & { userId: string }>> {
        const room = this.room;
        if (!room) { this.audioHealthPrev.clear(); return []; }
        const out: Array<InboundAudioHealth & { userId: string }> = [];
        const seen = new Set<string>();
        for (const p of room.remoteParticipants.values()) {
            const uid = String(userIdFromIdentity(p.identity));
            for (const pub of p.trackPublications.values()) {
                if (pub.kind !== Track.Kind.Audio) continue;
                const receiver = pub.track?.receiver;
                if (!receiver) continue;
                try {
                    const stats = await receiver.getStats();
                    const key = pub.trackSid;
                    seen.add(key);
                    for (const h of summariseInboundAudio(this.audioHealthPrev.get(key) ?? null, stats)) {
                        out.push({ ...h, userId: pub.source === Track.Source.ScreenShareAudio ? `${uid}:share` : uid });
                    }
                    this.audioHealthPrev.set(key, stats);
                } catch { /* receiver detached mid-iteration */ }
            }
        }
        for (const k of [...this.audioHealthPrev.keys()]) if (!seen.has(k)) this.audioHealthPrev.delete(k);
        return out;
    }

    /**
     * The SFU senders/receivers carrying any of `tracks`, for the stream
     * stats overlay (streamStats.ts). Matched by track identity: a watched
     * stream is built from its publications' mediaStreamTracks, and your own
     * share is published from the captured tracks themselves.
     */
    rtpEndpointsFor(tracks: MediaStreamTrack[]): RtpEndpoint[] {
        const room = this.room;
        if (!room) return [];
        const out: RtpEndpoint[] = [];
        for (const p of room.remoteParticipants.values()) {
            for (const pub of p.trackPublications.values()) {
                const t = pub.track?.mediaStreamTrack;
                const receiver = pub.track?.receiver;
                if (t && receiver && tracks.includes(t)) {
                    out.push({ key: receiver, direction: 'inbound', kind: t.kind, getStats: () => receiver.getStats() });
                }
            }
        }
        for (const pub of room.localParticipant.trackPublications.values()) {
            const t = pub.track?.mediaStreamTrack;
            const sender = pub.track?.sender;
            if (t && sender && tracks.includes(t)) {
                out.push({ key: sender, direction: 'outbound', kind: t.kind, getStats: () => sender.getStats() });
            }
        }
        return out;
    }

    async voiceDiagnostics(windowMs?: number): Promise<Record<string, unknown>> {
        const room = this.room;
        // Windowed reads (see meshDiagnostics): first pass now, second after
        // the window; delay fields are then over the window only.
        const before = new Map<string, RTCStatsReport>();
        if (windowMs && windowMs > 0 && room) {
            // VIDEO ONLY, both passes. The second pass summarises video rows
            // and nothing else, so a getStats() here for a microphone or a
            // screen-share audio track buys a report nobody reads — and this
            // runs on the sharer's main thread every five seconds, on the
            // machine already struggling to encode. Cheap to skip, and the
            // first pass had no filter at all where the second one does.
            for (const pub of room.localParticipant.trackPublications.values()) {
                if (pub.kind !== Track.Kind.Video) continue;
                const sender = pub.track?.sender;
                if (sender) { try { before.set(`local:${pub.trackSid}`, await sender.getStats()); } catch { /* detached */ } }
            }
            for (const p of room.remoteParticipants.values()) {
                for (const pub of p.trackPublications.values()) {
                    if (pub.kind !== Track.Kind.Video) continue;
                    const receiver = pub.track?.receiver;
                    if (receiver) { try { before.set(`remote:${pub.trackSid}`, await receiver.getStats()); } catch { /* detached */ } }
                }
            }
            await new Promise(r => setTimeout(r, windowMs));
        }
        const summarise = (key: string, stats: RTCStatsReport): RtcLatencySummary => {
            const prev = before.get(key);
            return prev && windowMs ? summariseRtcStatsDelta(prev, stats, windowMs) : summariseRtcStats(stats);
        };
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
                // The sender's delay fields (encode time, pacer delay, the
                // publisher pair) ride on each entry as `latency`.
                const latency = summarise(`local:${pub.trackSid}`, stats);
                // The frame rate the person CHOSE (the capture's own setting),
                // and each rung's configured cap and on/off state.
                const setFps = pub.track?.mediaStreamTrack?.getSettings?.().frameRate;
                const encodings = sender.getParameters?.().encodings;
                stats.forEach((s) => {
                    if (s.type !== 'outbound-rtp') return;
                    const r = s as unknown as Record<string, unknown>;
                    const profile = negotiatedH264Profile(stats, r.codecId);
                    localRtp.push({
                        source: String(pub.source), kind: r.kind,
                        // Simulcast (camera) yields one entry per layer.
                        ...(r.rid !== undefined && { rid: r.rid }),
                        bytes: r.bytesSent, frames: r.framesEncoded, fps: r.framesPerSecond,
                        // Chosen, capped and captured fps, sent size, on/off and
                        // sender id (statsSummary.ts videoSendExtras).
                        ...videoSendExtras(stats, r, setFps, encodings),
                        // undefined for audio (and pre-first-frame); the
                        // spread keeps audio entries free of noise keys.
                        ...(r.qualityLimitationReason !== undefined && {
                            limit: r.qualityLimitationReason,
                            limitDurations: r.qualityLimitationDurations,
                        }),
                        ...(r.encoderImplementation !== undefined && { encoder: r.encoderImplementation }),
                        // The one field that settles hardware vs software without
                        // parsing an encoder name. Chrome 112+; omitted entirely
                        // unless the document holds an active capture, which a
                        // real share does.
                        ...(r.powerEfficientEncoder !== undefined && { hwEncoder: r.powerEfficientEncoder }),
                        // The NEGOTIATED H.264 profile. `encoder=OpenH264` on
                        // its own cannot say why; `profile=42e01f` next to it
                        // can (h264Profiles.ts). Absent for other codecs.
                        ...(profile !== null && { profile }),
                        ...(r.kind === 'video' && { latency }),
                    });
                });
            } catch { /* sender detached mid-iteration */ }
        }
        // What THIS end receives. A viewer on the SFU path used to get no
        // numbers at all about the share they were complaining about — the
        // peers block below carries subscription booleans only. One row per
        // subscribed video publication: the SUBSCRIBER transport's jitter
        // buffer, processing and decode times, and its selected pair (a
        // different peer connection from the publisher's, so its own row).
        const remoteRtp: Record<string, unknown>[] = [];
        for (const p of room?.remoteParticipants.values() ?? []) {
            const uid = userIdFromIdentity(p.identity);
            for (const pub of p.trackPublications.values()) {
                const receiver = pub.track?.receiver;
                if (!receiver || pub.kind !== Track.Kind.Video) continue;
                try {
                    const stats = await receiver.getStats();
                    remoteRtp.push({
                        userId: uid, identity: p.identity, source: String(pub.source),
                        latency: summarise(`remote:${pub.trackSid}`, stats),
                        receivers: receiverHints([receiver]),
                    });
                } catch { /* receiver detached mid-iteration */ }
            }
        }
        return {
            connected: !!room,
            ...(windowMs ? { windowMs } : {}),
            localRtp,
            remoteRtp,
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
            // Live, so a reconnect cannot make the report disagree with the room.
            myMicPublished: this.localPubs(Track.Source.Microphone).length > 0,
            myMicMuted: this.localPubs(Track.Source.Microphone)[0]?.isMuted ?? null,
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
            // A participant that publishes NOTHING sends no media to encrypt
            // or to leak — a listener without SPEAK, a member with no mic. It
            // used to count as "not encrypted" forever and turned the whole
            // call's badge into "some media is blocked".
            if (p.trackPublications.size === 0) continue;
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

    /**
     * Publish one control frame to every connection of `userId` (a user can
     * be in the room from two devices; the input must reach the one hosting,
     * and the others drop it — an unopenable frame is dropped by design).
     *
     * `false` = not sent, use the relay: no room, no matching participant,
     * or LiveKit refused. Reliable delivery, always — the lane split lives
     * in the mesh transport; the SFU path carries the state semantics for
     * everything, because a dropped absolute move here would be
     * indistinguishable from the click that follows it going missing.
     */
    publishControlFrame(userId: number, frame: Uint8Array): boolean {
        if (!__RC_ENABLED__) return false; // lite: no remote control, so no control lane
        const room = this.room;
        if (!room || room.state !== ConnectionState.Connected) return false;
        const identities = [...room.remoteParticipants.values()]
            .filter((p) => userIdFromIdentity(p.identity) === userId)
            .map((p) => p.identity);
        if (identities.length === 0) return false;
        try {
            // A fresh, plainly-backed copy: publishData's type excludes a
            // SHARED-buffer view, and our frame builder is generic over both.
            const owned = new Uint8Array(new ArrayBuffer(frame.byteLength));
            owned.set(frame);
            void room.localParticipant.publishData(owned, {
                reliable: true,
                destinationIdentities: identities,
                topic: CTL_SFU_TOPIC,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Put the H.264 profiles a hardware encoder can take at the FRONT of the
     * publisher's offer, before its first negotiation. See h264Profiles.ts for
     * the measurement: the server answers with the first profile both sides
     * share, Chromium's default order makes that Constrained Baseline, and
     * Constrained Baseline is the one profile Chromium's MediaFoundation
     * factory never claims — so every share ever logged encoded in software
     * on machines with an idle NVENC.
     *
     * Hooked on LocalSenderCreated, which livekit-client emits after the
     * transceiver exists and before it negotiates (LocalParticipant.publishTrack:
     * createSender -> emit -> engine.negotiate). It is marked @internal there;
     * a test pins the event name so an upgrade that renames it fails loudly
     * instead of silently reverting every share to OpenH264. Fails OPEN: any
     * missing piece leaves the browser's own order in place, which is today's
     * behaviour, never a broken publish.
     */
    private preferHardwareH264(room: Room, sender: RTCRtpSender, track: Track): void {
        try {
            const outcome = preferHardwareH264ForSender(room, sender, track as { kind: string; codec?: string });
            if (outcome === 'not-h264') return; // a VP8 camera: nothing to reorder, nothing to say
            console.info(`[sfu] H.264 codec preference: ${outcome}`);
        } catch (e) {
            console.warn('[sfu] could not set the H.264 codec preference:', e);
        }
    }

    private wireRoomEvents(room: Room): void {
        room.localParticipant.on(ParticipantEvent.LocalSenderCreated, (sender, track) =>
            this.preferHardwareH264(room, sender, track),
        );
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
            .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
                // P2P INPUT over the SFU (W6/R3). Same frames, same registry,
                // same sealed-hello gate as the mesh lanes — only the pipe
                // differs, so remoteControl needs no SFU branch at all.
                //
                // The SFU RELAYS these (it is a server in the path), unlike
                // the mesh DC: the win here is latency and one fewer protocol
                // hop, NOT removing a trust boundary. The frames stay sealed
                // under the session key, so the SFU learns no more than the
                // WS relay already does.
                if (!__RC_ENABLED__ || topic !== CTL_SFU_TOPIC || !participant) return;
                const uid = userIdFromIdentity(participant.identity);
                if (uid === null || uid === this.localUserId) return;
                // Copy into a plain ArrayBuffer-backed view: LiveKit types
                // its payload as ArrayBufferLike, which may be shared.
                deliverSfuControlFrame(uid, Uint8Array.from(payload));
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
            .on(RoomEvent.Reconnected, () => this.syncSubscriptions())
            // The perms sweep can flip NO_RECEIVE mid-call (UpdateParticipant).
            .on(RoomEvent.ParticipantPermissionsChanged, () => this.syncSubscriptions())
            // Who can hear us (dfPause.ts). ConnectionStateChanged covers the
            // connect, every reconnect and the drop.
            .on(RoomEvent.ParticipantConnected, () => this.participantsChanged())
            .on(RoomEvent.ParticipantDisconnected, () => this.participantsChanged())
            .on(RoomEvent.ConnectionStateChanged, () => this.participantsChanged());
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
                // A pin set before this track arrived still applies: a camera
                // enlarged during a reconnect must not quietly come back small.
                pub.setVideoQuality(
                    this.pinnedCameras.get(uid)
                    ?? subscribedQuality(pub.source, uid === this.focusedUserId, this.participantCount()),
                );
                this.onCameraStream?.(uid, new MediaStream([track.mediaStreamTrack]));
                break;
            }
            case Track.Source.ScreenShare: {
                pub.setVideoQuality(
                    subscribedQuality(pub.source, uid === this.focusedUserId, this.participantCount(), this.watchedVideo.size),
                );
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
        (windowMs?: number) => sfuManager.voiceDiagnostics(windowMs);
}
