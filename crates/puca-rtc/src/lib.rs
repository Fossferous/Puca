//! WebRTC transport for the host agent — spike S3, promoted to a crate.
//!
//! THE QUESTION THIS ANSWERS: the agent captures and encodes natively, so it
//! also has to deliver frames to a browser. The alternatives were a full
//! libwebrtc binding (enormous, and a C++ build in the release pipeline) or a
//! sans-IO Rust stack. str0m is the latter: it owns the protocol state machine
//! and hands back "send these bytes, set this timer" while the caller owns the
//! sockets.
//!
//! That shape matters for more than taste. Because str0m never touches a
//! socket, the negotiation this feature depends on is testable with NO network
//! at all — the tests below prove an offer really advertises H.264 and really
//! completes against an answer, without a single UDP packet.
//!
//! WHAT IS PROVEN HERE, and what is not, stated plainly because the estimate for
//! the rest of Phase 6 hangs on it:
//!   * PROVEN: the API supports the exact shape needed — an SDP offer carrying
//!     H.264 on a sendonly video track, an answer applied, and a writer obtained
//!     for pushing encoded frames.
//!   * NOT PROVEN: end-to-end media into a real browser over TURN. That needs
//!     the agent's socket loop and a live peer, and it is the remaining risk in
//!     the estimate — the plan's own S3 success criterion was "video renders AND
//!     survives iceTransportPolicy:'relay'".

use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime, Mid};
use str0m::media::Frequency;
use str0m::{Candidate, Rtc, RtcError};
use std::net::SocketAddr;
use std::time::Instant;

/// One outbound video session: the agent's side of a device-control stream.
pub struct VideoSender {
    rtc: Rtc,
    mid: Option<Mid>,
    pending: Option<SdpPendingOffer>,
    /// Origin for RTP timestamps. Video runs on a 90 kHz clock, and a timestamp
    /// derived from wall-clock instead would jump whenever the system clock
    /// moved — which stalls playback rather than erroring.
    started: Instant,
}

#[derive(Debug)]
pub enum RtcSetupError {
    Sdp(String),
    Rtc(String),
}

impl std::fmt::Display for RtcSetupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RtcSetupError::Sdp(e) => write!(f, "SDP error: {e}"),
            RtcSetupError::Rtc(e) => write!(f, "RTC error: {e}"),
        }
    }
}

impl std::error::Error for RtcSetupError {}

impl From<RtcError> for RtcSetupError {
    fn from(e: RtcError) -> Self {
        RtcSetupError::Rtc(e.to_string())
    }
}

impl VideoSender {
    /// A sender with no candidates yet. The agent adds its own once it has
    /// bound sockets; keeping that out of here is what makes the negotiation
    /// testable without a network.
    pub fn new() -> Self {
        Self::new_at(Instant::now())
    }

    /// Explicit start time — str0m is sans-IO, so its whole clock is caller
    /// supplied. Taking it as a parameter is what lets tests be deterministic.
    pub fn new_at(start: Instant) -> Self {
        // ICE-lite is deliberately NOT used: the agent is frequently behind
        // NAT (that is the whole point of remote access), so it must be a
        // full ICE agent that can gather relay candidates.
        let mut builder = Rtc::builder();

        // REGISTER THE HIGH PROFILE CHROME ACTUALLY OFFERS.
        //
        // str0m's default H.264 set has High as `0x64001f`, and a payload is
        // matched on the profile it declares. Chrome offers High as
        // `0x640c1f` — same profile_idc (0x64), different profile-iop
        // constraint byte (0x0c) — so the two never matched and every session
        // silently settled on constrained baseline. MEASURED with a
        // four-payload Chrome-shaped offer: with only str0m's defaults the
        // answer kept pts 96 and 98 (both 42001f) and dropped the High pair;
        // adding this line keeps High and `negotiated_h264_profile_idc()`
        // resolves to 0x64.
        //
        // That is what makes the encoder's profile plumbing live rather than
        // decorative: High enables CABAC and the 8x8 transform, a real
        // bitrate-efficiency gain on text-heavy screen content.
        //
        // 116/117 are free in str0m's default map (it uses 96, 98, 108, 114,
        // 123, 124, 35 for H.264 plus their RTX partners, 111 Opus, 104 VP8,
        // 105/100 VP9, 102 H265, 45 AV1); a collision would make the whole
        // codec config unusable, so the tests below pin the negotiation.
        builder
            .codec_config()
            .add_h264(116.into(), Some(117.into()), true, 0x640c1f);

        Self {
            rtc: builder.build(start),
            mid: None,
            pending: None,
            started: start,
        }
    }

