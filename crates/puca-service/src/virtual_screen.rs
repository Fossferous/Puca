//! A virtual screen for remote control with the lid closed — the decisions.
//!
//! THE PROBLEM. A laptop with its lid shut and no external monitor has no
//! active display at all, so Windows has nothing to duplicate and the agent's
//! capture fails ("No monitors available", `puca-agent/src/composite.rs`). The
//! owner's own laptop was unreachable from their phone for exactly this reason
//! on 2026-10-21, and keeping the machine awake did not help: awake is not the
//! same as having a screen. Only an output that exists in software fixes it.
//!
//! THE SHAPE, and why each part is the way it is:
//!
//!  * OPT-IN, installed behind Windows' OWN consent. The driver is the
//!    open-source Virtual Display Driver (`crates/puca-service/vdd/NOTICE.md`),
//!    signed by SignPath Foundation rather than by Microsoft, so Windows asks
//!    "Would you like to install this device software?" and names the
//!    publisher. That prompt is the consent and it is kept: importing the
//!    SignPath certificate into Trusted Publishers to suppress it would trust
//!    every other project that certificate signs, machine-wide, for ever.
//!  * ON DEMAND ONLY. The device rests DISABLED. A virtual monitor that is
//!    always on extends the desktop while the lid is open, and windows open on
//!    a screen nobody can see. It is switched on only while a remote session
//!    asks for it AND there is no real screen, and off again after.
//!  * A LEASE, NOT A SWITCH. Whoever asks holds it for [`LEASE_TTL`] and must
//!    keep renewing. An agent that crashes stops renewing, and the screen goes
//!    off on its own within the TTL. Nobody has to remember to clean up after a
//!    process that no longer exists.
//!  * THE SERVICE'S OWN START IS THE CRASH RECOVERY. The device's enabled state
//!    persists across a service crash, a power cut and a reboot. A service that
//!    is just starting holds no leases, so any enabled virtual screen it finds
//!    is left over and gets switched off ([`startup_action`]). That is the
//!    crash-marker pattern of `frontend/src-tauri/src/display_topology.rs`, with
//!    the device's persisted state as the marker. A separate marker file would
//!    add a way to disagree with the truth and nothing else: the device state
//!    is written by the OS, atomically, and cannot go missing on its own.
//!
//! Everything here is pure and portable. The SetupAPI / CfgMgr calls that act
//! on it live in `virtual_screen_os.rs` (Windows only), and nothing in a test
//! reaches them: installing a display driver from `cargo test` would be the
//! same class of harm as `display_topology.rs` refusing to re-arrange the
//! developer's monitors.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The hardware ID the driver's INF matches (`[Standard.NTamd64]`). The device
/// node this service creates carries exactly this, and every lookup that
/// decides "is this device ours to touch" checks for it.
pub const HARDWARE_ID: &str = r"Root\MttVDD";

/// The INF's file name as the driver store records it. Removing a driver
/// package by its published name (`oemNN.inf`) is only safe after confirming
/// that name still belongs to THIS package: the numbers are reused.
pub const ORIGINAL_INF_NAME: &str = "mttvdd.inf";

/// The registry key the driver reads its settings folder from (`VDDPATH`).
/// Verified in the shipped binary's strings, not just the source: without the
/// value the driver falls back to `C:\VirtualDisplayDriver`, a folder any
/// signed-in user can create, which would let them choose the settings (and
/// the EDID file) a driver running as a service account parses.
pub const DRIVER_REG_KEY: &str = r"SOFTWARE\MikeTheTech\VirtualDisplayDriver";
pub const DRIVER_REG_PATH_VALUE: &str = "VDDPATH";
/// Written beside `VDDPATH` so removal can tell OUR key from one a separate
/// install of the same driver made — the only one of the two we may delete.
pub const DRIVER_REG_OWNER_VALUE: &str = "PucaInstalled";

/// How long a hold lasts without renewal. The agent renews every
/// [`RENEW_EVERY`]; the gap is what a busy control pipe (one instance, shared
/// with the app's polls) can cost a renewal without the screen going dark
/// mid-session.
pub const LEASE_TTL: Duration = Duration::from_secs(30);
pub const RENEW_EVERY: Duration = Duration::from_secs(10);

