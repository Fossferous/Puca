//! The agent-lifecycle decision, as a pure state machine.
//!
//! THIS IS THE PART EVERYONE GETS WRONG. A remote-desktop service has to keep an
//! agent running in the right place as the machine logs in and out, locks and
//! unlocks, and switches which session owns the physical console. Competitors
//! "stop working after you lock the PC" because they treat the lock as the end
//! of the session instead of a transition to a DIFFERENT desktop that needs a
//! DIFFERENT agent. Getting this wrong is invisible until someone locks their
//! screen from three timezones away and can never get back in.
//!
//! So the logic lives here, alone, with no Windows API in sight — every decision
//! is a pure function of (event, state), which is what lets it be tested against
//! every transition rather than discovered in the field. The Windows side
//! (`service.rs`) only translates SCM notifications into `SessionEvent`s and
//! carries out the `Action`s; it makes no decisions.
//!
//! THE TWO AGENT FLAVOURS, and why both exist:
//!
//!   * `SystemInteractive` — runs as SYSTEM in the interactive session and
//!     follows the input desktop onto Winlogon. Needed precisely when there is
//!     no user token to launch as (the login screen) or the user's desktop is
//!     not the input desktop (locked, or a UAC secure desktop is up). Spike S5
//!     proved a SYSTEM process can capture that secure desktop; this is what
//!     decides WHEN to use it.
//!
//! …and nothing else. Whenever a user is signed in and unlocked, the DESKTOP
//! APP owns the agent, exactly as it did before this service existed, and the
//! supervisor deliberately wants nothing running. That is the whole safety
//! argument: the service is inert for every ordinary minute of a signed-in
//! day and only acts in the window where no user-level process can.

/// Which kind of agent should run in a session.
///
/// There is deliberately only ONE. A `User` flavour existed here and was
/// removed: when a user is signed in and unlocked, the desktop app is running
/// and already owns an agent of its own, launched with the user's own rights
/// and torn down with the app. A service-launched second one would contend for
/// the same DXGI output (capture is exclusive), duplicate a lifetime the app
/// already manages correctly, and require the service to hand a user-session
/// process to the app — the handoff whose token had to be written somewhere
/// readable to work at all.
///
/// So the service does nothing whenever the app can do it, and the only thing
/// it ever launches is the one thing the app CANNOT be: SYSTEM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFlavour {
    /// As SYSTEM in the interactive session, following the input desktop. The
    /// only flavour that can capture the lock screen, the login screen, and UAC.
    SystemInteractive,
}

/// A session-state change, already resolved from the raw SCM notification.
///
/// The lock/unlock/logon/logoff variants carry the session they apply to; the
/// supervisor ignores any that are not the session it currently targets, so a
/// second (e.g. RDP) session locking does not disturb the console agent. The
/// console and startup variants carry a full snapshot because the service
/// queries WTS for the session's real state at those moments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    /// Service start: the current console session and its state, if any.
    Startup { console: Option<u32>, logged_on: bool, locked: bool },
    /// The physical console attached to (or switched to) this session.
    ConsoleConnect { session: u32, logged_on: bool, locked: bool },
    /// The physical console detached from this session (fast-user-switch away,
    /// or shutdown). Nothing is on the console afterwards.
    ConsoleDisconnect { session: u32 },
    /// A user logged on at this session.
    Logon { session: u32 },
    /// A user logged off this session.
    Logoff { session: u32 },
    /// This session locked.
    Lock { session: u32 },
    /// This session unlocked.
    Unlock { session: u32 },
}

/// What the supervisor wants the service to do. Order matters: a `Stop` for the
/// outgoing agent always precedes the `Launch` for its replacement, so the two
/// never run at once (double capture of one output is a design error, per the
/// DXGI exclusivity note in `puca-capture`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Launch (or replace) the agent in `session` with `flavour`.
    Launch { session: u32, flavour: AgentFlavour },
    /// Stop the agent running in `session`.
    Stop { session: u32 },
}

/// The console session's phase, as far as we have been told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Phase {
    logged_on: bool,
    locked: bool,
}

