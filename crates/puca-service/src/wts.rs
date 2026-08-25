//! Small WTS (Terminal Services) queries the service needs to snapshot a
//! session's state.
//!
//! Only ONE fact is queried reliably here: whether a user is logged on in a
//! session, via `WTSQueryUserToken`. It is the load-bearing input to the
//! supervisor's flavour choice (user present -> User agent; nobody -> the SYSTEM
//! agent for the greeter).
//!
//! Lock state is deliberately NOT queried. The documented `WTSINFOEX` lock flag
//! is famously unreliable (inverted on some Windows 7 builds) and there is no
//! clean successor, so the service treats lock state as UNKNOWN at startup
//! (assumed unlocked) and learns the truth from the first `Lock`/`Unlock`
//! session-change event — which IS reliable. The agent also follows the input
//! desktop itself, so a momentarily wrong flavour self-corrects rather than
//! stranding the session.

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;

/// Is a user logged on in `session`? True iff we can obtain that session's user
/// token — which is exactly the condition under which the User-flavour agent can
/// be launched, so the answer is also a precondition check for the launch.
pub fn is_user_logged_on(session: u32) -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if WTSQueryUserToken(session, &mut token).is_ok() {
            let _ = CloseHandle(token);
            true
        } else {
            false
        }
    }
}
