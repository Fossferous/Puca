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
//! [input-rx] lane=channel 1.02s move=58 rmove=0 down=1 up=1 wheel=0 sas=0 failed=0 keys=some keys_failed=0
//! ```
//!
//! POINTER COUNTS ARE EXACT; KEYBOARD ACTIVITY IS NOT, ON PURPOSE. Keys and
//! text are merged into one coarse bucket (`0`, `some`, `many`), and so are
//! their failures. An exact count was a real leak: on the sealed lane the
//! agent runs as SYSTEM at the sign-in screen, its log is readable by ordinary
//! users of the machine, and "key=8" in one window is a 4-digit PIN's length —
//! with the next lines giving away the typing rhythm. The bucket still says
//! what the question needs (keys arrived, or they did not) and nothing a
//! length can be read from. What remains visible is THAT typing happened in a
//! given second, which the question cannot do without.
//!
//! Never a coordinate, a key code or a character. Ungated so every CI leg
//! compiles and tests it; the stream thread's lane is Windows-only, the pipe
//! lanes are not.

use std::time::{Duration, Instant};

/// The kinds a line counts. `key` and `text` are counted into ONE keyboard
/// figure and printed only as a bucket (see the module header).
const KINDS: [&str; 8] = ["move", "rmove", "down", "up", "wheel", "key", "text", "sas"];

/// The columns printed EXACTLY, in order: every kind but the keyboard's.
const EXACT: [usize; 6] = [0, 1, 2, 3, 4, 7];

/// The keyboard kinds (`key`, `text`).
fn is_keyboard(kind: usize) -> bool {
    kind == 5 || kind == 6
}

/// At or above this many keyboard events in one window, the bucket reads
/// `many`. Twenty is ten keystrokes' downs and ups in a second: fast typing,
/// or a paste. `some` says nothing finer than "at least one, fewer than that".
const KEYS_MANY: u32 = 20;

/// The bucket a window's keyboard count is printed as.
pub fn keyboard_bucket(n: u32) -> &'static str {
    match n {
        0 => "0",
        n if n < KEYS_MANY => "some",
        _ => "many",
    }
}

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
///
/// The window still open when the tally goes away (the stream thread
/// returning, the pipe client disconnecting) is written by `Drop`, so the
/// last burst before a disconnect — the one a report is usually about — is
/// never lost. `flush` does the same on demand.
pub struct InputTally {
    lane: &'static str,
    opened: Option<Instant>,
    /// The latest event in the open window: a flushed window's span runs to
    /// it, not to whenever the flush happened.
    last: Option<Instant>,
    counts: [u32; KINDS.len()],
    /// Pointer (non-keyboard) events refused: exact, like their counts.
    failed: u32,
    /// Keyboard events refused: bucketed, like their count — an exact figure
    /// here would leak the same length the bucket hides.
    keys_failed: u32,
    /// Every event noted since creation, never reset: what a caller's test
    /// reads, so a slow machine closing a window between two events cannot
    /// make that test flaky.
    #[cfg(test)]
    lifetime: u32,
}

impl InputTally {
    pub fn new(lane: &'static str) -> Self {
        Self {
            lane,
            opened: None,
            last: None,
            counts: [0; KINDS.len()],
            failed: 0,
            keys_failed: 0,
            #[cfg(test)]
            lifetime: 0,
        }
    }

    /// Events counted since this tally was created, for tests of the callers.
    /// Cumulative on purpose: see `lifetime`.
    #[cfg(test)]
    pub fn counted(&self) -> u32 {
        self.lifetime
    }

    /// Count one event (and whether injecting it failed). Returns the line to
    /// log when this event closes a window of a second or more.
    pub fn note(&mut self, kind: usize, ok: bool, now: Instant) -> Option<String> {
        let opened = *self.opened.get_or_insert(now);
        self.last = Some(now);
        #[cfg(test)]
        {
            self.lifetime = self.lifetime.saturating_add(1);
        }
        if let Some(c) = self.counts.get_mut(kind) {
            *c = c.saturating_add(1);
        }
        if !ok {
            let f = if is_keyboard(kind) { &mut self.keys_failed } else { &mut self.failed };
            *f = f.saturating_add(1);
        }
        let span = now.saturating_duration_since(opened);
        if span < WINDOW {
            return None;
        }
        Some(self.take_line(span))
    }

