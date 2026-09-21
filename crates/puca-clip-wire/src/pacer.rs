//! The frame cadence both clip capture loops share.
//!
//! WHY THIS EXISTS. Both clip loops (the agent's `clip_host.rs`, and the app's
//! in-process fallback in `clip_capture.rs` that Lite builds run) took their
//! `fps` and used it for exactly two things: the longest `AcquireNextFrame`
//! would wait, and how often a STILL screen was re-encoded. Nothing capped a
//! screen that was changing. `AcquireNextFrame` returns on every present, so a
//! 165 Hz monitor with a video playing on it was read back, converted and
//! encoded at whatever rate the desktop composed.
//!
//! Measured 2026-09-19 on the machine it was written for (2560x1440 @ 165 Hz,
//! a stream playing in the app): started with `--fps 30 --bitrate 8000000`,
//! the shipped agent delivered 78.2 fps at 20.8 Mbit/s and used 95% of a core.
//! The bitrate follows the frame count because the encoder's sample clock is a
//! counter advanced by 1/fps per SUBMITTED frame, so under CBR every extra
//! frame buys another frame's worth of bits. The replay ring held 2.6x the
//! bytes for the same seconds, and Puca.exe and the webview paid per frame to
//! carry them.
//!
//! WHY IT LIVES IN THIS CRATE. It is not wire format, but it is the one thing
//! other than the wire format the two loops must agree on. Both loops also
//! depend on puca-capture and puca-encode, but pacing is neither capturing nor
//! encoding, and the remote-control stream shares those two crates with its
//! own, different pacing. This crate is clip-only and has no dependencies.
//! Two inline copies of the old Timeout-only pacing is how the missing cap
//! ended up in both loops at once.
//!
//! HOW TO USE IT, per slot:
//!
//! 1. Sleep for `wait(now)` BEFORE acquiring, then note the instant the slot
//!    opened (`slot_at`).
//! 2. Acquire, waiting for a new picture until `capture_deadline(slot_at)`
//!    and no longer. If none came, re-encode the stored frame.
//! 3. `take(slot_at)` when that frame is submitted to the encoder.
//!
//! - Sleeping before the acquire is what makes the cap cheap. Desktop
//!   duplication keeps no queue: every update that lands while nobody is
//!   acquiring is folded into the next acquire, which returns the newest
//!   picture. Frames that would have been dropped are never read back.
//! - Acquire-then-discard would be WRONG, not merely slower. Duplication only
//!   reports what changed since the last acquire, so a discarded present
//!   followed by a quiet screen leaves the loop repeating a stale picture.
//! - `take` on every SUBMISSION, including a still screen's re-encode of the
//!   stored frame and a submission the encoder answered with "need more
//!   input". A slot left open after such a submission would still be open on
//!   the next pass, so the loop would submit again inside the same slot and
//!   feed the encoder more than `fps` frames, which is the over-feed this
//!   exists to stop.
//! - `take` with the instant the slot OPENED, not the instant the readback
//!   finished. A readback that runs past a whole period would otherwise
//!   restart the grid from its end, and the next wait would add idle time on
//!   top of the readback on exactly the machines that are already slow.

use std::time::{Duration, Instant};

/// Fixed-grid frame slots at `fps`, with no catch-up burst after a stall.
#[derive(Debug, Clone)]
pub struct FramePacer {
    period: Duration,
    /// When the next slot opens. `None` until the first frame is taken, so the
    /// first frame is never delayed.
    next_due: Option<Instant>,
}

impl FramePacer {
    /// `fps == 0` is treated as 1 rather than dividing by zero: the argument
    /// parser accepts it, and a stalled clip beats a panicking capture thread.
    pub fn new(fps: u32) -> Self {
        // Nanoseconds, not milliseconds: 1000 / 30 = 33 ms is 30.3 fps, and
        // 1000 / 60 = 16 ms is 62.5 fps, which is the encoder over-fed again.
        let period = Duration::from_nanos(1_000_000_000 / u64::from(fps.max(1)));
        Self { period, next_due: None }
    }

    pub fn period(&self) -> Duration {
        self.period
    }

    /// How long to wait, as of `now`, before the next slot opens. Zero when it
    /// is already open.
    pub fn wait(&self, now: Instant) -> Duration {
        match self.next_due {
            Some(due) => due.saturating_duration_since(now),
            None => Duration::ZERO,
        }
    }

