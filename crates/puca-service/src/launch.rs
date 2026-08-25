//! Windows launch layer — start an agent in a session, as SYSTEM or as the user.
//!
//! Factored from spike S5, which proved the SYSTEM-in-session path LIVE: a
//! process launched this way followed the input desktop onto Winlogon and
//! captured the secure desktop. The two entry points differ only in WHOSE token
//! the child runs under:
//!
//!   * [`launch_as_system_in_session`] — SYSTEM in the interactive session.
//!     Reaches the login/lock/secure desktop. Used for `SystemInteractive`.
//!
//! A `launch_as_user_in_session` (via `WTSQueryUserToken`) lived here too and
//! was DELETED: the service no longer runs anything while a user is signed in
//! and unlocked — the desktop app owns its own agent in that state. Removing
//! it also removed the only reason the service had to hand a launch secret to
//! a user-session process, which is what forced that secret onto disk in a
//! world-readable directory.
//!
//! Both put the child on `winsta0\default` and let the agent do its own
//! desktop-following from there. Both require the caller to be SYSTEM with
//! `SeTcbPrivilege` — which the service is — and neither is reachable from an
//! ordinary process, which is the point.
//!
//! Only the command-line construction is unit-tested here; the token calls can
//! only be exercised against a live SCM-launched service (the S5 spike is that
//! exercise for the SYSTEM path).

use std::ffi::c_void;
use std::path::Path;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WIN32_ERROR};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LookupPrivilegeValueW, SetTokenInformation,
    SecurityImpersonation, TokenPrimary, TokenSessionId, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    TOKEN_ACCESS_MASK, TOKEN_ADJUST_PRIVILEGES, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
    SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
use windows::Win32::System::SystemServices::MAXIMUM_ALLOWED;
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, TerminateProcess,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
    STARTUPINFOW,
};
use windows::Win32::Foundation::LUID;

/// The interactive window station + desktop every agent starts on.
///
/// STARTS on — it does not stay there. This comment has now been wrong in
/// both directions, which is worth recording: it first over-claimed
/// ("re-attaches to Winlogon automatically" when nothing did), was corrected
/// to "NOTHING IMPLEMENTS THAT, the agent stays on default for its whole
/// life" — and then 0.8.81 built exactly that capability and the correction
/// became the false premise. Current truth: the agent's input and capture
/// paths both re-attach their threads via
/// `puca_input::desktop::follow_input_desktop()` (OpenInputDesktop +
/// SetThreadDesktop) — input on a refused SendInput, capture on AccessLost,
/// periodically while blocked (`stream.rs`). The launcher's job is only the
/// starting point; the agent follows the input desktop from there.
const INTERACTIVE_DESKTOP: &str = "winsta0\\default";

/// A launched agent process. Closing the handles on drop keeps the service from
/// leaking a handle per session change over a long uptime.
pub struct AgentProcess {
    process: HANDLE,
    thread: HANDLE,
    pub pid: u32,
    pub session: u32,
    /// How to reach this agent. Remembered because the desktop app has to be
    /// told both to drive the lock screen, and the service is the only party
    /// that knows them — they exist nowhere on disk by design.
    pub pipe: String,
    pub token: String,
}

impl AgentProcess {
    /// Has the agent exited? A dead agent is how the service learns a session
    /// ended unexpectedly (crash, kill) and should be relaunched.
    pub fn is_alive(&self) -> bool {
        // 0 == WAIT_OBJECT_0 (signalled = exited); 0x102 == WAIT_TIMEOUT
        // (still running). Anything else (WAIT_FAILED) we treat as "gone".
        unsafe { WaitForSingleObject(self.process, 0).0 == 0x00000102 }
    }

    /// Stop the agent. Best-effort: on teardown the process may already be gone.
    pub fn terminate(&self) {
        unsafe {
            let _ = TerminateProcess(self.process, 1);
        }
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.process);
            let _ = CloseHandle(self.thread);
        }
    }
}