/// The virtual screen's one mode. 1920x1080 at 60 Hz: what a phone's stage
/// shows well, cheap to encode, and the same size most laptop panels are.
pub const DEFAULT_WIDTH: u32 = 1920;
pub const DEFAULT_HEIGHT: u32 = 1080;
pub const DEFAULT_REFRESH_HZ: u32 = 60;

/// The files this service installs, with the SHA-256 the release shipped them
/// with. The bytes are EMBEDDED in this binary (`virtual_screen_os.rs`), so the
/// copy that installs them is the admin-only one under Program Files and the
/// hashes cannot be swapped by anyone who can write the app's own folder.
/// Checked again after the files are written, because what matters is what is
/// on disk when Windows reads it, not what was in memory.
pub const DRIVER_FILES: [(&str, &str); 3] = [
    ("MttVDD.dll", "c9ca837f57a98fbd43bc416a7f535a95843626e7759eaf85cf0cd7ce334dbb05"),
    ("MttVDD.inf", "550d211fe481e74dfe3f9d724ed78be48b3a9113405965d683d9373e8d672f5d"),
    ("mttvdd.cat", "08a0093fc9b2e32b287a6f8a77ca4de0a31830d29fc33d2b13a918dc859468f6"),
];

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Is `bytes` the pinned file called `name`? `false` for a name that is not in
/// the list at all, so a typo cannot read as "nothing to check".
pub fn matches_pinned(name: &str, bytes: &[u8]) -> bool {
    DRIVER_FILES
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .is_some_and(|(_, want)| sha256_hex(bytes) == *want)
}

/// The settings file Púca writes for the driver: ONE screen, ONE mode, logging
/// off. Only the elements the driver's parser reads (`loadSettings` in its
/// Driver.cpp, matched against the release's own example). No global refresh
/// list, because the driver multiplies every resolution by every entry in it,
/// and a 244 Hz mode is a mode Windows might pick.
pub fn settings_xml(width: u32, height: u32, refresh_hz: u32) -> String {
    format!(
        "<?xml version='1.0' encoding='utf-8'?>\n\
         <!-- Written by Púca's remote-access service. Rewritten every time the virtual\n     \
         screen is switched on, so a change made here does not last. -->\n\
         <vdd_settings>\n\
         \x20   <monitors>\n\
         \x20       <count>1</count>\n\
         \x20   </monitors>\n\
         \x20   <gpu>\n\
         \x20       <friendlyname>default</friendlyname>\n\
         \x20   </gpu>\n\
         \x20   <resolutions>\n\
         \x20       <resolution>\n\
         \x20           <width>{width}</width>\n\
         \x20           <height>{height}</height>\n\
         \x20           <refresh_rate>{refresh_hz}</refresh_rate>\n\
         \x20       </resolution>\n\
         \x20   </resolutions>\n\
         \x20   <options>\n\
         \x20       <CustomEdid>false</CustomEdid>\n\
         \x20       <PreventSpoof>false</PreventSpoof>\n\
         \x20       <EdidCeaOverride>false</EdidCeaOverride>\n\
         \x20       <HardwareCursor>true</HardwareCursor>\n\
         \x20       <SDR10bit>false</SDR10bit>\n\
         \x20       <HDRPlus>false</HDRPlus>\n\
         \x20       <logging>false</logging>\n\
         \x20       <debuglogging>false</debuglogging>\n\
         \x20   </options>\n\
         </vdd_settings>\n"
    )
}

/// What this service installed, recorded so removal touches exactly that and
/// nothing a separate install of the same driver made. Lives beside the
/// binaries in the admin-only install directory.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Installed {
    pub version: u32,
    /// The device node's instance ID, e.g. `ROOT\DISPLAY\0001`.
    pub instance_id: String,
    /// The driver store's published name for the package, e.g. `oem42.inf`.
    /// `None` when it could not be read back after install. Removal then
    /// leaves the package in the store and says so, rather than guessing a
    /// number that might be someone else's.
    #[serde(default)]
    pub oem_inf: Option<String>,
}

impl Installed {
    pub const VERSION: u32 = 1;
    pub const FILE: &'static str = "virtual-screen.json";
}

/// Why a hold cannot switch the screen on. Each sends a person somewhere
/// different, so each is named, and the agent passes the tag on to the phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unavailable {
    /// The option is off on this PC: nothing was ever installed.
    NotInstalled,
    /// The record says installed, but its device node is gone (removed by
    /// hand in Device Manager, or by a Windows reset). Turning the option off
    /// and on again repairs it.
    DeviceMissing,
    /// Windows refused to switch it on. The service log has the code.
    EnableFailed,
}

