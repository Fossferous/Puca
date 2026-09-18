//! What the per-event injection log lines are allowed to say.
//!
//! THE THREAT. At the sign-in screen the agent runs as SYSTEM and its log is
//! readable by ordinary users of the machine, as is the service's. The input
//! tally already buckets keyboard activity so a PIN's length cannot be read
//! from it (`puca-agent`'s `input_tally`). Every OTHER line written per
//! injected event undid that: one "inject failed: ... key press" line per
//! refused keystroke is the same count, spelled out, with a timestamp each;
//! one "[input] refused; followed the input desktop" line per refusal is that
//! count again without the word "key"; and the requested pixel beside
//! `GetCursorPos` on Winlogon is where each tap on the on-screen keyboard
//! landed.
//!
//! So a per-event line is RATE-LIMITED (`LineGate`: the first one always,
//! then at most one a second per gate), carries no event KIND
//! (`without_event_kind`), and never an absolute position (`cursor_tracking`).
//! Ungated, so the Linux CI leg compiles and tests all of it.

use std::time::{Duration, Instant};

/// At most one line per `interval`, the FIRST always admitted.
///
/// The first line is the one that matters as evidence — a refusal, or a
/// desktop follow, happened at all — so it is never the one dropped. Nothing
/// counts what was suppressed: a "(12 more)" suffix would be the count this
/// gate exists to withhold.
#[derive(Debug, Clone, Copy)]
pub struct LineGate {
    last: Option<Instant>,
    interval: Duration,
}

impl LineGate {
    /// One line a second.
    pub const fn per_second() -> Self {
        Self { last: None, interval: Duration::from_secs(1) }
    }

    /// Whether a line may be written at `now`; if so, `now` starts the next
    /// quiet period. Written as a match rather than `is_none_or`, which is
    /// newer than this workspace's declared toolchain floor.
    pub fn admit(&mut self, now: Instant) -> bool {
        let due = match self.last {
            None => true,
            Some(t) => now.saturating_duration_since(t) >= self.interval,
        };
        if due {
            self.last = Some(now);
        }
        due
    }
}

/// How every refusal `sent_detail` writes begins. What follows it, up to the
/// first `REFUSAL_DETAILS` marker, is the event kind ("key press", "pointer
/// move", "button release (teardown)").
pub(crate) const REFUSED_PREFIX: &str = "Windows refused the injected ";
/// The three details `sent_detail` can append straight after the kind — one
/// always follows it. Shared with `sent_detail` so the two cannot drift.
pub(crate) const DETAIL_NO_RETRY: &str = " (no retry was attempted)";
pub(crate) const DETAIL_FOLLOWED: &str = " (followed the input desktop to '";
pub(crate) const DETAIL_NO_FOLLOW: &str = " (could not follow the input desktop: ";
const REFUSAL_DETAILS: [&str; 3] = [DETAIL_NO_RETRY, DETAIL_FOLLOWED, DETAIL_NO_FOLLOW];

/// An injection error as a per-event log line may carry it: the refusal with
/// its diagnostic detail (which desktop was followed, GetLastError) but the
/// event kind replaced by "input"; anything else — "unmapped key: <code>",
/// a text or coordinate check — as one fixed sentence, since each of those
/// names the kind and some name the key.
///
/// The ERROR ITSELF keeps its kind (a caller that shows it to the person at
/// the controls should say what was refused); only log lines go through here.
pub fn without_event_kind(err: &str) -> String {
    if let Some(rest) = err.strip_prefix(REFUSED_PREFIX) {
        let detail = REFUSAL_DETAILS.iter().filter_map(|m| rest.find(m)).min();
        if let Some(at) = detail {
            return format!("{REFUSED_PREFIX}input{}", &rest[at..]);
        }
    }
    "an input event could not be injected (its kind is left out of the log on purpose)".to_string()
}

/// How far off, at most, still reads as "tracks": the cursor trails the
/// request by an event or so, and the distance is rounded to this step
/// besides, so it can never be read back into a position.
const TRACK_STEP_PX: f64 = 10.0;

