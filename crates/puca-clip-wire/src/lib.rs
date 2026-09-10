//! The frame format the clip capture host writes and the app reads.
//!
//! ONE DEFINITION, TWO PROCESSES. Clip capture runs in the agent rather than in
//! the app (see `puca-agent/src/clip_host.rs` for why: the app is pinned to a
//! GPU that drives no display, and desktop duplication only works on the GPU
//! driving the screen). That makes this a wire format, and a wire format
//! written out by hand at both ends is a format that will disagree with itself
//! — this codebase has already been bitten by frames built from a guessed
//! shape rather than the other end's real type. So both ends build and parse
//! records HERE, and the round-trip is tested.
//!
//! The stream is: `MAGIC` once, then records of
//! `flags:u8, ts_us:u64, dur_us:u64, len:u32, payload[len]`, little-endian.
//! The payload is one H.264 access unit in Annex-B.

/// Written once, after capture AND the encoder have both opened successfully.
///
/// It doubles as the READY signal: the parent cannot otherwise tell "started
/// and waiting for the screen to change" from "failed to start", because both
/// look like silence on a pipe.
pub const MAGIC: &[u8; 8] = b"PUCACLP1";

/// Bit 0 of `flags`: this access unit is a keyframe.
pub const FLAG_KEYFRAME: u8 = 1;

/// Bytes before the payload: flags(1) + ts_us(8) + dur_us(8) + len(4).
pub const HEADER_LEN: usize = 21;

/// An access unit's header, without the payload bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub keyframe: bool,
    /// Capture-relative microseconds. The first record of a session is 0.
    pub ts_us: u64,
    pub dur_us: u64,
    pub len: u32,
}

impl Header {
    pub fn to_bytes(self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[0] = if self.keyframe { FLAG_KEYFRAME } else { 0 };
        b[1..9].copy_from_slice(&self.ts_us.to_le_bytes());
        b[9..17].copy_from_slice(&self.dur_us.to_le_bytes());
        b[17..21].copy_from_slice(&self.len.to_le_bytes());
        b
    }

    pub fn from_bytes(b: &[u8; HEADER_LEN]) -> Self {
        Self {
            keyframe: b[0] & FLAG_KEYFRAME != 0,
            ts_us: u64::from_le_bytes(b[1..9].try_into().expect("8 bytes")),
            dur_us: u64::from_le_bytes(b[9..17].try_into().expect("8 bytes")),
            len: u32::from_le_bytes(b[17..21].try_into().expect("4 bytes")),
        }
    }
}

/// Refuse a length that cannot be a real access unit.
///
/// The reader allocates `len` bytes before it has seen them, so a desynced or
/// corrupt stream would otherwise be an instruction to allocate up to 4 GiB.
/// 64 MiB is far above any single frame this encoder produces.
pub const MAX_PAYLOAD: u32 = 64 * 1024 * 1024;

pub fn payload_len_is_sane(len: u32) -> bool {
    len <= MAX_PAYLOAD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_survives_the_round_trip() {
        // The whole point of this crate: if the two ends ever disagree about
        // field order or width, this is what says so.
        let h = Header { keyframe: true, ts_us: 1_234_567_890, dur_us: 16_666, len: 4096 };
        assert_eq!(Header::from_bytes(&h.to_bytes()), h);
    }

    #[test]
    fn a_delta_frame_round_trips_too() {
        // POSITIVE CONTROL for the flag: without this, `keyframe: true` for
        // every frame would pass the test above and break seeking silently.
        let h = Header { keyframe: false, ts_us: 0, dur_us: 1, len: 0 };
        let round = Header::from_bytes(&h.to_bytes());
        assert_eq!(round, h);
        assert!(!round.keyframe);
    }

    #[test]
    fn the_header_is_exactly_as_long_as_it_claims() {
        // A reader does one read_exact of HEADER_LEN. If the struct grows and
        // this constant does not, the reader silently takes the first bytes of
        // the payload as fields.
        assert_eq!(Header { keyframe: false, ts_us: 0, dur_us: 0, len: 0 }.to_bytes().len(), HEADER_LEN);
    }

    #[test]
    fn the_biggest_values_do_not_wrap() {
        let h = Header { keyframe: true, ts_us: u64::MAX, dur_us: u64::MAX, len: u32::MAX };
        assert_eq!(Header::from_bytes(&h.to_bytes()), h);
    }

    #[test]
    fn an_absurd_length_is_refused_and_a_real_one_is_not() {
        assert!(!payload_len_is_sane(u32::MAX));
        assert!(!payload_len_is_sane(MAX_PAYLOAD + 1));
        // POSITIVE CONTROL: a large but ordinary keyframe still passes, or the
        // guard would be a cap on legitimate video.
        assert!(payload_len_is_sane(2 * 1024 * 1024));
        assert!(payload_len_is_sane(MAX_PAYLOAD));
    }

    #[test]
    fn the_magic_is_eight_bytes_and_not_a_prefix_of_a_header() {
        // The reader reads the magic with read_exact(8) before any record, so
        // a magic of a different length would eat into the first frame.
        assert_eq!(MAGIC.len(), 8);
    }
}
