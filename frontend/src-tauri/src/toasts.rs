//! Message notifications on Windows that REPLACE one another, one per
//! conversation, instead of stacking one per message.
//!
//! WHY THIS EXISTS. Until this module every message notification went through
//! `tauri-plugin-notification` 2.4.0, whose desktop `show()` hands title and
//! body to `notify-rust` 4.18, which hands them to `tauri-winrt-notification`
//! 0.7.3. That last crate builds a `ToastNotification` and calls
//! `ToastNotifier::Show` with no `Tag` and no `Group` (it sets a tag only for a
//! progress bar), and the plugin drops every other field the page sends
//! (`tag`, `id`, `group`) on the way. Windows replaces a toast only when the new
//! one carries the same Tag AND Group as one it already holds, so a lively
//! channel raised a fresh pop-up, and a fresh notification-centre entry, for
//! every message. Measured on the owner's machine on 2026-11-12, read-only
//! (`ToastNotificationManager.History.GetHistory`): 100 Púca entries in the
//! notification centre (the most Windows keeps), not one with a Tag or a
//! Group, and 77 of the 99 gaps between consecutive ones under a minute.
//!
//! What Windows does with a tag, from Microsoft's own pages ("App
//! notification progress bar and data binding", `ToastNotification.Tag`,
//! `ToastNotification.SuppressPopup`, `ToastNotificationHistory.Remove`):
//! - a toast with the same Tag and Group REPLACES the old one: it moves to
//!   the top of the notification centre and pops up again unless
//!   `SuppressPopup` is set, which "places the toast notification silently
//!   into the action center";
//! - `ToastNotifier::Update` with the same Tag and Group changes the bound
//!   text IN PLACE: no pop-up, no sound, the entry keeps its position; it
//!   reports `NotificationNotFound` when the user has dismissed it;
//! - a tag is at most 64 characters (16 before Windows 10 1703), hence the
//!   16-character hash below;
//! - an unpackaged app removes its own entries with the overloads that take
//!   the app id.
//!
//! The page decides WHEN to pop (api/notifyGroups.ts: the first message of a
//! burst, a mention, a DM again after a while); this module only carries that
//! out: `popup: true` replaces the conversation's toast and pops it,
//! `popup: false` updates it in place, and re-adds it silently when the user
//! had dismissed it. Every toast is silent (`<audio silent="true"/>`), as the
//! plugin's were (notify-rust hands tauri-winrt-notification no sound, which
//! it writes as that same element): the app plays its own message sound.
//!
//! A click lands on the in-process `Activated` handler: it raises the window
//! and tells the page which conversation to open (`toast-activated`). Windows
//! delivers that for a toast still on screen. Púca's Start-menu shortcut
//! carries an AppUserModelID and no ToastActivatorCLSID, so a click on an
//! entry in the notification centre after its pop-up has gone may reach
//! Windows' plain shortcut launch instead, which the single-instance handler
//! turns into "show the window" (lib.rs). Only a real Windows desktop can say
//! which one happens; nothing here may show a toast to find out.

// Off Windows the commands refuse and the rule below is only its tests'.
#![cfg_attr(not(windows), allow(dead_code))]

/// The one Group every message toast is filed under. Removing it removes
/// every message toast and nothing else (Púca Tasks and the plugin's toasts
/// carry no group).
pub const GROUP: &str = "puca-msg";

/// Longest title or body handed to Windows, in characters. A toast shows two
/// or three lines of either; anything longer is a page bug, not a message.
const MAX_TEXT: usize = 160;

