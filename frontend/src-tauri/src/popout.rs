//! Púca's OWN stream pop-out windows (desktop only).
//!
//! WHY NOT THE OS PICTURE-IN-PICTURE. Chromium's video PiP window is capped at
//! 80% of the work area and aspect-locked (video_overlay_window_views.cc), and a
//! document holds ONE PiP window — so "make it bigger" and "pop out several
//! streams" were both impossible on the engines the web has. These are ordinary
//! top-level windows: always-on-top by default (a per-window pin), resizable up
//! to the whole screen (maximize included), one per popped stream.
//!
//! HOW. The main webview calls `window.open("about:blank#puca-pop-<slot>")`.
//! WebView2 raises NewWindowRequested; Tauri hands it to [`open_requested`]
//! (registered with `on_new_window` on the main window, lib.rs), which builds a
//! WebviewWindow labelled `pop-<slot>` in the SAME WebView2 environment and
//! returns it as the request's new window. Because the window is supplied
//! through NewWindowRequested, WebView2 keeps the opener relationship: the
//! popup is a same-origin, same-renderer `about:blank` document the MAIN realm
//! scripts directly, so the frontend portals a `<video>` into it bound to the
//! SAME MediaStream the app already decodes. Nothing is re-negotiated,
//! re-decoded or sent over IPC, and the popup's own realm runs no Púca code.
//!
//! WHAT IS REFUSED. Every other new-window request is denied, exactly as before
//! this module existed (wry's default with no handler was "handled, no window"):
//! links still leave through `open_external`. The popup itself can only ever
//! show `about:blank` ([`popout_navigation_allowed`]), and its own window.open
//! has no handler, so it is denied too.
//!
//! IPC IN THE POPUP. The pop-out labels are in no capability
//! (capabilities/default.json lists only `main`), yet the spike MEASURED that
//! the popup realm's `__TAURI_INTERNALS__.invoke` answers both an app command
//! and a core window command. Do not rely on the capability file to fence it.
//! It grants nothing new: the popup is a same-origin `about:blank` document
//! that cannot be navigated anywhere else and whose only script is the MAIN
//! realm reaching into it — anything able to run code there already runs in
//! the main window with the main window's grants.
//!
//! WINDOW STATE. Size, position and pin are remembered per SLOT (the n-th
//! pop-out open at once), not per person, in `popout-windows.json` under the
//! app config dir — geometry only. A remembered rectangle that no longer
//! touches any monitor (a display was unplugged) is re-placed; one larger than
//! its monitor is shrunk to fit. See [`place`].
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

/// How many pop-outs may be open at once. Each is one HWND plus a compositor
/// surface showing a track the app already decodes; the cap only exists so a
/// runaway caller cannot open windows without bound.
pub const MAX_POPOUTS: u32 = 8;
/// What the frontend opens. The fragment carries the slot: the window NAME
/// (`window.open`'s second argument) never reaches the handler — wry passes
/// only the URI and the size/position features.
pub const URL_PREFIX: &str = "about:blank#puca-pop-";
pub const LABEL_PREFIX: &str = "pop-";
/// The default content size, logical px (16:9). The window is not
/// aspect-locked: the video letterboxes.
const DEFAULT_W: f64 = 480.0;
const DEFAULT_H: f64 = 270.0;
const MIN_W: f64 = 160.0;
const MIN_H: f64 = 90.0;
/// Gap from the work-area edge for a first placement, and the cascade step
/// between slots so two new windows never sit exactly on top of each other.
const MARGIN: i32 = 24;
const CASCADE: i32 = 32;
const STORE_FILE: &str = "popout-windows.json";

/// The slot a `window.open` URL asks for — `None` for anything that is not
/// exactly `about:blank#puca-pop-<1..=MAX_POPOUTS>`. This is the whole filter
/// between "a page asked for a window" and "a window exists", so it is strict:
/// no leading zeros, no sign, no trailing text, nothing but the one fragment.
pub fn requested_slot(url: &str) -> Option<u32> {
    let rest = url.strip_prefix(URL_PREFIX)?;
    if rest.is_empty() || rest.len() > 3 || rest.starts_with('0') {
        return None;
    }
    if !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = rest.parse().ok()?;
    (1..=MAX_POPOUTS).contains(&n).then_some(n)
}