pub struct Supervisor {
    /// The session that currently owns the physical console, if any. We only
    /// ever run one agent, and only for this session — v1 does not drive RDP or
    /// background sessions.
    target: Option<u32>,
    phase: Phase,
    /// What we have actually asked to run: (session, flavour). `None` = nothing.
    running: Option<(u32, AgentFlavour)>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            target: None,
            phase: Phase { logged_on: false, locked: false },
            running: None,
        }
    }

    /// The flavour that SHOULD be running given the current target and phase, or
    /// `None` if nothing should run.
    ///
    /// The whole policy in three lines:
    ///   - no console session -> nothing (there is no desktop to capture);
    ///   - a user signed in AND unlocked -> nothing, because the DESKTOP APP
    ///     owns the agent in that state and always has;
    ///   - otherwise (nobody signed in, or signed in but locked) -> the SYSTEM
    ///     agent, because the thing to capture is the login or lock/secure
    ///     desktop and only SYSTEM-in-session can reach it.
    ///
    /// The middle line is the whole safety argument for this service: it is
    /// idle during every ordinary minute of a signed-in day, and only exists
    /// for the window where nothing else CAN work. It also means the two
    /// agents can never be alive at once, so they cannot fight over the
    /// exclusive DXGI capture.
    fn desired(&self) -> Option<(u32, AgentFlavour)> {
        let session = self.target?;
        if self.phase.logged_on && !self.phase.locked {
            return None;
        }
        Some((session, AgentFlavour::SystemInteractive))
    }

    /// Should the service be holding its own connection to the server?
    ///
    /// EXACTLY WHEN THE SYSTEM AGENT SHOULD RUN, and deliberately expressed as
    /// `desired().is_some()` rather than as its own copy of the rule. The two
    /// answers must never disagree: a socket up while no agent should run means
    /// the machine accepts a session it cannot serve, and an agent running with
    /// no socket means a lock screen nothing can reach. Writing the condition
    /// twice is how they would drift, so it is written once.
    ///
    /// The consequence worth stating plainly: while somebody is signed in and
    /// using the machine, this service holds NO network connection at all. It
    /// is not a background client that happens to idle — it is absent.
    pub fn wants_link(&self) -> bool {
        self.desired().is_some()
    }

    /// Fold in an event and return the actions to carry out. The heart of the
    /// module; every field mutation is here so the transition table is legible.
    pub fn on_event(&mut self, event: SessionEvent) -> Vec<Action> {
        match event {
            SessionEvent::Startup { console, logged_on, locked } => {
                self.target = console;
                self.phase = Phase { logged_on, locked };
            }
            SessionEvent::ConsoleConnect { session, logged_on, locked } => {
                self.target = Some(session);
                self.phase = Phase { logged_on, locked };
            }
            SessionEvent::ConsoleDisconnect { session } => {
                // Only clear if it is the session we were targeting; a disconnect
                // notification for some other session must not tear down the
                // console agent.
                if self.target == Some(session) {
                    self.target = None;
                    self.phase = Phase { logged_on: false, locked: false };
                }
            }
            // Lock/unlock/logon/logoff for a NON-target session are ignored: we
            // drive only the console session, and a background session changing
            // state must not move the console agent.
            SessionEvent::Logon { session } if self.target == Some(session) => {
                self.phase.logged_on = true;
                // A fresh logon is, by definition, not locked.
                self.phase.locked = false;
            }
            SessionEvent::Logoff { session } if self.target == Some(session) => {
                self.phase.logged_on = false;
                self.phase.locked = false;
            }
            SessionEvent::Lock { session } if self.target == Some(session) => {
                self.phase.locked = true;
            }
            SessionEvent::Unlock { session } if self.target == Some(session) => {
                self.phase.locked = false;
            }
            // Non-target session events: no state change, no actions.
            SessionEvent::Logon { .. }
            | SessionEvent::Logoff { .. }
            | SessionEvent::Lock { .. }
            | SessionEvent::Unlock { .. } => return Vec::new(),
        }
        self.reconcile()
    }

    /// Emit the minimum actions to make `running` equal `desired`.
    ///
    /// Idempotent: if nothing needs to change, it returns an empty list, so
    /// duplicate or redundant notifications (Windows delivers plenty) cost a
    /// no-op rather than a needless agent restart — a restart drops the live
    /// session, so "reconcile only on real change" is a correctness rule, not an
    /// optimisation.
    fn reconcile(&mut self) -> Vec<Action> {
        let desired = self.desired();
        if desired == self.running {
            return Vec::new();
        }
        let mut actions = Vec::new();
        // Stop first, so the outgoing agent releases the capture before the
        // replacement grabs it.
        if let Some((session, _)) = self.running {
            actions.push(Action::Stop { session });
        }
        if let Some((session, flavour)) = desired {
            actions.push(Action::Launch { session, flavour });
        }
        self.running = desired;
        actions
    }

    /// The agent currently believed to be running — for diagnostics and the
    /// service's own status reporting.
    pub fn running(&self) -> Option<(u32, AgentFlavour)> {
        self.running
    }
}

