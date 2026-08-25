//! Who is on the other end of the control pipe, and may they be told a secret?
//!
//! THE PROBLEM THIS SOLVES. The SYSTEM agent is the only thing that can see the
//! lock screen, and the desktop app is the only thing that knows whether a
//! remote session is authorised. They have to meet. The agent's pipe is
//! SYSTEM-only, so the app cannot reach it without being told the pipe name and
//! the launch token — and handing those to the wrong local process is handing
//! out SYSTEM-level control of the machine.
//!
//! WHY THE PIPE'S OWN ACL IS NOT THE ANSWER. `CONTROL_PIPE_SDDL` grants `IU`,
//! the interactive user — which on this machine includes two enabled non-admin
//! accounts. Granting SYSTEM reach to `IU` would be a real privilege escalation
//! across a boundary Microsoft does defend. So the ACL stays as the coarse
//! filter it is, and the decision is made here, per call, against the caller's
//! actual identity.
//!
//! THE RULE, and why it is the one drawn:
//!
//!   1. The caller must be the user of the CONSOLE session — the person
//!      physically at the machine whose lock screen this is. Not merely "an
//!      interactive user", which any fast-user-switched or service account can
//!      be.
//!   2. That user must be a local ADMINISTRATOR.
//!
//! Rule 2 is what keeps this from being an escalation rather than a
//! convenience. Microsoft's Security Servicing Criteria put administrators
//! inside the Trusted Computing Base: an admin can already become SYSTEM by
//! installing a service, so handing one a SYSTEM pipe crosses no boundary that
//! is defended. A STANDARD user becoming SYSTEM crosses one that is. If the
//! console user is not an administrator this refuses, and the lock-screen
//! feature is simply unavailable for that account — the correct trade.
//!
//! THE UAC TRAP, which is the easy way to get rule 2 wrong. A non-elevated
//! administrator's token carries the Administrators group marked
//! `SE_GROUP_USE_FOR_DENY_ONLY`, so `CheckTokenMembership` answers FALSE for a
//! user who is unambiguously an admin. Asking that question would refuse every
//! real caller, because the desktop app is deliberately not elevated. The
//! membership scan below therefore treats a deny-only Administrators entry as
//! present: the question is "is this ACCOUNT an administrator", not "is this
//! PROCESS currently elevated".

#![cfg(windows)]

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    CreateWellKnownSid, EqualSid, GetTokenInformation, TokenGroups, TokenUser,
    WinBuiltinAdministratorsSid, PSID, TOKEN_GROUPS, TOKEN_QUERY, TOKEN_USER,
};
// These live under SystemServices in windows 0.58, not Security, and are plain
// i32 rather than a newtype.
use windows::Win32::System::SystemServices::{SE_GROUP_ENABLED, SE_GROUP_USE_FOR_DENY_ONLY};
use windows::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;
use windows::Win32::System::Threading::{GetCurrentThread, OpenThreadToken};

/// A SID copied out of a token, so it outlives the token it came from.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Sid(Vec<u8>);

impl Sid {
    fn from_psid(p: PSID) -> Option<Self> {
        use windows::Win32::Security::{GetLengthSid, IsValidSid};
        unsafe {
            if p.0.is_null() || !IsValidSid(p).as_bool() {
                return None;
            }
            let len = GetLengthSid(p) as usize;
            let mut buf = vec![0u8; len];
            std::ptr::copy_nonoverlapping(p.0 as *const u8, buf.as_mut_ptr(), len);
            Some(Sid(buf))
        }
    }

    fn as_psid(&self) -> PSID {
        PSID(self.0.as_ptr() as *mut std::ffi::c_void)
    }

    /// The SDDL-ready textual form, for building the agent's pipe ACL.
    pub fn to_string_sid(&self) -> Option<String> {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
        let mut out = windows::core::PWSTR::null();
        unsafe {
            if ConvertSidToStringSidW(self.as_psid(), &mut out).is_err() || out.is_null() {
                return None;
            }
            let s = out.to_string().ok();
            let _ = LocalFree(HLOCAL(out.0 as *mut std::ffi::c_void));
            s
        }
    }

    /// S-1-5-18, the LocalSystem account. Compared as the well-known string
    /// form rather than by bytes so the intent is readable; the string form is
    /// canonical, so the comparison is exact.
    pub fn is_local_system(&self) -> bool {
        self.to_string_sid().as_deref() == Some("S-1-5-18")
    }
}

/// Close a handle on every exit, including the error paths.
struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Undo impersonation no matter how the caller leaves.
///
/// A thread left impersonating a client is a latent privilege bug: everything
/// it does afterwards runs as somebody else, and the service's next action
/// would silently be performed as the app's user.
struct Impersonation;
impl Drop for Impersonation {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Security::RevertToSelf();
        }
    }
}

