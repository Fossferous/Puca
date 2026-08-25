//! Restart policy for a dead agent — backoff, and giving up.
//!
//! FOUND BY THE INSTALL CHECKPOINT, 2026-07-29. The first live run relaunched the
//! agent every liveness tick because the stub exited immediately: eight restarts
//! before the screen locked, nine more after unlock, and it would have continued
//! for as long as the service ran. A genuinely broken agent — one that crashes on
//! startup, is quarantined by AV, or whose binary is missing — would do exactly
//! the same thing forever, spawning a process every two seconds and filling the
//! log with identical lines.
//!
//! That is worse than not restarting at all: it hammers the machine, buries the
//! real error in noise, and looks from outside like a fork bomb, which is
//! precisely the shape that gets a SYSTEM service quarantined.
//!
//! So restarts back off, and a persistently failing agent is eventually given up
//! on. Pure and clock-injected so every branch is testable without waiting real
//! seconds.

/// How long to wait after the Nth consecutive failure, in milliseconds.
///
/// Deliberately short at first: the common case is a one-off crash, and a user
/// waiting to connect should not pay 30 seconds for it. It grows quickly because
/// by the fourth failure in a row the problem is not transient.
const BACKOFF_MS: &[u64] = &[0, 1_000, 5_000, 15_000, 60_000];

/// Consecutive failures after which the agent is declared broken and left alone
/// until something changes (a session event, or the service restarting).
///
/// Giving up is the point. A service that retries forever converts "the agent is
/// broken" into "the machine is slow and the log is unreadable", which is a
/// strictly worse way to find out.
const GIVE_UP_AFTER: u32 = 5;

/// A restart that counted as successful — i.e. the agent stayed up this long.
///
/// Without this, an agent that crashes after 3 seconds would reset the counter on
/// every relaunch and never trip the give-up rule: it would look like a series of
/// first failures rather than a crash loop. This is the difference between
/// "restarts occasionally" and "is broken".
const CONSIDERED_HEALTHY_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    /// Relaunch now.
    Restart,
    /// Too soon since the last attempt; wait.
    Wait,
    /// Failed too many times in a row. Stop trying and say so ONCE.
    GiveUp,
    /// Already given up and already reported. Stay quiet.
    Silent,
}