#[cfg(test)]
mod tests {
    use super::AgentFlavour::*;
    use super::*;

    fn launch(session: u32, flavour: AgentFlavour) -> Action {
        Action::Launch { session, flavour }
    }
    fn stop(session: u32) -> Action {
        Action::Stop { session }
    }

    #[test]
    fn a_logged_in_unlocked_console_runs_nothing_because_the_app_owns_it() {
        // THE safety property of this whole service. During an ordinary
        // signed-in session the desktop app has its own agent and always has;
        // the service must stay out of the way entirely. If this ever launches
        // something, two agents fight over an exclusive DXGI capture and the
        // service has started doing privileged work nobody asked it for.
        let mut s = Supervisor::new();
        let actions = s.on_event(SessionEvent::Startup {
            console: Some(1),
            logged_on: true,
            locked: false,
        });
        assert_eq!(actions, vec![], "the app owns the agent while a user is present and unlocked");
        assert_eq!(s.running(), None);
    }

    #[test]
    fn the_login_screen_with_no_user_runs_the_system_agent() {
        // Boot to the login screen: a console session exists but nobody is
        // logged on. Only SYSTEM-in-session can capture Winlogon, so that is
        // what must run — this is the pre-login remote-access case.
        let mut s = Supervisor::new();
        let actions = s.on_event(SessionEvent::Startup {
            console: Some(1),
            logged_on: false,
            locked: false,
        });
        assert_eq!(actions, vec![launch(1, SystemInteractive)]);
    }

