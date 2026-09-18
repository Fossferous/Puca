//! Turning sign-in-screen access on, and off.
//!
//! WHAT THIS IS FOR. Every other remote-control path in this app needs the app
//! running, which means somebody has already signed in. This one is for the
//! machine that is sitting at its Windows sign-in screen — after a reboot, or
//! after being woken from off — where there is no app and no signed-in user.
//! Only the SYSTEM service can reach that, and only if the owner deliberately
//! turned it on.
//!
//! OFF BY DEFAULT, AND ABSENT RATHER THAN DISABLED. A machine that never enrols
//! has no config, no keys and no token, so the service's link thread finds
//! nothing and never opens a socket. `forget` puts it back exactly as it was.
//!
//! TWO SEPARATE SWITCHES, deliberately:
//!   * ENROLLED — this machine can be reached at its sign-in screen at all;
//!   * ARMED — a session there may be authorised by proving a passphrase.
//! Both are required for anything to happen. They are separate so that
//! disarming can shut the door without also tearing down the connection you
//! would need in order to re-arm it.
//!
//! WHY ENROLMENT IS TWO CALLS. Publishing a device into the account needs an
//! auth record signed by the ACCOUNT signing key, which is derived from the
//! account seed and must never reach a LocalSystem process holding an internet
//! socket. So the service generates the keypair and hands back only public
//! halves, the web layer signs a record describing them and enrols it, and the
//! service is then told the account's PUBLIC key — enough to verify other
//! devices, useless for enrolling any.

#![cfg(windows)]

use serde::Serialize;
use puca_service::control::{ControlRequest, CONTROL_PIPE};
use std::io::{BufRead, BufReader, Write};

/// Send one request to the service and read its reply.
///
/// Every call opens and closes the pipe. The service's control pipe is
/// request/response with no session state, and holding one open would mean a
/// UI toggle pinning a handle to a service that may restart under it.
fn ask(req: &ControlRequest) -> Result<serde_json::Value, String> {
    use std::os::windows::fs::OpenOptionsExt;
    // SECURITY_IDENTIFICATION, for the reason service_link::ask gives.
    const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
        .open(CONTROL_PIPE)
        .map_err(|_| "the Puca service is not installed on this computer".to_string())?;

    let mut writer = file
        .try_clone()
        .map_err(|e| format!("could not talk to the service: {e}"))?;
    let line = serde_json::to_string(req).map_err(|e| format!("could not encode: {e}"))?;
    writeln!(writer, "{line}").map_err(|e| format!("could not talk to the service: {e}"))?;
    writer.flush().ok();

    let mut reply = String::new();
    BufReader::new(file)
        .read_line(&mut reply)
        .map_err(|e| format!("the service did not answer: {e}"))?;

    let v: serde_json::Value = serde_json::from_str(reply.trim())
        .map_err(|_| "the service sent something unreadable".to_string())?;

    // A refusal carries the reason the service already worded for a person —
    // "only the user signed in at this computer's own screen can do this" — and
    // replacing it with a generic failure here would throw away the only part
    // that tells the user what to do.
    if v.get("t").and_then(|x| x.as_str()) == Some("refused") {
        return Err(v
            .get("reason")
            .and_then(|x| x.as_str())
            .unwrap_or("the service refused, without saying why")
            .to_string());
    }
    Ok(v)
}