    /// When a slot's acquire should stop waiting for a new picture and repeat
    /// the stored one instead: half a period after the slot opened ON THE
    /// GRID. Already in the past for a slot that opened late, which makes the
    /// acquire a plain poll.
    ///
    /// WHY WAIT AT ALL. A poll (0 ms) samples the screen at a fixed instant.
    /// When the asked-for rate matches the content (60 fps asked, a 60 fps
    /// game on a 60 Hz screen), the grid and the display's own vblank clock
    /// drift slowly against each other. While the phase sits inside the
    /// timing jitter, a poll lands just BEFORE a compose: that slot repeats the
    /// old picture, and the next one finds two composes and keeps only the
    /// newest. That is a duplicate and then a drop, over and over, for as long
    /// as the phase stays there. Waiting for a present phase-locks capture to
    /// the content instead. When a present is already pending (a busy screen
    /// faster than `fps`, the case the cap exists for), the acquire returns
    /// at once and the window costs nothing.
    pub fn capture_deadline(&self, slot_at: Instant) -> Instant {
        self.next_due.unwrap_or(slot_at) + self.period / 2
    }

    /// Acquire for the slot that opened at `slot_at`: call `acquire(timeout_ms)`
    /// until it yields a picture, fails with something other than a timeout,
    /// or the window from `capture_deadline` closes. Then return the timeout.
    ///
    /// One place for both loops, because the retry is the subtle part. Pointer
    /// news comes back from puca-capture as an immediate Timeout, not a
    /// picture. So a single call would end the window early every time the
    /// mouse moved, and the slot would repeat the stored picture while a
    /// present was a millisecond away.
    pub fn acquire_within<T, E>(
        &self,
        slot_at: Instant,
        mut acquire: impl FnMut(u32) -> Result<T, E>,
        is_timeout: impl Fn(&E) -> bool,
    ) -> Result<T, E> {
        let deadline = self.capture_deadline(slot_at);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            // Whole milliseconds rounded UP, so a wait cannot end just short
            // of the deadline and come back round as a spin.
            let timeout_ms = u32::try_from(left.as_micros().div_ceil(1000)).unwrap_or(u32::MAX);
            match acquire(timeout_ms) {
                Err(e) if is_timeout(&e) && Instant::now() < deadline => continue,
                other => return other,
            }
        }
    }

    /// Spend the slot that opened at `slot_at`.
    ///
    /// The next slot is one period after this one ON THE GRID, not one period
    /// after `slot_at`. So oversleeping by a few ms does not lower the average
    /// rate, because the following wait is that much shorter. A loop that
    /// fell a whole period or more behind (the AccessLost backoff sleeps up
    /// to a second, and an encoder can stall) restarts the grid one period
    /// from `slot_at` instead of firing the missed slots back to back. That
    /// would re-encode the stored picture once per missed slot, a few ms
    /// apart, each record claiming a whole period of duration, so they would
    /// overlap in the replay ring.
    pub fn take(&mut self, slot_at: Instant) {
        let next = match self.next_due {
            Some(due) => due + self.period,
            None => slot_at + self.period,
        };
        self.next_due = Some(if next <= slot_at { slot_at + self.period } else { next });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Offer a frame every `offer_every`, for `span`, to a loop that behaves
    /// like the capture loops: a frame offered before its slot is not
    /// acquired. Returns how many were taken. No sleeping; the clock is fake.
    fn run(fps: u32, offer_every: Duration, span: Duration) -> (u32, Vec<Duration>) {
        let t0 = Instant::now();
        let mut pacer = FramePacer::new(fps);
        let mut taken = Vec::new();
        let mut t = Duration::ZERO;
        while t < span {
            let now = t0 + t;
            if pacer.wait(now).is_zero() {
                pacer.take(now);
                taken.push(t);
            }
            t += offer_every;
        }
        (taken.len() as u32, taken)
    }

    #[test]
    fn a_165hz_desktop_is_held_to_the_asked_for_rate() {
        // The measured bug: 165 Hz of presents, fps 30. Before the cap every
        // one of them was encoded.
        let (n, _) = run(30, Duration::from_nanos(1_000_000_000 / 165), Duration::from_secs(10));
        assert!((295..=301).contains(&n), "{n} frames in 10 s at fps 30");
    }

    #[test]
    fn a_source_at_or_below_the_rate_is_not_thinned() {
        // POSITIVE CONTROL: a cap that also throttled frames arriving at the
        // asked-for rate would pass the test above and halve a 60 fps clip.
        let (n, _) = run(165, Duration::from_nanos(1_000_000_000 / 165), Duration::from_secs(10));
        assert!(n >= 1645, "{n} frames in 10 s: a 165 fps cap dropped 165 Hz frames");
        let (n, _) = run(60, Duration::from_millis(20), Duration::from_secs(10));
        assert!(n >= 499, "{n} frames in 10 s: a 60 fps cap dropped 50 Hz frames");
    }

    #[test]
    fn the_first_frame_is_never_delayed() {
        let pacer = FramePacer::new(30);
        assert_eq!(pacer.wait(Instant::now()), Duration::ZERO);
    }

    #[test]
    fn a_late_slot_does_not_lower_the_average_rate() {
        // Every slot is taken 10 ms late (an oversleep). With the grid
        // anchored on the previous slot rather than on `now`, the next wait
        // absorbs it; anchored on `now`, 30 fps would run at ~23.
        let t0 = Instant::now();
        let mut pacer = FramePacer::new(30);
        let mut now = t0;
        let mut n = 0;
        while now < t0 + Duration::from_secs(10) {
            now += pacer.wait(now);
            now += Duration::from_millis(10); // the oversleep
            pacer.take(now);
            n += 1;
        }
        assert!((298..=301).contains(&n), "{n} slots in 10 s with a 10 ms oversleep each");
    }

    #[test]
    fn a_stall_restarts_the_grid_instead_of_bursting() {
        let t0 = Instant::now();
        let mut pacer = FramePacer::new(30);
        pacer.take(t0);
        // A one-second stall, like the AccessLost backoff at its cap.
        let after = t0 + Duration::from_secs(1);
        assert_eq!(pacer.wait(after), Duration::ZERO);
        pacer.take(after);
        // Exactly ONE slot was open after the stall. The next is a full period
        // away, not the 29 slots that were missed.
        assert_eq!(pacer.wait(after), pacer.period());
        // Also at the edge: a take landing exactly on a period boundary behind.
        let mut edge = FramePacer::new(30);
        edge.take(t0);
        let late = t0 + 2 * edge.period();
        edge.take(late);
        assert_eq!(edge.wait(late), edge.period());
    }

    #[test]
    fn the_period_is_exact_rather_than_whole_milliseconds() {
        assert_eq!(FramePacer::new(30).period(), Duration::from_nanos(33_333_333));
        assert_eq!(FramePacer::new(60).period(), Duration::from_nanos(16_666_666));
    }

    #[test]
    fn fps_zero_does_not_panic() {
        assert_eq!(FramePacer::new(0).period(), Duration::from_secs(1));
    }

    /// A model of both capture loops over a screen that presents every
    /// `present_every` from `phase`, each present moved by a fixed
    /// pseudo-random amount within +/- `jitter`. It uses the loops' order:
    /// wait for the slot, acquire (the newest pending present at once, else
    /// wait for the next one until `deadline_of(slot)`, else repeat the stored
    /// picture), take the slot, then 1 ms of work. Returns
    /// (slots that repeated the stored picture, presents never captured).
    fn simulate(
        fps: u32,
        present_every: Duration,
        phase: Duration,
        jitter: Duration,
        span: Duration,
        deadline_of: impl Fn(&FramePacer, Instant) -> Instant,
    ) -> (u32, u32) {
        let t0 = Instant::now();
        let n = (span.as_nanos() / present_every.as_nanos()) as u64 + 2;
        let presents: Vec<Instant> = (0..n)
            .map(|k| {
                let j = ((k * 7919) % 2001) as i64 - 1000; // -1000..=1000
                let off = jitter.as_nanos() as i64 * j / 1000;
                let at = phase.as_nanos() as i64 + (present_every.as_nanos() as u64 * k) as i64 + off;
                t0 + Duration::from_nanos(at.max(0) as u64)
            })
            .collect();
        let mut pacer = FramePacer::new(fps);
        let (mut next, mut dups, mut drops) = (0usize, 0u32, 0u32);
        let mut now = t0;
        while now < t0 + span {
            now += pacer.wait(now);
            let slot_at = now;
            let pending = presents[next..].iter().take_while(|p| **p <= now).count();
            let Some(&upcoming) = presents.get(next + pending) else { break };
            if pending > 0 {
                drops += pending as u32 - 1;
                next += pending;
            } else if upcoming <= deadline_of(&pacer, slot_at) {
                now = upcoming;
                next += 1;
            } else {
                now = now.max(deadline_of(&pacer, slot_at));
                dups += 1;
            }
            pacer.take(slot_at);
            now += Duration::from_millis(1);
        }
        (dups, drops)
    }

    #[test]
    fn content_at_the_asked_for_rate_is_captured_once_each() {
        // 60 fps asked, a 60 Hz game, the slot grid sitting right on the
        // present phase with +/- 1 ms of jitter: the worst case for sampling.
        let every = Duration::from_nanos(1_000_000_000 / 60);
        let run = |deadline_of: &dyn Fn(&FramePacer, Instant) -> Instant| {
            simulate(60, every, Duration::from_micros(100), Duration::from_millis(1), Duration::from_secs(10), deadline_of)
        };
        let (dups, drops) = run(&|p, slot| p.capture_deadline(slot));
        assert!(dups + drops <= 2, "{dups} repeats and {drops} drops in 10 s of 60 fps content");
        // POSITIVE CONTROL: a plain 0 ms poll at the slot (the first version
        // of this cap) gives ~26 repeats and ~25 drops in the same 10 s. If
        // this stops failing, the model no longer reproduces the stutter, and
        // the assertion above would pass whatever the window did.
        let (dups, drops) = run(&|_, slot| slot);
        assert!(dups + drops >= 20, "the model lost the poll stutter: {dups} repeats, {drops} drops");
    }

    #[test]
    fn a_slow_readback_does_not_add_idle_on_top() {
        // 30 fps asked, but each acquire takes 40 ms (more than a period) and
        // each encode 5 ms: the best possible is one frame per 45 ms.
        let t0 = Instant::now();
        let rate = |take_at_slot_open: bool| {
            let mut pacer = FramePacer::new(30);
            let (mut now, mut n) = (t0, 0u32);
            while now < t0 + Duration::from_secs(10) {
                now += pacer.wait(now);
                let slot_at = now;
                now += Duration::from_millis(40);
                pacer.take(if take_at_slot_open { slot_at } else { now });
                now += Duration::from_millis(5);
                n += 1;
            }
            n
        };
        let n = rate(true);
        assert!((220..=223).contains(&n), "{n} frames in 10 s; 45 ms each is 222");
        // POSITIVE CONTROL: spending the slot after the readback restarts the
        // grid from there, and the next wait adds 28 ms of idle per frame.
        let late = rate(false);
        assert!(late < 160, "taking after the readback no longer costs anything ({late} frames)");
    }

    #[derive(Debug, PartialEq)]
    enum Got {
        Timeout,
        Broken,
    }

    #[test]
    fn pointer_news_does_not_end_the_window() {
        // Two immediate timeouts (the mouse moved), then a picture: the
        // helper must keep asking rather than give up on the first.
        let t0 = Instant::now();
        let mut pacer = FramePacer::new(20); // a 25 ms window
        pacer.take(t0);
        let slot = t0 + pacer.period();
        let mut calls = 0;
        let got = pacer.acquire_within(
            slot,
            |_| {
                calls += 1;
                if calls < 3 { Err(Got::Timeout) } else { Ok("picture") }
            },
            |e| *e == Got::Timeout,
        );
        assert_eq!(got, Ok("picture"));
        assert_eq!(calls, 3);
    }

    #[test]
    fn the_window_closes_and_other_errors_come_straight_back() {
        let pacer = FramePacer::new(20); // first slot: window ends 25 ms from now
        let slot = Instant::now();
        let got: Result<(), Got> = pacer.acquire_within(
            slot,
            |ms| {
                std::thread::sleep(Duration::from_millis(u64::from(ms)));
                Err(Got::Timeout)
            },
            |e| *e == Got::Timeout,
        );
        assert_eq!(got, Err(Got::Timeout));
        assert!(slot.elapsed() >= Duration::from_millis(25), "gave up after {:?}", slot.elapsed());
        // A lost duplication is not "nothing new yet": no retry.
        let mut calls = 0;
        let got: Result<(), Got> = pacer.acquire_within(
            Instant::now(),
            |_| {
                calls += 1;
                Err(Got::Broken)
            },
            |e| *e == Got::Timeout,
        );
        assert_eq!((got, calls), (Err(Got::Broken), 1));
    }

    #[test]
    fn the_capture_window_is_half_a_period_on_the_grid() {
        let t0 = Instant::now();
        let mut pacer = FramePacer::new(30);
        pacer.take(t0);
        let due = t0 + pacer.period();
        // On time, and 5 ms late: both end half a period after the GRID slot.
        assert_eq!(pacer.capture_deadline(due), due + pacer.period() / 2);
        let late = due + Duration::from_millis(5);
        assert_eq!(pacer.capture_deadline(late), due + pacer.period() / 2);
        // A slot opened later than that polls: its window is already over.
        assert!(pacer.capture_deadline(due + pacer.period()) < due + pacer.period());
    }

    #[test]
    fn slots_are_spaced_by_the_period() {
        // Offers every 1 ms, so each slot is taken up to 1 ms after it opens;
        // the grid keeps the spacing within that of the period either way.
        let (_, taken) = run(30, Duration::from_millis(1), Duration::from_secs(2));
        for w in taken.windows(2) {
            let gap = w[1] - w[0];
            assert!(gap >= Duration::from_millis(32), "gap {gap:?}");
            assert!(gap <= Duration::from_millis(35), "gap {gap:?}");
        }
    }
}