/// Whether the cursor followed an absolute move, WITHOUT a position: "tracks"
/// (within `TRACK_STEP_PX`), "did not move" (the same pixel as the last
/// check), or "off by N px" with N rounded to `TRACK_STEP_PX`. `cursor` is
/// `None` when `GetCursorPos` failed.
///
/// A distance rather than two points: two absolute points per line on the
/// Winlogon desktop let a reader of the log replay where each tap on the
/// on-screen keyboard landed. Whether the pointer follows is the whole
/// question, and a distance answers it.
pub fn cursor_tracking(requested: (i32, i32), cursor: Option<(i32, i32)>, previous: Option<(i32, i32)>) -> String {
    let Some(cursor) = cursor else {
        return "cursor unreadable".to_string();
    };
    let dx = f64::from(requested.0) - f64::from(cursor.0);
    let dy = f64::from(requested.1) - f64::from(cursor.1);
    let off = ((dx.hypot(dy) / TRACK_STEP_PX).round() * TRACK_STEP_PX) as i64;
    if off == 0 {
        "tracks".to_string()
    } else if previous == Some(cursor) {
        "did not move".to_string()
    } else {
        format!("off by {off} px")
    }
}

/// How many secure-desktop move checks are written after each desktop switch.
pub const SECURE_MOVE_CHECKS: u32 = 5;

/// Which secure-desktop move checks get a line: never on `Default`, at most
/// one a second, and only the first `SECURE_MOVE_CHECKS` after the thread
/// lands on a desktop — the trend right after a switch is the evidence; a
/// line a second for as long as someone uses the sign-in screen is a record
/// of their pointer.
#[derive(Debug, Default)]
pub struct SecureMoveChecks {
    desk: Option<String>,
    written: u32,
    gate: Option<LineGate>,
    /// The cursor at the last check written on this desktop, for "did not move".
    pub previous: Option<(i32, i32)>,
}