/// A conversation key ('chan:<server>:<channel>', 'dm:<id>', …) as a Windows
/// tag: 16 hex characters of FNV-1a 64, so every key fits the oldest limit
/// and the tag says nothing about the conversation it stands for.
pub fn tag_for(key: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The toast's XML. The two lines are BOUND (`{title}`, `{body}`) rather than
/// written in, which is what lets `Update` change them in place, and means no
/// name or channel ever passes through an XML parser.
pub const TOAST_XML: &str = concat!(
    r#"<toast><visual><binding template="ToastGeneric">"#,
    r#"<text>{title}</text><text>{body}</text>"#,
    r#"</binding></visual><audio silent="true"/></toast>"#,
);

fn clamp(s: &str) -> String {
    s.chars().take(MAX_TEXT).collect()
}

/// One request from the page, in the order the page sent them.
#[derive(Debug, Clone, PartialEq)]
pub enum Job {
    Show { key: String, title: String, body: String, popup: bool },
    Clear { key: String },
    ClearAll,
}

/// What `Update` found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Updated {
    InPlace,
    /// Dismissed by the user, removed, or never shown.
    NotFound,
}

/// Where the toasts go: Windows in the app, a recorder in the tests.
pub trait Sink {
    fn show(&mut self, key: &str, tag: &str, title: &str, body: &str, popup: bool, seq: u32) -> Result<(), String>;
    fn update(&mut self, tag: &str, title: &str, body: &str, seq: u32) -> Result<Updated, String>;
    fn remove(&mut self, tag: &str) -> Result<(), String>;
    fn remove_all(&mut self) -> Result<(), String>;
}

/// What a job came to, for the log line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    /// Replaced the conversation's toast and popped it.
    Popped,
    /// Changed its text where it is: no pop-up, no sound.
    Updated,
    /// It was gone (dismissed): put back silently, no pop-up.
    ReAddedQuietly,
    Cleared,
    Failed,
}

/// The rule, apart from Windows so it can be tested. Sequence numbers only
/// ever rise: Windows ignores an update whose number is not newer than the
/// data the toast already carries.
pub struct Toasts<S: Sink> {
    pub sink: S,
    seq: u32,
}

impl<S: Sink> Toasts<S> {
    pub fn new(sink: S) -> Self {
        Self { sink, seq: 0 }
    }

    fn next_seq(&mut self) -> u32 {
        self.seq = self.seq.wrapping_add(1).max(1);
        self.seq
    }

    pub fn handle(&mut self, job: Job) -> Outcome {
        match job {
            Job::Show { key, title, body, popup } => {
                let tag = tag_for(&key);
                let (title, body) = (clamp(&title), clamp(&body));
                let seq = self.next_seq();
                if popup {
                    return match self.sink.show(&key, &tag, &title, &body, true, seq) {
                        Ok(()) => Outcome::Popped,
                        Err(e) => { log::warn!("[notify] toast show failed: {e}"); Outcome::Failed }
                    };
                }
                match self.sink.update(&tag, &title, &body, seq) {
                    Ok(Updated::InPlace) => Outcome::Updated,
                    Ok(Updated::NotFound) | Err(_) => {
                        // Dismissed (or the update itself failed): the
                        // notification centre should still hold one entry
                        // saying what is waiting, so put it back without a
                        // pop-up. A new sequence number: the old data's is
                        // gone with it.
                        let seq = self.next_seq();
                        match self.sink.show(&key, &tag, &title, &body, false, seq) {
                            Ok(()) => Outcome::ReAddedQuietly,
                            Err(e) => { log::warn!("[notify] quiet toast failed: {e}"); Outcome::Failed }
                        }
                    }
                }
            }
            Job::Clear { key } => match self.sink.remove(&tag_for(&key)) {
                Ok(()) => Outcome::Cleared,
                // Usually "not there": nothing to remove is not a failure.
                Err(_) => Outcome::Cleared,
            },
            Job::ClearAll => match self.sink.remove_all() {
                Ok(()) => Outcome::Cleared,
                Err(_) => Outcome::Cleared,
            },
        }
    }
}