/// The SID of whoever is connected to `pipe`.
pub fn caller_sid(pipe: HANDLE) -> Result<Sid, String> {
    unsafe {
        ImpersonateNamedPipeClient(pipe).map_err(|e| format!("cannot identify the caller: {e}"))?;
        let _revert = Impersonation;

        let mut token = HANDLE::default();
        OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token)
            .map_err(|e| format!("cannot open the caller's token: {e}"))?;
        let token = Owned(token);

        sid_of_token(token.0)
    }
}

/// The SID a token belongs to.
fn sid_of_token(token: HANDLE) -> Result<Sid, String> {
    unsafe {
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            return Err("token has no user information".into());
        }
        let mut buf = vec![0u8; needed as usize];
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut _),
            needed,
            &mut needed,
        )
        .map_err(|e| format!("cannot read the token user: {e}"))?;
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        Sid::from_psid(tu.User.Sid).ok_or_else(|| "token user SID is invalid".to_string())
    }
}

/// The SID of the user signed in at `session`, or None if nobody is.
pub fn console_user_sid(session: u32) -> Option<Sid> {
    unsafe {
        let mut token = HANDLE::default();
        // Fails with ERROR_NO_TOKEN when nobody is signed in — which is not an
        // error here, it is the sign-in-screen case, and the answer is simply
        // "there is no console user to trust".
        if WTSQueryUserToken(session, &mut token).is_err() {
            return None;
        }
        let token = Owned(token);
        sid_of_token(token.0).ok()
    }
}

/// Is the user signed in at `session` a local administrator?
///
/// Asked of the console user's own token rather than of a caller, so the pipe
/// ACL built at launch and the token gate enforced per request are deciding the
/// same thing about the same person. Two independent notions of "trusted" is
/// how one of them quietly becomes wider than the other.
pub fn console_user_is_administrator(session: u32) -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if WTSQueryUserToken(session, &mut token).is_err() {
            return false;
        }
        let token = Owned(token);
        token_is_administrator(token.0)
    }
}

/// Is this token's ACCOUNT an administrator?
///
/// Deliberately not `CheckTokenMembership`: see the UAC note in this module's
/// header. A deny-only Administrators entry means "an admin running
/// unelevated", which is exactly the shipped desktop app, and must answer yes.
pub fn token_is_administrator(token: HANDLE) -> bool {
    unsafe {
        let mut admins_buf = [0u8; 68]; // SECURITY_MAX_SID_SIZE
        let mut len = admins_buf.len() as u32;
        let admins = PSID(admins_buf.as_mut_ptr() as *mut std::ffi::c_void);
        if CreateWellKnownSid(WinBuiltinAdministratorsSid, PSID::default(), admins, &mut len)
            .is_err()
        {
            return false;
        }

        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenGroups, None, 0, &mut needed);
        if needed == 0 {
            return false;
        }
        let mut buf = vec![0u8; needed as usize];
        if GetTokenInformation(
            token,
            TokenGroups,
            Some(buf.as_mut_ptr() as *mut _),
            needed,
            &mut needed,
        )
        .is_err()
        {
            return false;
        }
        let groups = &*(buf.as_ptr() as *const TOKEN_GROUPS);
        let list =
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize);
        list.iter().any(|g| {
            let attrs = g.Attributes;
            let usable = attrs & SE_GROUP_ENABLED as u32 != 0
                || attrs & SE_GROUP_USE_FOR_DENY_ONLY as u32 != 0;
            usable && EqualSid(g.Sid, admins).is_ok()
        })
    }
}

