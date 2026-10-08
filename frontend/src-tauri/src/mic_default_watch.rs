//! The Windows default microphone moving, told to the page and to puca.log.
//!
//! WHY (2026-10-07): Audio Hub moved the owner's default (and
//! communications) recording device from a still-connected headset to a desk
//! mic when another headset connected, and the call kept recording the
//! headset until he left and rejoined. The page now follows the default
//! itself (frontend/src/api/rtc/micDeviceWatchdog.ts) on `devicechange`,
//! which Chromium does fire for a default-only change on Windows: since M65
//! its own IMMNotificationClient (media/audio/win/audio_device_listener_win.cc)
//! reports default changes to the device monitor, and the 'default' entry's
//! label and group change. This module does not replace that; it is the same
//! notification taken first-hand, so that:
//!
//! - the page gets a second, independent trigger for the SAME debounced check
//!   (event [`EVENT`]) if WebView2 ever stops forwarding one;
//! - puca.log names the new default endpoint and the role that moved even
//!   when nothing else in the app reacts, which no log line did before.
//!
//! It only LISTENS: an `IMMNotificationClient` registered with the endpoint
//! enumerator, reading names. It never sets a default, a volume or anything
//! else on any device.
//!
//! THREADING. Windows calls the client on its own notification threads,
//! where blocking is forbidden (Unregister waits for running callbacks, so a
//! callback that blocks can deadlock it). The callback filters by data flow
//! and role, copies the endpoint id and posts it down an unbounded channel —
//! nothing else. One thread of ours owns everything COM: it initialises the
//! MTA, registers the client, coalesces bursts (Windows notifies once per
//! role, and Audio Hub moves two roles), resolves names, logs, emits, and on
//! [`stop`] unregisters the client before releasing it.

use serde::Serialize;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// The page listens for this (frontend/src/api/micDiag.ts MIC_DEFAULT_EVENT;
/// pinned by a test below).
pub const EVENT: &str = "mic-default-changed";

/// Quiet time that ends a burst of notifications: Windows sends one per role
/// (console, multimedia, communications) for a single change, back to back.
pub const COALESCE_QUIET: Duration = Duration::from_millis(250);
/// A burst is reported at most this long after its first notification.
pub const COALESCE_MAX: Duration = Duration::from_millis(1500);

// mmdeviceapi.h: EDataFlow eRender = 0, eCapture = 1, eAll = 2;
// ERole eConsole = 0, eMultimedia = 1, eCommunications = 2. Stable ABI.
const E_CAPTURE: i32 = 1;
const E_CONSOLE: i32 = 0;
const E_COMMUNICATIONS: i32 = 2;

/// The two capture roles Chromium's pseudo-devices follow: 'default' opens
/// the eConsole default, 'communications' the eCommunications one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Console,
    Communications,
}

/// Which `OnDefaultDeviceChanged` notifications matter: capture only (an
/// output default is the output half's business, applyOutputDevice), and only
/// the roles a capture can be opened on. eMultimedia accompanies eConsole
/// from the Sound settings and nothing opens it, so it would only double a
/// line.
pub fn watched_role(flow: i32, role: i32) -> Option<Role> {
    if flow != E_CAPTURE {
        return None;
    }
    match role {
        E_CONSOLE => Some(Role::Console),
        E_COMMUNICATIONS => Some(Role::Communications),
        _ => None,
    }
}

/// One notification as the callback posts it: the role and the new default
/// endpoint's id ('' when no capture device is left).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub role: Role,
    pub device_id: String,
}

pub enum Msg {
    Note(Note),
    Stop,
}

/// A coalesced burst: the LAST default seen for each role, and how many
/// notifications it took.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Burst {
    pub console: Option<String>,
    pub communications: Option<String>,
    pub notes: u32,
}

impl Burst {
    pub fn add(&mut self, n: Note) {
        self.notes += 1;
        match n.role {
            Role::Console => self.console = Some(n.device_id),
            Role::Communications => self.communications = Some(n.device_id),
        }
    }

