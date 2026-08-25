//! Raising the Secure Attention Sequence — Ctrl+Alt+Del — on behalf of a remote
//! controller, and the machine policy that has to be in place for it to work.
//!
//! WHY THIS LIVES IN THE SERVICE AND NOWHERE ELSE. `SendInput` cannot produce
//! the SAS. That is not an oversight to work around: win32k's SAS recogniser
//! reads the raw hardware stream and discards injected events by design, which
//! is what makes the sequence *secure* and what makes "am I really talking to
//! Windows?" answerable at a sign-in screen. Every scan-code trick fails, and —
//! worse — fails SILENTLY, returning success. That is exactly what shipped: the
//! viewer's Ctrl+Alt+Del sent six ordinary key frames, `SendInput` accepted all
//! six, the agent answered `Ok`, and nothing happened.
//!
//! The one supported path is `SendSAS` from `sas.dll`, and it works only for a
//! process running as LocalSystem with
//! `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System!SoftwareSASGeneration`
//! set to 1 (Services) or 3 (Services and Ease of Access). This service is that
//! process. The agent — user-flavour or system-flavour — asks over the control
//! pipe rather than trying itself, so there is one implementation and one place
//! where the answer can be honest.
//!
//! THE HONESTY PROBLEM, and how it is handled. `SendSAS` returns `void`. It
//! reports nothing: with the policy unset it is a no-op that looks identical to
//! success, which would recreate the exact lie this whole change exists to end.
//! So the policy is READ FIRST and a request is refused with the real reason
//! when it is not set. That turns the one unobservable failure into an
//! observable one; what remains unprovable from inside this process is whether
//! winlogon actually painted the secure desktop, and no API offers that.

#![cfg(windows)]

use windows::core::{s, w, PCWSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE,
    REG_VALUE_TYPE,
};

/// Where Windows keeps the software-SAS policy. Not ours; an admin or a group
/// policy may own this value, which is why nothing here overwrites a non-zero
/// one.
const POLICY_KEY: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System");
const POLICY_VALUE: PCWSTR = w!("SoftwareSASGeneration");

/// Our own key, used for exactly one thing: remembering that WE set the policy.
///
/// Without this marker, uninstalling would either leave the value behind for
/// ever or delete one an administrator deliberately set for something else —
/// Ease of Access software, an accessibility tool, a kiosk build. Both are
/// wrong, and the second is worse because it is silent.
const MARKER_KEY: PCWSTR = w!(r"SOFTWARE\Sovereign");
const MARKER_VALUE: PCWSTR = w!("SovereignSetSoftwareSAS");

/// Close an `HKEY` on every path, including the early returns.
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }
}

/// Read a REG_DWORD, or `None` if the key/value is absent or another type.
///
/// A wrong TYPE reads as absent on purpose: a string where a DWORD belongs is
/// not a policy this code can interpret, and guessing at it would be worse than
/// reporting "not set" and letting a person look.
fn read_dword(root: PCWSTR, value: PCWSTR) -> Option<u32> {
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, root, 0, KEY_READ, &mut key).is_err() {
            return None;
        }
        let key = Key(key);
        let mut kind = REG_VALUE_TYPE::default();
        let mut data = 0u32;
        let mut len = std::mem::size_of::<u32>() as u32;
        let rc = RegQueryValueExW(
            key.0,
            value,
            None,
            Some(&mut kind),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut len),
        );
        if rc.is_err() || kind != REG_DWORD || len as usize != std::mem::size_of::<u32>() {
            return None;
        }
        Some(data)
    }
}

fn write_dword(root: PCWSTR, value: PCWSTR, data: u32) -> Result<(), String> {
    unsafe {
        let mut key = HKEY::default();
        let rc = RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            root,
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        );
        if rc.is_err() {
            return Err(format!("cannot open the registry key for writing: {rc:?}"));
        }
        let key = Key(key);
        let rc = RegSetValueExW(key.0, value, 0, REG_DWORD, Some(&data.to_ne_bytes()));
        if rc.is_err() {
            return Err(format!("cannot write the registry value: {rc:?}"));
        }
        Ok(())
    }
}