/// Classify the caller on `pipe` for the policy layer.
///
/// Returns a verdict rather than a Result because "somebody else is on the
/// phone" is a normal outcome, not a fault, and the policy needs to tell the
/// two refusals apart to say something useful. Any failure to identify the
/// caller at all resolves to `NotConsoleUser`: the safe direction, since the
/// only thing this gates is handing out SYSTEM credentials.
pub fn classify(pipe: HANDLE, console_session: u32) -> crate::control::CallerTrust {
    use crate::control::CallerTrust;

    // LOGGED, because a refusal here is silent by design and this gate spent its
    // entire life refusing everyone without a single line to say so. The SIDs
    // are not secrets — they are account identifiers an admin can read from
    // `whoami /user` — and without them a mismatch is undiagnosable.
    let caller = match caller_sid(pipe) {
        Ok(c) => c,
        Err(e) => {
            crate::log::line(&format!("[caller] cannot identify the caller: {e}"));
            return CallerTrust::NotConsoleUser;
        }
    };
    // LocalSystem BEFORE the console-user comparison: pre-login there is no
    // console user to compare against, and that is precisely when the SYSTEM
    // sign-in-screen agent calls. Only `Sas` admits it (control.rs).
    if caller.is_local_system() {
        return CallerTrust::LocalSystem;
    }
    let Some(console) = console_user_sid(console_session) else {
        crate::log::line(&format!(
            "[caller] no console user for session {console_session}; refusing"
        ));
        return CallerTrust::NotConsoleUser;
    };
    if caller != console {
        crate::log::line(&format!(
            "[caller] caller {:?} is not the console user {:?} of session {console_session}",
            caller.to_string_sid(),
            console.to_string_sid()
        ));
        return CallerTrust::NotConsoleUser;
    }
    let admin = unsafe {
        if ImpersonateNamedPipeClient(pipe).is_err() {
            return CallerTrust::NotConsoleUser;
        }
        let _revert = Impersonation;
        let mut token = HANDLE::default();
        if OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token).is_err() {
            return CallerTrust::NotConsoleUser;
        }
        let token = Owned(token);
        token_is_administrator(token.0)
    };
    if admin {
        crate::log::line("[caller] console administrator — allowed");
        CallerTrust::ConsoleAdministrator
    } else {
        crate::log::line(
            "[caller] the console user is NOT a local administrator; refusing",
        );
        CallerTrust::NotAdministrator
    }
}