pub fn label_for(slot: u32) -> String {
    format!("{LABEL_PREFIX}{slot}")
}

/// The slot of a pop-out window label, `None` for every other window.
pub fn slot_of_label(label: &str) -> Option<u32> {
    let rest = label.strip_prefix(LABEL_PREFIX)?;
    requested_slot(&format!("{URL_PREFIX}{rest}"))
}

pub fn is_popout_label(label: &str) -> bool {
    slot_of_label(label).is_some()
}

/// Close-to-tray applies to the MAIN window only. The handler in lib.rs runs
/// for every window; without this a pop-out's X would hide it instead of
/// closing it — an invisible always-on-top window still holding the stream,
/// and a toggle in the app that still says "popped".
pub fn close_hides_to_tray(label: &str, close_to_tray: bool) -> bool {
    close_to_tray && label == "main"
}

/// The only document a pop-out may ever show: `about:blank` (with or without
/// the slot fragment). A file dropped on it, or anything else that tries to
/// navigate it, is refused.
pub fn popout_navigation_allowed(url: &str) -> bool {
    match url.split_once('#') {
        Some((base, _)) => base == "about:blank",
        None => url == "about:blank",
    }
}

/// The window title: the page's document title (the streamer's name, set by
/// the frontend), stripped of control characters and bounded. Empty → "Púca".
pub fn window_title(doc_title: &str) -> String {
    let t: String = doc_title.chars().filter(|c| !c.is_control()).take(100).collect();
    let t = t.trim();
    if t.is_empty() || t == "about:blank" {
        "Púca".to_string()
    } else {
        t.to_string()
    }
}

/// A rectangle in PHYSICAL pixels. For a saved window `x`/`y` is the OUTER
/// position (what Moved reports and set_position takes) and `w`/`h` the INNER
/// size (what Resized reports and set_size takes) — the same pairing
/// tauri-plugin-window-state uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    fn intersection_area(&self, o: &Rect) -> u64 {
        let l = (self.x as i64).max(o.x as i64);
        let t = (self.y as i64).max(o.y as i64);
        let r = (self.x as i64 + self.w as i64).min(o.x as i64 + o.w as i64);
        let b = (self.y as i64 + self.h as i64).min(o.y as i64 + o.h as i64);
        if r <= l || b <= t {
            0
        } else {
            ((r - l) * (b - t)) as u64
        }
    }
}

/// Where a pop-out goes. `saved` is its slot's remembered geometry, `work` the
/// work areas of the monitors present NOW, `anchor` the work area of the
/// monitor the main window is on, `default_inner` the default content size and
/// `frame` the window-frame overhead (outer − inner), all physical.
///
/// - A saved window that still overlaps a monitor stays where it was, on the
///   monitor it overlaps most — shrunk to fit that monitor's work area if it is
///   now bigger than it, and pulled fully onto it. There is NO other size cap:
///   a window may be as large as the work area (and maximize beyond the frame).
/// - Otherwise (first use, or its monitor is gone) it opens at the default
///   size in the bottom-right of the anchor monitor, cascaded by slot.
pub fn place(
    saved: Option<Rect>,
    work: &[Rect],
    anchor: Rect,
    default_inner: (u32, u32),
    frame: (u32, u32),
    slot: u32,
) -> Rect {
    let (fw, fh) = frame;
    let restored = saved.and_then(|r| {
        let outer = Rect { x: r.x, y: r.y, w: r.w.saturating_add(fw), h: r.h.saturating_add(fh) };
        work.iter()
            .map(|m| (m.intersection_area(&outer), *m))
            .filter(|(a, _)| *a > 0)
            .max_by_key(|(a, _)| *a)
            .map(|(_, m)| (r, m))
    });
    let (mut r, wa) = match restored {
        Some(v) => v,
        None => {
            let (w, h) = default_inner;
            let step = CASCADE * (slot.saturating_sub(1).min(MAX_POPOUTS) as i32);
            let x = anchor.x + anchor.w as i32 - (w + fw) as i32 - MARGIN - step;
            let y = anchor.y + anchor.h as i32 - (h + fh) as i32 - MARGIN - step;
            (Rect { x, y, w, h }, anchor)
        }
    };
    // Size: never bigger than the work area it is on (frame included).
    r.w = r.w.min(wa.w.saturating_sub(fw)).max(1);
    r.h = r.h.min(wa.h.saturating_sub(fh)).max(1);
    // Position: the whole outer box on that work area.
    let max_x = wa.x + (wa.w - (r.w + fw).min(wa.w)) as i32;
    let max_y = wa.y + (wa.h - (r.h + fh).min(wa.h)) as i32;
    r.x = r.x.clamp(wa.x, max_x);
    r.y = r.y.clamp(wa.y, max_y);
    r
}