// --- Windows -------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::{Sink, Updated, GROUP, TOAST_XML};
    use std::collections::VecDeque;
    use tauri::{AppHandle, Emitter};
    use windows::core::{IInspectable, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        NotificationData, NotificationUpdateResult, ToastNotification, ToastNotificationManager, ToastNotifier,
    };

    /// `notify-rust`'s fallback, used by the plugin for a build that runs out
    /// of `target\debug` or `target\release`: such a build has no Start-menu
    /// shortcut carrying the app's id, and Windows shows nothing for an id
    /// with none.
    const POWERSHELL_APP_ID: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

    /// The id the toasts are filed under: the plugin's own rule
    /// (tauri-plugin-notification 2.4.0, desktop.rs), so these and its
    /// toasts (Púca Tasks) share one entry in Windows' settings.
    pub fn app_id(identifier: &str) -> String {
        let dev = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.display().to_string()))
            .is_some_and(|d| d.ends_with("\\target\\debug") || d.ends_with("\\target\\release"));
        if dev { POWERSHELL_APP_ID.to_string() } else { identifier.to_string() }
    }

    /// How many toast objects to keep alive. Each holds its click handler;
    /// a conversation's newest replaces its older one. As many as the page
    /// keeps conversations (api/notifyGroups.ts, MAX_GROUPS).
    const KEEP: usize = 200;

    pub struct WinSink {
        app: AppHandle,
        app_id: HSTRING,
        notifier: Option<ToastNotifier>,
        live: VecDeque<(String, ToastNotification)>,
    }

    impl WinSink {
        pub fn new(app: AppHandle, app_id: String) -> Self {
            Self { app, app_id: HSTRING::from(app_id), notifier: None, live: VecDeque::new() }
        }

        fn notifier(&mut self) -> Result<ToastNotifier, String> {
            if let Some(n) = &self.notifier {
                return Ok(n.clone());
            }
            let n = ToastNotificationManager::CreateToastNotifierWithId(&self.app_id).map_err(|e| e.to_string())?;
            self.notifier = Some(n.clone());
            Ok(n)
        }

        fn keep(&mut self, tag: &str, toast: ToastNotification) {
            self.live.retain(|(t, _)| t != tag);
            self.live.push_back((tag.to_string(), toast));
            while self.live.len() > KEEP {
                self.live.pop_front();
            }
        }
    }

    pub fn data(title: &str, body: &str, seq: u32) -> windows::core::Result<NotificationData> {
        let data = NotificationData::new()?;
        let values = data.Values()?;
        values.Insert(&HSTRING::from("title"), &HSTRING::from(title))?;
        values.Insert(&HSTRING::from("body"), &HSTRING::from(body))?;
        data.SetSequenceNumber(seq)?;
        Ok(data)
    }

    /// The toast object, without showing it.
    pub fn build(tag: &str, title: &str, body: &str, popup: bool, seq: u32) -> windows::core::Result<ToastNotification> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(TOAST_XML))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        toast.SetTag(&HSTRING::from(tag))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        toast.SetSuppressPopup(!popup)?;
        toast.SetData(&data(title, body, seq)?)?;
        Ok(toast)
    }

    impl Sink for WinSink {
        fn show(&mut self, key: &str, tag: &str, title: &str, body: &str, popup: bool, seq: u32) -> Result<(), String> {
            let toast = build(tag, title, body, popup, seq).map_err(|e| e.to_string())?;
            let app = self.app.clone();
            let key = key.to_string();
            toast
                .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
                    super::activated(&app, &key);
                    Ok(())
                }))
                .map_err(|e| e.to_string())?;
            self.notifier()?.Show(&toast).map_err(|e| e.to_string())?;
            self.keep(tag, toast);
            Ok(())
        }

        fn update(&mut self, tag: &str, title: &str, body: &str, seq: u32) -> Result<Updated, String> {
            let data = data(title, body, seq).map_err(|e| e.to_string())?;
            let r = self
                .notifier()?
                .UpdateWithTagAndGroup(&data, &HSTRING::from(tag), &HSTRING::from(GROUP))
                .map_err(|e| e.to_string())?;
            Ok(if r == NotificationUpdateResult::Succeeded { Updated::InPlace } else { Updated::NotFound })
        }

        fn remove(&mut self, tag: &str) -> Result<(), String> {
            self.live.retain(|(t, _)| t != tag);
            ToastNotificationManager::History()
                .and_then(|h| h.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(GROUP), &self.app_id))
                .map_err(|e| e.to_string())
        }

        fn remove_all(&mut self) -> Result<(), String> {
            self.live.clear();
            ToastNotificationManager::History()
                .and_then(|h| h.RemoveGroupWithId(&HSTRING::from(GROUP), &self.app_id))
                .map_err(|e| e.to_string())
        }
    }

    /// Sent to the page when a toast is clicked; the payload is the key.
    pub const ACTIVATED_EVENT: &str = "toast-activated";

    pub fn emit_activated(app: &AppHandle, key: &str) {
        let _ = app.emit_to("main", ACTIVATED_EVENT, key.to_string());
    }
}

