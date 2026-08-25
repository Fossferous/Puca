//! H.264 encoding for the host agent.
//!
//! WHY THIS EXISTS, measured rather than assumed: one 2560x1440 BGRA frame is
//! 14.7 MB raw (19.6 MB once base64'd for the agent pipe). At 30fps that is
//! about 440 MB/s — so the raw path that made capture verifiable cannot ship.
//! Everything downstream (the WebRTC sender, the frame AEAD) works on encoded
//! frames.
//!
//! Media Foundation's H.264 MFT rather than a bundled encoder: it is present on
//! every supported Windows, transparently uses the GPU encoder when one exists,
//! and adds no redistribution question. openh264's binary is fetched at runtime
//! under Cisco's terms, which is a poor fit for a self-hosted app expected to
//! work offline.
//!
//! Output is Annex-B (start-code delimited).
//!
//! CORRECTION (2026-07-29): an earlier version of this comment said the frame
//! AEAD's clear-header offsets (10 keyframe / 3 delta) "are into an Annex-B NAL
//! stream". That is WRONG and it is worth stating rather than quietly deleting,
//! because it was used to price a piece of work.
//!
//! Those numbers are the **VP8** uncompressed data chunk sizes (RFC 6386 §9.1:
//! 3-byte frame tag + 3-byte start code 9d 01 2a + 2-byte width + 2-byte
//! height = 10 for a keyframe; frame tag alone = 3 for an interframe), plus the
//! Opus TOC byte for audio (RFC 6716 §3.1). They are the exact offsets at which
//! the boolean-entropy-coded partition begins. The numeric fit with anything
//! H.264 is coincidence.
//!
//! THEY ARE NOT VALID FOR H.264, and that is a latent defect rather than a live
//! one: nothing currently seals agent-produced H.264 (`stream.rs` hands encoded
//! bytes straight to the str0m writer, and the frame AEAD is only applied on the
//! browser mesh path). If it ever were sealed with these offsets the break would
//! be in PACKETIZATION, not crypto — str0m's H264Packetizer scans for Annex-B
//! start codes, and 10 clear bytes stops inside the SPS, so it would split on
//! whatever 00 00 01 sequences the ciphertext happened to contain. The correct
//! fix there is a codec-aware slice-NAL walk, not a different constant.
//!
//! MEASURED on a 2560x1440 desktop (tests/live_encode.rs):
//!   * 309 MB of raw frames -> 765 KB encoded, about 404x.
//!   * The keyframe arrives as NALs [9, 7, 8, 6, 6, 5] — AUD, SPS, PPS, SEI,
//!     IDR — and deltas as [9, 1].
//!   * The MFT used to buffer **17 frames** before emitting anything — about
//!     567ms at 30fps, which is most of the lag a remote-control user feels.
//!     `CODECAPI_AVLowLatencyMode` is the lever, and the trick is WHEN: set
//!     after `SetInputType` it returns `Ok(())` and does nothing, because the
//!     MFT reads its codec configuration while negotiating types. Set BEFORE
//!     `SetOutputType` the same call takes the depth to **1 frame (~33ms)**,
//!     measured both ways by `the_first_encoded_frame_emerges_within_a_few_inputs`.
//!     Compression did not suffer: still ~255x on real desktop content.
//!     `NeedMoreInput` remains normal and callers must not read it as a stall.
//!   * Asking for the GPU encoder and rewriting the BGRA->NV12 conversion took
//!     `encode_bgra` from **14.8ms to 5.5ms** per 1440p frame — 56 fps
//!     achievable to 117 — and compression from 404x to 840x, because the
//!     encoder gets each frame while its rate control still has time to spend
//!     on it. Neither half subsumes the other: the conversion runs before the
//!     GPU sees anything, so a hardware encoder alone would still have left
//!     ~15ms of a 33ms budget on the floor.