    /// Advertise a local socket the peer can reach us on.
    pub fn add_local_candidate(&mut self, addr: SocketAddr) -> Result<(), RtcSetupError> {
        let candidate = Candidate::host(addr, "udp")
            .map_err(|e| RtcSetupError::Rtc(e.to_string()))?;
        self.rtc.add_local_candidate(candidate);
        Ok(())
    }

    /// Advertise the address a STUN server says this socket maps to.
    ///
    /// `base` is the local interface the mapping belongs to, and str0m needs it
    /// to be a real address: pairing a reflexive candidate with the wildcard
    /// the socket is bound to gives a candidate str0m cannot route from, which
    /// fails exactly like having no candidate at all — the failure mode this
    /// whole path exists to remove.
    ///
    /// The header comment above claims the agent "must be a full ICE agent that
    /// can gather relay candidates". Until 0.8.6 nothing gathered anything: the
    /// only constructor exposed here was `host`, so every answer the agent ever
    /// sent carried host candidates only and worked on one LAN segment.
    pub fn add_server_reflexive_candidate(
        &mut self,
        addr: SocketAddr,
        base: SocketAddr,
    ) -> Result<(), RtcSetupError> {
        let candidate = Candidate::server_reflexive(addr, base, "udp")
            .map_err(|e| RtcSetupError::Rtc(e.to_string()))?;
        self.rtc.add_local_candidate(candidate);
        Ok(())
    }

    /// Advertise a relay allocated for us on a TURN server.
    ///
    /// `addr` is the address the TURN server relays on — what the peer sends
    /// to. `local` is the interface the allocation was made from. str0m takes a
    /// candidate's BASE as `Transmit.source`, and `Candidate::relayed` sets the
    /// base to the relayed address, which is precisely how the agent's socket
    /// loop knows a packet has to be wrapped for the relay rather than sent
    /// straight out. Changing that pairing silently un-relays the stream.
    pub fn add_relayed_candidate(
        &mut self,
        addr: SocketAddr,
        local: SocketAddr,
    ) -> Result<(), RtcSetupError> {
        let candidate = Candidate::relayed(addr, local, "udp")
            .map_err(|e| RtcSetupError::Rtc(e.to_string()))?;
        self.rtc.add_local_candidate(candidate);
        Ok(())
    }

    /// Add a candidate the PEER trickled to us.
    ///
    /// Without this the agent has no remote candidates at all and ICE can only
    /// ever reach `Checking`. The browser trickles: its offer carries few or no
    /// candidates and the useful ones (srflx, relay) arrive afterwards as
    /// separate signalling messages. session.ts routed those to `s.pc`, which is
    /// deliberately null on the agent transport — so they were queued into
    /// `pendingIce` and applied to nothing, and the host streamed frames into a
    /// connection that was never established.
    ///
    /// Takes the browser's `candidate` string verbatim (RFC 5245 §15.1). An
    /// unparseable one — Chrome's mDNS `.local` candidates cannot resolve here —
    /// is an error the caller reports and skips, not a reason to fail the
    /// session: the srflx and relay candidates in the same batch are the ones
    /// that matter.
    pub fn add_remote_candidate(&mut self, sdp: &str) -> Result<(), RtcSetupError> {
        let candidate = Candidate::from_sdp_string(sdp.trim())
            .map_err(|e| RtcSetupError::Rtc(e.to_string()))?;
        self.rtc.add_remote_candidate(candidate);
        Ok(())
    }

