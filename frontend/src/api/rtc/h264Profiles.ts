/**
 * Which H.264 PROFILE a screen share negotiates — and why that decides whether
 * the encoder is hardware or software.
 *
 * THE INCIDENT. Every `[stream-diag]` line this project has from the field —
 * about 11,900 samples across 13 sessions, 2026-09-02 to 2026-09-10 — reads
 * `encoder=OpenH264`, Chromium's SOFTWARE H.264 encoder, on a machine whose
 * native clip capture uses "NVIDIA H.264 Encoder MFT" the same day. Software
 * H.264 at 1080p60 is the single largest cost a share imposes and is why
 * sharing makes a game stutter. It was blamed, in turn, on WebView2, on the
 * GPU adapter the webview lands on, and on E2EE. None of those is it.
 *
 * WHAT IT ACTUALLY IS, measured 2026-09-16 in headless Edge 153 on an RTX 4080
 * SUPER, one loopback pair per profile, bitrate pinned:
 *
 *     profile-level-id=42001f packetization-mode=1  -> NVIDIA H.264 Encoder MFT
 *     profile-level-id=4d001f packetization-mode=1  -> NVIDIA H.264 Encoder MFT
 *     profile-level-id=640032 packetization-mode=1  -> NVIDIA H.264 Encoder MFT
 *     profile-level-id=42e01f packetization-mode=1  -> OpenH264
 *     any profile      with   packetization-mode=0  -> OpenH264
 *
 * Chromium's MediaFoundation encoder factory claims Baseline, Main and High,
 * packetization-mode 1 only. It does NOT claim CONSTRAINED Baseline (`42e0`),
 * which is a distinct profile to WebRTC's format matcher, so a session that
 * negotiates 42e01f is handed to OpenH264 with the hardware encoder sitting
 * idle. (`--disable-accelerated-video-encode` as the control turns 42001f
 * into OpenH264 too — the hardware rows are really hardware.)
 *
 * AND 42e01f IS WHAT THIS APP NEGOTIATES, through no choice of its own. The
 * LiveKit server (v1.13.4, `protocol/codecs`) registers exactly three H.264
 * variants: 42e01f mode 0, 42e01f mode 1, and High `640032` mode 1 — never
 * Baseline 42001f or Main. Chromium's default send order is
 * `42001f, 42001f/0, 42e01f, 42e01f/0, 4d001f, 4d001f/0, 640032`, the server
 * keeps the offer's relative order among the codecs it knows
 * (`configureReceiverCodecs` in pkg/rtc/transport.go), so its answer leads
 * with the first thing both sides share: 42e01f. Software, on every machine,
 * every time. livekit-client 2.22 sets no codec preference of its own; older
 * versions pinned 42e01f explicitly "for cross-browser compatibility", which
 * is the same outcome.
 *
 * THE FIX is the one thing the client controls: the ORDER of the offer. Put
 * the profiles a hardware encoder can take first — High, then Main, then
 * Baseline, mode 1 — and the server's answer leads with High. Nothing is
 * removed: 42e01f and everything else follow in their original order.
 * Retransmission and FEC entries (rtx/red/ulpfec/flexfec) ride along
 * untouched; dropping them from a preference list silently disables
 * NACK-based recovery, which is the kind of regression no test here would
 * notice.
 *
 * TWO QUESTIONS, KEPT APART. "Which entries should lead the offer" is the
 * ranking above, and Baseline and Main are in it because a hardware factory
 * claims them. "Does THIS machine have a hardware encoder" is a different
 * question, and Baseline/Main cannot answer it: OpenH264 advertises
 * 42001f and 4d001f too. The one entry software never advertises is High
 * (OpenH264 encodes only Baseline, Constrained Baseline and Main), so a High
 * entry in the SENDER capabilities is the presence test — `hasHardwareH264`.
 * The reorder is applied only when it passes; a software-only machine's offer
 * is left exactly as the browser built it, and the diagnostics say "no". (The
 * first cut conflated the two, so every machine read as hardware-eligible and
 * the "leave it alone" branch could never run; the review caught it.)
 *
 * Every viewer decodes High: Chromium's D3D11 decoder, Android MediaCodec and
 * every hardware decoder since 2008 do, and the server forwards the
 * publisher's bitstream unchanged — its subscriber-side media engine filters
 * the High entry out of its own OFFERS (`filterOutH264HighProfile` is the
 * offerer flag) and matches the down-track on MIME, exactly as it already
 * does for Safari publishers, which have always sent High.
 */