/// The active console session, or `None` when there is none to target
/// (`0xFFFFFFFF` — no console attached — or session 0, which is the isolated
/// service session and never an interactive target).
pub fn active_console_session() -> Option<u32> {
    let s = unsafe { WTSGetActiveConsoleSessionId() };
    if s == 0xFFFF_FFFF || s == 0 {
        None
    } else {
        Some(s)
    }
}

/// Quote one argument for a Windows command line, per the CommandLineToArgvW
/// rules the CRT and `std` both follow.
///
/// Backslashes are literal EXCEPT before a quote: a run of N backslashes then a
/// quote needs 2N+1 backslashes so the quote survives as data. Getting this
/// wrong turns a path like `C:\a\` at the end of a quoted arg into an escaped
/// closing quote and swallows the next argument — a classic, ugly bug.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"', '\n', '\u{0b}']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
            }
            '"' => {
                // Double the pending backslashes, then one more to escape ".
                out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(backslashes));
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    // Trailing backslashes precede the closing quote: double them so none of
    // them escapes it.
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
    out
}

/// Build a full command line: quoted exe followed by quoted args.
pub fn build_command_line(exe: &Path, args: &[&str]) -> String {
    let mut parts = vec![quote_arg(&exe.to_string_lossy())];
    parts.extend(args.iter().map(|a| quote_arg(a)));
    parts.join(" ")
}

/// The value following `flag` in an argv slice, or empty if absent.
///
/// Used to record what a launched agent was actually told, rather than trusting
/// a second copy of the same fact.
fn after_flag(args: &[&str], flag: &str) -> String {
    args.iter()
        .position(|a| *a == flag)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.to_string())
        .unwrap_or_default()
}

fn to_wide_nul(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Enable a named privilege on our own token; returns whether it ended enabled.
/// `CreateProcessAsUserW` checks `SeAssignPrimaryToken`/`SeIncreaseQuota` on the
/// caller, and a real SYSTEM service holds them — but holding is not enabling,
/// so enable defensively and report.
fn enable_privilege(name: windows::core::PCWSTR) -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .is_err()
        {
            return false;
        }
        let mut luid = LUID::default();
        let mut ok = false;
        if LookupPrivilegeValueW(None, name, &mut luid).is_ok() {
            let tp = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
            };
            ok = AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None).is_ok()
                && GetLastError() == WIN32_ERROR(0);
        }
        let _ = CloseHandle(token);
        ok
    }
}