fn default_pinned() -> bool {
    true
}

/// What is remembered for one slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotRecord {
    #[serde(default)]
    pub rect: Option<Rect>,
    /// Always-on-top. New slots start pinned — floating over everything is
    /// what a pop-out is for; the pin turns it into an ordinary window.
    #[serde(default = "default_pinned")]
    pub pinned: bool,
}

impl Default for SlotRecord {
    fn default() -> Self {
        SlotRecord { rect: None, pinned: true }
    }
}

/// Parse the store, ignoring anything malformed: a bad file must never stop a
/// window opening, it only forgets geometry.
pub fn parse_store(raw: &str) -> HashMap<u32, SlotRecord> {
    let parsed: HashMap<String, SlotRecord> = serde_json::from_str(raw).unwrap_or_default();
    parsed
        .into_iter()
        .filter_map(|(k, v)| {
            let slot: u32 = k.parse().ok()?;
            (1..=MAX_POPOUTS).contains(&slot).then_some((slot, v))
        })
        .collect()
}

fn render_store(map: &HashMap<u32, SlotRecord>) -> String {
    let as_str: std::collections::BTreeMap<String, SlotRecord> =
        map.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    serde_json::to_string_pretty(&as_str).unwrap_or_else(|_| "{}".into())
}

#[derive(Default)]
pub struct PopoutState {
    records: Mutex<HashMap<u32, SlotRecord>>,
    path: Mutex<Option<PathBuf>>,
}

impl PopoutState {
    /// Load the remembered slots from the app config dir (missing = none).
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let path = app.path().app_config_dir().ok().map(|d| d.join(STORE_FILE));
        let records = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|raw| parse_store(&raw))
            .unwrap_or_default();
        PopoutState { records: Mutex::new(records), path: Mutex::new(path) }
    }

    fn record(&self, slot: u32) -> SlotRecord {
        self.records.lock().map(|m| m.get(&slot).copied().unwrap_or_default()).unwrap_or_default()
    }

    fn update(&self, slot: u32, f: impl FnOnce(&mut SlotRecord)) {
        if let Ok(mut m) = self.records.lock() {
            f(m.entry(slot).or_default());
        }
    }

    fn save(&self) {
        let body = match self.records.lock() {
            Ok(m) => render_store(&m),
            Err(_) => return,
        };
        let Ok(path) = self.path.lock() else { return };
        if let Some(p) = path.as_ref() {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Err(e) = std::fs::write(p, body) {
                log::warn!("[popout] could not save window state: {e}");
            }
        }
    }
}

fn monitor_work_area(m: &tauri::Monitor) -> Rect {
    let wa = m.work_area();
    Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height }
}

