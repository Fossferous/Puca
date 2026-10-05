//! The clip desktop-audio wire into the page: what `clip_desktop_audio.rs`
//! sends on the raw binary IPC channel `start_clip_desktop_audio` is handed,
//! and what `api/clips/audioWire.ts` reads. Pure (no Tauri, no WASAPI) so the
//! byte layout and the batching are table-testable, and so the page's reader
//! is tested against the SAME bytes: `src/tests/fixtures/clip-audio-wire.json`
//! is built here and read there (src/tests/audioWire.test.ts).
//!
//! WHY IT EXISTS. Desktop audio used to reach the page as a Tauri event per
//! WASAPI packet: ~100 a second, each one 10 ms of interleaved f32 PCM
//! base64-encoded (x1.33), wrapped in JSON, formatted into a script and
//! evaluated in the page, where the main thread ran atob, a byte loop, a
//! de-interleave loop and built a new AudioBuffer and source — for every
//! packet, including the ones Windows flags as silent, which were sent as
//! zeros. 0.9.820 moved the clip VIDEO off that path (`chunk_frame` in
//! clip_capture.rs); this is the same move for audio:
//!
//!  - one raw binary message per ~100 ms of audio (`BATCH_MS`), not per
//!    packet. A raw message of 1 KiB or more costs an eval plus a fetch round
//!    trip (tauri `ipc/channel.rs`), and that round trip, not the bytes, is
//!    what the page pays for: measured in headless Edge (2026-10-04), each
//!    one took ~1 ms of the page's main thread, so 40 ms batches (25 a
//!    second) cost the page MORE than the base64 event they replaced, and
//!    100 ms (10 a second) cost it about 40% less. The batch is held in the
//!    shell up to 90 ms longer; the lead (below) accounts for every ms of it;
//!  - samples PLANAR (all of channel 0, then channel 1, ...), so the page hands
//!    each channel to `AudioBuffer.copyToChannel` as a view of the message;
//!  - a run of packets WASAPI flags silent is a message with NO samples,
//!    carrying how many frames of silence it stands for. The page advances its
//!    playhead by exactly that much and schedules nothing, so silence costs
//!    ~nothing and the timeline stays exact.
//!
//! THE LEAD IS MEASURED AS IT WAS, PACKET BY PACKET. The page measures the
//! loopback context's scheduling lead on arrival (`playhead - currentTime`,
//! nativeCapture.ts). On the one-packet wire every packet was emitted the
//! moment it was read, so each packet was one sample of that lead, and the
//! page reported a segment's lead whenever a sample beat the last report by
//! 5 ms. A batch holds its packets until its last one is read, so every
//! message lists its packets: how many frames each one is, and how long
//! before the message was sent it was read (`age_us`). The page walks that
//! list, adds each packet's age back, and takes exactly the samples the old
//! wire gave it, in the same order, under the same reporting rule — so the
//! measure, and the bias `NATIVE_AUDIO_OFFSET_US` was calibrated against, are
//! unchanged. (A first version sent one packet's position and age per
//! message, the one that would have shown the most lead. It took the same
//! maximum but reported it at different points than the per-packet rule
//! does, and under e2e/clip-av-emulation.mjs that alone moved clip audio by
//! up to a packet or two either way, 2026-10-04.)
//!
//! Little-endian, a fixed 24-byte header, then the packet table (8 bytes a
//! packet, so the payload stays 4-byte aligned for a Float32Array view), then
//! the samples:
//!
//!   0      u8   wire version (1)
//!   1      u8   flags: bit 0 = silent (no samples)
//!   2..10  u64  capture generation
//!  10..14  u32  sample rate (Hz)
//!  14..16  u16  channels
//!  16..20  u32  frames (per channel) this message stands for
//!  20..24  u32  packets: how many WASAPI packets it holds (n >= 1)
//!  24..    n x { u32 frames, u32 age_us }  in capture order; the frames sum
//!               to the message's, and age_us is how long before the send
//!               that packet was read
//!  24+8n.. channels x frames f32, planar (absent when silent)

// Only the Windows capture loop sends audio; elsewhere this is compiled
// (and tested) but never called.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::Instant;

