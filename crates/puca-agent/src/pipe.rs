//! Named-pipe transport (Windows).
//!
//! Newline-delimited JSON, one request per line, one response per line. Kept
//! deliberately dumb: every authorization decision lives in `session::Agent`, so
//! the transport cannot accidentally become a second place where access is
//! granted.
//!
//! The pipe is created with an explicit security descriptor rather than the
//! default. The default DACL would let any process in the user's session
//! connect — and this process injects OS input, so "any local process" is too
//! wide a door even before the token check.

use crate::protocol::{Request, Response};
use crate::session::Agent;
use std::io::{BufRead, BufReader, Write};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_WAIT,
};

/// Owner + SYSTEM only. Notably NOT "everyone" and not "authenticated users":
/// this process injects OS input, so the pipe must not be reachable by another
/// account on a shared machine even before the token is checked.
const PIPE_SDDL: &str = "D:(A;;GA;;;OW)(A;;GA;;;SY)";

/// The same, plus ONE named account.
///
/// Used only by a service-launched SYSTEM agent, and only for the SID the
/// SERVICE chose — the user signed in at the console, whom the service has
/// already established is a local administrator. The agent never takes this
/// from a remote peer or infers it; it is told, by the only party that can
/// launch it at all.
///
/// A SID is not a secret and a command line is readable by any local user, so
/// nothing is leaked by passing it that way. Nor is there an escalation in a
/// user launching their own agent with their own SID: that agent runs as them
/// and grants them their own privileges.
///
/// This is what makes the lock screen reachable. The agent's pipe was SYSTEM-only
/// — correct while the app launched its own agent, and an impasse once the thing
/// that can see Winlogon must be a different process from the thing that knows
/// whether a session is authorised.
fn pipe_sddl_for(allow_sid: Option<&str>) -> String {
    match allow_sid {
        None => PIPE_SDDL.to_string(),
        Some(sid) => format!("{PIPE_SDDL}(A;;GA;;;{sid})"),
    }
}

/// The only legal prefix for a Windows named pipe: two backslashes, a dot, then
/// `\pipe\`. Named rather than spelled out at each use because getting it wrong
/// by one backslash yields ERROR_INVALID_NAME (os error 123), which reads as
/// "the name is bad" and looks nothing like "you miscounted an escape".
pub const PIPE_PREFIX: &str = r"\\.\pipe\";

struct PipeHandle(HANDLE);

impl Drop for PipeHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = DisconnectNamedPipe(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

/// Blocking read/write wrapper so BufReader can drive the pipe.
struct PipeIo(HANDLE);

impl std::io::Read for PipeIo {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut read = 0u32;
        unsafe {
            ReadFile(self.0, Some(buf), Some(&mut read), None)
                .map_err(|e| std::io::Error::other(format!("{e}")))?;
        }
        Ok(read as usize)
    }
}

impl std::io::Write for PipeIo {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut written = 0u32;
        unsafe {
            WriteFile(self.0, Some(buf), Some(&mut written), None)
                .map_err(|e| std::io::Error::other(format!("{e}")))?;
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        unsafe {
            let _ = FlushFileBuffers(self.0);
        }
        Ok(())
    }
}