    #[test]
    fn locking_starts_the_system_agent() {
        // The moment this service exists for. On lock the input desktop becomes
        // Winlogon, which no user-level process — including the app's own agent
        // — can capture. There is nothing to stop first, because the service
        // was running nothing.
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(2), logged_on: true, locked: false });
        let actions = s.on_event(SessionEvent::Lock { session: 2 });
        assert_eq!(actions, vec![launch(2, SystemInteractive)]);
        assert_eq!(s.running(), Some((2, SystemInteractive)));
    }

    #[test]
    fn unlocking_stops_the_system_agent_and_starts_nothing() {
        // Handing back to the app. The SYSTEM agent must go away the instant it
        // is no longer the only thing that can work — leaving it running would
        // mean a SYSTEM process capturing an ordinary signed-in desktop, which
        // is exactly the privilege this design refuses to take.
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(2), logged_on: true, locked: false });
        s.on_event(SessionEvent::Lock { session: 2 });
        let actions = s.on_event(SessionEvent::Unlock { session: 2 });
        assert_eq!(actions, vec![stop(2)]);
        assert_eq!(s.running(), None);
    }

    #[test]
    fn a_redundant_lock_is_a_no_op() {
        // Windows delivers duplicate notifications; a second lock while already
        // locked must NOT restart the agent — a restart drops the live session.
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: false });
        s.on_event(SessionEvent::Lock { session: 1 });
        let again = s.on_event(SessionEvent::Lock { session: 1 });
        assert!(again.is_empty(), "a duplicate lock must not churn the agent, got {again:?}");
    }

    #[test]
    fn events_for_a_non_target_session_are_ignored() {
        // An RDP or background session locking must not disturb the console
        // agent. This is why lock/unlock carry a session id and are filtered.
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: false });
        let other = s.on_event(SessionEvent::Lock { session: 7 });
        assert!(other.is_empty(), "a lock on another session must not touch us");
        assert_eq!(s.running(), None, "still the app's agent, not ours");
    }

    #[test]
    fn logging_off_drops_to_the_system_agent_for_the_greeter() {
        // Log off -> back to the login screen -> SYSTEM agent, so a remote user
        // can still reach the greeter (and log back in).
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: false });
        // Nothing was running (the app owned the desktop), so this is a pure
        // launch — the greeter is ours.
        let actions = s.on_event(SessionEvent::Logoff { session: 1 });
        assert_eq!(actions, vec![launch(1, SystemInteractive)]);
    }

    #[test]
    fn console_disconnect_stops_everything() {
        // Fast-user-switch away or shutdown: nothing owns the console, so no
        // agent should run.
        let mut s = Supervisor::new();
        // Starting from a signed-in unlocked console, the service is running
        // NOTHING (the app owns it), so there is nothing to stop.
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: false });
        let actions = s.on_event(SessionEvent::ConsoleDisconnect { session: 1 });
        assert_eq!(actions, vec![]);
        assert_eq!(s.running(), None);

        // But from a LOCKED console, where the SYSTEM agent is ours, the
        // disconnect must stop it.
        let mut s2 = Supervisor::new();
        s2.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: true });
        assert_eq!(s2.running(), Some((1, SystemInteractive)));
        assert_eq!(s2.on_event(SessionEvent::ConsoleDisconnect { session: 1 }), vec![stop(1)]);
        assert_eq!(s2.running(), None);
    }

    #[test]
    fn a_disconnect_for_another_session_leaves_us_alone() {
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: false });
        let actions = s.on_event(SessionEvent::ConsoleDisconnect { session: 9 });
        assert!(actions.is_empty());
        assert_eq!(s.running(), None);
    }

    #[test]
    fn fast_user_switch_moves_the_agent_to_the_new_session() {
        // The console moves from session 1 (locked) to session 2 (a different
        // logged-in user). The agent must stop in 1 and start in 2, tracking the
        // console — the other half of "stops working after you switch users".
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: true, locked: true });
        assert_eq!(s.running(), Some((1, SystemInteractive)));
        let actions = s.on_event(SessionEvent::ConsoleConnect {
            session: 2,
            logged_on: true,
            locked: false,
        });
        // Session 1 was LOCKED (ours), session 2 is signed in and unlocked
        // (the app's). So the move is a pure stop: we hand back.
        assert_eq!(actions, vec![stop(1)]);
        assert_eq!(s.running(), None);
    }

    #[test]
    fn no_console_at_startup_runs_nothing() {
        let mut s = Supervisor::new();
        let actions = s.on_event(SessionEvent::Startup { console: None, logged_on: false, locked: false });
        assert!(actions.is_empty());
        assert_eq!(s.running(), None);
    }

    #[test]
    fn logon_after_a_headless_start_hands_back_to_the_app() {
        // Service started at the greeter (SYSTEM agent), then a user signs in:
        // the app is now running and owns the agent, so the service stops and
        // launches NOTHING. A Launch here would be the service quietly keeping
        // SYSTEM-level capture of a normal desktop.
        let mut s = Supervisor::new();
        s.on_event(SessionEvent::Startup { console: Some(1), logged_on: false, locked: false });
        assert_eq!(s.running(), Some((1, SystemInteractive)));
        let actions = s.on_event(SessionEvent::Logon { session: 1 });
        assert_eq!(actions, vec![stop(1)]);
        assert_eq!(s.running(), None);
    }

    #[test]
    fn a_full_day_of_transitions_never_double_launches() {
        // Fuzz-lite: a long realistic sequence must always keep `running` equal
        // to what `desired` would compute, and never emit a Launch without a
        // preceding Stop of the old agent. This catches any transition that
        // leaks a running agent.
        let mut s = Supervisor::new();
        let script = [
            SessionEvent::Startup { console: Some(1), logged_on: false, locked: false },
            SessionEvent::Logon { session: 1 },
            SessionEvent::Lock { session: 1 },
            SessionEvent::Unlock { session: 1 },
            SessionEvent::Lock { session: 1 },
            SessionEvent::Lock { session: 1 }, // duplicate
            SessionEvent::ConsoleConnect { session: 2, logged_on: true, locked: false },
            SessionEvent::Lock { session: 1 }, // stale, non-target
            SessionEvent::Logoff { session: 2 },
            SessionEvent::ConsoleDisconnect { session: 2 },
        ];
        let mut alive: Option<u32> = None;
        for ev in script {
            for action in s.on_event(ev) {
                match action {
                    Action::Stop { session } => {
                        assert_eq!(alive, Some(session), "stopped an agent that was not running");
                        alive = None;
                    }
                    Action::Launch { session, .. } => {
                        assert_eq!(alive, None, "launched while an agent was still running");
                        alive = Some(session);
                    }
                }
            }
            // Invariant: what we think is alive matches the running() view.
            assert_eq!(alive, s.running().map(|(sess, _)| sess));
        }
        assert_eq!(s.running(), None, "everything torn down at the end");
    }

    #[test]
    fn the_socket_is_up_exactly_when_the_system_agent_should_be() {
        // THE PROPERTY, swept over the whole transition table rather than
        // spot-checked. Any future edit to `desired()` that changes one answer
        // without the other fails here.
        let every_event = |session: u32| {
            vec![
                SessionEvent::Startup { console: Some(session), logged_on: false, locked: false },
                SessionEvent::Startup { console: Some(session), logged_on: true, locked: false },
                SessionEvent::Startup { console: Some(session), logged_on: true, locked: true },
                SessionEvent::Startup { console: None, logged_on: false, locked: false },
                SessionEvent::ConsoleConnect { session, logged_on: true, locked: false },
                SessionEvent::ConsoleConnect { session, logged_on: true, locked: true },
                SessionEvent::ConsoleConnect { session, logged_on: false, locked: false },
                SessionEvent::ConsoleDisconnect { session },
                SessionEvent::Logon { session },
                SessionEvent::Logoff { session },
                SessionEvent::Lock { session },
                SessionEvent::Unlock { session },
            ]
        };

        let mut sup = Supervisor::new();
        let mut saw_up = false;
        let mut saw_down = false;
        // Two sessions interleaved, so events for a non-target session are
        // covered too.
        for session in [1u32, 2, 1, 2] {
            for ev in every_event(session) {
                sup.on_event(ev);
                let agent_should_run = sup.running.is_some();
                assert_eq!(
                    sup.wants_link(),
                    agent_should_run,
                    "socket and agent disagreed after {ev:?}"
                );
                if sup.wants_link() { saw_up = true } else { saw_down = true }
            }
        }
        // A POSITIVE CONTROL. Without these the assertion above would pass
        // trivially if the sweep never actually reached one of the two states —
        // which is the shape of green test this codebase has shipped before.
        assert!(saw_up, "the sweep never reached a state wanting the socket");
        assert!(saw_down, "the sweep never reached a state wanting it down");
    }

    #[test]
    fn nobody_signed_in_means_the_socket_is_up() {
        // The case the whole feature exists for: a machine that just cold-booted
        // to its sign-in screen must be reachable.
        let mut sup = Supervisor::new();
        sup.on_event(SessionEvent::Startup { console: Some(1), logged_on: false, locked: false });
        assert!(sup.wants_link(), "a cold-booted sign-in screen must be reachable");

        // And an ordinary signed-in day must not be.
        sup.on_event(SessionEvent::Logon { session: 1 });
        assert!(!sup.wants_link(), "the app owns the machine while somebody is using it");

        // Locking hands it back.
        sup.on_event(SessionEvent::Lock { session: 1 });
        assert!(sup.wants_link());
    }
}