pub const AUDIO_WIRE_VERSION: u8 = 1;
/// The fixed part of the header; the packet table follows it.
pub const AUDIO_HEADER_LEN: usize = 24;
/// One packet-table entry: u32 frames, u32 age_us.
pub const AUDIO_PACKET_ENTRY_LEN: usize = 8;
pub const AUDIO_FLAG_SILENT: u8 = 1;
/// The batch target. A message is sent once it holds at least this much, so
/// with WASAPI's usual 10 ms packets it is 100 ms (10 messages a second), and
/// never more than one packet beyond it. See the module header for why not
/// 40: the page pays per message, not per byte.
pub const BATCH_MS: u32 = 100;

/// One message. `packets` is (frames, age_us) per WASAPI packet in capture
/// order, its frames summing to the message's; `planar` is `None` for a
/// silent run (no samples), otherwise one slice per channel, each as long as
/// the message.
pub fn audio_frame<S: AsRef<[f32]>>(
    generation: u64,
    sample_rate: u32,
    channels: u16,
    packets: &[(u32, u32)],
    planar: Option<&[S]>,
) -> Vec<u8> {
    let frames: u32 = packets.iter().map(|p| p.0).sum();
    let payload = planar.map_or(0, |p| p.iter().map(|c| c.as_ref().len()).sum::<usize>() * 4);
    let mut out = Vec::with_capacity(AUDIO_HEADER_LEN + AUDIO_PACKET_ENTRY_LEN * packets.len() + payload);
    out.push(AUDIO_WIRE_VERSION);
    out.push(if planar.is_none() { AUDIO_FLAG_SILENT } else { 0 });
    out.extend_from_slice(&generation.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&frames.to_le_bytes());
    out.extend_from_slice(&(packets.len() as u32).to_le_bytes());
    for &(f, age_us) in packets {
        out.extend_from_slice(&f.to_le_bytes());
        out.extend_from_slice(&age_us.to_le_bytes());
    }
    if let Some(planar) = planar {
        for ch in planar {
            let ch = ch.as_ref();
            let at = out.len();
            out.resize(at + ch.len() * 4, 0);
            for (dst, s) in out[at..].chunks_exact_mut(4).zip(ch) {
                dst.copy_from_slice(&s.to_le_bytes());
            }
        }
    }
    out
}

/// What is being collected for the next message.
struct Pending {
    sample_rate: u32,
    channels: u16,
    silent: bool,
    frames: u32,
}

/// Turns WASAPI packets into wire messages: batches of about `BATCH_MS`,
/// planar, with runs of silent packets as sample-less messages. A message
/// never mixes formats or silent with sound — either change sends what is
/// pending first, so every frame WASAPI delivered is accounted for exactly
/// once, in order.
pub struct AudioBatcher {
    generation: u64,
    batch_ms: u32,
    pending: Option<Pending>,
    /// One sample buffer per channel, reused across messages.
    planar: Vec<Vec<f32>>,
    /// The pending message's packets: frames, and when each was read.
    /// Reused across messages.
    packets: Vec<(u32, Instant)>,
    /// The table as sent (frames, age_us). Reused across messages.
    table: Vec<(u32, u32)>,
}

impl AudioBatcher {
    pub fn new(generation: u64) -> Self {
        Self::with_batch_ms(generation, BATCH_MS)
    }