/// Which H.264 profile to configure the encoder for.
///
/// Chosen from what the PEER negotiated, never assumed: sending High-profile
/// bitstream under a payload type whose fmtp says baseline decodes on Chromium
/// by luck, not by contract. Baseline is the safe floor; High buys roughly
/// 10-20% bitrate efficiency (CABAC, 8x8 transforms) at the same visual
/// quality, which at a fixed CBR target is a straight quality win.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum H264Profile {
    Baseline,
    Main,
    High,
}

/// Which codec produced a frame.
///
/// Carried WITH the bytes rather than inferred, because every consumer needs it
/// and guessing is how bytes end up sent under the wrong RTP payload type — a
/// connection that looks healthy and decodes to nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameCodec {
    /// Annex-B: NAL units prefixed with 00 00 00 01 / 00 00 01.
    H264,
    /// A VP8 frame: uncompressed data chunk then the boolean-coded partitions.
    Vp8,
}

/// One encoded frame.
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    /// The bitstream. Its layout depends on `codec` — do NOT assume Annex-B.
    pub data: Vec<u8>,
    /// True for a keyframe — the frame a joining viewer can start decoding
    /// from. Getting this wrong means either a receiver that never gets a
    /// decodable start, or one that discards perfectly good deltas.
    pub keyframe: bool,
    /// What produced `data`. The RTP payload type is chosen from this.
    pub codec: FrameCodec,
}

#[derive(Debug)]
pub enum EncodeError {
    /// The encoder wants more input before it can emit anything. Normal at
    /// startup and NOT a failure — an encoder that has not filled its pipeline
    /// yet looks identical to a broken one if this is treated as an error.
    NeedMoreInput,
    Failed(String),
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EncodeError::NeedMoreInput => write!(f, "encoder needs more input"),
            EncodeError::Failed(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EncodeError {}

/// Does `data` begin with an Annex-B start code?
pub fn has_start_code(data: &[u8]) -> bool {
    data.starts_with(&[0, 0, 0, 1]) || data.starts_with(&[0, 0, 1])
}

/// Walk the NAL unit types present in an Annex-B stream.
///
/// Used to tell a keyframe from a delta without trusting the encoder's own
/// flag — MFT sets its keyframe attribute inconsistently across drivers, and a
/// receiver that never gets a real IDR shows a permanently black screen.
pub fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 3 < data.len() {
        let (is_start, skip) = if data[i..].starts_with(&[0, 0, 0, 1]) {
            (true, 4)
        } else if data[i..].starts_with(&[0, 0, 1]) {
            (true, 3)
        } else {
            (false, 1)
        };
        if is_start {
            if let Some(&b) = data.get(i + skip) {
                out.push(b & 0x1F); // low 5 bits = nal_unit_type
            }
            i += skip;
        } else {
            i += 1;
        }
    }
    out
}

/// Whether the stream carries an IDR (type 5). SPS (7) and PPS (8) usually
/// precede it and are not themselves decodable starts.
pub fn contains_idr(data: &[u8]) -> bool {
    nal_types(data).contains(&5)
}

#[cfg(windows)]
mod windows_impl;

#[cfg(windows)]
pub use windows_impl::H264Encoder;

/// Is this VP8 frame a keyframe?
///
/// Read from the BITSTREAM, not from whatever the encoder claimed, for the same
/// reason `contains_idr` exists: the two disagreeing is a real failure mode, and
/// the bitstream is the thing the decoder will actually believe.
///
/// RFC 6386 §9.1. Bit 0 of the first frame-tag byte is the frame type — 0 means
/// KEY, 1 means interframe (note the inversion; reading it the obvious way round
/// marks every delta as a keyframe). A keyframe then carries the 3-byte start
/// code `9d 01 2a` at offset 3.
///
/// BOTH checks are required. A bare `d[0] & 1 == 0` calls a truncated or empty
/// buffer a keyframe, and a caller that trusts it will announce a decodable
/// start that is not there.
pub fn is_vp8_keyframe(data: &[u8]) -> bool {
    data.len() >= 10
        && data[0] & 0x01 == 0
        && data[3] == 0x9d
        && data[4] == 0x01
        && data[5] == 0x2a
}

/// Width and height a VP8 KEYFRAME declares, or None if it is not one.
///
/// Surfaced because a mismatch against the capture size is a real bug that
/// otherwise shows up as a stretched or torn picture rather than an error.
pub fn vp8_keyframe_dimensions(data: &[u8]) -> Option<(u16, u16)> {
    if !is_vp8_keyframe(data) {
        return None;
    }
    // 14-bit sizes; the top 2 bits are the upscaling factor, not part of it.
    let w = u16::from_le_bytes([data[6], data[7]]) & 0x3fff;
    let h = u16::from_le_bytes([data[8], data[9]]) & 0x3fff;
    Some((w, h))
}

#[cfg(all(unix, feature = "vp8"))]
mod vp8_impl;

#[cfg(all(unix, feature = "vp8"))]
pub use vp8_impl::Vp8Encoder;

#[cfg(not(windows))]
mod stub {
    use super::*;