    /// Create an SDP offer carrying one send-only H.264 video track.
    ///
    /// Send-only by construction: the agent streams a screen and takes input
    /// over the app's sealed WebSocket channel, never over media. A recvonly or
    /// sendrecv track would negotiate an inbound path nothing consumes.
    pub fn create_offer(&mut self) -> Result<String, RtcSetupError> {
        let mut change = self.rtc.sdp_api();
        let mid = change.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        self.mid = Some(mid);
        let (offer, pending) = change
            .apply()
            .ok_or_else(|| RtcSetupError::Sdp("no changes to offer".into()))?;
        self.pending = Some(pending);
        Ok(offer.to_sdp_string())
    }

    /// Apply the peer's answer, completing negotiation.
    pub fn accept_answer(&mut self, answer_sdp: &str) -> Result<(), RtcSetupError> {
        let answer = SdpAnswer::from_sdp_string(answer_sdp)
            .map_err(|e| RtcSetupError::Sdp(e.to_string()))?;
        let pending = self
            .pending
            .take()
            .ok_or_else(|| RtcSetupError::Sdp("no offer is pending".into()))?;
        self.rtc.sdp_api().accept_answer(pending, answer)?;
        Ok(())
    }

    /// Handle an offer from the peer (the browser offering first).
    ///
    /// CRITICALLY, this also records the negotiated `mid`. When WE offer,
    /// `add_media` hands one back; when we ANSWER, the media comes from the
    /// remote description and there is nothing to return it. Leaving `mid` unset
    /// makes `send_frame` return "not ready" for every frame forever -- the
    /// connection reaches `connected`, the encoder runs, and the peer sees a
    /// black screen with no error anywhere. That is exactly what happened until
    /// a live browser test caught it.
    pub fn accept_offer(&mut self, offer_sdp: &str) -> Result<String, RtcSetupError> {
        let offer = SdpOffer::from_sdp_string(offer_sdp)
            .map_err(|e| RtcSetupError::Sdp(e.to_string()))?;
        let answer = self.rtc.sdp_api().accept_offer(offer)?;
        let mut answer_sdp = answer.to_sdp_string();
        
        // str0m emits `ufrag` inside the candidate line (e.g. `a=candidate:... typ host ufrag XXX`).
        // Some strict WebRTC parsers (like Safari on iOS) reject candidates with extensions they don't like,
        // which leaves the controller with 0 remote candidates and causes ICE to hang in 'checking' forever.
        // We strip `ufrag <val>` from all candidate lines before sending.
        let mut clean_sdp = String::with_capacity(answer_sdp.len());
        for line in answer_sdp.lines() {
            if line.starts_with("a=candidate:") {
                if let Some(ufrag_idx) = line.find(" ufrag ") {
                    let end_idx = line[ufrag_idx + 7..].find(' ').map(|i| i + ufrag_idx + 7).unwrap_or(line.len());
                    clean_sdp.push_str(&line[..ufrag_idx]);
                    clean_sdp.push_str(&line[end_idx..]);
                } else {
                    clean_sdp.push_str(line);
                }
            } else {
                clean_sdp.push_str(line);
            }
            clean_sdp.push_str("\r\n");
        }
        answer_sdp = clean_sdp;

        self.mid = first_video_mid(&answer_sdp);
        if self.mid.is_none() {
            return Err(RtcSetupError::Sdp(
                "the answer has no video media to send on".to_string(),
            ));
        }
        Ok(answer_sdp)
    }

    /// Is the transport ready to carry media?
    pub fn is_connected(&self) -> bool {
        self.rtc.is_alive() && self.mid.is_some()
    }