/// Put a freshly built (still hidden) pop-out where [`place`] says.
fn position_new<R: Runtime>(app: &AppHandle<R>, w: &WebviewWindow<R>, slot: u32, saved: Option<Rect>) {
    let work: Vec<Rect> = w
        .available_monitors()
        .map(|ms| ms.iter().map(monitor_work_area).collect())
        .unwrap_or_default();
    let main_monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    let (anchor, scale) = match main_monitor.as_ref() {
        Some(m) => (monitor_work_area(m), m.scale_factor()),
        None => match work.first() {
            Some(r) => (*r, 1.0),
            None => return, // no monitor information at all: leave it to the OS
        },
    };
    let frame = match (w.outer_size(), w.inner_size()) {
        (Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    };
    let default_inner = ((DEFAULT_W * scale).round() as u32, (DEFAULT_H * scale).round() as u32);
    let r = place(saved, &work, anchor, default_inner, frame, slot);
    let _ = w.set_size(PhysicalSize { width: r.w, height: r.h });
    let _ = w.set_position(PhysicalPosition { x: r.x, y: r.y });
}

/// Remember the slot's geometry as the user moves and resizes it, and write it
/// out when the window goes away.
fn track<R: Runtime>(w: &WebviewWindow<R>, slot: u32) {
    let app = w.app_handle().clone();
    let win = w.clone();
    w.on_window_event(move |e| {
        let Some(state) = app.try_state::<PopoutState>() else { return };
        let steady = !win.is_minimized().unwrap_or(false) && !win.is_maximized().unwrap_or(false);
        match e {
            WindowEvent::Moved(p) if steady => state.update(slot, |r| {
                let mut rect = r.rect.unwrap_or(Rect { x: 0, y: 0, w: 0, h: 0 });
                rect.x = p.x;
                rect.y = p.y;
                r.rect = Some(rect);
            }),
            WindowEvent::Resized(s) if steady && s.width > 0 && s.height > 0 => state.update(slot, |r| {
                let mut rect = r.rect.unwrap_or(Rect { x: 0, y: 0, w: 0, h: 0 });
                rect.w = s.width;
                rect.h = s.height;
                r.rect = Some(rect);
            }),
            WindowEvent::Destroyed => state.save(),
            _ => {}
        }
    });
}

/// The main window's new-window handler. Only a pop-out request becomes a
/// window; everything else is denied, as it was before this handler existed.
pub fn open_requested<R: Runtime>(
    app: &AppHandle<R>,
    url: &Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<R> {
    let Some(slot) = requested_slot(url.as_str()) else {
        // Never the URL itself: it can be anything a page asked for.
        log::info!("[popout] refused a new-window request (not a pop-out)");
        return NewWindowResponse::Deny;
    };
    let label = label_for(slot);
    if app.get_webview_window(&label).is_some() {
        log::warn!("[popout] slot {slot} is already open; refused");
        return NewWindowResponse::Deny;
    }
    let record = app.try_state::<PopoutState>().map(|s| s.record(slot)).unwrap_or_default();
    let Ok(blank) = "about:blank".parse::<Url>() else { return NewWindowResponse::Deny };
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        // The SAME WebView2 environment as the opener — required for a window
        // handed back through NewWindowRequested (Tauri's NewWindowResponse
        // docs), and what keeps it in the opener's browser process.
        .window_features(features)
        .title("Púca")
        .always_on_top(record.pinned)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .min_inner_size(MIN_W, MIN_H)
        .inner_size(DEFAULT_W, DEFAULT_H)
        // Built hidden, placed, then shown: no flash at the default spot.
        .visible(false)
        .on_document_title_changed(|w, t| {
            let _ = w.set_title(&window_title(&t));
        })
        .on_navigation(|u| popout_navigation_allowed(u.as_str()))
        .build();
    match built {
        Ok(w) => {
            position_new(app, &w, slot, record.rect);
            track(&w, slot);
            let _ = w.show();
            log::info!("[popout] opened slot {slot} (pinned={})", record.pinned);
            NewWindowResponse::Create { window: w }
        }
        Err(e) => {
            log::warn!("[popout] could not build slot {slot}: {e}");
            NewWindowResponse::Deny
        }
    }
}

/// Close every pop-out. The main page reloading or going away leaves them
/// with no opener — blank windows nothing can ever fill again.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, w) in app.webview_windows() {
        if is_popout_label(&label) {
            let _ = w.destroy();
        }
    }
}

/// Feature probe for the frontend: a shell that answers this has pop-out
/// windows. An older shell rejects the invoke, and the frontend keeps the
/// browser PiP engines.
#[tauri::command]
pub fn popout_supported() -> bool {
    true
}