/// Whether the caller on `pipe` may be handed the SYSTEM agent's credentials.
///
/// Returns the caller's SID on success, because the agent's pipe ACL is then
/// built for exactly that account and nobody else.
pub fn authorise_agent_handoff(pipe: HANDLE, console_session: u32) -> Result<Sid, String> {
    let caller = caller_sid(pipe)?;
    let Some(console) = console_user_sid(console_session) else {
        return Err(
            "nobody is signed in at the console, so there is no user this could belong to".into(),
        );
    };
    if caller != console {
        return Err(
            "only the user signed in at this computer's own screen may drive the system agent"
                .into(),
        );
    }

    // Re-impersonate to inspect the caller's groups. Done as a second step
    // rather than folded into caller_sid so that each function does one thing
    // and the impersonation window stays as short as it can be.
    unsafe {
        ImpersonateNamedPipeClient(pipe).map_err(|e| format!("cannot identify the caller: {e}"))?;
        let _revert = Impersonation;
        let mut token = HANDLE::default();
        OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token)
            .map_err(|e| format!("cannot open the caller's token: {e}"))?;
        let token = Owned(token);
        if !token_is_administrator(token.0) {
            return Err(
                "this feature needs an administrator account: handing SYSTEM control to a \
                 standard user would be a privilege escalation, not a feature"
                    .into(),
            );
        }
    }
    Ok(caller)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sid_survives_the_token_it_came_from() {
        // The whole point of copying rather than borrowing: the token is closed
        // when `Owned` drops, and a PSID into it would dangle. This is the test
        // that would catch someone "optimising" the copy away.
        let me = unsafe {
            let mut t = HANDLE::default();
            windows::Win32::System::Threading::OpenProcessToken(
                windows::Win32::System::Threading::GetCurrentProcess(),
                TOKEN_QUERY,
                &mut t,
            )
            .expect("own token");
            let owned = Owned(t);
            sid_of_token(owned.0).expect("own SID")
        };
        // Token is closed. The SID must still be readable and printable.
        let s = me.to_string_sid().expect("printable");
        assert!(s.starts_with("S-1-"), "not a SID: {s}");
        assert_eq!(me, me.clone());
    }

    #[test]
    fn this_account_is_recognised_as_an_administrator_if_it_is_one() {
        // Not an assertion about THIS machine — it reports rather than demands,
        // because the suite must pass for a standard user too. What it does pin
        // is that the call completes and does not panic on a real token, which
        // is where the unsafe group walk would fail.
        let is_admin = unsafe {
            let mut t = HANDLE::default();
            windows::Win32::System::Threading::OpenProcessToken(
                windows::Win32::System::Threading::GetCurrentProcess(),
                TOKEN_QUERY,
                &mut t,
            )
            .expect("own token");
            let owned = Owned(t);
            token_is_administrator(owned.0)
        };
        println!("this account is an administrator: {is_admin}");

        // NOT asserted true unconditionally — the suite must pass for a
        // standard user, and this machine's answer is not the contract.
        //
        // What IS pinned: whatever it says, it must agree with a second,
        // independent reading of the same fact. A `token_is_administrator` that
        // always returned false would satisfy a bare "it did not panic" test
        // while refusing every real caller — and it would look exactly like the
        // UAC deny-only bug this function exists to avoid. VERIFIED under
        // --nocapture on an unelevated admin session: reports `true`, where
        // CheckTokenMembership reports false.
        let via_group_walk = is_admin;
        let elevated_now = unsafe {
            use windows::Win32::Security::{TokenElevation, TOKEN_ELEVATION};
            let mut t = HANDLE::default();
            windows::Win32::System::Threading::OpenProcessToken(
                windows::Win32::System::Threading::GetCurrentProcess(),
                TOKEN_QUERY,
                &mut t,
            )
            .expect("own token");
            let owned = Owned(t);
            let mut el = TOKEN_ELEVATION::default();
            let mut n = 0u32;
            let ok = GetTokenInformation(
                owned.0,
                TokenElevation,
                Some(&mut el as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut n,
            )
            .is_ok();
            ok && el.TokenIsElevated != 0
        };
        // The load-bearing implication: an ELEVATED process is always an
        // administrator. If elevation says yes and the group walk says no, the
        // walk is broken.
        if elevated_now {
            assert!(via_group_walk, "an elevated process must read as an administrator");
        }
    }

    #[test]
    fn there_is_no_console_user_for_a_session_that_does_not_exist() {
        // Session 0xFFFF is never a real console session. The honest answer is
        // None, not a panic and not a spurious SID — the sign-in-screen case
        // takes this same path and must be a clean "nobody".
        assert!(console_user_sid(0xFFFF).is_none());
    }

    /// THE TEST THAT WOULD HAVE CAUGHT THE GATE REFUSING EVERYONE.
    ///
    /// `ImpersonateNamedPipeClient` fails with ERROR_CANNOT_IMPERSONATE (1368)
    /// until the server has READ a message from the client. `control_pipe::serve`
    /// classified at connect time — its comment even boasted it ran "before a
    /// single byte of theirs has been read" — so identification always failed,
    /// `classify` fell to its safe default of NotConsoleUser, and the control
    /// pipe refused EVERY caller, including the console administrator it exists
    /// to admit.
    ///
    /// Nothing caught it: a refusal is a normal outcome, so nothing logged and
    /// no test failed. It surfaced only when a person clicked the toggle and it
    /// did nothing.
    ///
    /// This drives a REAL named pipe with a REAL client thread, and asserts both
    /// halves — that identification fails before a read, and succeeds after one.
    /// The first half is what pins the ordering requirement; without it a future
    /// edit could move classification back before the read and only this
    /// comment would object.
    #[test]
    fn the_caller_can_only_be_identified_after_reading_from_them() {
        use std::io::{BufRead, BufReader, Write};
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{PIPE_ACCESS_DUPLEX, FILE_FLAGS_AND_ATTRIBUTES};
        use windows::Win32::System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
        };

        // A pipe name unique to this test run, so a stale one cannot be joined.
        let name = format!(r"\\.\pipe\sovereign-imp-test-{}", std::process::id());
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

        let server = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                None,
            )
        };
        assert!(!server.is_invalid(), "could not create the test pipe");
        let server = Owned(server);

        // The client writes one line, then waits so the server can query it.
        let client_name = name.clone();
        let client = std::thread::spawn(move || {
            // Give the server a moment to reach ConnectNamedPipe.
            std::thread::sleep(std::time::Duration::from_millis(50));
            let mut f = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&client_name)
                .expect("client connects");
            f.write_all(b"{\"t\":\"status\"}\n").expect("client writes");
            f.flush().ok();
            std::thread::sleep(std::time::Duration::from_millis(400));
        });

        unsafe {
            let _ = ConnectNamedPipe(server.0, None);
        }

        // BEFORE any read: identification must fail. This is the half that
        // pins the ordering — it is the exact state the shipped code was in.
        let before = caller_sid(server.0);
        assert!(
            before.is_err(),
            "impersonation is expected to fail before a read; if Windows ever \
             allows it, the ordering comment in control_pipe::serve is stale"
        );

        // Read the client's message, exactly as serve() does.
        let mut reader = BufReader::new(std::fs::File::from(unsafe {
            use std::os::windows::io::FromRawHandle;
            std::fs::File::from_raw_handle(server.0 .0 as *mut _)
        }));
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        assert!(line.contains("status"), "server read: {line:?}");

        // AFTER the read: identification must succeed, and must name THIS
        // account — the test process is the client.
        let after = caller_sid(server.0).expect("the caller must be identifiable after a read");
        let me = unsafe {
            let mut t = HANDLE::default();
            windows::Win32::System::Threading::OpenProcessToken(
                windows::Win32::System::Threading::GetCurrentProcess(),
                TOKEN_QUERY,
                &mut t,
            )
            .expect("own token");
            let owned = Owned(t);
            sid_of_token(owned.0).expect("own SID")
        };
        assert_eq!(after, me, "the identified caller must be this test's own account");

        // Leak the handle rather than closing it twice: `reader` owns a File
        // built from the same raw handle and will close it on drop.
        std::mem::forget(server);
        let _ = client.join();
    }
}