/** Just enough of RTCRtpCodec / RTCRtpCodec to rank an entry. */
export interface CodecLike {
    mimeType: string;
    sdpFmtpLine?: string;
}

/** The `profile-level-id` of an H.264 fmtp line, lower-cased, or null. */
export function h264ProfileLevelId(sdpFmtpLine: string | undefined): string | null {
    if (!sdpFmtpLine) return null;
    for (const kv of sdpFmtpLine.split(';')) {
        const [k, v] = kv.split('=', 2).map((s) => s.trim().toLowerCase());
        if (k === 'profile-level-id' && v && /^[0-9a-f]{6}$/.test(v)) return v;
    }
    return null;
}

function fmtpParam(sdpFmtpLine: string | undefined, name: string): string | null {
    if (!sdpFmtpLine) return null;
    for (const kv of sdpFmtpLine.split(';')) {
        const [k, v] = kv.split('=', 2).map((s) => s.trim().toLowerCase());
        if (k === name) return v ?? '';
    }
    return null;
}

/**
 * Rank of an H.264 entry among those Chromium's hardware factory claims, or
 * null for one it does not (Constrained Baseline, packetization-mode 0, and
 * the exotic profiles decoders list but no encoder here offers). Lower ranks
 * first: High gives the best picture per bit and is the only one of the three
 * the LiveKit server also knows.
 */
export function hardwareH264Rank(codec: CodecLike): number | null {
    if (codec.mimeType.toLowerCase() !== 'video/h264') return null;
    // RFC 6184: absent packetization-mode means 0 (single NAL unit mode).
    if (fmtpParam(codec.sdpFmtpLine, 'packetization-mode') !== '1') return null;
    const pl = h264ProfileLevelId(codec.sdpFmtpLine);
    if (!pl) return null;
    const idc = pl.slice(0, 2);
    const iop = pl.slice(2, 4);
    // profile_iop `00` is the plain profile. 42e0 (constraint_set1) is
    // Constrained Baseline and 640c is Constrained High — different profiles
    // to the matcher, and not what the encoder factory advertises.
    if (iop !== '00') return null;
    if (idc === '64') return 0;
    if (idc === '4d') return 1;
    if (idc === '42') return 2;
    return null;
}

/** Ranked for the ORDER of the offer. Not a statement about this machine:
 *  OpenH264 advertises Baseline and Main too — see `hasHardwareH264`. */
export function isHardwareEligibleH264(codec: CodecLike): boolean {
    return hardwareH264Rank(codec) !== null;
}

/**
 * Does this SENDER list come from a machine with a hardware H.264 encoder?
 * Decided by a High entry (`64` with profile_iop `00`, mode 1): the one
 * entry the MediaFoundation factory adds that Chromium's software encoder
 * never advertises. Measured 2026-09-16 — the only difference between the
 * sender lists with and without `--disable-accelerated-video-encode` was
 * `640032` — and pinned by the test fixtures next door.
 */
export function hasHardwareH264(codecs: readonly CodecLike[]): boolean {
    return codecs.some((c) => hardwareH264Rank(c) === 0);
}

/**
 * The same entries, hardware-eligible H.264 first (High, Main, Baseline),
 * everything else after in its original order. A stable partition: no entry
 * is added, dropped or rewritten.
 */