fn delete_value(root: PCWSTR, value: PCWSTR) -> Result<(), String> {
    unsafe {
        let mut key = HKEY::default();
        let rc = RegOpenKeyExW(HKEY_LOCAL_MACHINE, root, 0, KEY_SET_VALUE, &mut key);
        if rc.is_err() {
            return Err(format!("cannot open the registry key: {rc:?}"));
        }
        let key = Key(key);
        let rc = RegDeleteValueW(key.0, value);
        // Already gone is the desired end state, not a failure.
        if rc.is_err() && rc.0 != 2 {
            return Err(format!("cannot delete the registry value: {rc:?}"));
        }
        Ok(())
    }
}

/// What the policy value currently says, or `None` when it is not set.
pub fn policy() -> Option<u32> {
    read_dword(POLICY_KEY, POLICY_VALUE)
}

/// Does `value` let a SERVICE raise the SAS?
///
/// PURE, and the only place these numbers are interpreted. 0 is None, 1 is
/// Services, 2 is Ease of Access applications, 3 is both. Only 1 and 3 include
/// us — 2 is a real setting an administrator may have chosen for an
/// accessibility tool, and reading it as "close enough" would make every refused
/// request read as a bug in this code.
pub fn policy_permits_services(value: Option<u32>) -> bool {
    matches!(value, Some(1) | Some(3))
}

/// What [`ensure_policy`] should do about what it found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyAction {
    /// Absent — write 1.
    Write,
    /// Somebody already decided. Leave it, whatever it says.
    LeaveAlone(u32),
}

/// PURE decision, so the "do not stamp on an administrator's setting" rule is
/// testable without a registry.
///
/// ONLY an ABSENT value is written. Every present value was put there by
/// somebody: 2 (Ease of Access only) for an accessibility tool, and 0 ("None")
/// is not "unset" — it is the value the "Disable or enable software Secure
/// Attention Sequence" group policy writes when an administrator picks None,
/// i.e. a deliberate decision that no software may raise it. Windows itself
/// never writes this value, so absent is the only state nobody chose. A request
/// on a machine that chose otherwise is refused with the real reason —
/// see `raise_with`.
pub fn policy_action(current: Option<u32>) -> PolicyAction {
    match current {
        None => PolicyAction::Write,
        Some(v) => PolicyAction::LeaveAlone(v),
    }
}

/// What [`remove_policy_if_ours`] should do, given the marker and the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemovalAction {
    /// No marker: this code never wrote the policy. Touch nothing.
    NotOurs,
    /// Marker, but the value is already gone. Drop the marker only.
    AlreadyGone,
    /// Marker, but the value is no longer the 1 this code wrote — an
    /// administrator or a group policy changed it since. It is theirs now:
    /// leave it, and drop the marker so no later uninstall tries again.
    ChangedSince(u32),
    /// Marker and the value is still our 1. Remove it.
    Remove,
}

/// PURE, for the same reason as `policy_action`: "only remove what THIS code
/// wrote" is a rule, and a rule with a registry in the way never gets tested.
pub fn removal_action(marker: Option<u32>, current: Option<u32>) -> RemovalAction {
    if marker != Some(1) {
        return RemovalAction::NotOurs;
    }
    match current {
        None => RemovalAction::AlreadyGone,
        Some(1) => RemovalAction::Remove,
        Some(v) => RemovalAction::ChangedSince(v),
    }
}

/// What `ensure_policy` did, as one line for the service log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyOutcome {
    /// Already usable, or already owned by somebody else. Carries the value.
    Kept(u32),
    /// We wrote 1 and recorded that we did.
    Wrote,
    /// The write failed. NEVER fatal — see `ensure_policy`.
    Failed(String),
}

impl std::fmt::Display for PolicyOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyOutcome::Kept(v) => write!(
                f,
                "SoftwareSASGeneration is already {v} ({}); left as it is",
                if policy_permits_services(Some(*v)) {
                    "Ctrl+Alt+Del over remote control will work"
                } else {
                    "a service may NOT raise Ctrl+Alt+Del; an administrator set this"
                }
            ),
            PolicyOutcome::Wrote => write!(
                f,
                "SoftwareSASGeneration was unset; wrote 1 so this service may raise Ctrl+Alt+Del"
            ),
            PolicyOutcome::Failed(e) => write!(
                f,
                "could not set SoftwareSASGeneration ({e}); Ctrl+Alt+Del over remote control \
                 will be refused with that reason rather than silently doing nothing"
            ),
        }
    }
}