/// A click on a toast: the window comes up ("raise": a click is the one
/// user-initiated path attention_main_window allows it for) and the page
/// opens that conversation.
#[cfg(windows)]
fn activated(app: &tauri::AppHandle, key: &str) {
    crate::attention_main_window(app.clone(), None, Some("raise".to_string()));
    win::emit_activated(app, key);
}

#[cfg(windows)]
static WORKER: std::sync::OnceLock<crate::ordered_worker::OrderedWorker<Job>> = std::sync::OnceLock::new();

#[cfg(windows)]
fn send(app: &tauri::AppHandle, job: Job) -> Result<(), String> {
    let worker = WORKER.get_or_init(|| {
        let app = app.clone();
        let mut toasts: Option<Toasts<win::WinSink>> = None;
        // One thread, in order: a quiet update must never overtake the
        // pop-up it updates. Off the UI thread, which a sync command runs on
        // (ordered_worker.rs), in its own MTA as heif.rs does.
        crate::ordered_worker::OrderedWorker::spawn("toasts", move |job: Job| {
            let t = toasts.get_or_insert_with(|| {
                let _ = unsafe {
                    windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED)
                };
                let id = win::app_id(&app.config().identifier);
                Toasts::new(win::WinSink::new(app.clone(), id))
            });
            let what = match &job { Job::Show { popup: true, .. } => "show", Job::Show { .. } => "update", Job::Clear { .. } => "clear", Job::ClearAll => "clear-all" };
            let outcome = t.handle(job);
            log::debug!("[notify] toast {what}: {outcome:?}");
        })
    });
    worker.send(job).map_err(|_| "the toast worker is gone".to_string())
}

/// Show or update the toast for one conversation (see the module header).
/// Returns as soon as the request is queued; the page falls back to the
/// plugin only when this command itself is missing or refuses.
#[tauri::command]
pub fn toast_show(app: tauri::AppHandle, key: String, title: String, body: String, popup: bool) -> Result<(), String> {
    if key.is_empty() {
        return Err("a toast needs a key".into());
    }
    #[cfg(windows)]
    {
        send(&app, Job::Show { key, title, body, popup })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body, popup);
        Err("toasts that replace each other are Windows-only".into())
    }
}

/// Take one conversation's toast out of the notification centre (it was read
/// in the app, or clicked).
#[tauri::command]
pub fn toast_clear(app: tauri::AppHandle, key: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        send(&app, Job::Clear { key })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, key);
        Err("Windows-only".into())
    }
}