    pub fn roles(&self) -> Vec<&'static str> {
        let mut r = Vec::new();
        if self.console.is_some() {
            r.push("console");
        }
        if self.communications.is_some() {
            r.push("communications");
        }
        r
    }
}

/// Collect a burst that began with `first`: every note arriving within
/// `quiet` of the one before joins it, up to `max` after the start. Returns
/// the burst and whether the watch was told to stop (a Stop, or every sender
/// gone) while collecting — the burst is still reported then.
pub fn collect_burst(first: Note, rx: &Receiver<Msg>, quiet: Duration, max: Duration) -> (Burst, bool) {
    let start = Instant::now();
    let mut b = Burst::default();
    b.add(first);
    loop {
        let left = max.saturating_sub(start.elapsed());
        if left.is_zero() {
            return (b, false);
        }
        match rx.recv_timeout(quiet.min(left)) {
            Ok(Msg::Note(n)) => b.add(n),
            Ok(Msg::Stop) => return (b, true),
            Err(RecvTimeoutError::Timeout) => return (b, false),
            Err(RecvTimeoutError::Disconnected) => return (b, true),
        }
    }
}

/// What the page receives (NativeDefaultChange in micDeviceWatchdog.ts):
/// the roles that moved and the friendly names of their new defaults.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Payload {
    pub roles: Vec<&'static str>,
    pub console: Option<String>,
    pub communications: Option<String>,
}

/// `[mic] Windows default input changed (3 notifications): default -> Microphone (FMA120); communications -> Microphone (FMA120)`
pub fn log_line(b: &Burst, console: Option<&str>, communications: Option<&str>) -> String {
    let mut parts = Vec::new();
    if b.console.is_some() {
        parts.push(format!("default -> {}", console.unwrap_or("(unknown)")));
    }
    if b.communications.is_some() {
        parts.push(format!("communications -> {}", communications.unwrap_or("(unknown)")));
    }
    format!(
        "[mic] Windows default input changed ({} notification{}): {}",
        b.notes,
        if b.notes == 1 { "" } else { "s" },
        parts.join("; ")
    )
}