#[derive(Serialize, Default)]
pub struct LockScreenState {
    /// Is the service present at all? Everything else is meaningless without it.
    pub service_installed: bool,
    pub enrolled: bool,
    pub armed: bool,
    /// The device row this machine is enrolled as at its sign-in screen, or
    /// None when it is not enrolled.
    ///
    /// THE APP USES THIS TO STOP SHOWING ONE PC AS TWO DEVICES, and to PATCH
    /// this row's LAN details so it can actually be woken — see
    /// `puca_service::link::enrolled_device_id`, which carries the full
    /// reasoning, and `frontend/src/api/devices/lanInfo.ts`, which consumes it.
    pub device_id: Option<String>,
    /// Fingerprint of the INSTALLED service+agent pair, reported by the
    /// running service itself. Compared against `service_bundled_fingerprint`
    /// to decide whether the running service predates this app — the app
    /// auto-updates, the service does not, and the skew is invisible until a
    /// control-pipe field the app relies on silently never arrives. Absent
    /// from an older service, which is itself the strongest "needs update".
    pub bins_hash: Option<String>,
    /// What the SERVER last said about the sign-in-screen link, from the
    /// service's link-health record (`puca_service::link::LinkHealth`), for
    /// the enrolled identity only. `enrolled` above is local files and reads
    /// true while the server refuses the machine; these are what can tell.
    /// All None from an older service, which the UI reads as "nothing to say".
    /// Unix seconds.
    pub link_attested_at: Option<i64>,
    pub link_refused_first: Option<i64>,
    pub link_refused_last: Option<i64>,
    pub link_refused_count: u32,
    pub link_refused_status: Option<u16>,
    /// Why the state could not be read, if it could not. Shown rather than
    /// swallowed: a toggle that silently renders "off" when it could not ask is
    /// how someone concludes a feature is broken.
    pub error: Option<String>,
}

/// Read the real state, never a stored flag.
///
/// The answer lives in files the service owns and that an administrator can
/// remove by hand. A cached boolean here would eventually claim a machine is
/// armed when its record has been deleted.
#[tauri::command]
pub async fn lock_screen_state() -> LockScreenState {
    tauri::async_runtime::spawn_blocking(|| match ask(&ControlRequest::UnattendedState) {
        Ok(v) => read_unattended(&v),
        Err(e) => LockScreenState { error: Some(e), ..LockScreenState::default() },
    })
    .await
    .unwrap_or_default()
}

/// Pull the three facts out of the service's reply.
///
/// A NAMED FUNCTION so a test can feed it a REAL, serialised
/// `ControlResponse::UnattendedState` built from the service's own type. These
/// two crates compile separately and are joined only by these key strings, and
/// this repo has repeatedly shipped cross-process names that failed silently —
/// a wrong key here would simply report an unenrolled machine for ever, which
/// looks exactly like a machine nobody turned this on for.
fn read_unattended(v: &serde_json::Value) -> LockScreenState {
    LockScreenState {
        service_installed: true,
        enrolled: v.get("enrolled").and_then(|x| x.as_bool()).unwrap_or(false),
        armed: v.get("armed").and_then(|x| x.as_bool()).unwrap_or(false),
        // Absent from an older service, and null when unenrolled — both mean
        // "no companion row to pair with", which is the safe answer.
        device_id: v
            .get("device_id")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        // Absent (old service) reads as None, which the UI treats as "needs
        // update" — an old service is precisely a service needing an update.
        bins_hash: v
            .get("bins_hash")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        link_attested_at: link_i64(v, "attested_at"),
        link_refused_first: link_i64(v, "refused_first"),
        link_refused_last: link_i64(v, "refused_last"),
        link_refused_count: v
            .get("link")
            .and_then(|l| l.get("refused_count"))
            .and_then(|x| x.as_u64())
            .map(|n| n.min(u32::MAX as u64) as u32)
            .unwrap_or(0),
        // Only a client-error status is a refusal; anything else in this slot
        // is a service this app does not understand, and says nothing.
        link_refused_status: v
            .get("link")
            .and_then(|l| l.get("refused_status"))
            .and_then(|x| x.as_u64())
            .filter(|s| (400..=499).contains(s))
            .map(|s| s as u16),
        error: None,
    }
}

/// One timestamp from the service's `link` object. Absent (an older service,
/// or nothing recorded) is None.
fn link_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get("link").and_then(|l| l.get(key)).and_then(|x| x.as_i64())
}

#[derive(Serialize)]
pub struct BegunEnrolment {
    pub device_id: String,
    pub device_pub: String,
    pub sign_pub: String,
}