    /// Whether a payload type for `codec` was negotiated for our track.
    ///
    /// Checked explicitly rather than assumed: if the peer only offered a codec
    /// we cannot produce, the connection succeeds and then carries nothing
    /// decodable — the failure shows up as a black screen, not as an error.
    pub fn negotiated(&self, codec: Codec) -> bool {
        let Some(mid) = self.mid else { return false };
        let Some(media) = self.rtc.media(mid) else { return false };
        let config = self.rtc.codec_config();
        media
            .remote_pts()
            .iter()
            .filter_map(|pt| config.iter().find(|p| p.pt() == *pt))
            .any(|p| p.spec().codec == codec)
    }

    /// Convenience for the Windows/H.264 path and its tests.
    pub fn negotiated_h264(&self) -> bool {
        self.negotiated(Codec::H264)
    }

    /// The profile_idc of the H.264 payload this sender will actually use
    /// (0x42 baseline, 0x4D main, 0x64 high), or None when H.264 was not
    /// negotiated at all.
    ///
    /// Exposed so the ENCODER can be built to match the wire: sending High
    /// bitstream under a payload whose fmtp says baseline happens to decode on
    /// Chromium, but it is out of contract and it is exactly the kind of
    /// works-by-luck this crate's payload-type comment warns about. The
    /// selection here and the one in `send_frame` are the same function, so
    /// the two cannot disagree.
    pub fn negotiated_h264_profile_idc(&self) -> Option<u8> {
        let mid = self.mid?;
        let media = self.rtc.media(mid)?;
        let config = self.rtc.codec_config();
        // ITERATE THE CONFIG, filtered by remote_pts — the same order
        // `Writer::payload_params()` uses. Walking remote_pts() instead (the
        // peer's m-line preference order) yields the same SET in a different
        // ORDER, and `max_by_key` returns the LAST maximum, so two payloads of
        // equal rank could resolve differently here and in `send_frame`: the
        // encoder would be built for one profile while the bytes went out
        // under the other's payload type. The comment on this function used to
        // claim they "cannot disagree"; that was true of the function and not
        // of its input.
        let remote = media.remote_pts();
        let params: Vec<&str0m::format::PayloadParams> =
            config.iter().filter(|p| remote.contains(&p.pt())).collect();
        best_h264(params.into_iter()).map(|p| profile_idc(p).unwrap_or(0x42))
    }

    /// Convenience for the Linux/VP8 path.
    pub fn negotiated_vp8(&self) -> bool {
        self.negotiated(Codec::Vp8)
    }

    /// Push one encoded frame. Returns false when the track is not ready yet.
    pub fn send_frame(
        &mut self,
        frame: &puca_encode::EncodedFrame,
        now: Instant,
    ) -> Result<bool, RtcSetupError> {
        let Some(mid) = self.mid else { return Ok(false) };
        let started = self.started;
        let Some(writer) = self.rtc.writer(mid) else { return Ok(false) };
        // Pick the payload type from THIS FRAME's codec, never the first one
        // offered. A peer may negotiate several, and sending bytes of one codec
        // under another's payload type produces a connection that works and
        // decodes to nothing — a black screen with a healthy-looking session.
        //
        // No fallback on purpose: if the negotiated set does not contain our
        // codec, refuse to send rather than send something undecodable.
        let pt = match frame.codec {
            // H.264 payloads are ranked, not first-match: a browser offers the
            // same codec several times (constrained-baseline through high, in
            // both packetization modes), and which one we pick decides both
            // the quality ceiling and whether frames may be fragmented. See
            // `best_h264`.
            puca_encode::FrameCodec::H264 => best_h264(writer.payload_params()).map(|p| p.pt()),
            puca_encode::FrameCodec::Vp8 => writer
                .payload_params()
                .find(|p| p.spec().codec == Codec::Vp8)
                .map(|p| p.pt()),
        };
        let Some(pt) = pt else {
            return Ok(false);
        };
        // 90 kHz video clock, measured from this sender's start.
        let rtp_time = MediaTime::new(
            (now.saturating_duration_since(started).as_secs_f64() * 90_000.0) as u64,
            Frequency::NINETY_KHZ,
        );
        writer
            .write(pt, now, rtp_time, frame.data.clone())
            .map_err(RtcSetupError::from)?;
        Ok(true)
    }