/// The service's whole answer to a virtual-screen request.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Report {
    /// The option is on: the driver and its device are installed.
    pub installed: bool,
    /// The virtual screen is switched on right now.
    pub on: bool,
    /// The device's instance ID, so the agent can tell its output from a real
    /// one (`puca-agent/src/virtual_screen.rs`). `None` when not installed.
    #[serde(default)]
    pub instance_id: Option<String>,
    /// Set when a hold could not switch it on.
    #[serde(default)]
    pub unavailable: Option<Unavailable>,
}

/// What a change to the lease book requires of the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    Enable,
    Disable,
    Nothing,
}

/// Holds, keyed by the CLIENT PROCESS ID the kernel reports for the pipe
/// connection. The process id is not something a caller can choose, so one
/// caller cannot renew or release another's hold. A pid that dies stops
/// renewing, and its hold expires. A reused pid inherits at most one TTL.
#[derive(Debug, Default)]
pub struct LeaseBook {
    leases: HashMap<u32, Instant>,
    /// What the device was last told to be. Kept here so that a failed OS
    /// call can be retried by the next transition, instead of being assumed.
    on: bool,
}

impl LeaseBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    /// Record what the device actually is after an OS call. `false` after a
    /// failed enable keeps the book honest: the next hold tries again.
    pub fn set_on(&mut self, on: bool) {
        self.on = on;
    }

    pub fn holders(&self) -> usize {
        self.leases.len()
    }

    /// `pid` wants the screen on for another TTL.
    pub fn hold(&mut self, pid: u32, now: Instant) -> Transition {
        self.expire_only(now);
        self.leases.insert(pid, now + LEASE_TTL);
        if self.on {
            Transition::Nothing
        } else {
            Transition::Enable
        }
    }

    /// `pid` is done with it. Releasing a hold you do not have is a no-op,
    /// not an error: an agent releasing twice (stream end, then shutdown) must
    /// not be told something went wrong.
    pub fn release(&mut self, pid: u32, now: Instant) -> Transition {
        self.expire_only(now);
        self.leases.remove(&pid);
        self.settle()
    }

    /// The periodic tick: drop holds nobody renewed.
    pub fn expire(&mut self, now: Instant) -> Transition {
        self.expire_only(now);
        self.settle()
    }

    /// A hold that could not switch the screen on is withdrawn, so a failure
    /// does not leave a lease keeping "on" true in nobody's interest.
    pub fn withdraw(&mut self, pid: u32) {
        self.leases.remove(&pid);
    }

    fn expire_only(&mut self, now: Instant) {
        self.leases.retain(|_, until| *until > now);
    }

    fn settle(&self) -> Transition {
        if self.leases.is_empty() && self.on {
            Transition::Disable
        } else {
            Transition::Nothing
        }
    }
}

/// What a service that is just starting does about the device. It holds no
/// leases, so an enabled virtual screen can only be left over from a crash,
/// a power cut or a reboot that interrupted a session. `enabled` is `None`
/// when the device's state could not be read, and then the safe action is
/// still to try to switch it off.
pub fn startup_action(installed: bool, enabled: Option<bool>) -> Transition {
    match (installed, enabled) {
        (false, _) => Transition::Nothing,
        (true, Some(false)) => Transition::Nothing,
        (true, Some(true)) | (true, None) => Transition::Disable,
    }
}

/// Is a hardware-ID list (as SetupAPI returns it: one string per entry) the
/// driver this module installs? Case-insensitive, as PnP compares them. Both
/// spellings the INF lists count: `Root\MttVDD` and the bare `MttVDD` its
/// sample app uses.
pub fn is_driver_hardware_id(ids: &[String]) -> bool {
    ids.iter().any(|id| {
        id.eq_ignore_ascii_case(HARDWARE_ID) || id.eq_ignore_ascii_case("MttVDD")
    })
}