    pub fn with_batch_ms(generation: u64, batch_ms: u32) -> Self {
        Self {
            generation,
            batch_ms: batch_ms.max(1),
            pending: None,
            planar: Vec::new(),
            packets: Vec::new(),
            table: Vec::new(),
        }
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// One packet as WASAPI delivered it, read at `now`: `frames` frames of
    /// interleaved f32 little-endian in `data` (ignored when `silent`:
    /// AUDCLNT_BUFFERFLAGS_SILENT says the bytes mean nothing). Any message
    /// this completes is appended to `out`, ready to send.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        sample_rate: u32,
        channels: u16,
        frames: u32,
        data: &[u8],
        silent: bool,
        now: Instant,
        out: &mut Vec<Vec<u8>>,
    ) {
        if frames == 0 || channels == 0 || sample_rate == 0 {
            return;
        }
        // A short buffer (never seen; WASAPI fills what it reports) is read
        // as far as it goes rather than past its end.
        let frames = if silent {
            frames
        } else {
            frames.min((data.len() / (4 * channels as usize)) as u32)
        };
        if frames == 0 {
            return;
        }
        let incompatible = self.pending.as_ref().is_some_and(|p| {
            p.sample_rate != sample_rate || p.channels != channels || p.silent != silent
        });
        if incompatible {
            if let Some(m) = self.flush(now) {
                out.push(m);
            }
        }
        if self.pending.is_none() {
            let target = self.batch_frames(sample_rate) as usize;
            self.planar.resize_with(if silent { 0 } else { channels as usize }, Vec::new);
            for ch in &mut self.planar {
                ch.clear();
                ch.reserve(target + frames as usize);
            }
            self.packets.clear();
            self.pending = Some(Pending { sample_rate, channels, silent, frames: 0 });
        }
        if !silent {
            let frame_bytes = 4 * channels as usize;
            let packet = &data[..frames as usize * frame_bytes];
            for (c, plane) in self.planar.iter_mut().enumerate() {
                let o = c * 4;
                plane.extend(
                    packet
                        .chunks_exact(frame_bytes)
                        .map(|f| f32::from_le_bytes([f[o], f[o + 1], f[o + 2], f[o + 3]])),
                );
            }
        }
        self.packets.push((frames, now));
        let p = self.pending.as_mut().expect("pending was just ensured");
        p.frames += frames;
        if p.frames >= self.batch_frames(sample_rate) {
            if let Some(m) = self.flush(now) {
                out.push(m);
            }
        }
    }

    /// Send whatever is pending now (a timeout with no new packet, or a
    /// format/silence change). `None` when nothing is.
    pub fn flush(&mut self, now: Instant) -> Option<Vec<u8>> {
        let p = self.pending.take()?;
        self.table.clear();
        self.table.extend(self.packets.iter().map(|&(f, read)| {
            let age = now.saturating_duration_since(read).as_micros().min(u32::MAX as u128) as u32;
            (f, age)
        }));
        let planar = if p.silent { None } else { Some(&self.planar[..]) };
        Some(audio_frame(self.generation, p.sample_rate, p.channels, &self.table, planar))
    }