/// Close a pop-out from the app ("Bring back", the stream ending, the app
/// navigating away). NOT the popup's own `window.close()`: wry answers a
/// script close by destroying only the webview's container HWND, which left
/// the top-level window standing as an empty, always-on-top frame — and its
/// label taken, so the slot could never open again (measured in the spike).
#[tauri::command]
pub fn popout_close<R: Runtime>(app: AppHandle<R>, slot: u32) -> Result<(), String> {
    if !(1..=MAX_POPOUTS).contains(&slot) {
        return Err(format!("no pop-out slot {slot}"));
    }
    if let Some(w) = app.get_webview_window(&label_for(slot)) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read (`pinned: None`) or set a pop-out slot's always-on-top pin. The
/// setting is remembered for the slot and applied to its window if open.
#[tauri::command]
pub fn popout_pin<R: Runtime>(app: AppHandle<R>, slot: u32, pinned: Option<bool>) -> Result<bool, String> {
    if !(1..=MAX_POPOUTS).contains(&slot) {
        return Err(format!("no pop-out slot {slot}"));
    }
    let state = app.try_state::<PopoutState>().ok_or("pop-out state missing")?;
    if let Some(p) = pinned {
        state.update(slot, |r| r.pinned = p);
        if let Some(w) = app.get_webview_window(&label_for(slot)) {
            w.set_always_on_top(p).map_err(|e| e.to_string())?;
        }
        state.save();
    }
    Ok(state.record(slot).pinned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_popout_urls_are_accepted() {
        assert_eq!(requested_slot("about:blank#puca-pop-1"), Some(1));
        assert_eq!(requested_slot(&format!("about:blank#puca-pop-{MAX_POPOUTS}")), Some(MAX_POPOUTS));
        for bad in [
            "about:blank",
            "about:blank#",
            "about:blank#puca-pop-",
            "about:blank#puca-pop-0",
            "about:blank#puca-pop-01",
            "about:blank#puca-pop--1",
            "about:blank#puca-pop-+1",
            "about:blank#puca-pop-1x",
            "about:blank#puca-pop-1#2",
            "about:blank#puca-pop-1 ",
            "about:blank#puca-pop-9999",
            "about:blank?x#puca-pop-1",
            "about:srcdoc#puca-pop-1",
            "https://evil.example/#puca-pop-1",
            "http://tauri.localhost/#puca-pop-1",
            "ABOUT:BLANK#puca-pop-1",
            "javascript:alert(1)//about:blank#puca-pop-1",
            "",
        ] {
            assert_eq!(requested_slot(bad), None, "{bad:?} must be refused");
        }
        assert_eq!(requested_slot(&format!("about:blank#puca-pop-{}", MAX_POPOUTS + 1)), None);
    }

    /// The same filter as Tauri hands it over: through url::Url, which
    /// normalises. A request that only matches before parsing (or only after)
    /// would be a hole.
    #[test]
    fn the_filter_holds_after_url_parsing() {
        let ok: Url = "about:blank#puca-pop-3".parse().unwrap();
        assert_eq!(requested_slot(ok.as_str()), Some(3));
        let upper: Url = "ABOUT:blank#puca-pop-3".parse().unwrap();
        // url lowercases the scheme — that is still the pop-out request.
        assert_eq!(requested_slot(upper.as_str()), Some(3));
        for bad in ["https://example.com/#puca-pop-1", "about:blank", "data:text/html,#puca-pop-1"] {
            let u: Url = bad.parse().unwrap();
            assert_eq!(requested_slot(u.as_str()), None, "{bad}");
        }
    }

    #[test]
    fn labels_round_trip_and_nothing_else_is_a_popout() {
        for s in 1..=MAX_POPOUTS {
            assert_eq!(slot_of_label(&label_for(s)), Some(s));
        }
        for bad in ["main", "pop-", "pop-0", "pop-01", "pop-x", "pop-1 ", "popout-1", "Pop-1"] {
            assert!(!is_popout_label(bad), "{bad}");
        }
    }

    #[test]
    fn close_to_tray_hides_only_the_main_window() {
        assert!(close_hides_to_tray("main", true));
        assert!(!close_hides_to_tray("main", false));
        assert!(!close_hides_to_tray("pop-1", true), "a pop-out's X must CLOSE it");
        assert!(!close_hides_to_tray("pop-1", false));
    }

    #[test]
    fn a_popout_can_only_show_about_blank() {
        assert!(popout_navigation_allowed("about:blank"));
        assert!(popout_navigation_allowed("about:blank#puca-pop-2"));
        for bad in [
            "file:///C:/x.png",
            "https://example.com/",
            "about:blankx",
            "about:srcdoc",
            "http://tauri.localhost/",
            // A fragment must not launder another document through.
            "https://example.com/#puca-pop-1",
            "file:///C:/x.png#about:blank",
            "about:blankx#puca-pop-1",
        ] {
            assert!(!popout_navigation_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn titles_are_bounded_and_clean() {
        assert_eq!(window_title("Alice"), "Alice");
        assert_eq!(window_title("  "), "Púca");
        assert_eq!(window_title("about:blank"), "Púca");
        assert_eq!(window_title("a\u{7}b\nc"), "abc");
        assert_eq!(window_title(&"x".repeat(500)).chars().count(), 100);
    }

    const FHD: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 }; // 1080 minus a taskbar
    const RIGHT: Rect = Rect { x: 1920, y: 0, w: 2560, h: 1400 };
    const FRAME: (u32, u32) = (16, 39);

    #[test]
    fn first_open_is_default_size_bottom_right_and_slots_cascade() {
        let one = place(None, &[FHD], FHD, (480, 270), FRAME, 1);
        assert_eq!((one.w, one.h), (480, 270));
        assert_eq!(one.x + (one.w + FRAME.0) as i32, FHD.w as i32 - MARGIN);
        assert_eq!(one.y + (one.h + FRAME.1) as i32, FHD.h as i32 - MARGIN);
        let two = place(None, &[FHD], FHD, (480, 270), FRAME, 2);
        assert_eq!((two.x, two.y), (one.x - CASCADE, one.y - CASCADE));
    }

    /// The owner's complaint: the OS PiP stops at 80% of the screen. A saved
    /// pop-out as big as the work area must come back that big.
    #[test]
    fn no_eighty_percent_cap_a_full_work_area_window_is_kept() {
        let full = Rect { x: 0, y: 0, w: FHD.w - FRAME.0, h: FHD.h - FRAME.1 };
        let r = place(Some(full), &[FHD], FHD, (480, 270), FRAME, 1);
        assert_eq!(r, full);
        assert!(r.w as f64 > FHD.w as f64 * 0.8 && r.h as f64 > FHD.h as f64 * 0.8);
    }

    #[test]
    fn a_window_on_a_second_monitor_stays_there() {
        let saved = Rect { x: 2200, y: 100, w: 1600, h: 900 };
        assert_eq!(place(Some(saved), &[FHD, RIGHT], FHD, (480, 270), FRAME, 1), saved);
    }

    #[test]
    fn a_window_whose_monitor_is_gone_is_replaced_on_the_anchor() {
        let saved = Rect { x: 2200, y: 100, w: 1600, h: 900 };
        let r = place(Some(saved), &[FHD], FHD, (480, 270), FRAME, 1);
        assert_eq!(r, place(None, &[FHD], FHD, (480, 270), FRAME, 1));
    }

    #[test]
    fn an_oversized_or_overhanging_window_is_shrunk_and_pulled_on_screen() {
        let saved = Rect { x: -300, y: 900, w: 4000, h: 3000 };
        let r = place(Some(saved), &[FHD], FHD, (480, 270), FRAME, 1);
        assert_eq!((r.w, r.h), (FHD.w - FRAME.0, FHD.h - FRAME.1));
        assert_eq!((r.x, r.y), (0, 0));
        let overhang = Rect { x: 1700, y: 900, w: 640, h: 360 };
        let r = place(Some(overhang), &[FHD], FHD, (480, 270), FRAME, 1);
        assert_eq!((r.w, r.h), (640, 360));
        assert!(r.x + (r.w + FRAME.0) as i32 <= FHD.w as i32);
        assert!(r.y + (r.h + FRAME.1) as i32 <= FHD.h as i32);
    }

    #[test]
    fn the_store_survives_garbage_and_keeps_pins() {
        assert!(parse_store("not json").is_empty());
        assert!(parse_store("{\"0\":{},\"99\":{},\"x\":{}}").is_empty());
        let m = parse_store("{\"2\":{\"pinned\":false},\"1\":{\"rect\":{\"x\":1,\"y\":2,\"w\":3,\"h\":4}}}");
        assert!(!m[&2].pinned);
        assert!(m[&1].pinned, "a slot with no pin recorded starts pinned");
        assert_eq!(m[&1].rect, Some(Rect { x: 1, y: 2, w: 3, h: 4 }));
        assert_eq!(parse_store(&render_store(&m)), m);
    }
}