export function preferHardwareH264<T extends CodecLike>(codecs: readonly T[]): T[] {
    const ranked: { c: T; rank: number; i: number }[] = [];
    const rest: T[] = [];
    codecs.forEach((c, i) => {
        const rank = hardwareH264Rank(c);
        if (rank === null) rest.push(c);
        else ranked.push({ c, rank, i });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
    return [...ranked.map((r) => r.c), ...rest];
}

/** The shape of a transceiver this module needs; RTCRtpTransceiver satisfies it. */
export interface TransceiverLike {
    setCodecPreferences?: (codecs: RTCRtpCodec[]) => void;
}

export type HardwareH264Outcome =
    /** The preference was set: High now leads the offer. */
    | 'applied'
    /** This sender advertises no High entry, so there is no hardware encoder
     *  to reach (software-only machine, or no H.264 at all): the browser's own
     *  order is left alone, and the offer is byte-for-byte what it was. */
    | 'none-available'
    /** No getCapabilities / setCodecPreferences here: nothing to do. */
    | 'unsupported';

/**
 * Apply the preference to one video transceiver, before its first offer.
 *
 * Uses the SENDER's capabilities, not the receiver's: an entry the encoder
 * side never claimed (every High entry on a software-only machine) would be
 * dropped from a sendonly offer anyway, and reading the decoder's list — which
 * always includes High — would say "hardware-eligible" about a machine that
 * has none.
 */
export function applyHardwareH264Preference(
    transceiver: TransceiverLike,
    capabilities: { codecs: RTCRtpCodec[] } | null | undefined =
        typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function'
            ? RTCRtpSender.getCapabilities('video')
            : null,
): HardwareH264Outcome {
    if (!capabilities || typeof transceiver.setCodecPreferences !== 'function') return 'unsupported';
    // Presence, not rank: Baseline/Main are in the ranking but OpenH264 has
    // them too, so only a High entry says a hardware encoder is here to reach.
    if (!hasHardwareH264(capabilities.codecs)) return 'none-available';
    transceiver.setCodecPreferences(preferHardwareH264(capabilities.codecs));
    return 'applied';
}

/** The slice of a livekit-client Room the sender hook reads. */
export interface PublisherRoomLike {
    engine: {
        pcManager?: {
            publisher: { getTransceivers(): (TransceiverLike & { sender: unknown })[] };
        };
    };
}

export type SenderHookOutcome =
    | HardwareH264Outcome
    /** Not a video sender, or not an H.264 one: nothing to reorder. */
    | 'not-h264'
    /** The publisher has no transceiver for this sender (closed mid-publish). */
    | 'no-transceiver';

/**
 * The LocalSenderCreated handler, as a function of the room, the new sender
 * and its track, so it can be exercised without a live Room. livekit-client
 * sets `LocalVideoTrack.codec` from the publish options before it emits the
 * event, which is what makes "is this an H.264 publish" answerable here.
 * Fails OPEN at every step: the worst outcome is the browser's own order.
 */
export function preferHardwareH264ForSender(
    room: PublisherRoomLike,
    sender: unknown,
    track: { kind: string; codec?: string },
    capabilities?: { codecs: RTCRtpCodec[] } | null,
): SenderHookOutcome {
    if (track.kind !== 'video' || track.codec !== 'h264') return 'not-h264';
    let transceiver: TransceiverLike | undefined;
    try {
        transceiver = room.engine.pcManager?.publisher.getTransceivers().find((t) => t.sender === sender);
    } catch { /* publisher closed mid-publish; the publish fails on its own */ }
    if (!transceiver) return 'no-transceiver';
    return capabilities === undefined
        ? applyHardwareH264Preference(transceiver)
        : applyHardwareH264Preference(transceiver, capabilities);
}

/**
 * The NEGOTIATED profile-level-id behind an outbound-rtp entry, read from the
 * `codec` stats entry it points at, or null when it is not H.264 (or the
 * report has no such entry). What `[stream-diag]` prints as `profile=`.
 */
export function negotiatedH264Profile(report: RTCStatsReport, codecId: unknown): string | null {
    if (typeof codecId !== 'string') return null;
    const codec = report.get(codecId) as { mimeType?: unknown; sdpFmtpLine?: unknown } | undefined;
    if (!codec || typeof codec.mimeType !== 'string' || codec.mimeType.toLowerCase() !== 'video/h264') return null;
    return h264ProfileLevelId(typeof codec.sdpFmtpLine === 'string' ? codec.sdpFmtpLine : undefined);
}

/** A one-line summary for the diagnostics report: what this browser can send. */
export function h264SendProfilesLine(capabilities: { codecs: CodecLike[] } | null | undefined): string {
    if (!capabilities) return 'h264 send (no RTCRtpSender.getCapabilities)';
    const h264 = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    if (h264.length === 0) return 'h264 send none';
    const label = (c: CodecLike) =>
        `${h264ProfileLevelId(c.sdpFmtpLine) ?? '??????'}/${fmtpParam(c.sdpFmtpLine, 'packetization-mode') ?? '0'}`;
    // The presence test, not the ranking: Baseline/Main are ranked for the
    // order but software advertises them too, so naming them here would call
    // every machine hardware-capable (the first cut did exactly that).
    const high = h264.filter((c) => hardwareH264Rank(c) === 0).map(label);
    const verdict = high.length
        ? `yes (High ${high.join(' ')} leads the offer)`
        : 'no (no High entry: software H.264 only, offer left as the browser built it)';
    return `h264 send ${h264.map(label).join(' ')}  hardware encoder: ${verdict}`;
}