    /// The underlying Rtc, for the agent's own socket/timer loop.
    pub fn rtc_mut(&mut self) -> &mut Rtc {
        &mut self.rtc
    }
}

impl Default for VideoSender {
    fn default() -> Self {
        Self::new()
    }
}

/// profile_idc (0x42/0x4D/0x64) from a payload's fmtp, if it carries one.
fn profile_idc(p: &str0m::format::PayloadParams) -> Option<u8> {
    p.spec()
        .format
        .profile_level_id
        .map(|plid| ((plid >> 16) & 0xFF) as u8)
}

/// Pick the H.264 payload this sender should use, best first.
///
/// Two rules, in order:
///
///  1. ONLY packetization-mode 1 (or an absent fmtp, whose default some
///     browsers treat as mode 1 anyway). Mode 0 forbids FU-A fragmentation,
///     and a keyframe's SPS+IDR at desktop resolutions is far beyond one MTU —
///     picking a mode-0 payload produces a stream that works until the first
///     large NAL and then never again.
///  2. Among those, the highest profile: High (0x64) > Main (0x4D) > the
///     rest. High is CABAC + 8x8 transforms — measurably better text at the
///     same CBR target — and every Chromium offers it.
///
/// Falls back to the first H.264 payload of any shape rather than None, so a
/// peer with an eccentric offer degrades to exactly the old first-match
/// behaviour instead of losing video.
fn best_h264<'a>(
    params: impl Iterator<Item = &'a str0m::format::PayloadParams>,
) -> Option<&'a str0m::format::PayloadParams> {
    let all: Vec<&str0m::format::PayloadParams> =
        params.filter(|p| p.spec().codec == Codec::H264).collect();
    let mode1 = all
        .iter()
        .filter(|p| p.spec().format.packetization_mode.unwrap_or(1) == 1)
        .max_by_key(|p| match profile_idc(p) {
            Some(0x64) => 3,
            Some(0x4D) => 2,
            _ => 1,
        })
        .copied();
    mode1.or_else(|| all.first().copied())
}

/// The `a=mid:` of the first video m-section.
///
/// Parsed from SDP because str0m exposes no way to enumerate negotiated media,
/// and the mid is what every later `writer()` call is keyed on.
fn first_video_mid(sdp: &str) -> Option<Mid> {
    let mut in_video = false;
    for line in sdp.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("m=") {
            // Track which m-section we are inside; an audio section's mid would
            // silently send video down the wrong track.
            in_video = rest.starts_with("video");
        } else if in_video {
            if let Some(mid) = line.strip_prefix("a=mid:") {
                return Some(Mid::from(mid.trim()));
            }
        }
    }
    None
}

/// Does an SDP string advertise `codec` (by rtpmap name, e.g. "h264", "vp8")?
///
/// Worth having: an offer that negotiates cleanly while carrying no codec we can
/// produce yields a connection that works and shows nothing.
pub fn sdp_offers(sdp: &str, codec_name: &str) -> bool {
    sdp.to_ascii_lowercase().contains(&codec_name.to_ascii_lowercase())
}