/// Make sure a service is allowed to raise the SAS on this machine.
///
/// CALLED AT SERVICE START, not only from `install`. `puca-service update`
/// replaces the binaries without re-running the installer, so a policy applied
/// only at install time would be missing on every machine that updated into this
/// feature rather than installing fresh.
///
/// NEVER FAILS THE SERVICE. A registry write that a group policy refuses is a
/// reason Ctrl+Alt+Del will not work; it is not a reason for a machine to lose
/// unattended access entirely. The outcome is logged and the refusal, when it
/// comes, says what is actually wrong.
pub fn ensure_policy() -> PolicyOutcome {
    match policy_action(policy()) {
        PolicyAction::LeaveAlone(v) => PolicyOutcome::Kept(v),
        PolicyAction::Write => match write_dword(POLICY_KEY, POLICY_VALUE, 1) {
            Ok(()) => {
                // The marker is written AFTER the policy and its failure is
                // swallowed on purpose: a marker with no policy would make
                // uninstall delete a value it did not set. Missing the marker
                // costs only that the value is left behind, which is the safe
                // direction.
                let _ = write_dword(MARKER_KEY, MARKER_VALUE, 1);
                PolicyOutcome::Wrote
            }
            Err(e) => PolicyOutcome::Failed(e),
        },
    }
}

/// Undo [`ensure_policy`], but ONLY if this is the code that did it.
///
/// The marker is the whole mechanism. `SoftwareSASGeneration` is a shared
/// machine policy: deleting one that an administrator, a kiosk image or an
/// accessibility product set would silently break something else on the way out
/// of this one. Returns a line for the caller to print.
pub fn remove_policy_if_ours() -> String {
    match removal_action(read_dword(MARKER_KEY, MARKER_VALUE), policy()) {
        RemovalAction::NotOurs => {
            "SoftwareSASGeneration was not set by Puca; left untouched".into()
        }
        RemovalAction::AlreadyGone => {
            let _ = delete_value(MARKER_KEY, MARKER_VALUE);
            "SoftwareSASGeneration was already gone; nothing to remove".into()
        }
        RemovalAction::ChangedSince(v) => {
            let _ = delete_value(MARKER_KEY, MARKER_VALUE);
            format!(
                "SoftwareSASGeneration is now {v}, not the 1 this service wrote — somebody \
                 changed it since, so it is theirs; left untouched"
            )
        }
        // The marker goes ONLY once the value is actually gone. Dropping it
        // first (as the first version did) made a refused delete permanent:
        // the value stayed, the marker did not, and every later uninstall
        // reported "not set by Puca" about a value Puca set.
        RemovalAction::Remove => match delete_value(POLICY_KEY, POLICY_VALUE) {
            Ok(()) => {
                let _ = delete_value(MARKER_KEY, MARKER_VALUE);
                "removed the SoftwareSASGeneration policy this service set".into()
            }
            Err(e) => format!(
                "could not remove the SoftwareSASGeneration policy: {e}; the marker is kept so \
                 the next uninstall tries again"
            ),
        },
    }
}

/// `VOID SendSAS(BOOL AsUser)` — the entire supported API for this.
type SendSasFn = unsafe extern "system" fn(BOOL);

/// Resolve `SendSAS` from `sas.dll`, System32 only.
///
/// `LoadLibraryExW` + `LOAD_LIBRARY_SEARCH_SYSTEM32`, never a bare
/// `LoadLibrary`: this process is LocalSystem, and the application directory
/// sitting ahead of System32 in the default search order turns a planted
/// `sas.dll` into SYSTEM code execution. `main.rs` already calls
/// `dll_search::harden()` for the same reason; this is the belt to that's
/// braces, because a load that names its own search path cannot be undone by
/// anything that runs later.
///
/// The library handle is deliberately never freed: unloading a DLL whose
/// function pointer we may still hand out is how a use-after-free happens, and
/// one leaked module handle for the life of a service costs nothing.
fn resolve_send_sas() -> Result<SendSasFn, String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    unsafe {
        let module = LoadLibraryExW(w!("sas.dll"), HANDLE::default(), LOAD_LIBRARY_SEARCH_SYSTEM32)
            .map_err(|e| format!("this Windows install has no sas.dll in System32 ({e})"))?;
        let proc = GetProcAddress(module, s!("SendSAS"))
            .ok_or_else(|| "sas.dll does not export SendSAS".to_string())?;
        Ok(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            SendSasFn,
        >(proc))
    }
}