/// Step one: ask the service to generate this machine's device identity.
///
/// Returns PUBLIC halves only. The caller signs an auth record over them with
/// the account key and enrols it, then calls `lock_screen_finish_enrol`.
#[tauri::command]
pub async fn lock_screen_begin_enrol() -> Result<BegunEnrolment, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let v = ask(&ControlRequest::EnrolBegin)?;
        let s = |k: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("the service did not return {k}"))
        };
        Ok(BegunEnrolment {
            device_id: s("device_id")?,
            device_pub: s("device_pub")?,
            sign_pub: s("sign_pub")?,
        })
    })
    .await
    .map_err(|e| format!("the request did not finish: {e}"))?
}

/// Step two: hand the service the connection details.
#[tauri::command]
pub async fn lock_screen_finish_enrol(
    api_base: String,
    user_id: i64,
    token: String,
    account_sign_pub: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ask(&ControlRequest::EnrolFinish { api_base, user_id, token, account_sign_pub })
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("the request did not finish: {e}"))?
}

/// Arm this machine with a record derived from a passphrase.
///
/// The record is the salt and the PUBLIC verifying key — never the passphrase
/// and never the private key, which exist only on the controlling device.
#[tauri::command]
pub async fn lock_screen_arm(record: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ask(&ControlRequest::Arm { record }).map(|_| ())
    })
    .await
    .map_err(|e| format!("the request did not finish: {e}"))?
}

#[tauri::command]
pub async fn lock_screen_disarm() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| ask(&ControlRequest::Disarm).map(|_| ()))
        .await
        .map_err(|e| format!("the request did not finish: {e}"))?
}