fn create_pipe(name: &str, allow_sid: Option<&str>) -> Result<PipeHandle, String> {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(pipe_sddl_for(allow_sid).as_str()),
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|e| format!("could not build the pipe security descriptor: {e}"))?;
    }

    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: false.into(),
    };

    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            // FIRST_PIPE_INSTANCE makes this call FAIL if the name is already
            // taken, instead of quietly joining an existing pipe. Without it any
            // local process can create this name first and become "the agent":
            // the real one then finds the name in use, and whatever connects
            // next is talking to the squatter. Failing loudly is the only safe
            // outcome — a pipe we did not create is not ours to serve on.
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            // ONE instance. A second concurrent driver of the same agent is not
            // a feature — it is two callers fighting over one mouse.
            1,
            64 * 1024,
            64 * 1024,
            0,
            Some(&sa),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        // WITH the OS error. Without it this said only "could not create the
        // pipe", so a machine where the agent could not start looked identical
        // to one with no agent installed — and the visible symptom was the
        // browser's screen picker appearing, which reads as a feature rather
        // than a fault. That cost five rounds of guessing.
        return Err(format!(
            "could not create the pipe {name}: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(PipeHandle(handle))
}

/// Serve one client at a time, forever.
///
/// When a client disconnects the agent waits for the next rather than exiting.
/// That is now a convenience, not a safety property: since --parent-pid the
/// agent dies with the app anyway, and it could never have kept an unattended
/// machine reachable on its own — it holds no socket and authorises nothing, so
/// an agent whose app has died has nobody to accept a session for it. The
/// original comment claimed otherwise and justified reusing one Agent across
/// clients, which is exactly what broke reconnection.
pub fn serve(
    name: &str,
    token: String,
    flavour: crate::flavour::Flavour,
    allow_sid: Option<&str>,
    ua_record: Option<&str>,
) -> Result<(), String> {
    loop {
        // A FRESH Agent per client, not one reused across connections.
        //
        // The old code built it once outside this loop, so `authenticated`
        // survived a client disconnecting — and session.rs answers a second
        // Hello with "already authenticated". The app's connect() reads that as
        // "the agent refused our token", agent_probe returns false, and the
        // Devices UI silently falls back to the browser's screen picker. So the
        // very case the comment below claims to support was broken: reconnecting
        // to a live agent could never succeed.
        //
        // Reproduced against the shipped binary:
        //   client 1 hello -> {"ok":"hello","version":1,"platform":"windows"}
        //   client 2 hello -> {"ok":"error","message":"already authenticated"}
        //
        // Rebuilding also drops the previous client's captures, sessions and
        // streams, which is what you want anyway: a new controller inheriting a
        // dead one's DXGI duplication is how one stray stream makes every later
        // session on that monitor fail.
        let mut agent = Agent::new(token.clone(), flavour);
        // Re-read per connection: see arm_from_record_file. A disarm must shut
        // the next session, not the next boot.
        if let Some(path) = ua_record {
            agent.arm_from_record_file(path);
        }
        let pipe = create_pipe(name, allow_sid)?;
        unsafe {
            // ERROR_PIPE_CONNECTED means a client raced in before we called
            // this — which is a successful connection, not a failure.
            let _ = ConnectNamedPipe(pipe.0, None);
        }

        let mut reader = BufReader::new(PipeIo(pipe.0));
        let mut writer = PipeIo(pipe.0);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,             // client went away
                Ok(_) => {}
                Err(_) => break,
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<Request>(trimmed) {
                Ok(req) => agent.handle(req),
                // Answer rather than dropping: a caller that gets silence
                // cannot tell a malformed request from a hung agent.
                Err(e) => Response::error(format!("bad request: {e}")),
            };

            let mut out = serde_json::to_string(&response)
                .unwrap_or_else(|_| r#"{"ok":"error","message":"could not encode response"}"#.into());
            out.push('\n');
            if writer.write_all(out.as_bytes()).is_err() {
                break;
            }
            let _ = writer.flush();
        }

        // A client that vanishes mid-session must not leave keys held down in
        // whatever application had focus.
        puca_input::release_all();
    }
}

#[cfg(all(windows, test))]
mod tests {
    use super::*;

    /// Can the agent create its own pipe AT ALL?
    ///
    /// It could not, on the machine that reported "screen sharing still not
    /// working": the agent printed "listening on ..." and then "could not create
    /// the pipe" and exited, so agent_probe failed and every session fell back to
    /// the browser's screen picker. Nothing tested this, because until 0.8.4 no
    /// installer shipped the agent — so the one component the feature depends on
    /// had no coverage of its very first syscall.
    #[test]
    fn creates_its_pipe_with_a_fresh_name() {
        // Built from PIPE_PREFIX, not written inline: the first version of this
        // test had a single leading backslash, so CreateNamedPipeW answered
        // ERROR_INVALID_NAME and the test "proved" the agent was broken when the
        // only broken thing was the test's own string.
        let name = format!("{}sovereign-agent-test-{}", PIPE_PREFIX, std::process::id());
        let pipe = create_pipe(&name, None);
        assert!(pipe.is_ok(), "create_pipe failed: {:?}", pipe.err());
    }

    /// FIRST_PIPE_INSTANCE means the SECOND create must fail while the first is
    /// held — that is the squatting protection added in 0.8.2. Asserting it here
    /// so the flag cannot be quietly dropped, and so its cost is visible: an
    /// orphaned agent holding the name will stop a new one starting.
    #[test]
    fn refuses_a_second_instance_of_the_same_name() {
        let name = format!("{}sovereign-agent-dup-{}", PIPE_PREFIX, std::process::id());
        let first = create_pipe(&name, None).expect("first create should succeed");
        let second = create_pipe(&name, None);
        assert!(second.is_err(), "a second instance must be refused");
        drop(first);
    }

    #[test]
    fn the_default_pipe_admits_only_its_owner_and_the_system() {
        // The shipped case, unchanged: an app-launched agent must stay
        // unreachable by any other account on a shared machine, even before the
        // token is checked.
        let sddl = pipe_sddl_for(None);
        assert_eq!(sddl, "D:(A;;GA;;;OW)(A;;GA;;;SY)");
        assert!(!sddl.contains(";IU)"), "interactive users must never be granted");
        assert!(!sddl.contains(";WD)"), "Everyone must never be granted");
        assert!(!sddl.contains(";AU)"), "Authenticated Users is far too broad");
        assert!(!sddl.contains(";BA)"), "Administrators as a GROUP is wider than one account");
    }

    #[test]
    fn a_named_account_is_added_without_widening_anything_else() {
        // The lock-screen case. Exactly ONE extra ACE, naming exactly the SID
        // the service chose — never a group. Granting BA, IU or AU here would
        // reach every administrator or every interactive account on the
        // machine, which is precisely the escalation the caller gate upstream
        // exists to prevent; widening it here would make that gate pointless.
        let sddl = pipe_sddl_for(Some("S-1-5-21-1-2-3-1001"));
        assert!(sddl.starts_with("D:(A;;GA;;;OW)(A;;GA;;;SY)"), "the base must survive: {sddl}");
        assert!(sddl.ends_with("(A;;GA;;;S-1-5-21-1-2-3-1001)"), "{sddl}");
        assert_eq!(sddl.matches("(A;").count(), 3, "exactly three ACEs: {sddl}");
        for group in [";IU)", ";WD)", ";AU)", ";BA)"] {
            assert!(!sddl.contains(group), "{group} must not appear: {sddl}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_generated_descriptor_is_one_windows_actually_accepts() {
        // A malformed SDDL does not fail loudly at the string level — it fails
        // when Windows parses it, at pipe-creation time, inside a service, on a
        // machine nobody is looking at. Parse it here instead.
        use windows::core::HSTRING;
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows::Win32::Security::PSECURITY_DESCRIPTOR;
        for sddl in [pipe_sddl_for(None), pipe_sddl_for(Some("S-1-5-18"))] {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    &HSTRING::from(sddl.as_str()),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
            };
            assert!(ok.is_ok(), "Windows rejected {sddl}: {ok:?}");
            if !sd.0.is_null() {
                unsafe {
                    let _ = windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(sd.0),
                    );
                }
            }
        }
    }
}
