//! Latency on the agent's side of remote control: when to capture after an
//! input arrives, and the probe that measures the whole loop.
//!
//! CAPTURING SOON AFTER AN INPUT. The stream loop captures on a fixed clock
//! (`next_frame += frame_interval`), so whatever an input changes on screen —
//! the pointer the agent draws, a menu opening — waits for the next tick: half
//! a frame on average, a whole frame at worst (17 / 33 ms at 30 fps). An input
//! that arrives over the direct channel now pulls the next tick in to just
//! after it, so the change is captured as soon as Windows can show it, and the
//! clock carries on from there. Bounded below by half a frame after the last
//! capture, so a fast mouse cannot more than double the frame rate the session
//! asked for.
//!
//! THE PROBE. The viewer sends `{"t":"probe","p":N}` on the direct input
//! channel, the same lane its mouse takes. The agent injects nothing: it
//! captures as an input would make it (the pull-in above), sends the next
//! frame even if the screen is still (re-sending the held picture, as it does
//! for a keyframe request), and answers on the caret channel with that frame's
//! RTP timestamp. The viewer timed the send and sees the frame presented
//! (`requestVideoFrameCallback` reports its `rtpTimestamp`), so the difference
//! is the whole loop — viewer, network, this loop, capture, encode, network,
//! jitter buffer, decode, display — on ONE clock, the viewer's. `host` in the
//! answer is this side's share, from the probe's arrival to its frame's send.
//!
//! `"q":1` on a probe (or on any input) asks for the OLD timing — no pull-in —
//! so the viewer's "compare" can measure before and after in one build.

use std::time::{Duration, Instant};

/// How long after an input to capture: enough for the pointer to have moved
/// (SendInput is applied by the raw-input thread almost at once) and short of
/// any frame interval. The capture's own acquire wait (up to 5 ms) still lets
/// a change that takes a composition to appear arrive in the same frame.
pub(crate) const INPUT_CAPTURE_LEAD: Duration = Duration::from_millis(2);

/// The closest two captures may be after a pull-in, as a fraction of the
/// session's frame interval. Half a frame: at most twice the asked-for rate,
/// and only while input keeps arriving faster than the frame clock.
pub(crate) const MIN_CAPTURE_GAP: f64 = 0.5;

/// When the next capture should happen after an input at `now`, given the last
/// capture: soon after the input, but never closer than half a frame after the
/// last capture. The caller takes the EARLIER of this and its own schedule.
pub(crate) fn capture_after_input(now: Instant, last_capture: Option<Instant>, interval: Duration) -> Instant {
    let soon = now + INPUT_CAPTURE_LEAD;
    match last_capture {
        Some(t) => soon.max(t + interval.mul_f64(MIN_CAPTURE_GAP)),
        None => soon,
    }
}

/// Does this input ask for the old timing (`"q":1`)? A cheap look rather than
/// a parse: it runs on every input, and the viewer writes the field exactly so.
pub(crate) fn wants_classic(event_json: &str) -> bool {
    event_json.contains("\"q\":1")
}

/// A probe waiting for its frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Probe {
    pub id: u32,
    pub arrived: Instant,
}

/// `{"t":"probe","p":N}` (with or without `"q":1`), or None for anything else
/// — including every ordinary input, which must go on to be injected.
pub(crate) fn parse_probe(event_json: &str) -> Option<u32> {
    // Most inputs are not probes; skip the parse for them.
    if !event_json.contains("\"probe\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(event_json).ok()?;
    if v.get("t")?.as_str()? != "probe" {
        return None;
    }
    let p = v.get("p")?.as_u64()?;
    u32::try_from(p).ok()
}

/// The answer, as the viewer's caret-channel reader expects it: the probe, the
/// RTP timestamp of the frame that answers it, and this side's milliseconds.
pub(crate) fn probe_reply(id: u32, rtp_ts: u32, host: Duration) -> Vec<u8> {
    let host_ms = (host.as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
    format!("{{\"k\":\"probe\",\"p\":{id},\"ts\":{rtp_ts},\"host\":{host_ms}}}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_input_pulls_the_capture_in_to_just_after_it() {
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        // Last capture 1 ms ago: half a frame is the floor.
        let at = capture_after_input(t0 + Duration::from_millis(1), Some(t0), interval);
        assert_eq!(at, t0 + interval.mul_f64(MIN_CAPTURE_GAP));
        // Mid-frame: just after the input, well before the next tick at 33 ms.
        let input = t0 + Duration::from_millis(20);
        let at = capture_after_input(input, Some(t0), interval);
        assert_eq!(at, input + INPUT_CAPTURE_LEAD);
        assert!(at < t0 + interval, "the point is to beat the fixed clock");
        // No capture yet: just after the input.
        assert_eq!(capture_after_input(input, None, interval), input + INPUT_CAPTURE_LEAD);
    }

    #[test]
    fn a_probe_is_recognised_and_nothing_else_is() {
        assert_eq!(parse_probe(r#"{"t":"probe","p":7}"#), Some(7));
        assert_eq!(parse_probe(r#"{"t":"probe","p":7,"q":1}"#), Some(7));
        assert_eq!(parse_probe(r#"{"t":"move","x":0.5,"y":0.5}"#), None);
        assert_eq!(parse_probe(r#"{"t":"text","text":"probe"}"#), None, "the word in typed text is not a probe");
        assert_eq!(parse_probe(r#"{"t":"probe"}"#), None, "no id, no probe");
        assert_eq!(parse_probe(r#"{"t":"probe","p":-1}"#), None);
        assert_eq!(parse_probe(r#"{"t":"probe","p":5000000000}"#), None);
        assert_eq!(parse_probe("not json \"probe\""), None);
    }

    #[test]
    fn the_old_timing_is_asked_for_exactly_so() {
        assert!(wants_classic(r#"{"t":"probe","p":7,"q":1}"#));
        assert!(wants_classic(r#"{"t":"move","x":0.1,"y":0.2,"q":1}"#));
        assert!(!wants_classic(r#"{"t":"move","x":0.1,"y":0.2}"#));
    }

    #[test]
    fn the_reply_is_the_line_the_viewer_reads() {
        let line = probe_reply(7, 123_456, Duration::from_micros(3_456));
        assert_eq!(String::from_utf8(line).unwrap(), r#"{"k":"probe","p":7,"ts":123456,"host":3.5}"#);
    }
}