/// May the install go ahead, given the devices already carrying this driver's
/// hardware ID and whether its registry key already exists?
///
/// REFUSED when somebody else's copy is present. The Virtual Display Driver is
/// popular with game-streaming setups (Sunshine, Apollo), and both copies
/// would share one hardware ID, one control pipe and one settings key. An
/// install over the top would re-point that person's settings at ours, and a
/// later removal would take their virtual screen away.
pub fn install_precheck(
    ours: Option<&Installed>,
    devices_with_id: &[String],
    registry_key_exists: bool,
    registry_key_is_ours: bool,
) -> Result<(), &'static str> {
    let foreign_device = devices_with_id.iter().any(|d| {
        ours.map(|o| !o.instance_id.eq_ignore_ascii_case(d)).unwrap_or(true)
    });
    if foreign_device || (registry_key_exists && !registry_key_is_ours) {
        return Err(FOREIGN_INSTALL);
    }
    Ok(())
}

pub const FOREIGN_INSTALL: &str =
    "Another copy of the Virtual Display Driver is already installed on this PC (often by a \
     game-streaming app). Púca will not install a second copy over it or change its settings. \
     Remove that copy first if you want Púca to manage the virtual screen.";

/// Turn a SetupAPI failure during install into a sentence. The codes are the
/// ones Windows returns when the person declines its device-software prompt
/// (ERROR_CANCELLED, and the Authenticode "trust not established" family),
/// which is a choice and must not read as a fault.
pub fn describe_install_error(code: u32) -> String {
    match code {
        // ERROR_CANCELLED, and the same as an HRESULT.
        1223 | 0x8007_04C7 => DECLINED.to_string(),
        // ERROR_AUTHENTICODE_DISALLOWED, _TRUST_NOT_ESTABLISHED and
        // _PUBLISHER_NOT_TRUSTED (setupapi.h; values checked against the
        // windows crate): the publisher prompt was declined.
        0xE000_0240 | 0xE000_0242 | 0xE000_0243 => DECLINED.to_string(),
        // ERROR_FILE_HASH_NOT_IN_CATALOG, ERROR_NO_CATALOG_FOR_OEM_INF,
        // TRUST_E_NOSIGNATURE: the package itself was refused.
        0xE000_024B | 0xE000_022F | 0x800B_0100 => format!(
            "Windows refused the virtual screen driver package (error 0x{code:08X}). Nothing was \
             installed."
        ),
        _ => format!(
            "Windows could not install the virtual screen driver (error 0x{code:08X}). Nothing was \
             installed."
        ),
    }
}

pub const DECLINED: &str =
    "You declined Windows' prompt to install the virtual screen driver, so nothing was installed.";

pub const NOT_X64: &str =
    "The virtual screen is only available on 64-bit Intel and AMD PCs. Púca does not ship a version \
     of the driver for this processor.";

pub const NEEDS_REMOTE_ACCESS: &str =
    "Turn on remote access for this PC first: the virtual screen is switched on and off by Púca's \
     remote-access service.";

/// The elevated helper's exit code for an install or removal that failed.
///
/// AN EXIT CODE BECAUSE IT IS ALL THAT CROSSES BACK. The app raises the helper
/// with ShellExecute's `runas` verb, which gives it no way to read the
/// helper's output, and having an elevated process write its answer into a
/// path the user chose is the classic way to hand that user a write anywhere
/// on disk. So the cases a person can act on get their own codes, and the app
/// turns them back into these same sentences with [`message_for_exit_code`].
pub fn exit_code_for(message: &str) -> i32 {
    match message {
        DECLINED => 3,
        FOREIGN_INSTALL => 4,
        NOT_X64 => 5,
        NEEDS_REMOTE_ACCESS => 6,
        _ => 1,
    }
}