    /// The line for the window still open, if anything was counted in it —
    /// and the window closes. `None` for an idle lane.
    pub fn flush(&mut self) -> Option<String> {
        let (opened, last) = (self.opened?, self.last?);
        Some(self.take_line(last.saturating_duration_since(opened)))
    }

    /// Format the open window as a line, and start a fresh one.
    fn take_line(&mut self, span: Duration) -> String {
        let mut line = format!("[input-rx] lane={} {:.2}s", self.lane, span.as_secs_f64());
        for &i in &EXACT {
            line.push_str(&format!(" {}={}", KINDS[i], self.counts[i]));
        }
        let keys = self.counts[5].saturating_add(self.counts[6]);
        line.push_str(&format!(
            " failed={} keys={} keys_failed={}",
            self.failed,
            keyboard_bucket(keys),
            keyboard_bucket(self.keys_failed),
        ));
        self.opened = None;
        self.last = None;
        self.counts = [0; KINDS.len()];
        self.failed = 0;
        self.keys_failed = 0;
        line
    }
}

impl Drop for InputTally {
    fn drop(&mut self) {
        if let Some(line) = self.flush() {
            emit(&line);
        }
    }
}

/// Where a flushed line goes: the log, and — in a test build — a per-thread
/// record the tests read, since stderr is not something a test can assert on.
fn emit(line: &str) {
    eprintln!("{line}");
    #[cfg(test)]
    EMITTED.with(|e| e.borrow_mut().push(line.to_string()));
}