    /// Hard error rather than empty frames: an agent that reported "encoding"
    /// while emitting nothing would look connected and show a black screen.
    pub struct H264Encoder;

    impl H264Encoder {
        pub fn new(_w: u32, _h: u32, _fps: u32, _bitrate: u32) -> Result<Self, EncodeError> {
            Err(EncodeError::Failed(
                "H.264 encoding is only implemented on Windows".into(),
            ))
        }
        pub fn encode_bgra(
            &mut self,
            _bgra: &[u8],
            _stride: usize,
            _force_key: bool,
        ) -> Result<EncodedFrame, EncodeError> {
            Err(EncodeError::Failed(
                "H.264 encoding is only implemented on Windows".into(),
            ))
        }
    }
}

#[cfg(not(windows))]
pub use stub::H264Encoder;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_both_start_code_lengths() {
        assert!(has_start_code(&[0, 0, 0, 1, 0x65]));
        assert!(has_start_code(&[0, 0, 1, 0x65]));
        assert!(!has_start_code(&[0, 0, 0, 0]));
        assert!(!has_start_code(&[1, 2, 3, 4]));
        assert!(!has_start_code(&[]));
    }

    #[test]
    fn extracts_nal_types_across_units() {
        // SPS(7), PPS(8), IDR(5) — the usual keyframe preamble.
        let stream = [
            0, 0, 0, 1, 0x67, 0xAA,
            0, 0, 0, 1, 0x68, 0xBB,
            0, 0, 0, 1, 0x65, 0xCC,
        ];
        assert_eq!(nal_types(&stream), vec![7, 8, 5]);
        assert!(contains_idr(&stream));
    }

    #[test]
    fn a_delta_only_stream_is_not_a_keyframe() {
        // Type 1 is a non-IDR slice. Treating it as a keyframe means a joining
        // viewer is told it can start decoding when it cannot, and sits on a
        // black screen indefinitely.
        let stream = [0, 0, 0, 1, 0x41, 0xDD];
        assert_eq!(nal_types(&stream), vec![1]);
        assert!(!contains_idr(&stream));
    }

    #[test]
    fn handles_three_byte_start_codes_too() {
        // Encoders mix 3- and 4-byte start codes within one stream; scanning
        // for only the 4-byte form silently misses half the NALs.
        let stream = [0, 0, 1, 0x67, 0, 0, 0, 1, 0x65];
        assert_eq!(nal_types(&stream), vec![7, 5]);
        assert!(contains_idr(&stream));
    }

    #[test]
    fn empty_and_truncated_input_do_not_panic() {
        assert!(nal_types(&[]).is_empty());
        assert!(nal_types(&[0, 0]).is_empty());
        assert!(nal_types(&[0, 0, 0, 1]).is_empty(), "a start code with no payload yields nothing");
        assert!(!contains_idr(&[]));
    }

