//! What this agent will do, decided by whose account it runs under.
//!
//! The agent has always run as the signed-in user. A remote controller of that
//! agent gets that user's desktop and that user's files — which is the whole
//! bargain, and the OS enforces the ceiling whatever the agent gets wrong.
//!
//! The system service breaks that bargain. It starts an agent as LocalSystem so
//! there is something to control when nobody is signed in or the machine is
//! locked, and LocalSystem has no ceiling. Every guard the agent implements in
//! software is now the ONLY guard, where before it was a convenience above a
//! floor the OS was holding anyway.
//!
//! So the SYSTEM agent gives back what it does not need. It exists to show a
//! locked screen and type into it; it does not need the filesystem, and a
//! filesystem it does not offer cannot be escaped into.

/// Who launched this agent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flavour {
    /// The signed-in user's own desktop app. Runs as that user.
    User,
    /// The system service, into the console session, because nobody is signed
    /// in or the machine is locked. Runs as LocalSystem.
    SystemInteractive,
}

/// Something a controller can ask for that is worth deciding per flavour.
///
/// An enum rather than a string so [`Flavour::allows`] matches exhaustively:
/// adding a variant here stops the crate compiling until someone has decided
/// what a SYSTEM agent does with it. A new privileged reach must not arrive
/// already permitted because nobody remembered this file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Capability {
    /// Opening the file-transfer scope.
    ///
    /// This is the only request that gives a peer any reach into the
    /// filesystem: a stream starts ungranted, and the `files` data channel is
    /// the only channel whose bytes ever reach disk.
    FileAccess,
    /// Screen capture and streaming.
    Capture,
    /// Synthesised keyboard and mouse input.
    Input,
    /// Blanking the local display for the duration of a session.
    PrivacyMode,
    /// Locking the console or shutting the machine down on the controller's
    /// request (the sealed `power` signal).
    Power,
}

impl Flavour {
    /// Read `--flavour`.
    ///
    /// **This argument can only ever restrict.** Absent is `User`, because the
    /// desktop app has never passed it and must keep working untouched. Every
    /// other value — including one this build does not recognise, which is a
    /// newer service talking to an older agent — resolves to the restricted
    /// flavour.
    ///
    /// Written that way round on purpose: an argument that can only take
    /// permissions away has no failure mode where a string we misread is the
    /// reason a SYSTEM process was handed the disk.
    pub fn parse(arg: Option<&str>) -> Self {
        match arg {
            None => Flavour::User,
            Some(_) => Flavour::SystemInteractive,
        }
    }

    pub fn allows(self, cap: Capability) -> bool {
        match (self, cap) {
            (Flavour::User, _) => true,

            // The point of this flavour: something to see and something to
            // type into while the machine is locked.
            (Flavour::SystemInteractive, Capability::Capture) => true,
            (Flavour::SystemInteractive, Capability::Input) => true,

            // Blanking the physical panel while a remote operator drives the
            // lock screen is if anything more wanted here than it is for a
            // signed-in user, and it reaches nothing but this machine's own
            // display.
            (Flavour::SystemInteractive, Capability::PrivacyMode) => true,

            // Shutting down from the sign-in screen is exactly what someone
            // who locked the box remotely and is done with it wants; LOCK is
            // a no-op here (the console is already locked). Runs as
            // LocalSystem, which holds SeShutdownPrivilege.
            (Flavour::SystemInteractive, Capability::Power) => true,

            // Refused. As the user, a jail escape reaches what that user could
            // already reach; as SYSTEM the same escape reaches every other
            // profile on the machine and the registry hives behind them. This
            // codebase has already shipped a lexically-checked jail that a
            // directory junction walked straight out of, and the alternative
            // scope — "fixed drives minus system paths" — is a denylist, which
            // is the shape of guard that fails by going stale.
            //
            // Nothing is lost that the operator cannot get by signing in,
            // which is the one thing this agent exists to let them do.
            (Flavour::SystemInteractive, Capability::FileAccess) => false,
        }
    }

    /// What to tell a caller whose request this flavour will not serve.
    ///
    /// Phrased as a property of the agent with the way forward attached, not as
    /// an error: a refusal that reads like a fault gets retried, reported as a
    /// bug, and eventually "fixed".
    pub fn refusal(self, cap: Capability) -> Option<String> {
        if self.allows(cap) {
            return None;
        }
        Some(match cap {
            Capability::FileAccess => {
                "file access is not offered before sign-in: this agent is running as the \
                 system, and file transfer is deliberately available only to an agent \
                 running as you. Sign in on this machine and reconnect."
                    .to_string()
            }
            Capability::Capture | Capability::Input | Capability::PrivacyMode | Capability::Power => {
                format!("{cap:?} is not available to the pre-login agent")
            }
        })
    }

    /// Whether this agent can drive UAC prompts and the lock screen.
    ///
    /// Reported to the app as `Capabilities.elevated`, which is what suppresses
    /// the "cannot get through UAC or the lock screen" note in the UI. It was
    /// hardcoded false because it was always false; it is now a real answer.
    pub fn is_elevated(self) -> bool {
        matches!(self, Flavour::SystemInteractive)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_flavour_argument_is_the_desktop_app() {
        // Every shipped install launches the agent with no --flavour at all.
        // If this ever returns SystemInteractive, file transfer dies for
        // everyone on the next release.
        assert_eq!(Flavour::parse(None), Flavour::User);
        assert!(Flavour::parse(None).allows(Capability::FileAccess));
    }

    #[test]
    fn the_flavour_argument_can_only_restrict() {
        // The invariant, stated as a test: no string grants anything. A newer
        // service, a typo, and a hostile argv all land in the same place.
        for arg in ["system", "user", "", "SYSTEM", "nonsense", "--token"] {
            assert_eq!(
                Flavour::parse(Some(arg)),
                Flavour::SystemInteractive,
                "{arg:?} must not widen the agent"
            );
        }
    }

    #[test]
    fn the_system_agent_refuses_the_filesystem() {
        // The headline restriction. Revert `allows` to `true` and this goes red.
        let f = Flavour::SystemInteractive;
        assert!(!f.allows(Capability::FileAccess));
        let msg = f.refusal(Capability::FileAccess).expect("a refusal");
        assert!(msg.contains("Sign in"), "the refusal must say how to proceed: {msg}");
    }

    #[test]
    fn the_system_agent_still_shows_and_types() {
        // The positive control: without this, a refusal that accidentally
        // covered everything would look exactly like a correct one, and the
        // feature would be dead rather than restricted.
        let f = Flavour::SystemInteractive;
        assert!(f.allows(Capability::Capture), "there would be nothing to look at");
        assert!(f.allows(Capability::Input), "there would be no way to sign in");
        assert!(f.allows(Capability::PrivacyMode));
        assert_eq!(f.refusal(Capability::Capture), None);
    }

    #[test]
    fn the_user_agent_is_unchanged() {
        // This flavour is what ships today. Nothing here may become a refusal.
        let f = Flavour::User;
        for cap in [
            Capability::FileAccess,
            Capability::Capture,
            Capability::Input,
            Capability::PrivacyMode,
        ] {
            assert!(f.allows(cap), "{cap:?} is allowed today and must stay allowed");
            assert_eq!(f.refusal(cap), None);
        }
    }

    #[test]
    fn elevation_is_claimed_only_by_the_system_agent() {
        // `elevated` suppresses the UI's "cannot get through UAC or the lock
        // screen" note. Claiming it as the user would promise a capability the
        // user-flavour agent has never had.
        assert!(!Flavour::User.is_elevated());
        assert!(Flavour::SystemInteractive.is_elevated());
    }
}
