//! Is the laptop's lid closed?
//!
//! Needed because a closed lid does not always remove the built-in panel from
//! the desktop: on the owner's laptop (0.9.842 field report, 2026-10-22) the
//! panel stays an ACTIVE output, Windows just never presents a frame to it,
//! and a capture of it waits for ever. `virtual_screen.rs` treats a built-in
//! panel behind a closed lid as dark; this module is where "closed" comes from.
//!
//! The lid switch has no synchronous query. Its state arrives as a power-setting
//! notification (`GUID_LIDSWITCH_STATE_CHANGE`), delivered once with the current
//! state when you subscribe and again on every change. The subscription is the
//! callback form (`DEVICE_NOTIFY_CALLBACK`), so it needs no window and works the
//! same in the app's agent and in the sign-in-screen (SYSTEM) one. It is made
//! once, at agent start, and lives for the process.
//!
//! `None` = not known: a desktop PC with no lid, a subscription that failed, or
//! no notification yet. Every caller treats that as "no lid problem", which is
//! exactly the behaviour before this existed.

#![cfg(windows)]

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Once;
use windows::core::GUID;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Power::{
    PowerSettingRegisterNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
};
use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

/// `GUID_LIDSWITCH_STATE_CHANGE` (winnt.h), spelt here so the crate needs no
/// extra windows feature for one constant. Pinned by a test against the value
/// Microsoft documents.
const LID_GUID: GUID = GUID::from_u128(0xba3e0f4d_b817_4094_a2d1_d56379e6a0f3);

/// `PBT_POWERSETTINGCHANGE`.
const PBT_POWERSETTINGCHANGE: u32 = 0x8013;

const UNKNOWN: u8 = 0;
const OPEN: u8 = 1;
const CLOSED: u8 = 2;
static STATE: AtomicU8 = AtomicU8::new(UNKNOWN);

/// What the subscription is told to call. Static, because the OS holds the
/// pointer for the life of the subscription, which is the life of the process.
/// Wrapped only to be a `static`: the struct carries a raw context pointer,
/// which is null here and never written, so sharing it is sound.
struct Params(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS);
unsafe impl Sync for Params {}
static PARAMS: Params = Params(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
    Callback: Some(on_power_setting),
    Context: std::ptr::null_mut(),
});

unsafe extern "system" fn on_power_setting(
    _context: *const core::ffi::c_void,
    kind: u32,
    setting: *const core::ffi::c_void,
) -> u32 {
    if kind != PBT_POWERSETTINGCHANGE || setting.is_null() {
        return 0;
    }
    let s = &*(setting as *const POWERBROADCAST_SETTING);
    if s.PowerSetting != LID_GUID {
        return 0;
    }
    let data = std::slice::from_raw_parts(s.Data.as_ptr(), s.DataLength as usize);
    if let Some(closed) = crate::virtual_screen::decode_lid(data) {
        let new = if closed { CLOSED } else { OPEN };
        if STATE.swap(new, Ordering::SeqCst) != new {
            eprintln!("[lid] the lid is now {}", if closed { "closed" } else { "open" });
        }
    }
    0
}

/// Subscribe to the lid switch. Idempotent; called once from `main`.
pub fn start() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let mut handle: *mut core::ffi::c_void = std::ptr::null_mut();
        let rc = PowerSettingRegisterNotification(
            &LID_GUID,
            DEVICE_NOTIFY_CALLBACK,
            HANDLE(&PARAMS.0 as *const DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS as *mut core::ffi::c_void),
            &mut handle,
        );
        if rc.is_err() {
            // A desktop PC may have no lid to report on; either way this is
            // "unknown", which changes nothing.
            eprintln!("[lid] could not subscribe to the lid switch ({rc:?}); its state stays unknown");
        }
        // The registration handle is deliberately never released: the
        // subscription is for the life of this process.
    });
}

/// `Some(true)` closed, `Some(false)` open, `None` not known.
pub fn closed() -> Option<bool> {
    match STATE.load(Ordering::SeqCst) {
        CLOSED => Some(true),
        OPEN => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_lid_guid_is_the_documented_one() {
        // winnt.h: GUID_LIDSWITCH_STATE_CHANGE = {BA3E0F4D-B817-4094-A2D1-D56379E6A0F3}.
        assert_eq!(format!("{:?}", super::LID_GUID), "BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
    }

    #[test]
    fn nothing_known_until_the_switch_has_said() {
        // No subscription in a test: the state must read as unknown, which
        // every caller treats as "no lid problem".
        assert_eq!(super::closed(), None);
    }
}