    fn batch_frames(&self, sample_rate: u32) -> u32 {
        ((sample_rate as u64 * self.batch_ms as u64) / 1000).max(1) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn le(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    /// A message read back (the TS reader's job; here to make the batching
    /// tests readable).
    struct Read {
        silent: bool,
        generation: u64,
        rate: u32,
        channels: u16,
        frames: u32,
        /// (frames, age_us) per packet.
        packets: Vec<(u32, u32)>,
        planar: Vec<Vec<f32>>,
    }
    fn read(m: &[u8]) -> Read {
        let u32_at = |o: usize| u32::from_le_bytes(m[o..o + 4].try_into().unwrap());
        assert_eq!(m[0], AUDIO_WIRE_VERSION);
        let channels = u16::from_le_bytes(m[14..16].try_into().unwrap());
        let frames = u32_at(16);
        let n = u32_at(20) as usize;
        let packets: Vec<(u32, u32)> = (0..n)
            .map(|k| (u32_at(AUDIO_HEADER_LEN + 8 * k), u32_at(AUDIO_HEADER_LEN + 8 * k + 4)))
            .collect();
        assert_eq!(packets.iter().map(|p| p.0).sum::<u32>(), frames, "the table accounts for every frame");
        let at = AUDIO_HEADER_LEN + AUDIO_PACKET_ENTRY_LEN * n;
        let silent = m[1] & AUDIO_FLAG_SILENT != 0;
        let planar = if silent {
            assert_eq!(m.len(), at, "a silent run carries no samples");
            vec![]
        } else {
            assert_eq!(m.len(), at + channels as usize * frames as usize * 4);
            (0..channels as usize)
                .map(|c| {
                    (0..frames as usize)
                        .map(|i| {
                            let o = at + (c * frames as usize + i) * 4;
                            f32::from_le_bytes(m[o..o + 4].try_into().unwrap())
                        })
                        .collect()
                })
                .collect()
        };
        Read {
            silent,
            generation: u64::from_le_bytes(m[2..10].try_into().unwrap()),
            rate: u32_at(10),
            channels,
            frames,
            packets,
            planar,
        }
    }

    /// The page reads exactly these bytes. Every message in the shared
    /// fixture is BUILT here from its fields and must come out as its hex;
    /// src/tests/audioWire.test.ts READS the same hex and must get the same
    /// fields. The hex came from an independent encoder, so a layout change
    /// on either side alone turns that side red.
    #[test]
    fn every_message_in_the_shared_fixture_is_its_documented_bytes() {
        let doc: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/tests/fixtures/clip-audio-wire.json"
        ))
        .expect("fixture parses");
        assert_eq!(doc["version"].as_u64(), Some(AUDIO_WIRE_VERSION as u64));
        assert_eq!(doc["headerLen"].as_u64(), Some(AUDIO_HEADER_LEN as u64));
        assert_eq!(doc["packetEntryLen"].as_u64(), Some(AUDIO_PACKET_ENTRY_LEN as u64));
        let cases = doc["cases"].as_array().expect("cases");
        let n = |c: &serde_json::Value, k: &str| c[k].as_u64().unwrap_or_else(|| panic!("{k} missing"));
        let (mut sound, mut silent) = (0, 0);
        for c in cases {
            let planar: Option<Vec<Vec<f32>>> = c["planar"].as_array().map(|chs| {
                chs.iter()
                    .map(|ch| ch.as_array().expect("a channel").iter().map(|x| x.as_f64().expect("a sample") as f32).collect())
                    .collect()
            });
            let packets: Vec<(u32, u32)> = c["packets"]
                .as_array()
                .expect("packets")
                .iter()
                .map(|p| (n(p, "frames") as u32, n(p, "ageUs") as u32))
                .collect();
            let f = audio_frame(n(c, "generation"), n(c, "sampleRate") as u32, n(c, "channels") as u16, &packets, planar.as_deref());
            assert_eq!(f, hex(c["hex"].as_str().expect("hex")), "{}", c["name"]);
            assert_eq!(read(&f).frames as u64, n(c, "frames"), "{}", c["name"]);
            if planar.is_some() {
                sound += 1
            } else {
                silent += 1
            }
        }
        // Positive control on the table itself: it must hold both kinds.
        assert!(sound >= 2 && silent >= 1, "the fixture covers sound ({sound}) and a silent run ({silent})");
    }

    /// The mechanics below are shown with 40 ms batches (four packets, easy
    /// to read). What the shell actually sends: 100 ms, ten 10 ms packets a
    /// message, at 48 kHz and at 44.1 kHz alike — ten a second, the rate the
    /// page's per-message cost was measured at.
    #[test]
    fn the_shell_sends_100_ms_a_message() {
        assert_eq!(BATCH_MS, 100);
        let t0 = Instant::now();
        for (rate, packet) in [(48_000u32, 480u32), (44_100, 441)] {
            let mut b = AudioBatcher::new(1);
            let mut out = vec![];
            let pcm = le(&vec![0.0f32; packet as usize * 2]);
            for k in 0..30u64 {
                b.push(rate, 2, packet, &pcm, false, t0 + Duration::from_millis(10 * k), &mut out);
            }
            assert_eq!(out.len(), 3, "{rate} Hz: 300 ms of packets is three messages");
            for m in &out {
                let r = read(m);
                assert_eq!((r.frames, r.packets.len()), (packet * 10, 10), "{rate} Hz");
            }
        }
    }