/// The name to show for an endpoint id: its friendly name from `names`
/// (id -> name), "(no microphone)" for the empty id Windows sends when the
/// last capture device went, and the id's tail otherwise.
pub fn display_name(id: &str, names: &[(String, String)]) -> String {
    if id.is_empty() {
        return "(no microphone)".into();
    }
    names
        .iter()
        .find(|(i, _)| i == id)
        .map(|(_, n)| n.clone())
        .unwrap_or_else(|| {
            let tail: String = id.chars().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
            format!("(endpoint …{tail})")
        })
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use tauri::{AppHandle, Emitter};
    use windows::core::{implement, Result as WinResult, PCWSTR};
    use windows::Win32::Media::Audio::{
        EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl,
        MMDeviceEnumerator, DEVICE_STATE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    #[implement(IMMNotificationClient)]
    struct Client {
        tx: Sender<Msg>,
    }

    impl IMMNotificationClient_Impl for Client_Impl {
        fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> WinResult<()> {
            Ok(())
        }
        fn OnDeviceAdded(&self, _id: &PCWSTR) -> WinResult<()> {
            Ok(())
        }
        fn OnDeviceRemoved(&self, _id: &PCWSTR) -> WinResult<()> {
            Ok(())
        }
        fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, id: &PCWSTR) -> WinResult<()> {
            // On a Windows notification thread: filter, copy, post. Sending
            // on an unbounded channel never blocks.
            if let Some(role) = watched_role(flow.0, role.0) {
                let device_id = if id.is_null() { String::new() } else { unsafe { id.to_string() }.unwrap_or_default() };
                let _ = self.tx.send(Msg::Note(Note { role, device_id }));
            }
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> WinResult<()> {
            Ok(())
        }
    }

    /// The client as COM sees it, for the registration test.
    #[cfg(test)]
    pub(super) fn test_client(tx: Sender<Msg>) -> IMMNotificationClient {
        Client { tx }.into()
    }

    static WATCH: Mutex<Option<(Sender<Msg>, JoinHandle<()>)>> = Mutex::new(None);

    /// Start the watch once. A failure is logged and the app runs without it
    /// (the page still has devicechange).
    pub fn start(app: AppHandle) {
        let mut slot = WATCH.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_some() {
            return;
        }
        let (tx, rx) = channel::<Msg>();
        let for_client = tx.clone();
        match std::thread::Builder::new()
            .name("mic-default-watch".into())
            .spawn(move || run(app, for_client, rx))
        {
            Ok(handle) => *slot = Some((tx, handle)),
            Err(e) => log::warn!("[mic] cannot start the Windows default-input watch: {e}"),
        }
    }

    /// Unregister and end the thread. Bounded: never holds up the app's exit
    /// on a stuck COM call (process exit releases everything anyway).
    pub fn stop() {
        let taken = WATCH.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some((tx, handle)) = taken {
            let _ = tx.send(Msg::Stop);
            drop(tx);
            let deadline = Instant::now() + Duration::from_secs(1);
            while !handle.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
    }

    /// Every active capture endpoint as (id, friendly name), read-only.
    fn capture_names() -> Vec<(String, String)> {
        let Ok(en) = wasapi::DeviceEnumerator::new() else { return vec![] };
        let Ok(col) = en.get_device_collection(&wasapi::Direction::Capture) else { return vec![] };
        let n = col.get_nbr_devices().unwrap_or(0);
        (0..n)
            .filter_map(|i| col.get_device_at_index(i).ok())
            .filter_map(|d| Some((d.get_id().ok()?, d.get_friendlyname().ok()?)))
            .collect()
    }

    fn current_default(role: &wasapi::Role) -> String {
        wasapi::DeviceEnumerator::new()
            .and_then(|en| en.get_default_device_for_role(&wasapi::Direction::Capture, role))
            .and_then(|d| d.get_friendlyname())
            .unwrap_or_else(|_| "(none)".into())
    }

    fn report(app: &AppHandle, b: &Burst) {
        let names = capture_names();
        let console = b.console.as_deref().map(|id| display_name(id, &names));
        let communications = b.communications.as_deref().map(|id| display_name(id, &names));
        log::info!("{}", log_line(b, console.as_deref(), communications.as_deref()));
        let _ = app.emit(EVENT, Payload { roles: b.roles(), console, communications });
    }

    fn run(app: AppHandle, for_client: Sender<Msg>, rx: Receiver<Msg>) {
        // Our own thread, so the apartment is ours to choose; the client is
        // called on Windows' threads either way.
        if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
            log::warn!("[mic] cannot watch the Windows default input (COM: {e})");
            return;
        }
        let registered = (|| -> WinResult<(IMMDeviceEnumerator, IMMNotificationClient)> {
            let en: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
            let client: IMMNotificationClient = Client { tx: for_client }.into();
            unsafe { en.RegisterEndpointNotificationCallback(&client)? };
            Ok((en, client))
        })();
        match registered {
            Err(e) => log::warn!("[mic] cannot watch the Windows default input: {e}"),
            Ok((en, client)) => {
                log::info!(
                    "[mic] watching the Windows default input (now: default -> {}; communications -> {})",
                    current_default(&wasapi::Role::Console),
                    current_default(&wasapi::Role::Communications),
                );
                loop {
                    match rx.recv() {
                        Ok(Msg::Note(n)) => {
                            let (b, stopping) = collect_burst(n, &rx, COALESCE_QUIET, COALESCE_MAX);
                            report(&app, &b);
                            if stopping {
                                break;
                            }
                        }
                        Ok(Msg::Stop) | Err(_) => break,
                    }
                }
                // Unregister BEFORE the last reference goes: Windows holds no
                // reference of its own, and returns only once no callback is
                // running, so the client is never called after this.
                unsafe {
                    let _ = en.UnregisterEndpointNotificationCallback(&client);
                }
                drop(client);
                drop(en);
            }
        }
        unsafe { CoUninitialize() };
    }
}

#[cfg(windows)]
pub use imp::{start, stop};

#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn stop() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn note(role: Role, id: &str) -> Note {
        Note { role, device_id: id.into() }
    }

    #[test]
    fn only_capture_console_and_communications_reach_the_page() {
        // (flow, role): render 0 / capture 1 / all 2; console 0 / multimedia 1 / communications 2
        assert_eq!(watched_role(1, 0), Some(Role::Console));
        assert_eq!(watched_role(1, 2), Some(Role::Communications));
        assert_eq!(watched_role(1, 1), None, "multimedia only doubles console");
        for role in 0..3 {
            assert_eq!(watched_role(0, role), None, "an output default is not the mic's business");
            assert_eq!(watched_role(2, role), None);
        }
        assert_eq!(watched_role(1, 7), None);
    }

    #[test]
    fn a_burst_keeps_the_last_default_per_role_and_counts_every_note() {
        let mut b = Burst::default();
        b.add(note(Role::Console, "{arctis}"));
        b.add(note(Role::Console, "{fma}"));
        b.add(note(Role::Communications, "{fma}"));
        assert_eq!(b.console.as_deref(), Some("{fma}"));
        assert_eq!(b.communications.as_deref(), Some("{fma}"));
        assert_eq!(b.notes, 3);
        assert_eq!(b.roles(), vec!["console", "communications"]);
        let mut only = Burst::default();
        only.add(note(Role::Communications, ""));
        assert_eq!(only.roles(), vec!["communications"]);
    }

    #[test]
    fn notes_already_waiting_join_the_burst_and_a_later_one_starts_the_next() {
        let (tx, rx) = channel();
        tx.send(Msg::Note(note(Role::Communications, "{fma}"))).unwrap();
        tx.send(Msg::Note(note(Role::Console, "{fma}"))).unwrap();
        let (b, stopping) = collect_burst(note(Role::Console, "{x}"), &rx, Duration::from_millis(40), Duration::from_secs(5));
        assert!(!stopping);
        assert_eq!(b.notes, 3);
        assert_eq!(b.console.as_deref(), Some("{fma}"));
        // Sent after the burst went quiet: it is the NEXT burst, not this one.
        tx.send(Msg::Note(note(Role::Console, "{xm6}"))).unwrap();
        let Ok(Msg::Note(n)) = rx.try_recv() else { panic!("the later note must still be queued") };
        assert_eq!(n.device_id, "{xm6}");
    }

    #[test]
    fn notes_trickling_in_within_the_quiet_time_join_until_max() {
        let (tx, rx) = channel();
        let sender = std::thread::spawn(move || {
            for _ in 0..50 {
                if tx.send(Msg::Note(note(Role::Console, "{a}"))).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let t0 = Instant::now();
        let (b, _) = collect_burst(note(Role::Console, "{a}"), &rx, Duration::from_millis(500), Duration::from_millis(120));
        let took = t0.elapsed();
        assert!(took >= Duration::from_millis(120) && took < Duration::from_millis(450), "bounded by max, not quiet: {took:?}");
        assert!(b.notes >= 2, "{b:?}");
        drop(rx);
        let _ = sender.join();
    }

    #[test]
    fn a_stop_or_a_closed_channel_ends_the_burst_and_says_so() {
        let (tx, rx) = channel();
        tx.send(Msg::Stop).unwrap();
        let (b, stopping) = collect_burst(note(Role::Console, "{a}"), &rx, Duration::from_secs(5), Duration::from_secs(5));
        assert!(stopping);
        assert_eq!(b.notes, 1);
        drop(tx);
        let (_, stopping) = collect_burst(note(Role::Console, "{a}"), &rx, Duration::from_secs(5), Duration::from_secs(5));
        assert!(stopping, "every sender gone is a stop too");
    }

    #[test]
    fn log_lines_and_names() {
        let mut b = Burst::default();
        b.add(note(Role::Console, "{0.0.1.00000000}.{fma}"));
        b.add(note(Role::Communications, "{0.0.1.00000000}.{fma}"));
        let names = vec![("{0.0.1.00000000}.{fma}".to_string(), "Microphone (FMA120)".to_string())];
        let n = display_name("{0.0.1.00000000}.{fma}", &names);
        assert_eq!(n, "Microphone (FMA120)");
        assert_eq!(
            log_line(&b, Some(&n), Some(&n)),
            "[mic] Windows default input changed (2 notifications): default -> Microphone (FMA120); communications -> Microphone (FMA120)"
        );
        assert_eq!(display_name("", &names), "(no microphone)");
        // An endpoint not in the list: the id's last 12 characters.
        assert_eq!(display_name("{0.0.1.00000000}.{gone-device}", &names), "(endpoint …gone-device})");
        let mut one = Burst::default();
        one.add(note(Role::Communications, ""));
        assert_eq!(log_line(&one, None, Some("(no microphone)")), "[mic] Windows default input changed (1 notification): communications -> (no microphone)");
    }

    #[test]
    fn the_payload_has_the_shape_the_page_reads() {
        let p = Payload { roles: vec!["console"], console: Some("Microphone (FMA120)".into()), communications: None };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({ "roles": ["console"], "console": "Microphone (FMA120)", "communications": null })
        );
    }

    #[test]
    fn the_page_listens_for_the_event_this_file_emits() {
        let ts = include_str!("../../src/api/micDiag.ts");
        assert!(ts.contains("subscribeNativeMicDefault"), "that is not the real micDiag.ts — the path is wrong and this test checks nothing");
        assert!(
            ts.contains(&format!("export const MIC_DEFAULT_EVENT = '{EVENT}';")),
            "micDiag.ts no longer names {EVENT:?}; the two ends of the event have drifted"
        );
        let wd = include_str!("../../src/api/rtc/micDeviceWatchdog.ts");
        for field in ["roles?: string[];", "console?: string | null;", "communications?: string | null;"] {
            assert!(wd.contains(field), "NativeDefaultChange lost {field:?}");
        }
    }

    /// The real registration on the machine running the test: register,
    /// unregister, release — and the client (with its sender) is really
    /// freed, so nothing of ours keeps it alive. Measured with this test:
    /// it also passes with the Unregister call removed, i.e. Windows holds
    /// NO reference of its own while registered, which is why `run`
    /// unregisters BEFORE releasing (the other order leaves Windows calling
    /// freed memory). Listens only; changes nothing.
    #[cfg(windows)]
    #[test]
    fn registers_and_unregisters_on_this_machine_without_touching_anything() {
        use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator};
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
        std::thread::spawn(|| unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().expect("COM");
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("enumerator");
            let (tx, rx) = channel::<Msg>();
            let client = imp_test_client(tx);
            en.RegisterEndpointNotificationCallback(&client).expect("register");
            en.UnregisterEndpointNotificationCallback(&client).expect("unregister");
            drop(client);
            // The client and its sender are gone: the channel says so.
            assert!(matches!(rx.recv_timeout(Duration::from_millis(50)), Err(RecvTimeoutError::Disconnected)));
            drop(en);
            CoUninitialize();
        })
        .join()
        .expect("thread");
    }

    #[cfg(windows)]
    fn imp_test_client(tx: std::sync::mpsc::Sender<Msg>) -> windows::Win32::Media::Audio::IMMNotificationClient {
        imp::test_client(tx)
    }
}