    /// Build a minimal VP8 frame header. `key` picks the frame type; the rest is
    /// the real layout so the tests exercise the same bytes libvpx emits.
    fn vp8_header(key: bool, w: u16, h: u16) -> Vec<u8> {
        let mut d = vec![0u8; 10];
        // Frame tag, 3 bytes little-endian: bit 0 = frame type (0 = KEY),
        // bits 1-3 version, bit 4 show_frame, bits 5-23 partition size.
        d[0] = if key { 0x00 } else { 0x01 };
        d[1] = 0x00;
        d[2] = 0x00;
        if key {
            d[3] = 0x9d;
            d[4] = 0x01;
            d[5] = 0x2a;
            d[6..8].copy_from_slice(&w.to_le_bytes());
            d[8..10].copy_from_slice(&h.to_le_bytes());
        }
        d
    }

    #[test]
    fn a_vp8_keyframe_is_recognised() {
        assert!(is_vp8_keyframe(&vp8_header(true, 1920, 1080)));
    }

    #[test]
    fn the_frame_type_bit_is_INVERTED_and_that_matters() {
        // RFC 6386: bit 0 == 0 means KEY, 1 means interframe. Reading it the
        // obvious way round marks every delta as a keyframe, which tells the
        // receiver it can start decoding anywhere — it cannot, and the result is
        // a permanently broken picture rather than an error.
        let delta = vp8_header(false, 1920, 1080);
        assert_eq!(delta[0] & 1, 1, "the fixture really is an interframe");
        assert!(!is_vp8_keyframe(&delta));
    }

    #[test]
    fn a_frame_without_the_start_code_is_not_a_keyframe() {
        // The frame-type bit alone is not enough: random data with an even first
        // byte would pass. The 9d 01 2a start code is what makes it VP8.
        let mut d = vp8_header(true, 640, 480);
        d[4] = 0x02;
        assert!(!is_vp8_keyframe(&d), "a corrupt start code must not pass");
    }

    #[test]
    fn a_truncated_frame_is_never_a_keyframe() {
        // The length guard. Without it these index out of bounds or, worse,
        // report a decodable start that is not there.
        assert!(!is_vp8_keyframe(&[]));
        assert!(!is_vp8_keyframe(&[0x00]));
        for n in 0..10 {
            let short = vp8_header(true, 320, 240)[..n].to_vec();
            assert!(!is_vp8_keyframe(&short), "{n} bytes must not qualify");
        }
    }

    #[test]
    fn keyframe_dimensions_are_read_back() {
        // A mismatch against the capture size shows up as a stretched or torn
        // picture rather than an error, so it is worth being able to assert on.
        assert_eq!(vp8_keyframe_dimensions(&vp8_header(true, 2560, 1440)), Some((2560, 1440)));
        assert_eq!(vp8_keyframe_dimensions(&vp8_header(true, 320, 240)), Some((320, 240)));
    }

    #[test]
    fn the_upscaling_bits_are_masked_off_the_dimensions() {
        // The size fields are 14-bit; the top 2 bits are a scaling factor. Not
        // masking them turns 1920 into a nonsense width on any frame that sets
        // them.
        let mut d = vp8_header(true, 1920, 1080);
        d[7] |= 0xc0; // horizontal scale = 3
        d[9] |= 0x40; // vertical scale = 1
        assert_eq!(vp8_keyframe_dimensions(&d), Some((1920, 1080)));
    }

    #[test]
    fn dimensions_are_none_for_an_interframe() {
        // Interframes carry no size at all; returning stale or garbage numbers
        // would be worse than admitting there are none.
        assert_eq!(vp8_keyframe_dimensions(&vp8_header(false, 1920, 1080)), None);
    }

    #[test]
    fn h264_and_vp8_detection_do_not_answer_for_each_other() {
        // The two codecs' detectors must not cross-fire: an Annex-B IDR is not a
        // VP8 keyframe, and a VP8 keyframe contains no NAL start code.
        let annexb = [0u8, 0, 0, 1, 0x65, 1, 2, 3, 4, 5];
        assert!(contains_idr(&annexb));
        assert!(!is_vp8_keyframe(&annexb));

        let vp8 = vp8_header(true, 640, 480);
        assert!(!contains_idr(&vp8));
        assert!(is_vp8_keyframe(&vp8));
    }
}