/// Tracks consecutive failures for the one agent the service supervises.
pub struct RestartPolicy {
    consecutive: u32,
    /// When the last launch attempt happened.
    last_attempt_ms: Option<u64>,
    /// Whether the give-up message has been emitted, so it is logged once and
    /// not on every tick.
    gave_up_reported: bool,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self { consecutive: 0, last_attempt_ms: None, gave_up_reported: false }
    }

    /// Note a launch attempt at `now_ms`.
    pub fn record_attempt(&mut self, now_ms: u64) {
        self.last_attempt_ms = Some(now_ms);
    }

    /// The agent we launched has been observed ALIVE and has been up long
    /// enough to count as healthy. Clears the failure streak.
    pub fn record_healthy(&mut self, launched_at_ms: u64, now_ms: u64) {
        if now_ms.saturating_sub(launched_at_ms) >= CONSIDERED_HEALTHY_MS {
            self.consecutive = 0;
            self.gave_up_reported = false;
        }
    }

    /// The agent is dead. Should it be relaunched now?
    pub fn on_dead(&mut self, now_ms: u64) -> RestartDecision {
        if self.consecutive >= GIVE_UP_AFTER {
            if self.gave_up_reported {
                return RestartDecision::Silent;
            }
            self.gave_up_reported = true;
            return RestartDecision::GiveUp;
        }

        let wait = BACKOFF_MS[(self.consecutive as usize).min(BACKOFF_MS.len() - 1)];
        if let Some(last) = self.last_attempt_ms {
            if now_ms.saturating_sub(last) < wait {
                return RestartDecision::Wait;
            }
        }
        self.consecutive += 1;
        self.last_attempt_ms = Some(now_ms);
        RestartDecision::Restart
    }

    /// A session change happened, so the situation is materially different:
    /// clear the streak and try again. A user logging in is a real reason to
    /// believe a previously-failing launch might now work.
    pub fn reset(&mut self) {
        self.consecutive = 0;
        self.last_attempt_ms = None;
        self.gave_up_reported = false;
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_failure_restarts_immediately() {
        // A one-off crash is the common case and must not cost the user a delay.
        let mut p = RestartPolicy::new();
        assert_eq!(p.on_dead(1_000), RestartDecision::Restart);
    }

    #[test]
    fn a_second_failure_waits_before_restarting() {
        let mut p = RestartPolicy::new();
        assert_eq!(p.on_dead(1_000), RestartDecision::Restart);
        // Immediately after: too soon.
        assert_eq!(p.on_dead(1_100), RestartDecision::Wait);
        // After the 1s backoff: allowed.
        assert_eq!(p.on_dead(2_000), RestartDecision::Restart);
    }

    #[test]
    fn a_crash_loop_is_eventually_given_up_on() {
        // THE BUG THIS FILE EXISTS FOR. Before it, a permanently broken agent was
        // relaunched every 2s forever. Walk a fast-crashing agent through and
        // assert it stops, rather than restarting until the machine is rebooted.
        let mut p = RestartPolicy::new();
        let mut now = 0u64;
        let mut restarts = 0;
        for _ in 0..200 {
            match p.on_dead(now) {
                RestartDecision::Restart => restarts += 1,
                RestartDecision::GiveUp => break,
                _ => {}
            }
            now += 100_000; // plenty of time; never blocked by backoff
        }
        assert_eq!(restarts, GIVE_UP_AFTER, "must stop after the give-up threshold");
        assert_eq!(p.on_dead(now), RestartDecision::Silent, "and stay quiet after saying so");
    }

    #[test]
    fn giving_up_is_reported_exactly_once() {
        // Logged once, not every tick: the point of giving up is that the log
        // becomes readable again.
        let mut p = RestartPolicy::new();
        let mut now = 0u64;
        for _ in 0..GIVE_UP_AFTER {
            p.on_dead(now);
            now += 100_000;
        }
        assert_eq!(p.on_dead(now), RestartDecision::GiveUp);
        for _ in 0..5 {
            now += 100_000;
            assert_eq!(p.on_dead(now), RestartDecision::Silent);
        }
    }

    #[test]
    fn a_short_lived_agent_does_not_reset_the_streak() {
        // The subtle one. An agent that survives 3 seconds and dies would, on a
        // naive "it started, so clear the counter" rule, look like an endless
        // series of FIRST failures and never trip the give-up. Only real uptime
        // counts as healthy.
        let mut p = RestartPolicy::new();
        p.on_dead(0);
        p.record_healthy(0, 3_000); // up for 3s — not enough
        assert_eq!(p.consecutive_failures(), 1, "a brief life must not clear the streak");

        p.record_healthy(0, CONSIDERED_HEALTHY_MS + 1);
        assert_eq!(p.consecutive_failures(), 0, "real uptime does clear it");
    }

    #[test]
    fn a_session_change_gives_a_broken_agent_another_chance() {
        // A user logging in is a genuine reason to believe a launch that failed
        // (no user token, say) might now succeed. Without this, one bad patch
        // would poison the service until it restarted.
        let mut p = RestartPolicy::new();
        let mut now = 0u64;
        for _ in 0..GIVE_UP_AFTER {
            p.on_dead(now);
            now += 100_000;
        }
        assert_eq!(p.on_dead(now), RestartDecision::GiveUp);

        p.reset();
        assert_eq!(p.on_dead(now + 1), RestartDecision::Restart, "a session change re-arms it");
    }

    #[test]
    fn backoff_grows_and_then_holds() {
        // Grows quickly (by the 4th consecutive failure it is not transient) but
        // caps, so a machine that recovers is not left waiting for hours.
        assert_eq!(BACKOFF_MS[0], 0);
        assert!(BACKOFF_MS.windows(2).all(|w| w[0] <= w[1]), "must be non-decreasing");
        assert_eq!(*BACKOFF_MS.last().unwrap(), 60_000, "caps at a minute");
    }
}