/// Forget everything: keys, token, config and the arming record.
#[tauri::command]
pub async fn lock_screen_unenrol() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| ask(&ControlRequest::Unenrol).map(|_| ()))
        .await
        .map_err(|e| format!("the request did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_serialise_the_way_the_service_parses_them() {
        // BUILT FROM THE SERVICE'S OWN TYPE. The last bug in this file was a
        // handwritten frame that no test ever ran — see service_link.rs's
        // parse_handle. Round-tripping through the real enum is what makes a
        // misspelling impossible rather than merely unlikely.
        let reqs = [
            ControlRequest::UnattendedState,
            ControlRequest::EnrolBegin,
            ControlRequest::Unenrol,
            ControlRequest::Disarm,
            ControlRequest::Arm { record: "{}".into() },
            ControlRequest::EnrolFinish {
                api_base: "https://chat.example.com".into(),
                user_id: 1,
                token: "t".into(),
                account_sign_pub: "ed25519:AAAA".into(),
            },
        ];
        for r in &reqs {
            let wire = serde_json::to_string(r).expect("serialise");
            // Tagged "t", snake_case — the shape control_pipe.rs deserialises.
            let v: serde_json::Value = serde_json::from_str(&wire).expect("parse");
            let tag = v.get("t").and_then(|x| x.as_str()).expect("a tag");
            assert_eq!(tag, tag.to_lowercase(), "tags are snake_case: {tag}");
            // And it must deserialise back into the very same request.
            let back: ControlRequest = serde_json::from_str(&wire).expect("round trip");
            assert_eq!(&back, r);
        }
    }

    #[test]
    fn a_refusal_keeps_the_services_own_wording() {
        // The service words refusals for a person. Replacing them with a
        // generic failure throws away the only part that says what to do.
        let refused = puca_service::control::ControlResponse::Refused {
            reason: "only the user signed in at this computer's own screen can do this".into(),
        };
        let wire = serde_json::to_string(&refused).unwrap();
        let v: serde_json::Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(v.get("t").and_then(|x| x.as_str()), Some("refused"));
        assert_eq!(
            v.get("reason").and_then(|x| x.as_str()),
            Some("only the user signed in at this computer's own screen can do this")
        );
    }

    #[test]
    fn no_service_is_reported_as_absent_rather_than_as_a_failure() {
        // The default on every machine that never turned this on. It must not
        // read as an error the user has to act on — and the state struct's
        // default must be the safe one, since spawn_blocking failure falls back
        // to it.
        let d = LockScreenState::default();
        assert!(!d.service_installed && !d.enrolled && !d.armed);
        assert!(d.device_id.is_none(), "no service means no companion row");
    }

    #[test]
    fn the_enrolled_device_id_survives_the_trip_from_the_service() {
        // BOTH ENDS, NOT A GUESSED STRING. The expectation is built from the
        // service's OWN type and serialised exactly as the pipe would carry it,
        // then handed to the real parser. Rename the field on either side and
        // this fails — whereas the product would merely go on reporting "no
        // companion row", i.e. one PC listed as two devices with the sign-in
        // half permanently un-wakeable, and nothing would say why.
        let reply = puca_service::control::ControlResponse::UnattendedState {
            armed: true,
            enrolled: true,
            device_id: Some("iE7UN9h775LJJ1rIbNblf".into()),
            bins_hash: Some("abc123".into()),
            link: Some(puca_service::control::LinkHealthView {
                attested_at: Some(1),
                refused_first: Some(2),
                refused_last: Some(3),
                refused_count: 4,
                refused_status: Some(400),
            }),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&reply).unwrap()).unwrap();

        let state = read_unattended(&v);
        assert_eq!(state.device_id.as_deref(), Some("iE7UN9h775LJJ1rIbNblf"));
        assert!(state.enrolled && state.armed && state.service_installed);
        // The pair fingerprint rides the same reply — BOTH ends, same test
        // discipline as device_id: a rename on either side must go red here,
        // because the product failure it causes is a permanently missing
        // "update the service" prompt, which looks like nothing at all.
        assert_eq!(state.bins_hash.as_deref(), Some("abc123"));
        // The link-health record, same discipline: a rename on either side
        // would leave the app showing a ticked box with no warning while the
        // server refuses the machine — the exact failure it was added for.
        assert_eq!(state.link_attested_at, Some(1));
        assert_eq!(state.link_refused_first, Some(2));
        assert_eq!(state.link_refused_last, Some(3));
        assert_eq!(state.link_refused_count, 4);
        assert_eq!(state.link_refused_status, Some(400));
    }

    #[test]
    fn an_unenrolled_machine_reports_no_companion_row_rather_than_a_blank_one() {
        // An empty string would sail through `Option` and become a device id
        // that PATCHes nothing and groups with nothing. Both shapes the service
        // can legitimately produce must land as None.
        let absent = puca_service::control::ControlResponse::UnattendedState {
            armed: false,
            enrolled: false,
            device_id: None,
            bins_hash: None,
            link: None,
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&absent).unwrap()).unwrap();
        assert!(read_unattended(&v).device_id.is_none());

        // And an older service, which does not send the field at all.
        let old: serde_json::Value =
            serde_json::from_str(r#"{"t":"unattended_state","armed":false,"enrolled":true}"#)
                .unwrap();
        assert!(read_unattended(&old).device_id.is_none());
        assert!(read_unattended(&old).enrolled, "the rest must still parse");
        // An old service reports no fingerprint — which must land as None,
        // the value the UI reads as "this service needs updating". True by
        // construction: a service too old to say what it is IS out of date.
        assert!(read_unattended(&old).bins_hash.is_none());
        // An old service has nothing to say about the link — which must read
        // as no refusal, so the app shows exactly what it always did.
        let o = read_unattended(&old);
        assert_eq!(
            (o.link_attested_at, o.link_refused_first, o.link_refused_last),
            (None, None, None)
        );
        assert_eq!((o.link_refused_count, o.link_refused_status), (0, None));
        // As must a service that sent the key with nothing in it.
        let n = read_unattended(&v);
        assert_eq!((n.link_refused_first, n.link_refused_count), (None, 0));

        // An empty string is not an id.
        let blank: serde_json::Value = serde_json::from_str(
            r#"{"t":"unattended_state","armed":false,"enrolled":true,"device_id":""}"#,
        )
        .unwrap();
        assert!(read_unattended(&blank).device_id.is_none());
    }
}