    #[test]
    fn ten_ms_packets_become_one_message_per_40_ms_planar_listing_each_packet() {
        let t0 = Instant::now();
        let mut b = AudioBatcher::with_batch_ms(3, 40);
        let mut out = vec![];
        // 8 stereo packets of 480 frames, each sample naming its packet,
        // frame and channel: (packet * 1000 + frame) * sign(channel).
        for k in 0..8u32 {
            let pcm: Vec<f32> = (0..480u32)
                .flat_map(|i| {
                    let v = (k * 1000 + i) as f32;
                    [v, -v]
                })
                .collect();
            b.push(48_000, 2, 480, &le(&pcm), false, t0 + Duration::from_millis(10 * k as u64), &mut out);
        }
        assert_eq!(out.len(), 2, "80 ms of 10 ms packets is two 40 ms messages");
        assert!(!b.has_pending());
        for (n, m) in out.iter().enumerate() {
            let r = read(m);
            assert!(!r.silent);
            assert_eq!((r.generation, r.rate, r.channels, r.frames), (3, 48_000, 2, 1920));
            // Four packets, each read 10 ms after the one before; the message
            // left as the fourth was read.
            assert_eq!(r.packets, vec![(480, 30_000), (480, 20_000), (480, 10_000), (480, 0)]);
            // Planar and in order: channel 0 is every packet's left samples
            // back to back, channel 1 the right.
            for i in 0..1920usize {
                let v = ((n as u32 * 4 + i as u32 / 480) * 1000 + i as u32 % 480) as f32;
                assert_eq!(r.planar[0][i], v);
                assert_eq!(r.planar[1][i], -v);
            }
        }
    }

    /// Packets are not read evenly — a busy capture thread, a game holding
    /// the CPU, two periods drained at once. Every packet's own read time is
    /// on the wire, so the page can take the sample each would have given
    /// on the one-packet wire.
    #[test]
    fn every_packet_carries_how_long_before_the_send_it_was_read() {
        let t0 = Instant::now();
        let ms = |m: u64| t0 + Duration::from_millis(m);
        let pcm = le(&[0.0f32; 480 * 2]);
        let ages = |reads: [u64; 4]| {
            let mut b = AudioBatcher::with_batch_ms(1, 40);
            let mut out = vec![];
            for r in reads {
                b.push(48_000, 2, 480, &pcm, false, ms(r), &mut out);
            }
            assert_eq!(out.len(), 1);
            read(&out[0]).packets.iter().map(|p| p.1).collect::<Vec<_>>()
        };
        assert_eq!(ages([0, 10, 20, 38]), vec![38_000, 28_000, 18_000, 0]);
        assert_eq!(ages([10, 12, 30, 40]), vec![30_000, 28_000, 10_000, 0]);
        assert_eq!(ages([5, 5, 25, 25]), vec![20_000, 20_000, 0, 0]);
    }

    #[test]
    fn a_silent_run_is_sample_less_messages_at_the_same_cadence_and_every_frame_is_counted() {
        let t0 = Instant::now();
        let mut b = AudioBatcher::with_batch_ms(1, 40);
        let mut out = vec![];
        let sound = le(&[0.5f32; 480 * 2]);
        // sound 20 ms, silence 100 ms, sound 30 ms, then a timeout flush.
        let mut t = t0;
        let mut packet = |silent: bool, out: &mut Vec<Vec<u8>>, b: &mut AudioBatcher| {
            b.push(48_000, 2, 480, if silent { &[] } else { &sound[..] }, silent, t, out);
            t += Duration::from_millis(10);
        };
        for _ in 0..2 {
            packet(false, &mut out, &mut b);
        }
        for _ in 0..10 {
            packet(true, &mut out, &mut b);
        }
        for _ in 0..3 {
            packet(false, &mut out, &mut b);
        }
        let tail = b.flush(t0 + Duration::from_millis(165)).unwrap();
        out.push(tail);
        let msgs: Vec<Read> = out.iter().map(|m| read(m)).collect();
        let shape: Vec<(bool, u32, usize)> = msgs.iter().map(|r| (r.silent, r.frames, r.packets.len())).collect();
        assert_eq!(
            shape,
            vec![
                (false, 960, 2),  // the sound before the silence, sent when the silence began
                (true, 1920, 4),  // 40 ms of silence
                (true, 1920, 4),  // 40 ms of silence
                (true, 960, 2),   // the last 20 ms of it, sent when the sound came back
                (false, 1440, 3), // the tail, by the timeout
            ]
        );
        // THE TIMELINE IS EXACT: nothing dropped, nothing invented.
        assert_eq!(msgs.iter().map(|r| r.frames).sum::<u32>(), 15 * 480);
        // Every packet says how long it waited: a full batch goes the moment
        // its last packet is read; a run cut short by a change waited for
        // the packet that showed the change; the tail waited for the
        // timeout (its packets read at t0 + 120..140 ms, sent at 165).
        let ages: Vec<Vec<u32>> = msgs.iter().map(|r| r.packets.iter().map(|p| p.1).collect()).collect();
        assert_eq!(
            ages,
            vec![
                vec![20_000, 10_000],
                vec![30_000, 20_000, 10_000, 0],
                vec![30_000, 20_000, 10_000, 0],
                vec![20_000, 10_000],
                vec![45_000, 35_000, 25_000],
            ]
        );
    }