/// Take every message toast out (sign-out).
#[tauri::command]
pub fn toast_clear_all(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        send(&app, Job::ClearAll)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Windows-only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What reached "Windows", one line per call, and a model of what the
    /// notification centre then holds, by Microsoft's documented rules: a
    /// show with a tag replaces that tag's entry, an update changes one that
    /// is there and fails on one that is not.
    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
        centre: Vec<(String, String, String)>,
        popups: usize,
        fail_update: bool,
    }

    impl Sink for Recorder {
        fn show(&mut self, _key: &str, tag: &str, title: &str, body: &str, popup: bool, seq: u32) -> Result<(), String> {
            self.calls.push(format!("show {tag} popup={popup} seq={seq}"));
            self.centre.retain(|(t, _, _)| t != tag);
            self.centre.push((tag.to_string(), title.to_string(), body.to_string()));
            if popup {
                self.popups += 1;
            }
            Ok(())
        }
        fn update(&mut self, tag: &str, title: &str, body: &str, seq: u32) -> Result<Updated, String> {
            self.calls.push(format!("update {tag} seq={seq}"));
            if self.fail_update {
                return Err("E_FAIL".into());
            }
            match self.centre.iter_mut().find(|(t, _, _)| t == tag) {
                Some(entry) => {
                    entry.1 = title.to_string();
                    entry.2 = body.to_string();
                    Ok(Updated::InPlace)
                }
                None => Ok(Updated::NotFound),
            }
        }
        fn remove(&mut self, tag: &str) -> Result<(), String> {
            self.calls.push(format!("remove {tag}"));
            self.centre.retain(|(t, _, _)| t != tag);
            Ok(())
        }
        fn remove_all(&mut self) -> Result<(), String> {
            self.calls.push("remove-all".into());
            self.centre.clear();
            Ok(())
        }
    }

    fn show(key: &str, body: &str, popup: bool) -> Job {
        Job::Show { key: key.into(), title: "#general".into(), body: body.into(), popup }
    }

    #[test]
    fn a_tag_is_16_hex_characters_stable_and_distinct_per_conversation() {
        let a = tag_for("chan:6f1c2b9e-7d42-4f0a-9a51-3c2d1e0f9b8a:1234567890123");
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, tag_for("chan:6f1c2b9e-7d42-4f0a-9a51-3c2d1e0f9b8a:1234567890123"));
        assert_ne!(a, tag_for("chan:6f1c2b9e-7d42-4f0a-9a51-3c2d1e0f9b8a:1234567890124"));
        assert_ne!(tag_for("dm:1"), tag_for("dm:2"));
        // FNV-1a 64 of the empty string is its offset basis: the hash is the
        // published one, not something that happens to look like it.
        assert_eq!(tag_for(""), "cbf29ce484222325");
    }

    #[test]
    fn a_burst_in_one_conversation_is_one_entry_that_popped_once() {
        let mut t = Toasts::new(Recorder::default());
        assert_eq!(t.handle(show("chan:s:1", "alice sent a message", true)), Outcome::Popped);
        for n in 2..=20 {
            assert_eq!(t.handle(show("chan:s:1", &format!("alice and 2 others: {n} new messages"), false)), Outcome::Updated);
        }
        assert_eq!(t.sink.centre.len(), 1);
        assert_eq!(t.sink.popups, 1);
        assert_eq!(t.sink.centre[0].2, "alice and 2 others: 20 new messages");
        // Every update carries a newer number than the data before it.
        let seqs: Vec<u32> = t.sink.calls.iter().map(|c| c.rsplit("seq=").next().unwrap().parse().unwrap()).collect();
        assert!(seqs.windows(2).all(|w| w[1] > w[0]), "{seqs:?}");
    }

    #[test]
    fn two_conversations_are_two_entries() {
        let mut t = Toasts::new(Recorder::default());
        t.handle(show("chan:s:1", "a", true));
        t.handle(show("dm:9", "b", true));
        t.handle(show("chan:s:1", "c", false));
        t.handle(show("dm:9", "d", false));
        assert_eq!(t.sink.centre.len(), 2);
        assert_eq!(t.sink.popups, 2);
    }

    #[test]
    fn a_dismissed_toast_comes_back_quietly_not_as_a_pop_up() {
        let mut t = Toasts::new(Recorder::default());
        t.handle(show("chan:s:1", "a", true));
        t.sink.centre.clear(); // the user swiped it away
        assert_eq!(t.handle(show("chan:s:1", "b", false)), Outcome::ReAddedQuietly);
        assert_eq!(t.sink.popups, 1);
        assert_eq!(t.sink.centre.len(), 1);
        let last = t.sink.calls.last().unwrap();
        assert!(last.contains("popup=false"), "{last}");
    }

    #[test]
    fn an_update_windows_refuses_also_falls_back_to_a_quiet_show() {
        let mut t = Toasts::new(Recorder { fail_update: true, ..Default::default() });
        t.handle(show("chan:s:1", "a", true));
        assert_eq!(t.handle(show("chan:s:1", "b", false)), Outcome::ReAddedQuietly);
        assert_eq!(t.sink.popups, 1);
        assert_eq!(t.sink.centre.len(), 1);
    }

    #[test]
    fn a_pop_replaces_the_entry_rather_than_adding_one() {
        let mut t = Toasts::new(Recorder::default());
        t.handle(show("dm:9", "one", true));
        t.handle(show("dm:9", "two", true));
        assert_eq!(t.sink.centre.len(), 1);
        assert_eq!(t.sink.popups, 2);
    }

    #[test]
    fn clearing_takes_out_only_that_conversation_and_clear_all_takes_every_one() {
        let mut t = Toasts::new(Recorder::default());
        t.handle(show("chan:s:1", "a", true));
        t.handle(show("dm:9", "b", true));
        assert_eq!(t.handle(Job::Clear { key: "chan:s:1".into() }), Outcome::Cleared);
        assert_eq!(t.sink.centre.len(), 1);
        assert_eq!(t.sink.centre[0].0, tag_for("dm:9"));
        t.handle(Job::ClearAll);
        assert!(t.sink.centre.is_empty());
    }

    #[test]
    fn titles_and_bodies_are_clamped() {
        let mut t = Toasts::new(Recorder::default());
        let long = "x".repeat(1000);
        t.handle(Job::Show { key: "k".into(), title: long.clone(), body: long, popup: true });
        assert_eq!(t.sink.centre[0].1.chars().count(), MAX_TEXT);
        assert_eq!(t.sink.centre[0].2.chars().count(), MAX_TEXT);
    }

    #[test]
    fn every_toast_is_silent_and_its_lines_are_bound_not_written_in() {
        assert!(TOAST_XML.contains(r#"<audio silent="true"/>"#));
        assert!(TOAST_XML.contains("<text>{title}</text><text>{body}</text>"));
        assert!(TOAST_XML.contains(r#"template="ToastGeneric""#));
    }

    /// The real WinRT objects, built and never shown: the XML parses, the tag,
    /// group, pop-up flag and bound data are accepted and read back. Nothing
    /// here calls `Show`, so nothing can appear on screen.
    #[cfg(windows)]
    #[test]
    fn the_real_toast_object_takes_the_tag_group_and_bound_lines() {
        let tag = tag_for("chan:s:1");
        let toast = win::build(&tag, "#general · Server <&>", "alice and 2 others: 5 new messages", false, 7).unwrap();
        assert_eq!(toast.Tag().unwrap().to_string(), tag);
        assert_eq!(toast.Group().unwrap().to_string(), GROUP);
        assert!(toast.SuppressPopup().unwrap());
        let data = toast.Data().unwrap();
        assert_eq!(data.SequenceNumber().unwrap(), 7);
        let values = data.Values().unwrap();
        // Markup in a name stays text: it is a bound value, never XML.
        assert_eq!(values.Lookup(&windows::core::HSTRING::from("title")).unwrap().to_string(), "#general · Server <&>");
        let popped = win::build(&tag, "t", "b", true, 8).unwrap();
        assert!(!popped.SuppressPopup().unwrap());
    }
}