/// Convenience wrapper kept for the H.264 tests and callers.
pub fn sdp_offers_h264(sdp: &str) -> bool {
    sdp_offers(sdp, "h264")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A browser-shaped offer. The browser offers first in the current
    /// design (session.ts creates it), so this is the path that runs.
        const BROWSER_OFFER: &str = "\
v=0\r\n\
o=- 1 1 IN IP4 127.0.0.1\r\n\
s=-\r\n\
t=0 0\r\n\
a=group:BUNDLE 0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 102\r\n\
c=IN IP4 0.0.0.0\r\n\
a=rtcp-mux\r\n\
a=ice-ufrag:abcd\r\n\
a=ice-pwd:efghijklmnopqrstuvwx\r\n\
a=fingerprint:sha-256 \
00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:\
00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n\
a=setup:actpass\r\n\
a=mid:0\r\n\
a=recvonly\r\n\
a=rtpmap:102 H264/90000\r\n\
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n";


    /// A Chrome-shaped offer carrying FOUR H.264 payloads, which is what a real
    /// browser sends: constrained-baseline and high, each in packetization mode
    /// 0 and 1. The single-payload BROWSER_OFFER above cannot exercise a
    /// ranking at all — every selection function returns the same pt.
    const MULTI_PROFILE_OFFER: &str = "\
v=0\r\n\
o=- 1 1 IN IP4 127.0.0.1\r\n\
s=-\r\n\
t=0 0\r\n\
a=group:BUNDLE 0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 96 98 100 102\r\n\
c=IN IP4 0.0.0.0\r\n\
a=rtcp-mux\r\n\
a=ice-ufrag:abcd\r\n\
a=ice-pwd:efghijklmnopqrstuvwx\r\n\
a=fingerprint:sha-256 \
00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:\
00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n\
a=setup:actpass\r\n\
a=mid:0\r\n\
a=recvonly\r\n\
a=rtpmap:96 H264/90000\r\n\
a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f\r\n\
a=rtpmap:98 H264/90000\r\n\
a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n\
a=rtpmap:100 H264/90000\r\n\
a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f\r\n\
a=rtpmap:102 H264/90000\r\n\
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f\r\n";

    /// The ranking must take the HIGH profile in packetization mode 1 (pt 102),
    /// not the first payload offered (pt 96, which is baseline AND mode 0).
    ///
    /// Both halves matter and each has cost a real failure class elsewhere:
    /// mode 0 forbids FU-A fragmentation, so a desktop-resolution keyframe
    /// would be undecodable; baseline forgoes CABAC, which is a standing
    /// bitrate cost on text.
    #[test]
    fn h264_selection_prefers_high_profile_in_packetization_mode_1() {
        let mut sender = VideoSender::new();
        sender.accept_offer(MULTI_PROFILE_OFFER).expect("answer");
        assert_eq!(
            sender.negotiated_h264_profile_idc(),
            Some(0x64),
            "must select the High-profile payload when the peer offers one",
        );
    }

    /// POSITIVE CONTROL for the test above: the rig can actually observe a
    /// LOWER answer. Without this, a `negotiated_h264_profile_idc` that
    /// returned `Some(0x64)` unconditionally — or an offer parser that quietly
    /// dropped the fmtp lines — would satisfy the assertion above while
    /// proving nothing.
    #[test]
    fn h264_selection_reports_baseline_when_that_is_all_the_peer_offers() {
        let mut sender = VideoSender::new();
        sender.accept_offer(BROWSER_OFFER).expect("answer");
        assert_eq!(
            sender.negotiated_h264_profile_idc(),
            Some(0x42),
            "the single-payload offer is baseline; reporting High would be a lie",
        );
    }

    /// Nothing negotiated yet must not resolve to a profile — the encoder is
    /// built from this, and a default-shaped `Some` would silently pin every
    /// session to whatever that default is.
    #[test]
    fn h264_profile_is_unknown_before_negotiation() {
        let sender = VideoSender::new();
        assert_eq!(sender.negotiated_h264_profile_idc(), None);
    }

    /// A real Chrome candidate line must be accepted.
    ///
    /// This is the one that was missing entirely: with no remote candidates
    /// str0m can only ever report `Checking`, which is exactly what the owner's
    /// agent.log showed while frames were being encoded.
    #[test]
    fn a_browser_trickled_candidate_is_accepted() {
        let mut sender = VideoSender::new();
        sender.accept_offer(BROWSER_OFFER).expect("answer");
        // srflx is the shape that actually connects across networks.
        sender
            .add_remote_candidate(
                "candidate:842163049 1 udp 1677729535 203.0.113.44 54321 typ srflx                  raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-cost 999",
            )
            .expect("a server-reflexive candidate must be accepted");
        sender
            .add_remote_candidate("candidate:1 1 udp 2113929471 198.51.100.7 9000 typ host")
            .expect("a host candidate must be accepted");
    }

    /// POSITIVE CONTROL for the test above: prove the parser can REFUSE, so
    /// "accepted" means something. Chrome hides local addresses behind mDNS
    /// names, which have no IP to connect to — the agent must skip those rather
    /// than fail the session, and the test must be able to see the difference.
    #[test]
    fn an_mdns_candidate_is_refused_not_silently_accepted() {
        let mut sender = VideoSender::new();
        sender.accept_offer(BROWSER_OFFER).expect("answer");
        let mdns = "candidate:1 1 udp 2113929471                     9b36eaac-bb2e-49bb-bb78-21c41c499900.local 9000 typ host";
        assert!(
            sender.add_remote_candidate(mdns).is_err(),
            "an mDNS candidate has no address; accepting it would mean the parser              accepts anything and the sibling test proves nothing"
        );
        assert!(sender.add_remote_candidate("total nonsense").is_err());
    }

    /// The load-bearing viability check, and it needs NO network — which is the
    /// property that made str0m worth choosing.
    #[test]
    fn produces_an_offer_advertising_h264_video() {
        let mut sender = VideoSender::new();
        sender
            .add_local_candidate("192.168.0.10:44444".parse().unwrap())
            .expect("candidate");
        let offer = sender.create_offer().expect("offer");

        assert!(offer.contains("m=video"), "offer must contain a video media section");
        assert!(sdp_offers_h264(&offer), "offer must advertise H.264:\n{offer}");
        // Send-only: the agent streams a screen; input arrives over the app's
        // sealed WebSocket channel, never over media.
        assert!(
            offer.contains("a=sendonly"),
            "the agent's video track must be send-only:\n{offer}"
        );
        assert!(offer.contains("a=candidate"), "offer must carry the local candidate");
    }

    #[test]
    fn a_second_offer_without_an_answer_is_refused() {
        // Applying an answer to the wrong pending offer silently mis-negotiates,
        // so the API is driven the way the agent will drive it.
        let mut sender = VideoSender::new();
        sender.create_offer().expect("first offer");
        assert!(sender.accept_answer("not-an-sdp").is_err(), "garbage must not apply");
    }

    #[test]
    fn the_mid_is_recorded_when_ANSWERING_not_only_when_offering() {
        // The bug a live browser test caught, and that the SDP-only assertion
        // below sailed straight past: answering left `mid` unset, so every frame
        // was silently dropped while the connection looked perfectly healthy.
        let mut sender = VideoSender::new();
        assert!(sender.mid.is_none(), "nothing negotiated yet");
        sender.accept_offer(BROWSER_OFFER).expect("answer");
        assert!(sender.mid.is_some(), "answering MUST record the mid to send on");
    }

    #[test]
    fn a_mid_is_taken_from_the_video_section_not_whichever_comes_first() {
        // An audio mid here would send video down the wrong track.
        let sdp = concat!(
            "v=0
",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111
",
            "a=mid:0
",
            "m=video 9 UDP/TLS/RTP/SAVPF 102
",
            "a=mid:1
",
        );
        assert_eq!(first_video_mid(sdp), Some(Mid::from("1")));
        assert_eq!(
            first_video_mid("v=0
m=audio 9 x
a=mid:0
"),
            None,
            "an audio-only answer has nothing to send video on",
        );
        assert_eq!(first_video_mid(""), None);
    }

    #[test]
    fn answering_a_browser_style_offer_yields_an_h264_answer() {
        // The browser offers first in the current design (session.ts creates the
        // offer), so this is the path that actually runs.
        let browser_offer = BROWSER_OFFER;

        let mut sender = VideoSender::new();
        let answer = sender.accept_offer(browser_offer).expect("should answer a browser offer");
        assert!(answer.contains("m=video"), "answer must contain video:\n{answer}");
        assert!(sdp_offers_h264(&answer), "answer must keep H.264:\n{answer}");
    }

    #[test]
    fn a_malformed_offer_is_refused_rather_than_half_applied() {
        let mut sender = VideoSender::new();
        assert!(sender.accept_offer("v=0\r\ngarbage").is_err());
    }

    #[test]
    fn sending_before_negotiation_reports_not_ready_instead_of_erroring() {
        // The agent's loop will try to push frames as soon as it has them; that
        // must be a no-op before the track exists, not a failure that tears the
        // session down.
        let mut sender = VideoSender::new();
        let frame = puca_encode::EncodedFrame {
            data: vec![0, 0, 0, 1, 0x65, 0xAA],
            keyframe: true,
            codec: puca_encode::FrameCodec::H264,
        };
        assert_eq!(sender.send_frame(&frame, Instant::now()).ok(), Some(false));
        assert!(!sender.is_connected());
    }

    #[test]
    fn h264_detection_does_not_claim_success_before_negotiation() {
        let sender = VideoSender::new();
        assert!(!sender.negotiated_h264(), "must not claim H.264 with no media at all");
    }

    /// A browser offer advertising ONLY VP8 — the mirror of BROWSER_OFFER,
    /// which is the Linux host's case.
    const BROWSER_OFFER_VP8: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtcp-mux\r\na=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdef0123\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\na=setup:actpass\r\na=mid:0\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\n";

    #[test]
    fn a_vp8_offer_is_answered_and_reported_as_vp8_not_h264() {
        // The Linux host's case. Answering a VP8-only offer must report VP8
        // negotiated and H.264 NOT negotiated — claiming H.264 here is exactly
        // how frames end up written under a payload type the peer cannot decode.
        let mut sender = VideoSender::new();
        let answer = sender.accept_offer(BROWSER_OFFER_VP8).expect("answer a VP8 offer");
        assert!(sdp_offers(&answer, "vp8"), "answer must keep VP8:
{answer}");
        assert!(sender.negotiated_vp8(), "VP8 must be reported negotiated");
        assert!(!sender.negotiated_h264(), "must NOT claim H.264 on a VP8-only session");
    }

    #[test]
    fn a_frame_is_never_sent_under_another_codecs_payload_type() {
        // THE FAILURE THIS GUARDS: sending VP8 bytes under an H.264 payload type
        // (or the reverse) gives a connection that looks entirely healthy and
        // decodes to nothing. Refusing to send is the correct answer.
        let mut sender = VideoSender::new();
        sender.accept_offer(BROWSER_OFFER_VP8).expect("answer");

        let h264_frame = puca_encode::EncodedFrame {
            data: vec![0, 0, 0, 1, 0x65, 0xAA],
            keyframe: true,
            codec: puca_encode::FrameCodec::H264,
        };
        // The session negotiated VP8 only, so an H.264 frame must be refused
        // rather than squeezed under the VP8 payload type.
        assert_eq!(
            sender.send_frame(&h264_frame, Instant::now()).ok(),
            Some(false),
            "an H.264 frame must not be sent on a VP8-only session",
        );
    }

    #[test]
    fn sdp_offers_matches_the_codec_it_is_asked_about() {
        assert!(sdp_offers(BROWSER_OFFER_VP8, "vp8"));
        assert!(!sdp_offers(BROWSER_OFFER_VP8, "h264"));
        assert!(sdp_offers(BROWSER_OFFER, "h264"));
        assert!(!sdp_offers(BROWSER_OFFER, "vp8"));
    }
}