/// Raise the SAS, given the machine policy and a way to call `SendSAS`.
///
/// THE SEAM. `entry` is a parameter so the unit tests can drive every refusal —
/// and the success path — without ever calling the real `SendSAS`, which would
/// throw the secure desktop over whatever the person at this machine was doing.
/// A test suite that can only exercise the failures is one where the interesting
/// half is untested; a test suite that exercises the success by really doing it
/// is one nobody will run twice.
///
/// ORDER MATTERS: the policy is checked BEFORE the entry point is used. With the
/// policy unset `SendSAS` is a silent no-op returning `void`, so calling it
/// first and then reporting success is precisely the failure this module was
/// written to remove.
pub fn raise_with<F: FnOnce()>(
    policy_value: Option<u32>,
    entry: Result<F, String>,
) -> Result<(), String> {
    if !policy_permits_services(policy_value) {
        return Err(match policy_value {
            None => POLICY_NOT_SET.to_string(),
            // 0 included: "None" is a choice (see policy_action), not an absence.
            Some(v) => format!(
                "Ctrl+Alt+Del cannot be raised: the SoftwareSASGeneration policy on this \
                 computer is set to {v}, which does not allow a service to do it. An \
                 administrator chose that setting, so it has not been changed.",
            ),
        });
    }
    let entry = entry?;
    entry();
    // `SendSAS` returns void: this says the call was made with the policy in
    // place, which is as much as Windows will ever tell us. It does NOT claim
    // the secure desktop appeared.
    Ok(())
}

/// The refusal when nothing has enabled software SAS at all.
///
/// A named constant because it is asserted on from two crates' tests and shown
/// to a person: this is the string that has to send someone somewhere useful
/// rather than leaving them clicking a button that does nothing.
pub const POLICY_NOT_SET: &str =
    "Ctrl+Alt+Del cannot be raised: the SoftwareSASGeneration policy is not set on this \
     computer, so Windows ignores software requests for the secure attention sequence. The \
     Puca service normally sets this when it starts — check the service log.";

