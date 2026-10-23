//! Latency on the agent's side of remote control: when to take the picture
//! after an input, and the probe that measures the whole loop.
//!
//! CATCHING AN INPUT'S EFFECT. The stream loop captures on a fixed clock
//! (`next_frame += frame_interval`), so whatever an input changes on screen —
//! a menu opening, a typed letter, a button lighting up — waits for the next
//! tick once it is there: half a frame on average, a whole frame at worst
//! (17 / 33 ms at 30 fps). So after an input the loop WATCHES for that change
//! (`WATCH_FOR`), looking for a new frame every couple of milliseconds, and
//! takes it the moment the compositor presents it; the clock carries on from
//! that frame. Two rules keep it honest:
//!
//! - Only a NEW frame counts. A look that finds nothing changes nothing — the
//!   clock keeps its schedule. (The first version pulled the next tick in to
//!   2 ms after the input and re-phased the clock from there; an app redraws
//!   and the compositor presents a vsync or so later, so that capture usually
//!   found nothing, and the change then waited a WHOLE frame from the
//!   pulled-in tick: later than the old clock would have shown it.)
//! - Never sooner than a whole frame interval after the last frame sent
//!   (`may_capture_early`). The encoder spends the session's bitrate as
//!   bitrate/fps per frame, so a frame rate above the session's is a bitrate
//!   above it. (The first version allowed half an interval: under continuous
//!   input on a screen that changes every frame — a game in Game mode — that
//!   was twice the frames and twice the bitrate.)
//!
//! So the gain is on a screen that was still — most of what a pointer and a
//! keyboard do on a desktop — where a change now shows the moment it is
//! drawn; a screen that changes on its own every frame is captured at the
//! frame rate exactly as before, and only a higher frame rate helps it (the
//! viewer asks for 60 fps on a LAN).
//!
//! THE PROBE. The viewer sends `{"t":"probe","p":N}` on the direct input
//! channel, the same lane its mouse takes. The agent injects nothing: it
//! takes the next frame as soon as the same floor allows (`probe_capture_at`),
//! sends it even if the screen is still (re-sending the held picture, as it
//! does for a keyframe request), and answers on the caret channel with that
//! frame's RTP timestamp. The viewer timed the send and sees the frame
//! presented (`requestVideoFrameCallback` reports its `rtpTimestamp`), so the
//! difference is the whole loop — viewer, network, this loop, capture,
//! encode, network, jitter buffer, decode, display — on ONE clock, the
//! viewer's. `host` in the answer is this side's share, from the probe's
//! arrival to its frame's send. A probe stands for an input whose change is on
//! screen at once, which is exactly the wait after a change that the watch
//! removes; it says nothing about how long an app takes to redraw.
//!
//! `"q":1` on a probe (or on any input) asks for the OLD timing — no watch,
//! the next tick of the clock — so the viewer's "compare" can measure before
//! and after in one build.

use std::time::{Duration, Instant};

/// After an input, how long to keep watching for the change it makes. An app
/// that takes longer than this to redraw is the clock's to catch, at most a
/// frame later.
pub(crate) const WATCH_FOR: Duration = Duration::from_millis(100);

/// How often to look for a new frame while watching: a change waits at most
/// this long once it is on screen. The loop raises the system timer to 1 ms.
pub(crate) const WATCH_POLL: Duration = Duration::from_millis(2);

/// The soonest a probe's frame is taken after the probe arrives.
pub(crate) const PROBE_CAPTURE_LEAD: Duration = Duration::from_millis(2);

/// May the stream take a frame NOW, ahead of its clock, to catch an input's
/// change? Only while watching for one, only before the clock's own tick (the
/// tick takes it then), and never sooner than a whole frame interval after
/// the last frame sent — so neither the session's frame rate nor, through the
/// encoder's per-frame budget, its bitrate can be exceeded.
pub(crate) fn may_capture_early(
    now: Instant,
    watching_until: Option<Instant>,
    next_frame: Instant,
    last_sent: Option<Instant>,
    interval: Duration,
) -> bool {
    watching_until.is_some_and(|w| now < w)
        && now < next_frame
        && last_sent.is_none_or(|t| now >= t + interval)
}

