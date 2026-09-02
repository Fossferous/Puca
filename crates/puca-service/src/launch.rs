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

/// This process's environment plus one extra variable, as the UTF-16,
/// double-NUL-terminated block `CreateProcessAsUserW` wants.
///
/// BUILT rather than inherited, because there is no way to ADD a variable to an
/// inherited environment and the launch token has to travel somewhere that is
/// not the command line — see [`crate::AGENT_TOKEN_ENV`] for why.
///
/// `encode_wide` rather than `to_string_lossy`: an environment value that is
/// not valid UTF-16 must reach the child unchanged, and a lossy conversion
/// would corrupt it silently. Sorted because that is what the API documents;
/// Windows is forgiving about it in practice, and depending on forgiveness is
/// how a launch works on one machine and not another.
fn env_block_with(name: &str, value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut entries: Vec<Vec<u16>> = Vec::new();
    for (k, v) in std::env::vars_os() {
        // Ours wins if the parent already carries one by this name, rather
        // than the child seeing two entries and the OS choosing.
        if k.to_string_lossy().eq_ignore_ascii_case(name) {
            continue;
        }
        let mut e: Vec<u16> = k.encode_wide().collect();
        e.push(u16::from(b'='));
        e.extend(v.encode_wide());
        entries.push(e);
    }
    let mut mine: Vec<u16> = name.encode_utf16().collect();
    mine.push(u16::from(b'='));
    mine.extend(value.encode_utf16());
    entries.push(mine);

    entries.sort();
    let mut out = Vec::new();
    for e in entries {
        out.extend(e);
        out.push(0);
    }
    // The block ends with an empty string, i.e. a second NUL.
    out.push(0);
    out
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
    secret_env: Option<(&str, &str)>,
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
    let mut user_block: *mut c_void = core::ptr::null_mut();
    let mut env_block: *mut c_void = core::ptr::null_mut();
    let mut flags = CREATE_NO_WINDOW;
    if use_user_env && CreateEnvironmentBlock(&mut user_block, token, false).is_ok() {
        flags |= CREATE_UNICODE_ENVIRONMENT;
        env_block = user_block;
    } else {
        user_block = core::ptr::null_mut();
    }

    // THE LAUNCH SECRET RIDES THE ENVIRONMENT, NOT ARGV. Process-create
    // auditing and EDR record full command lines and ship them off the box;
    // they do not record environment blocks by default. Built from OUR
    // environment, which is what the SYSTEM agent would otherwise have
    // inherited, so nothing else about the child changes.
    //
    // The user-profile block is not combined with it: the only live caller is
    // the SYSTEM path (`launch_as_user_in_session` was deleted), so there is no
    // case to combine, and inventing one silently would be worse than the
    // assertion below.
    let secret_block: Vec<u16>;
    if let Some((name, value)) = secret_env {
        debug_assert!(
            !use_user_env,
            "a user-profile environment block and a launch secret are not combined",
        );
        secret_block = env_block_with(name, value);
        env_block = secret_block.as_ptr() as *mut c_void;
        flags |= CREATE_UNICODE_ENVIRONMENT;
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

    if !user_block.is_null() {
        let _ = DestroyEnvironmentBlock(user_block);
    }

    created.map_err(|e| format!("CreateProcessAsUser failed for session {session}: {e}"))?;
    Ok(AgentProcess {
        process: pi.hProcess,
        thread: pi.hThread,
        pid: pi.dwProcessId,
        session,
        // Recovered from the argv we were handed rather than passed separately,
        // so the recorded value is BY CONSTRUCTION the one the child was
        // actually started with. Passing it alongside would let the two drift
        // and hand the app a pipe name the agent never opened.
        pipe: after_flag(args, "--pipe"),
        // The token is no longer IN argv, so it comes from the same tuple the
        // environment block was built from — the same "one source" rule, moved
        // to where the value now lives.
        token: secret_env.map(|(_, v)| v.to_string()).unwrap_or_default(),
    })
}

/// Start an agent as **SYSTEM in the interactive session** — the S5 path. Reaches
/// the login/lock/secure desktop.
///
/// `secret_env` is the launch token, handed over as `(NAME, VALUE)` for the
/// child's environment block rather than as an argv pair — see
/// [`crate::AGENT_TOKEN_ENV`].
pub fn launch_as_system_in_session(
    session: u32,
    exe: &Path,
    args: &[&str],
    secret_env: Option<(&str, &str)>,
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

        let out = spawn_with_token(dup, session, exe, args, false, secret_env);
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

    /// The environment block is the place the token DOES appear, and it has to
    /// be well formed or `CreateProcessAsUserW` fails with a useless error.
    #[test]
    fn the_environment_block_carries_the_secret_and_is_terminated() {
        let block = env_block_with("PUCA_AGENT_TOKEN", "abc123");
        let text = String::from_utf16_lossy(&block);
        assert!(text.contains("PUCA_AGENT_TOKEN=abc123"));
        assert_eq!(block[block.len() - 1], 0, "the block ends with a NUL");
        assert_eq!(block[block.len() - 2], 0, "preceded by the entry's own NUL");

        // Sorted, as the API documents. Depending on Windows being forgiving
        // is how a launch works on one machine and not another.
        let mut entries: Vec<Vec<u16>> = Vec::new();
        let mut cur: Vec<u16> = Vec::new();
        for &u in &block {
            if u == 0 {
                if cur.is_empty() {
                    break;
                }
                entries.push(std::mem::take(&mut cur));
            } else {
                cur.push(u);
            }
        }
        let mut sorted = entries.clone();
        sorted.sort();
        assert_eq!(entries, sorted, "the block must be sorted");

        // And exactly one entry for our name, even though the parent may have
        // one already — two would let the OS pick.
        let mine = entries
            .iter()
            .filter(|e| String::from_utf16_lossy(e).starts_with("PUCA_AGENT_TOKEN="))
            .count();
        assert_eq!(mine, 1);
    }
}