#[cfg(test)]
thread_local! {
    static EMITTED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use puca_input::ControlInput as C;

    fn t0() -> Instant {
        Instant::now()
    }

    fn key() -> usize {
        kind_of(&C::Key { code: "KeyA".into(), down: true })
    }
    fn text() -> usize {
        kind_of(&C::Text { text: "1".into() })
    }

    #[test]
    fn a_busy_lane_writes_one_line_a_second_with_every_kind_counted() {
        let start = t0();
        let mut t = InputTally::new("channel");
        let mv = kind_of(&C::Move { x: 0.5, y: 0.5 });
        // 60 moves across 0.9 s: no line yet.
        for i in 0..60u64 {
            assert!(t.note(mv, true, start + Duration::from_millis(i * 15)).is_none(), "early line at {i}");
        }
        assert!(t.note(key(), false, start + Duration::from_millis(950)).is_none());
        // The event that closes the window carries the line, counting itself.
        let line = t.note(mv, true, start + Duration::from_millis(1_010)).expect("a line is due");
        assert_eq!(
            line,
            "[input-rx] lane=channel 1.01s move=61 rmove=0 down=0 up=0 wheel=0 sas=0 failed=0 keys=some keys_failed=some"
        );
        // And the next window starts from zero.
        let next = t.note(mv, true, start + Duration::from_millis(1_020));
        assert!(next.is_none(), "a fresh window must not be due at once");
        let line2 = t.note(mv, true, start + Duration::from_millis(2_100)).expect("second line");
        assert!(line2.contains(" move=2 ") && line2.contains(" keys=0 "), "{line2}");
    }

    #[test]
    fn keys_only_is_what_the_lock_screen_report_would_look_like() {
        // The shape that settles the report: keys and text arriving, no move.
        let start = t0();
        let mut t = InputTally::new("pipe");
        t.note(text(), true, start);
        let line = t.note(key(), true, start + WINDOW).expect("due");
        assert!(line.starts_with("[input-rx] lane=pipe "), "{line}");
        assert!(line.contains(" move=0 ") && line.contains(" keys=some "), "{line}");
    }

    /// THE PRIVACY PROPERTY. A 4-digit PIN typed at the sign-in screen is
    /// eight key events (downs and ups), maybe four text events besides. The
    /// line must not tell that apart from one keystroke — or from nine
    /// digits — or the log hands out the PIN's length.
    #[test]
    fn a_pin_length_cannot_be_read_from_the_sealed_lane() {
        let line_for = |keys: u32, texts: u32, failing: bool| {
            let start = t0();
            let mut t = InputTally::new("sealed");
            for i in 0..keys {
                t.note(key(), !failing, start + Duration::from_millis(u64::from(i)));
            }
            for i in 0..texts {
                t.note(text(), !failing, start + Duration::from_millis(100 + u64::from(i)));
            }
            t.note(0, true, start + WINDOW).expect("due")
        };
        let one = line_for(1, 0, false);
        assert_eq!(one, line_for(8, 4, false), "a 4-digit PIN must read exactly like one key");
        assert_eq!(one, line_for(18, 1, false), "and like a nine-digit one");
        assert!(one.contains(" keys=some ") && !one.contains(" key=") && !one.contains(" text="), "{one}");
        // Refusals too: an exact failure count would leak the same length.
        let refused = line_for(8, 0, true);
        assert_eq!(refused, line_for(3, 0, true));
        assert!(refused.contains(" failed=0 keys=some keys_failed=some"), "{refused}");
    }

    #[test]
    fn the_keyboard_bucket_has_three_values() {
        assert_eq!(keyboard_bucket(0), "0");
        assert_eq!(keyboard_bucket(1), "some");
        assert_eq!(keyboard_bucket(KEYS_MANY - 1), "some");
        assert_eq!(keyboard_bucket(KEYS_MANY), "many");
        assert_eq!(keyboard_bucket(u32::MAX), "many");
    }

    #[test]
    fn pointer_failures_stay_exact() {
        let start = t0();
        let mut t = InputTally::new("channel");
        for i in 0..3u64 {
            t.note(0, false, start + Duration::from_millis(i));
        }
        let line = t.note(2, false, start + WINDOW).expect("due");
        assert!(line.contains(" move=3 rmove=0 down=1 ") && line.contains(" failed=4 keys=0 keys_failed=0"), "{line}");
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
    fn flush_writes_the_last_burst_and_only_once() {
        let start = t0();
        let mut t = InputTally::new("pipe");
        assert_eq!(t.flush(), None, "an idle lane flushes nothing");
        t.note(0, true, start);
        t.note(0, true, start + Duration::from_millis(400));
        t.note(key(), true, start + Duration::from_millis(500));
        let line = t.flush().expect("a burst shorter than a second is still written");
        assert_eq!(
            line,
            "[input-rx] lane=pipe 0.50s move=2 rmove=0 down=0 up=0 wheel=0 sas=0 failed=0 keys=some keys_failed=0"
        );
        assert_eq!(t.flush(), None, "and the window it closed is not written twice");
        // A flush right after a line was due flushes nothing either.
        t.note(0, true, start + Duration::from_secs(2));
        assert!(t.note(0, true, start + Duration::from_secs(3)).is_some());
        assert_eq!(t.flush(), None);
    }

    #[test]
    fn a_tally_going_away_writes_its_open_window() {
        // The stream thread returning and the pipe client disconnecting both
        // end in a drop; that is where the last burst would otherwise vanish.
        EMITTED.with(|e| e.borrow_mut().clear());
        {
            let mut t = InputTally::new("channel");
            t.note(0, true, t0());
        }
        let got = EMITTED.with(|e| std::mem::take(&mut *e.borrow_mut()));
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got[0].starts_with("[input-rx] lane=channel ") && got[0].contains(" move=1 "), "{got:?}");
        // And an idle tally going away writes nothing.
        drop(InputTally::new("pipe"));
        assert!(EMITTED.with(|e| e.borrow().is_empty()));
    }

    #[test]
    fn counted_survives_a_window_closing() {
        // What makes the callers' tests immune to a slow machine: a pause of
        // more than a second between two events closes the window, and the
        // count a test reads must not start again from zero.
        let start = t0();
        let mut t = InputTally::new("pipe");
        t.note(0, true, start);
        assert!(t.note(0, true, start + Duration::from_millis(1_500)).is_some(), "the window closed");
        assert_eq!(t.counted(), 2);
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
        // And exactly the keyboard's two are the bucketed ones.
        let keyboard: Vec<usize> = (0..KINDS.len()).filter(|&k| is_keyboard(k)).collect();
        assert_eq!(keyboard, vec![5, 6]);
        assert_eq!(EXACT.len() + keyboard.len(), KINDS.len());
    }
}