/// Launch `exe` with `args` under `token` in `session`, on the interactive
/// desktop. Shared by both entry points; `token` is the only difference.
///
/// `use_user_env` builds the user's environment block (correct profile paths for
/// a user agent); for the SYSTEM agent the service environment is inherited.
unsafe fn spawn_with_token(
    token: HANDLE,
    session: u32,
    exe: &Path,
    args: &[&str],
    use_user_env: bool,
) -> Result<AgentProcess, String> {
    enable_privilege(SE_ASSIGNPRIMARYTOKEN_NAME);
    enable_privilege(SE_INCREASE_QUOTA_NAME);

    let mut cmd = to_wide_nul(&build_command_line(exe, args));
    let mut desktop = to_wide_nul(INTERACTIVE_DESKTOP);

    let mut si = STARTUPINFOW {
        cb: core::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    si.lpDesktop = PWSTR(desktop.as_mut_ptr());
    let mut pi = PROCESS_INFORMATION::default();

    // Optional user-profile environment. Without it a user agent inherits the
    // SERVICE's (SYSTEM's) %APPDATA%/%TEMP%, which is the wrong profile.
    let mut env_block: *mut c_void = core::ptr::null_mut();
    let mut flags = CREATE_NO_WINDOW;
    if use_user_env && CreateEnvironmentBlock(&mut env_block, token, false).is_ok() {
        flags |= CREATE_UNICODE_ENVIRONMENT;
    } else {
        env_block = core::ptr::null_mut();
    }

    let created = CreateProcessAsUserW(
        token,
        None,
        PWSTR(cmd.as_mut_ptr()),
        None,
        None,
        false,
        flags,
        if env_block.is_null() { None } else { Some(env_block) },
        None,
        &si,
        &mut pi,
    );

    if !env_block.is_null() {
        let _ = DestroyEnvironmentBlock(env_block);
    }

    created.map_err(|e| format!("CreateProcessAsUser failed for session {session}: {e}"))?;
    Ok(AgentProcess {
        process: pi.hProcess,
        thread: pi.hThread,
        pid: pi.dwProcessId,
        session,
        // Recovered from the argv we were handed rather than passed separately,
        // so the recorded values are BY CONSTRUCTION the ones the child was
        // actually started with. Passing them alongside would let the two drift
        // and hand the app a pipe name the agent never opened.
        pipe: after_flag(args, "--pipe"),
        token: after_flag(args, "--token"),
    })
}

/// Start an agent as **SYSTEM in the interactive session** — the S5 path. Reaches
/// the login/lock/secure desktop.
pub fn launch_as_system_in_session(
    session: u32,
    exe: &Path,
    args: &[&str],
) -> Result<AgentProcess, String> {
    unsafe {
        let mut src = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &mut src)
            .map_err(|e| format!("OpenProcessToken(self) failed: {e}"))?;

        let mut dup = HANDLE::default();
        let r = DuplicateTokenEx(
            src,
            TOKEN_ACCESS_MASK(MAXIMUM_ALLOWED),
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut dup,
        );
        if let Err(e) = r {
            let _ = CloseHandle(src);
            return Err(format!("DuplicateTokenEx failed: {e}"));
        }

        // Retarget the SYSTEM token at the interactive session.
        let sid = session;
        if let Err(e) = SetTokenInformation(
            dup,
            TokenSessionId,
            &sid as *const u32 as *const c_void,
            core::mem::size_of::<u32>() as u32,
        ) {
            let _ = CloseHandle(dup);
            let _ = CloseHandle(src);
            return Err(format!("SetTokenInformation(session {session}) failed: {e}"));
        }

        let out = spawn_with_token(dup, session, exe, args, false);
        let _ = CloseHandle(dup);
        let _ = CloseHandle(src);
        out
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_plain_arg_is_not_quoted() {
        assert_eq!(quote_arg("--seconds"), "--seconds");
        assert_eq!(quote_arg("90"), "90");
    }

    #[test]
    fn an_arg_with_spaces_is_quoted() {
        assert_eq!(quote_arg("hello world"), "\"hello world\"");
    }

    #[test]
    fn an_empty_arg_becomes_an_empty_quoted_string() {
        // An empty arg unquoted would VANISH from argv, shifting every later
        // argument by one. It must survive as "".
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn a_trailing_backslash_inside_quotes_is_doubled() {
        // C:\path\ as a quoted arg: the trailing backslash must not escape the
        // closing quote, or the next argument is swallowed. Round-trips to a
        // single backslash under CommandLineToArgvW.
        assert_eq!(quote_arg("C:\\path with space\\"), "\"C:\\path with space\\\\\"");
    }

    #[test]
    fn an_embedded_quote_is_escaped() {
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn backslashes_before_an_embedded_quote_are_doubled_plus_one() {
        // Two backslashes then a quote -> 2*2+1 = 5 backslashes then the quote.
        assert_eq!(quote_arg("a\\\\\"b"), "\"a\\\\\\\\\\\"b\"");
    }

    #[test]
    fn a_command_line_quotes_the_exe_and_each_arg() {
        let exe = PathBuf::from("C:\\Program Files\\Sovereign\\agent.exe");
        let cmd = build_command_line(&exe, &["--session", "2", "--token", "ab cd"]);
        assert_eq!(
            cmd,
            "\"C:\\Program Files\\Sovereign\\agent.exe\" --session 2 --token \"ab cd\"",
        );
    }

    #[test]
    fn build_command_line_leaves_simple_args_bare() {
        let exe = PathBuf::from("agent.exe");
        assert_eq!(build_command_line(&exe, &["--hidden"]), "agent.exe --hidden");
    }
}