/// When a probe's frame should be taken: just after it arrives — the soonest
/// an input's change could be on screen — and never sooner than a whole frame
/// interval after the last frame sent, the floor real input gets. The caller
/// takes the EARLIER of this and its own schedule.
pub(crate) fn probe_capture_at(arrived: Instant, last_sent: Option<Instant>, interval: Duration) -> Instant {
    let soon = arrived + PROBE_CAPTURE_LEAD;
    match last_sent {
        Some(t) => soon.max(t + interval),
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
    fn a_frame_is_taken_early_only_while_watching_and_before_the_tick() {
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        let tick = t0 + interval;
        let long_ago = t0.checked_sub(Duration::from_secs(1));
        let at = t0 + Duration::from_millis(10);
        assert!(may_capture_early(at, Some(at + WATCH_FOR), tick, long_ago, interval));
        assert!(!may_capture_early(at, None, tick, long_ago, interval), "not watching: the clock decides");
        assert!(!may_capture_early(at, Some(at), tick, long_ago, interval), "the watch is over");
        assert!(!may_capture_early(tick, Some(tick + WATCH_FOR), tick, long_ago, interval), "the tick itself takes it");
        assert!(may_capture_early(at, Some(at + WATCH_FOR), tick, None, interval), "nothing sent yet: no floor");
    }

    #[test]
    fn never_sooner_than_a_whole_frame_after_the_last_one_sent() {
        // The frame rate is the session's, and with it the encoder's bitrate:
        // an early frame is a moved frame, never an extra one.
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        let sent = Some(t0);
        let tick = t0 + Duration::from_secs(1);
        let watching = Some(tick);
        for ms in [1, 10, 16, 32] {
            let now = t0 + Duration::from_millis(ms);
            assert!(!may_capture_early(now, watching, tick, sent, interval), "{ms} ms after a frame");
        }
        assert!(may_capture_early(t0 + interval, watching, tick, sent, interval));
    }

    #[test]
    fn continuous_input_on_a_busy_screen_keeps_the_frame_rate() {
        // Input every 8 ms and a new picture on every look (a game in Game
        // mode), the loop's own rules, one simulated second at 30 fps.
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        let mut next_frame = t0;
        let mut last_sent: Option<Instant> = None;
        let mut watching: Option<Instant> = None;
        let mut frames = 0;
        for ms in 0..1000u64 {
            let now = t0 + Duration::from_millis(ms);
            if ms % 8 == 0 {
                watching = Some(now + WATCH_FOR);
            }
            if now >= next_frame {
                next_frame += interval;
                frames += 1;
                last_sent = Some(now);
            } else if may_capture_early(now, watching, next_frame, last_sent, interval) {
                next_frame = now + interval;
                frames += 1;
                last_sent = Some(now);
            }
        }
        assert!(frames <= 31, "{frames} frames in a second at 30 fps");
    }

    #[test]
    fn on_a_still_screen_a_change_is_taken_when_it_appears() {
        // The last frame went out long ago; an input at 10 ms, and its change
        // on screen at 26 ms (an app redraw and a present later): taken at the
        // first look at or after 26 ms, not at the clock's tick at 33 ms.
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        let tick = t0 + interval;
        let last_sent = t0.checked_sub(Duration::from_secs(2));
        let input = t0 + Duration::from_millis(10);
        let watching = Some(input + WATCH_FOR);
        let appears = t0 + Duration::from_millis(26);
        let mut look = input;
        let taken = loop {
            if may_capture_early(look, watching, tick, last_sent, interval) && look >= appears {
                break look;
            }
            look += WATCH_POLL;
        };
        assert!(taken < appears + WATCH_POLL + Duration::from_millis(1), "taken {:?} after it appeared", taken - appears);
        assert!(taken < tick);
    }

    #[test]
    fn a_probe_frame_follows_the_same_floor() {
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        let arrived = t0 + Duration::from_millis(500);
        assert_eq!(probe_capture_at(arrived, Some(t0), interval), arrived + PROBE_CAPTURE_LEAD);
        assert_eq!(probe_capture_at(arrived, None, interval), arrived + PROBE_CAPTURE_LEAD);
        let just_sent = arrived - Duration::from_millis(5);
        assert_eq!(probe_capture_at(arrived, Some(just_sent), interval), just_sent + interval);
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