impl SecureMoveChecks {
    /// Whether a check on `desk` at `now` gets a line. A different desktop
    /// from the last check's starts the count (and the cursor history) again
    /// — `Default` included, so lock, unlock and lock again is two switches
    /// onto Winlogon, each checked.
    pub fn admit(&mut self, desk: &str, now: Instant) -> bool {
        let switched = match &self.desk {
            Some(d) => !d.eq_ignore_ascii_case(desk),
            None => true,
        };
        if switched {
            self.desk = Some(desk.to_string());
            self.written = 0;
            self.gate = None;
            self.previous = None;
        }
        if desk.eq_ignore_ascii_case("Default") {
            return false; // a line a second on every ordinary session
        }
        if self.written >= SECURE_MOVE_CHECKS {
            return false;
        }
        if !self.gate.get_or_insert_with(LineGate::per_second).admit(now) {
            return false;
        }
        self.written += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_admits_the_first_line_then_one_a_second() {
        let t0 = Instant::now();
        let mut g = LineGate::per_second();
        assert!(g.admit(t0), "the first line is the evidence and is always written");
        for ms in [0u64, 1, 500, 999] {
            assert!(!g.admit(t0 + Duration::from_millis(ms)), "a second line inside the second at +{ms} ms");
        }
        assert!(g.admit(t0 + Duration::from_millis(1_000)), "a second later, the next one is");
        assert!(!g.admit(t0 + Duration::from_millis(1_500)));
        assert!(g.admit(t0 + Duration::from_millis(2_000)));
    }

    #[test]
    fn a_burst_of_refusals_writes_the_same_lines_whatever_its_size() {
        // THE PRIVACY PROPERTY: a one-second burst of 1 or of 8 refused
        // events (a 4-digit PIN's downs and ups) writes exactly one line.
        let lines = |n: u64| {
            let t0 = Instant::now();
            let mut g = LineGate::per_second();
            (0..n).filter(|i| g.admit(t0 + Duration::from_millis(i * 100))).count()
        };
        assert_eq!(lines(1), 1);
        assert_eq!(lines(8), 1, "a PIN's worth of refusals must read like one");
        assert_eq!(lines(10), 1);
        assert_eq!(lines(11), 2, "the positive control: a burst past a second writes a second line");
    }

    #[test]
    fn a_clock_that_steps_back_does_not_reopen_the_gate() {
        let t0 = Instant::now() + Duration::from_secs(5);
        let mut g = LineGate::per_second();
        assert!(g.admit(t0));
        assert!(!g.admit(t0 - Duration::from_secs(3)));
    }

    #[test]
    fn a_refusal_loses_its_kind_and_keeps_its_detail() {
        for kind in ["key press", "key release", "pointer move", "button release (teardown)", "text", "scroll"] {
            let e = format!(
                "{REFUSED_PREFIX}{kind}{DETAIL_FOLLOWED}Winlogon', but the retry was STILL refused). GetLastError=5. The usual cause ..."
            );
            let safe = without_event_kind(&e);
            assert_eq!(
                safe,
                "Windows refused the injected input (followed the input desktop to 'Winlogon', but the retry was STILL refused). GetLastError=5. The usual cause ..."
            );
            assert!(!safe.contains(kind), "{safe}");
        }
        let no_retry = without_event_kind(&format!("{REFUSED_PREFIX}key press{DETAIL_NO_RETRY}. The usual cause"));
        assert_eq!(no_retry, "Windows refused the injected input (no retry was attempted). The usual cause");
        let no_follow =
            without_event_kind(&format!("{REFUSED_PREFIX}key release{DETAIL_NO_FOLLOW}access denied). x"));
        assert_eq!(no_follow, "Windows refused the injected input (could not follow the input desktop: access denied). x");
    }

    #[test]
    fn anything_else_is_one_fixed_sentence() {
        let generic = without_event_kind("unmapped key: KeyQ");
        assert!(!generic.contains("KeyQ") && !generic.contains("key:"), "{generic}");
        assert_eq!(generic, without_event_kind("non-finite coordinate"));
        assert_eq!(generic, without_event_kind("text too long"));
        // A refusal prefix with no detail after it is not trusted to be cut.
        assert_eq!(generic, without_event_kind("Windows refused the injected key press"));
    }

    #[test]
    fn tracking_is_a_verdict_never_a_position() {
        assert_eq!(cursor_tracking((500, 300), Some((500, 300)), None), "tracks");
        assert_eq!(cursor_tracking((500, 300), Some((503, 302)), None), "tracks", "within a step");
        assert_eq!(cursor_tracking((500, 300), Some((620, 300)), Some((100, 100))), "off by 120 px");
        assert_eq!(cursor_tracking((500, 300), Some((536, 300)), None), "off by 40 px", "rounded to 10");
        assert_eq!(cursor_tracking((900, 700), Some((10, 10)), Some((10, 10))), "did not move");
        assert_eq!(cursor_tracking((900, 700), None, Some((10, 10))), "cursor unreadable");
        // No coordinate of either point appears in any verdict.
        for v in [
            cursor_tracking((1234, 567), Some((1300, 600)), None),
            cursor_tracking((1234, 567), Some((1300, 600)), Some((1300, 600))),
        ] {
            assert!(!v.contains("1234") && !v.contains("567") && !v.contains("1300") && !v.contains("600"), "{v}");
            assert!(!v.contains('(') && !v.contains(','), "{v}");
        }
    }

    #[test]
    fn checks_stop_after_the_first_few_and_restart_on_a_switch() {
        let t0 = Instant::now();
        let mut c = SecureMoveChecks::default();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut written = 0;
        for s in 0..20 {
            if c.admit("Winlogon", at(s)) {
                written += 1;
            }
        }
        assert_eq!(written, SECURE_MOVE_CHECKS, "only the first few moves after the switch");
        // Rate-limited too: a burst inside one second is one line.
        let mut burst = SecureMoveChecks::default();
        assert!(burst.admit("Winlogon", t0));
        assert!(!burst.admit("Winlogon", t0 + Duration::from_millis(300)));
        // A switch starts again, and forgets the cursor it last saw. The
        // ordinary desktop itself is never checked.
        c.previous = Some((1, 1));
        assert!(!c.admit("Default", at(21)), "never a line on Default");
        assert_eq!(c.previous, None, "but going there is a switch");
        assert!(c.admit("Winlogon", at(21)), "so a return to Winlogon is checked again");
        assert!(c.admit("Winlogon-UAC", at(21)), "as is any other secure desktop");
    }
}