    /// WASAPI's autoconvert hands this capture 48 kHz stereo whatever the
    /// device runs, but a restart can land on another device and nothing on
    /// the wire may assume a format: 44.1 kHz, 5.1 and 7.1 batch the same
    /// way, a change of format sends what is pending first, and a
    /// multichannel packet is de-interleaved channel by channel.
    #[test]
    fn any_rate_and_channel_count_batches_and_a_format_change_flushes() {
        let t0 = Instant::now();
        let mut b = AudioBatcher::with_batch_ms(2, 40);
        let mut out = vec![];
        // 44.1 kHz 5.1: 441-frame packets; 40 ms is 1764 frames, so the 4th
        // packet (1764) completes the message.
        let pcm51: Vec<f32> = (0..441).flat_map(|i| (0..6).map(move |c| (c * 10_000 + i) as f32)).collect();
        for k in 0..4 {
            b.push(44_100, 6, 441, &le(&pcm51), false, t0 + Duration::from_millis(10 * k), &mut out);
        }
        assert_eq!(out.len(), 1);
        let r = read(&out[0]);
        assert_eq!((r.rate, r.channels, r.frames, r.packets.len()), (44_100, 6, 1764, 4));
        for c in 0..6 {
            assert_eq!(r.planar[c][0], (c * 10_000) as f32);
            assert_eq!(r.planar[c][440], (c * 10_000 + 440) as f32);
            assert_eq!(r.planar[c][441], (c * 10_000) as f32, "the second packet follows the first");
        }
        // 7.1 at 48 kHz, after a 20 ms 5.1 remainder: the change of format
        // sends the remainder on its own first.
        out.clear();
        for k in 0..2 {
            b.push(44_100, 6, 441, &le(&pcm51), false, t0 + Duration::from_millis(50 + 10 * k), &mut out);
        }
        assert!(out.is_empty());
        let pcm71 = le(&vec![0.125f32; 480 * 8]);
        b.push(48_000, 8, 480, &pcm71, false, t0 + Duration::from_millis(70), &mut out);
        assert_eq!(out.len(), 1, "the 5.1 remainder went first");
        let r = read(&out[0]);
        assert_eq!((r.rate, r.channels, r.frames), (44_100, 6, 882));
        assert_eq!(r.packets, vec![(441, 20_000), (441, 10_000)]);
        let r = read(&b.flush(t0 + Duration::from_millis(70)).unwrap());
        assert_eq!((r.rate, r.channels, r.frames, r.packets.clone()), (48_000, 8, 480, vec![(480, 0)]));
        assert!(r.planar.iter().all(|c| c.len() == 480 && c.iter().all(|&s| s == 0.125)));
    }

    #[test]
    fn nothing_pending_flushes_nothing_and_empty_packets_are_ignored() {
        let t0 = Instant::now();
        let mut b = AudioBatcher::with_batch_ms(1, 40);
        let mut out = vec![];
        assert!(b.flush(t0).is_none());
        b.push(48_000, 2, 0, &[], false, t0, &mut out);
        // A buffer shorter than the frames it claims is read as far as it goes.
        b.push(48_000, 2, 480, &le(&[1.0f32; 10]), false, t0, &mut out);
        assert!(out.is_empty());
        let r = read(&b.flush(t0).unwrap());
        assert_eq!((r.frames, r.packets), (5, vec![(5, 0)]));
    }
}
