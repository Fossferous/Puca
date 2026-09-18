//! Per-lane input counts, by kind, logged at most about once a second.
//!
//! WHY. Every host-side input log line records a FAILURE: a refused frame, a
//! refused `SendInput`. Success is silent, and so is absence. A report of "the
//! keyboard worked but the mouse did nothing" therefore had nothing on the
//! agent side to separate "the phone never sent a move" from "moves arrived
//! and were accepted, and nothing happened" — the two halves of the question,
//! with entirely different fixes. One line per second per lane, while input is
//! actually flowing, answers it:
//!
//! ```text
//! [input-rx] lane=channel 1.02s move=58 rmove=0 down=1 up=1 wheel=0 key=0 text=4 sas=0 failed=0
//! ```
//!
//! Counts only — never a coordinate, a key code or a character, so the log
//! carries nothing typed. Ungated so every CI leg compiles and tests it; the
//! stream thread's lane is Windows-only, the pipe lanes are not.

use std::time::{Duration, Instant};

/// The kinds a line counts, in the order it prints them.
const KINDS: [&str; 8] = ["move", "rmove", "down", "up", "wheel", "key", "text", "sas"];

/// Which column an event counts in.
pub fn kind_of(ev: &puca_input::ControlInput) -> usize {
    use puca_input::ControlInput as C;
    match ev {
        C::Move { .. } => 0,
        C::Rmove { .. } => 1,
        C::Down { .. } => 2,
        C::Up { .. } => 3,
        C::Wheel { .. } => 4,
        C::Key { .. } => 5,
        C::Text { .. } => 6,
        C::Sas => 7,
    }
}

/// How long a window runs before its line is due.
const WINDOW: Duration = Duration::from_secs(1);

/// One lane's running counts. The window OPENS on the first event after a
/// line and CLOSES on the first event at least a second later, so an idle
/// lane writes nothing at all and a busy one writes about once a second.
pub struct InputTally {
    lane: &'static str,
    opened: Option<Instant>,
    counts: [u32; KINDS.len()],
    failed: u32,
}

impl InputTally {
    pub fn new(lane: &'static str) -> Self {
        Self { lane, opened: None, counts: [0; KINDS.len()], failed: 0 }
    }

    /// Events counted in the window still open, for tests of the callers.
    #[cfg(test)]
    pub fn counted(&self) -> u32 {
        self.counts.iter().sum()
    }

    /// Count one event (and whether injecting it failed). Returns the line to
    /// log when this event closes a window of a second or more.
    pub fn note(&mut self, kind: usize, ok: bool, now: Instant) -> Option<String> {
        let opened = *self.opened.get_or_insert(now);
        if let Some(c) = self.counts.get_mut(kind) {
            *c = c.saturating_add(1);
        }
        if !ok {
            self.failed = self.failed.saturating_add(1);
        }
        let span = now.saturating_duration_since(opened);
        if span < WINDOW {
            return None;
        }
        let mut line = format!("[input-rx] lane={} {:.2}s", self.lane, span.as_secs_f64());
        for (name, n) in KINDS.iter().zip(self.counts.iter()) {
            line.push_str(&format!(" {name}={n}"));
        }
        line.push_str(&format!(" failed={}", self.failed));
        self.opened = None;
        self.counts = [0; KINDS.len()];
        self.failed = 0;
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use puca_input::ControlInput as C;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn a_busy_lane_writes_one_line_a_second_with_every_kind_counted() {
        let start = t0();
        let mut t = InputTally::new("channel");
        let mv = kind_of(&C::Move { x: 0.5, y: 0.5 });
        let key = kind_of(&C::Key { code: "KeyA".into(), down: true });
        // 60 moves across 0.9 s: no line yet.
        for i in 0..60u64 {
            assert!(t.note(mv, true, start + Duration::from_millis(i * 15)).is_none(), "early line at {i}");
        }
        assert!(t.note(key, false, start + Duration::from_millis(950)).is_none());
        // The event that closes the window carries the line, counting itself.
        let line = t.note(mv, true, start + Duration::from_millis(1_010)).expect("a line is due");
        assert_eq!(
            line,
            "[input-rx] lane=channel 1.01s move=61 rmove=0 down=0 up=0 wheel=0 key=1 text=0 sas=0 failed=1"
        );
        // And the next window starts from zero.
        let next = t.note(mv, true, start + Duration::from_millis(1_020));
        assert!(next.is_none(), "a fresh window must not be due at once");
        let line2 = t.note(mv, true, start + Duration::from_millis(2_100)).expect("second line");
        assert!(line2.contains(" move=2 ") && line2.contains("failed=0"), "{line2}");
    }

    #[test]
    fn keys_only_is_what_the_lock_screen_report_would_look_like() {
        // The shape that settles the report: keys and text arriving, no move.
        let start = t0();
        let mut t = InputTally::new("pipe");
        t.note(kind_of(&C::Text { text: "1".into() }), true, start);
        let line = t
            .note(kind_of(&C::Key { code: "Enter".into(), down: true }), true, start + WINDOW)
            .expect("due");
        assert!(line.starts_with("[input-rx] lane=pipe "), "{line}");
        assert!(line.contains(" move=0 ") && line.contains(" key=1 ") && line.contains(" text=1 "), "{line}");
    }

    #[test]
    fn an_idle_lane_writes_nothing_however_long_it_waits() {
        let start = t0();
        let mut t = InputTally::new("channel");
        // One event, then silence: no line (a line needs a closing event).
        assert!(t.note(0, true, start).is_none());
        // A single event after a long gap closes the window it opened.
        let line = t.note(0, true, start + Duration::from_secs(30)).expect("the gap closes it");
        assert!(line.contains(" move=2 ") && line.contains("30.00s"), "{line}");
    }

    #[test]
    fn every_kind_has_its_own_column() {
        let all = [
            C::Move { x: 0.0, y: 0.0 },
            C::Rmove { dx: 1.0, dy: 0.0 },
            C::Down { button: 0 },
            C::Up { button: 0 },
            C::Wheel { dy: 1.0 },
            C::Key { code: "KeyA".into(), down: true },
            C::Text { text: "a".into() },
            C::Sas,
        ];
        let cols: Vec<usize> = all.iter().map(kind_of).collect();
        assert_eq!(cols, (0..KINDS.len()).collect::<Vec<_>>());
    }
}