/// Raise the SAS for real.
pub fn raise() -> Result<(), String> {
    let entry = resolve_send_sas().map(|f| {
        move || unsafe {
            // FALSE = "not as the user": the documented value for a service
            // raising the sequence on the console. TRUE is for a process already
            // running in the user's session and is not what this is.
            f(BOOL(0))
        }
    });
    raise_with(policy(), entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A stand-in for `SendSAS` that records the call instead of making it.
    fn spy(flag: &Cell<bool>) -> impl FnOnce() + '_ {
        move || flag.set(true)
    }

    #[test]
    fn only_the_values_that_include_services_are_accepted() {
        // 2 is "Ease of Access applications" — a real setting that does NOT
        // include a service. Reading it as good enough would produce a request
        // that is accepted and then does nothing, which is the shape of bug this
        // module exists to remove.
        assert!(policy_permits_services(Some(1)));
        assert!(policy_permits_services(Some(3)));
        assert!(!policy_permits_services(Some(0)));
        assert!(!policy_permits_services(Some(2)));
        assert!(!policy_permits_services(None));
        assert!(!policy_permits_services(Some(99)));
    }

    #[test]
    fn an_unset_policy_is_written_and_an_administrators_choice_is_not() {
        assert_eq!(policy_action(None), PolicyAction::Write);
        // Already ours, or already good: nothing to do.
        assert_eq!(policy_action(Some(1)), PolicyAction::LeaveAlone(1));
        assert_eq!(policy_action(Some(3)), PolicyAction::LeaveAlone(3));
        // THE ONE THAT MATTERS. 2 means somebody deliberately enabled software
        // SAS for Ease of Access only. Overwriting it with 1 would fix this
        // feature by breaking an accessibility tool, silently.
        assert_eq!(policy_action(Some(2)), PolicyAction::LeaveAlone(2));
        // 0 is NOT "unset". It is what the group policy writes for "None" —
        // an administrator saying no software may raise the SAS. The first
        // version overwrote it with 1, which is a LocalSystem service quietly
        // re-enabling something an administrator switched off.
        assert_eq!(policy_action(Some(0)), PolicyAction::LeaveAlone(0));
    }

    #[test]
    fn uninstall_removes_only_the_value_this_code_wrote() {
        // No marker: never ours, whatever the value says.
        assert_eq!(removal_action(None, Some(1)), RemovalAction::NotOurs);
        assert_eq!(removal_action(Some(0), Some(1)), RemovalAction::NotOurs);
        // Ours and untouched since: remove.
        assert_eq!(removal_action(Some(1), Some(1)), RemovalAction::Remove);
        // Ours, but already gone: only the marker is stale.
        assert_eq!(removal_action(Some(1), None), RemovalAction::AlreadyGone);
        // Ours, but somebody changed it after install (an administrator, a
        // GPO). Deleting THEIR value on the way out — which the first version
        // did, deleting whatever was there — would silently break whatever
        // they set it for.
        assert_eq!(removal_action(Some(1), Some(3)), RemovalAction::ChangedSince(3));
        assert_eq!(removal_action(Some(1), Some(0)), RemovalAction::ChangedSince(0));
    }

    #[test]
    fn a_machine_without_the_policy_refuses_rather_than_pretending() {
        // THE HEADLINE BEHAVIOUR. `SendSAS` returns void, so with the policy
        // unset it is a no-op indistinguishable from success. Calling it anyway
        // and answering Ok would rebuild the exact lie this replaces.
        let called = Cell::new(false);
        let err = raise_with(None, Ok(spy(&called))).expect_err("no policy must be a refusal");
        assert!(!called.get(), "SendSAS must not be called when it can only be a no-op");
        assert_eq!(err, POLICY_NOT_SET);
        assert!(err.contains("SoftwareSASGeneration"), "the refusal must name the setting: {err}");

        let called = Cell::new(false);
        assert!(raise_with(Some(0), Ok(spy(&called))).is_err());
        assert!(!called.get());
    }

    #[test]
    fn an_ease_of_access_only_policy_says_so_instead_of_blaming_itself() {
        let called = Cell::new(false);
        let err = raise_with(Some(2), Ok(spy(&called))).expect_err("2 excludes services");
        assert!(!called.get());
        assert!(err.contains('2'), "must say what the policy actually is: {err}");
        assert!(
            err.contains("administrator"),
            "must say why it was not simply changed: {err}"
        );
        // And it must NOT be the generic "not set" message, or the two
        // conditions send a reader to the same wrong place.
        assert_ne!(err, POLICY_NOT_SET);
    }

    #[test]
    fn a_missing_entry_point_is_reported_rather_than_swallowed() {
        let err = raise_with(Some(1), Err::<fn(), _>("no sas.dll".to_string()))
            .expect_err("an unresolvable SendSAS must not read as success");
        assert!(err.contains("no sas.dll"), "{err}");
    }

    #[test]
    fn with_the_policy_in_place_the_call_is_actually_made() {
        // THE POSITIVE CONTROL. Every refusal above would pass against a
        // `raise_with` that returned Err unconditionally — which would leave the
        // feature dead in exactly the way it is dead today, and no test would
        // notice.
        for value in [1u32, 3] {
            let called = Cell::new(false);
            assert!(raise_with(Some(value), Ok(spy(&called))).is_ok(), "policy {value}");
            assert!(called.get(), "policy {value}: SendSAS was never called");
        }
    }

    #[test]
    fn the_policy_is_read_from_the_machine_without_panicking() {
        // Not an assertion about THIS machine — the suite must pass whether or
        // not the service has ever run here. What it pins is that the read
        // completes on a real registry and returns something interpretable,
        // which is where the unsafe query would fail.
        let v = policy();
        println!("SoftwareSASGeneration on this machine: {v:?}");
        // Absent, or one of the four policy values. Anything else is noise from
        // a wrong-sized or wrong-typed read — the one thing this test can
        // actually catch on a machine whose setting it does not control.
        assert!(
            matches!(v, None | Some(0..=3)),
            "SoftwareSASGeneration read back as {v:?}, which is not a policy value"
        );
    }

    #[test]
    fn the_outcome_lines_say_different_things() {
        // These three go into the service log and are the only record of why
        // Ctrl+Alt+Del does or does not work on a machine nobody can reach.
        let lines = [
            PolicyOutcome::Wrote.to_string(),
            PolicyOutcome::Kept(2).to_string(),
            PolicyOutcome::Kept(1).to_string(),
            PolicyOutcome::Failed("access denied".into()).to_string(),
        ];
        for (i, a) in lines.iter().enumerate() {
            for b in lines.iter().skip(i + 1) {
                assert_ne!(a, b, "two different outcomes must not log the same line");
            }
        }
        assert!(lines[1].contains("may NOT"), "a useless policy must say so: {}", lines[1]);
        assert!(lines[3].contains("access denied"), "{}", lines[3]);
    }
}