/// The app's half of [`exit_code_for`]. `None` for a code with no sentence of
/// its own; the app then says the helper failed and points at the service log.
pub fn message_for_exit_code(code: u32) -> Option<&'static str> {
    match code {
        3 => Some(DECLINED),
        4 => Some(FOREIGN_INSTALL),
        5 => Some(NOT_X64),
        6 => Some(NEEDS_REMOTE_ACCESS),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn the_first_hold_switches_it_on_and_later_ones_do_not() {
        let now = t0();
        let mut book = LeaseBook::new();
        assert_eq!(book.hold(10, now), Transition::Enable);
        book.set_on(true);
        // Same holder renewing, and a second holder joining: no new enable.
        assert_eq!(book.hold(10, now + Duration::from_secs(5)), Transition::Nothing);
        assert_eq!(book.hold(11, now + Duration::from_secs(6)), Transition::Nothing);
        assert_eq!(book.holders(), 2);
    }

    #[test]
    fn it_switches_off_only_when_the_last_holder_lets_go() {
        let now = t0();
        let mut book = LeaseBook::new();
        book.hold(10, now);
        book.set_on(true);
        book.hold(11, now);
        // One of two leaving keeps it on: the other session is still using it.
        assert_eq!(book.release(10, now), Transition::Nothing);
        // The last one leaving switches it off.
        assert_eq!(book.release(11, now), Transition::Disable);
    }

    #[test]
    fn an_unrenewed_hold_expires_and_switches_it_off() {
        // THE CRASH CASE: an agent that dies stops renewing. Nobody releases.
        let now = t0();
        let mut book = LeaseBook::new();
        book.hold(10, now);
        book.set_on(true);
        // Negative control: still inside the TTL, nothing happens.
        assert_eq!(book.expire(now + LEASE_TTL - Duration::from_secs(1)), Transition::Nothing);
        assert_eq!(book.expire(now + LEASE_TTL), Transition::Disable);
    }

    #[test]
    fn renewing_keeps_it_on_past_the_first_ttl() {
        let now = t0();
        let mut book = LeaseBook::new();
        book.hold(10, now);
        book.set_on(true);
        let mut t = now;
        for _ in 0..10 {
            t += RENEW_EVERY;
            assert_eq!(book.hold(10, t), Transition::Nothing);
            assert_eq!(book.expire(t), Transition::Nothing);
        }
        assert!(t > now + LEASE_TTL, "the loop must outlast one TTL to prove anything");
    }

    #[test]
    fn the_renewal_cadence_fits_inside_the_ttl_with_room_for_a_busy_pipe() {
        // Two missed renewals must not darken a live session's screen.
        assert!(RENEW_EVERY * 2 < LEASE_TTL);
    }

    #[test]
    fn releasing_a_hold_you_do_not_have_changes_nothing() {
        let now = t0();
        let mut book = LeaseBook::new();
        book.hold(10, now);
        book.set_on(true);
        assert_eq!(book.release(99, now), Transition::Nothing);
        assert_eq!(book.holders(), 1);
        // And an empty, off book never asks to disable.
        let mut empty = LeaseBook::new();
        assert_eq!(empty.release(1, now), Transition::Nothing);
        assert_eq!(empty.expire(now), Transition::Nothing);
    }

    #[test]
    fn a_failed_enable_is_retried_by_the_next_hold() {
        let now = t0();
        let mut book = LeaseBook::new();
        assert_eq!(book.hold(10, now), Transition::Enable);
        // The OS call failed: the caller withdraws the hold and leaves `on` false.
        book.withdraw(10);
        book.set_on(false);
        assert_eq!(book.holders(), 0);
        assert_eq!(book.hold(10, now), Transition::Enable, "the next attempt must try again");
    }

    #[test]
    fn a_starting_service_switches_off_a_screen_it_finds_on() {
        assert_eq!(startup_action(true, Some(true)), Transition::Disable);
        // Could not read the state: still try, the safe direction.
        assert_eq!(startup_action(true, None), Transition::Disable);
        // Negative controls: already off, or nothing installed.
        assert_eq!(startup_action(true, Some(false)), Transition::Nothing);
        assert_eq!(startup_action(false, Some(true)), Transition::Nothing);
    }

    #[test]
    fn the_pinned_hashes_match_the_vendored_files() {
        // The same files `virtual_screen_os.rs` embeds. If someone updates the
        // driver without updating the pins (or the other way round), the
        // install would refuse on every machine; this says so here instead.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vdd");
        for (name, _) in DRIVER_FILES {
            let bytes = std::fs::read(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(matches_pinned(name, &bytes), "{name} does not match its pinned SHA-256");
        }
        // Negative control: one changed byte must fail.
        let mut dll = std::fs::read(dir.join("MttVDD.dll")).unwrap();
        dll[0] ^= 1;
        assert!(!matches_pinned("MttVDD.dll", &dll));
        // And a name that is not pinned never passes.
        assert!(!matches_pinned("other.dll", b"anything"));
    }

    #[test]
    fn the_inf_is_still_utf16_with_its_bom() {
        // `.gitattributes` marks the vendored files binary because the catalog
        // signs these exact bytes. A checkout that converted line endings
        // would still hash differently and fail the test above; this names
        // the likelier cause first.
        let inf = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vdd").join("MttVDD.inf"),
        )
        .unwrap();
        assert_eq!(&inf[..2], &[0xFF, 0xFE], "MttVDD.inf must be UTF-16LE with a BOM");
    }

    #[test]
    fn the_settings_name_one_screen_and_the_default_mode_only() {
        let xml = settings_xml(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_REFRESH_HZ);
        assert!(xml.contains("<count>1</count>"));
        assert!(xml.contains("<width>1920</width>"));
        assert!(xml.contains("<height>1080</height>"));
        assert!(xml.contains("<refresh_rate>60</refresh_rate>"));
        assert_eq!(xml.matches("<resolution>").count(), 1);
        // No global refresh list: the driver multiplies it into every mode.
        assert!(!xml.contains("g_refresh_rate"));
        assert!(xml.contains("<logging>false</logging>"));
        assert!(xml.contains("<debuglogging>false</debuglogging>"));
        // A custom EDID would make the driver read user_edid.bin.
        assert!(xml.contains("<CustomEdid>false</CustomEdid>"));
    }

    #[test]
    fn only_this_drivers_hardware_ids_count_as_ours() {
        assert!(is_driver_hardware_id(&[r"ROOT\MTTVDD".into()]));
        assert!(is_driver_hardware_id(&["mttvdd".into()]));
        assert!(!is_driver_hardware_id(&[r"Root\ParsecVDA".into(), r"PCI\VEN_10DE".into()]));
        assert!(!is_driver_hardware_id(&[]));
    }

    #[test]
    fn someone_elses_copy_of_the_driver_blocks_the_install() {
        let ours = Installed {
            version: 1,
            instance_id: r"ROOT\DISPLAY\0001".into(),
            oem_inf: Some("oem42.inf".into()),
        };
        // Fresh machine.
        assert!(install_precheck(None, &[], false, false).is_ok());
        // Re-running our own install over our own device.
        assert!(install_precheck(Some(&ours), &[r"ROOT\DISPLAY\0001".into()], true, true).is_ok());
        // Another device with the same hardware ID.
        assert_eq!(
            install_precheck(None, &[r"ROOT\DISPLAY\0000".into()], false, false),
            Err(FOREIGN_INSTALL)
        );
        assert_eq!(
            install_precheck(Some(&ours), &[r"ROOT\DISPLAY\0000".into()], true, true),
            Err(FOREIGN_INSTALL)
        );
        // Its settings key, without our mark on it.
        assert_eq!(install_precheck(None, &[], true, false), Err(FOREIGN_INSTALL));
    }

    #[test]
    fn declining_the_windows_prompt_reads_as_a_choice_not_a_fault() {
        assert_eq!(describe_install_error(1223), DECLINED);
        assert_eq!(describe_install_error(0xE000_0242), DECLINED);
        assert_eq!(describe_install_error(0xE000_0243), DECLINED);
        assert!(describe_install_error(0xE000_024B).contains("refused"));
        assert!(describe_install_error(5).contains("0x00000005"));
    }

    #[test]
    fn every_actionable_failure_survives_the_trip_through_an_exit_code() {
        for msg in [DECLINED, FOREIGN_INSTALL, NOT_X64, NEEDS_REMOTE_ACCESS] {
            let code = exit_code_for(msg);
            assert_ne!(code, 0, "a failure must never exit 0");
            assert_ne!(code, 1, "{msg} needs its own code");
            assert_ne!(code, 2, "2 is the binary's own 'unknown command' — an old service");
            assert_eq!(message_for_exit_code(code as u32), Some(msg));
        }
        // Anything else is the generic failure, which has no sentence.
        assert_eq!(exit_code_for("disk full"), 1);
        assert_eq!(message_for_exit_code(1), None);
        assert_eq!(message_for_exit_code(2), None);
    }

    #[test]
    fn the_report_and_reasons_have_stable_wire_spellings() {
        // The agent matches these literally (puca-agent/src/virtual_screen.rs
        // pins the same strings on its side).
        assert_eq!(serde_json::to_string(&Unavailable::NotInstalled).unwrap(), r#""not_installed""#);
        assert_eq!(serde_json::to_string(&Unavailable::DeviceMissing).unwrap(), r#""device_missing""#);
        assert_eq!(serde_json::to_string(&Unavailable::EnableFailed).unwrap(), r#""enable_failed""#);
        let r = Report { installed: true, on: false, instance_id: None, unavailable: None };
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["installed"], true);
        assert_eq!(v["on"], false);
    }
}
