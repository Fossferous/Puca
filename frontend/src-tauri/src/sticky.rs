//! Sticky notes: a Púca Notes note in a small window of its own on the
//! desktop (docs/STICKY_NOTES.md). Desktop only; the full app AND Lite.
//!
//! THE SAME ENGINE AS THE STREAM POP-OUTS (popout.rs), for the same reason
//! it is safe there. The main page calls
//! `window.open("about:blank#puca-sticky-<slot>")`; WebView2 raises
//! NewWindowRequested; [`open_requested`] answers with a WebviewWindow built
//! in the SAME WebView2 environment, so the popup is a same-origin
//! `about:blank` document the MAIN realm scripts directly. React portals the
//! note into it. The decrypted note, the vault keys and the session never
//! leave the main realm: nothing is sent over IPC, nothing is decrypted a
//! second time, and the popup's own realm runs no Púca code. Every command
//! below is called by the MAIN realm (the popup's buttons are main-realm React
//! handlers), and none of them carries note content: a slot number, a note's
//! KEY (`<user>/list:<id>`), a rectangle, a pin.
//!
//! WHAT IS REMEMBERED, per note, in `sticky-windows.json` under the app config
//! dir: where its window was, how big, whether it stays on top and whether it
//! is docked to a side of the screen. Geometry only, keyed by the account and
//! the note's number — never a title, a colour or a word of the note. WHICH
//! notes are open is the page's (device-local, per account), because only the
//! page knows whether a note still exists.
//!
//! WHAT IS REFUSED. Only `about:blank#puca-sticky-<1..=MAX_STICKIES>` becomes a
//! sticky window, only after the page has bound that slot to a note
//! ([`sticky_bind`]), and a sticky window can only ever show `about:blank`.
//! Its own window.open has no handler and is denied, as a pop-out's is.
//!
//! THE GLOBAL SHORTCUT ("new sticky note" from anywhere) is a Win32 hot key
//! (RegisterHotKey) on a thread of its own, not the low-level keyboard hook in
//! hotkeys.rs: a hot key is delivered by Windows only when its exact
//! combination is pressed, so no keystroke of any other app ever passes
//! through this process, and Windows itself refuses a combination something
//! else already holds — which the Settings row then says.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::popout::Rect;

/// How many sticky windows may be open at once. Microsoft's app has no
/// stated cap; this one exists so a runaway caller cannot open windows
/// without bound, and is far above what fits on a screen.
pub const MAX_STICKIES: u32 = 24;
pub const URL_PREFIX: &str = "about:blank#puca-sticky-";
pub const LABEL_PREFIX: &str = "sticky-";
/// The default content size, logical px: a square, as a paper note is.
const DEFAULT_W: f64 = 300.0;
const DEFAULT_H: f64 = 300.0;
const MIN_W: f64 = 200.0;
const MIN_H: f64 = 150.0;
/// Width a note docks at (logical px) when it is narrower than this.
const DOCK_MIN_W: f64 = 320.0;
const MARGIN: i32 = 24;
const CASCADE: i32 = 32;
const STORE_FILE: &str = "sticky-windows.json";
/// The most notes whose geometry is kept; the least recently used go first.
pub const MAX_RECORDS: usize = 400;
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// Tauri events the page listens for.
pub const EVENT_NEW_NOTE: &str = "sticky://new-note";
/// A sticky window's close was REQUESTED (Alt+F4, Windows closing it): the
/// person took the note off the desktop. A window the shell destroys itself
/// — the page reloading, Púca quitting — raises no such request, and the note
/// stays in the set the page brings back at start (stickyStore.ts).
pub const EVENT_CLOSED: &str = "sticky://closed";

/// The slot a `window.open` URL asks for — `None` for anything that is not
/// exactly `about:blank#puca-sticky-<1..=MAX_STICKIES>`. The same strictness
/// as popout.rs's filter: no leading zeros, no sign, nothing after the number.
pub fn requested_slot(url: &str) -> Option<u32> {
    let rest = url.strip_prefix(URL_PREFIX)?;
    if rest.is_empty() || rest.len() > 3 || rest.starts_with('0') {
        return None;
    }
    if !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = rest.parse().ok()?;
    (1..=MAX_STICKIES).contains(&n).then_some(n)
}

pub fn label_for(slot: u32) -> String {
    format!("{LABEL_PREFIX}{slot}")
}

pub fn slot_of_label(label: &str) -> Option<u32> {
    let rest = label.strip_prefix(LABEL_PREFIX)?;
    requested_slot(&format!("{URL_PREFIX}{rest}"))
}

pub fn is_sticky_label(label: &str) -> bool {
    slot_of_label(label).is_some()
}

fn digits(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
}

/// A note's place key: the account, then which note — `<user id>/list:<id>`
/// or `<user id>/channel:<id>` (Púca Notes' own note key, notesModel.ts
/// noteKey), `<user id>/temp:<n>` for a note made offline that has no number
/// yet (the outbox's temporary id -n), and `<user id>/new:<n>` for a new
/// sticky note nothing has been typed in. The account is in it so two
/// accounts on one PC never share a window's place.
pub fn valid_place(place: &str) -> bool {
    let Some((user, note)) = place.split_once('/') else { return false };
    let Some((kind, id)) = note.split_once(':') else { return false };
    digits(user, 12) && matches!(kind, "list" | "channel" | "temp" | "new") && digits(id, 15)
}

/// The window title: the document title the page set (the note's title),
/// clean and bounded. WebView2 reports the URL until the page names itself.
pub fn window_title(doc_title: &str) -> String {
    let t: String = doc_title.chars().filter(|c| !c.is_control()).take(100).collect();
    let t = t.trim();
    if t.is_empty() || crate::popout::popout_navigation_allowed(t) {
        "Sticky note".to_string()
    } else {
        t.to_string()
    }
}

/// Which side of the screen a note is docked to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn parse(s: &str) -> Option<Side> {
        match s {
            "left" => Some(Side::Left),
            "right" => Some(Side::Right),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Left => "left",
            Side::Right => "right",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dock {
    pub side: Side,
    /// Where the note was before it docked, to go back to.
    #[serde(default)]
    pub before: Option<Rect>,
}

/// What is remembered for one note.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub rect: Option<Rect>,
    /// Always on top. Off for a new note: a paper note on the desktop does
    /// not cover the window being worked in, and the pin turns it on.
    #[serde(default)]
    pub on_top: bool,
    #[serde(default)]
    pub dock: Option<Dock>,
    /// A logical clock, for dropping the least recently used past MAX_RECORDS.
    #[serde(default)]
    pub used: u64,
}

/// Parse the store, keeping only well-formed places. A bad file never stops a
/// note opening; it only forgets where the notes were. A draft's place
/// (`new:`) is not kept from one session to the next: drafts are numbered
/// afresh by every page, and the next one would inherit a stranger's pin.
pub fn parse_store(raw: &str) -> HashMap<String, Record> {
    let parsed: HashMap<String, Record> = serde_json::from_str(raw).unwrap_or_default();
    parsed.into_iter().filter(|(k, _)| valid_place(k) && !k.contains("/new:")).collect()
}

fn render_store(map: &HashMap<String, Record>) -> String {
    let sorted: std::collections::BTreeMap<&String, &Record> = map.iter().collect();
    serde_json::to_string_pretty(&sorted).unwrap_or_else(|_| "{}".into())
}

/// Drop the least recently used records past `max`.
pub fn prune(map: &mut HashMap<String, Record>, max: usize) {
    if map.len() <= max {
        return;
    }
    let mut by_use: Vec<(u64, String)> = map.iter().map(|(k, r)| (r.used, k.clone())).collect();
    by_use.sort();
    let drop = map.len() - max;
    for (_, k) in by_use.into_iter().take(drop) {
        map.remove(&k);
    }
}

/// Where a sticky window goes: its remembered rectangle if it still touches a
/// monitor (pulled fully onto the one it overlaps most, shrunk to fit), else
/// the default size in the TOP-right of the anchor monitor's work area — clear
/// of the notification toasts in the bottom right — cascaded by slot.
pub fn place(saved: Option<Rect>, work: &[Rect], anchor: Rect, default_inner: (u32, u32), frame: (u32, u32), slot: u32) -> Rect {
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
            let step = CASCADE * (slot.saturating_sub(1).min(MAX_STICKIES) as i32);
            let x = anchor.x + anchor.w as i32 - (w + fw) as i32 - MARGIN - step;
            let y = anchor.y + MARGIN + step;
            (Rect { x, y, w, h }, anchor)
        }
    };
    r.w = r.w.min(wa.w.saturating_sub(fw)).max(1);
    r.h = r.h.min(wa.h.saturating_sub(fh)).max(1);
    let max_x = wa.x + (wa.w - (r.w + fw).min(wa.w)) as i32;
    let max_y = wa.y + (wa.h - (r.h + fh).min(wa.h)) as i32;
    r.x = r.x.clamp(wa.x, max_x);
    r.y = r.y.clamp(wa.y, max_y);
    r
}

/// A docked note: the full height of the work area it is on, at its own width
/// (at least `min_w`, at most half the work area), against that side.
pub fn docked_rect(current: Rect, wa: Rect, side: Side, min_w: u32, frame: (u32, u32)) -> Rect {
    let (fw, fh) = frame;
    let w = current.w.max(min_w).min((wa.w / 2).saturating_sub(fw)).max(1);
    let h = wa.h.saturating_sub(fh).max(1);
    let x = match side {
        Side::Left => wa.x,
        Side::Right => wa.x + wa.w as i32 - (w + fw) as i32,
    };
    Rect { x, y: wa.y, w, h }
}

/// A slot the page has said which note it holds, and whether its window
/// should take the focus when it opens (a note reopened at start does not).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    place: String,
    focus: bool,
    /// Which window this binding is for: a slot is bound afresh for every
    /// window opened in it, and a window that is still going away must not
    /// write its geometry into the note the slot holds next.
    gen: u64,
}

#[derive(Default)]
pub struct StickyState {
    records: Mutex<HashMap<String, Record>>,
    bound: Mutex<HashMap<u32, Binding>>,
    path: Mutex<Option<PathBuf>>,
    clock: AtomicU64,
    #[cfg(windows)]
    hotkey: Mutex<Option<hotkey::Running>>,
}

impl StickyState {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let path = app.path().app_config_dir().ok().map(|d| d.join(STORE_FILE));
        let records = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|raw| parse_store(&raw))
            .unwrap_or_default();
        let clock = records.values().map(|r| r.used).max().unwrap_or(0);
        StickyState {
            records: Mutex::new(records),
            path: Mutex::new(path),
            clock: AtomicU64::new(clock),
            ..Default::default()
        }
    }

    fn record(&self, place: &str) -> Record {
        self.records.lock().map(|m| m.get(place).copied().unwrap_or_default()).unwrap_or_default()
    }

    fn update(&self, place: &str, f: impl FnOnce(&mut Record)) {
        if let Ok(mut m) = self.records.lock() {
            f(m.entry(place.to_string()).or_default());
        }
    }

    fn touch(&self, place: &str) {
        let t = self.clock.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut m) = self.records.lock() {
            m.entry(place.to_string()).or_default().used = t;
            prune(&mut m, MAX_RECORDS);
        }
    }

    fn forget(&self, place: &str) {
        if let Ok(mut m) = self.records.lock() {
            m.remove(place);
        }
    }

    fn binding(&self, slot: u32) -> Option<Binding> {
        self.bound.lock().ok().and_then(|m| m.get(&slot).cloned())
    }

    fn place_of(&self, slot: u32) -> Option<String> {
        self.binding(slot).map(|b| b.place)
    }

    /// The note `slot` holds, but only while it is still window `gen`'s.
    fn place_for(&self, slot: u32, gen: u64) -> Option<String> {
        self.binding(slot).filter(|b| b.gen == gen).map(|b| b.place)
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
                log::warn!("[sticky] could not save window state: {e}");
            }
        }
    }
}

fn monitor_work_area(m: &tauri::Monitor) -> Rect {
    let wa = m.work_area();
    Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height }
}

fn frame_of<R: Runtime>(w: &WebviewWindow<R>) -> (u32, u32) {
    match (w.outer_size(), w.inner_size()) {
        (Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    }
}

fn set_rect<R: Runtime>(w: &WebviewWindow<R>, r: Rect) {
    let _ = w.set_size(PhysicalSize { width: r.w, height: r.h });
    let _ = w.set_position(PhysicalPosition { x: r.x, y: r.y });
}

fn position_new<R: Runtime>(app: &AppHandle<R>, w: &WebviewWindow<R>, slot: u32, rec: Record) {
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
            None => return,
        },
    };
    let frame = frame_of(w);
    let default_inner = ((DEFAULT_W * scale).round() as u32, (DEFAULT_H * scale).round() as u32);
    let r = place(rec.rect, &work, anchor, default_inner, frame, slot);
    set_rect(w, r);
}

/// Remember the note's geometry as it is moved and resized; a note dragged
/// away from the side it was docked to is no longer docked.
fn track<R: Runtime>(w: &WebviewWindow<R>, slot: u32, gen: u64) {
    let app = w.app_handle().clone();
    let win = w.clone();
    w.on_window_event(move |e| {
        let Some(state) = app.try_state::<StickyState>() else { return };
        let Some(place) = state.place_for(slot, gen) else { return };
        let steady = !win.is_minimized().unwrap_or(false) && !win.is_maximized().unwrap_or(false);
        match e {
            WindowEvent::Moved(p) if steady => state.update(&place, |r| {
                let mut rect = r.rect.unwrap_or(Rect { x: 0, y: 0, w: 0, h: 0 });
                // A move the dock itself made lands exactly where the dock put
                // it; any other move is the person taking it off the side.
                if r.dock.is_some() && (rect.x - p.x).abs() > 2 {
                    r.dock = None;
                }
                rect.x = p.x;
                rect.y = p.y;
                r.rect = Some(rect);
            }),
            WindowEvent::Resized(s) if steady && s.width > 0 && s.height > 0 => state.update(&place, |r| {
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

/// The main window's new-window handler, for sticky URLs. lib.rs routes a
/// request here when [`requested_slot`] matches, and to popout.rs otherwise.
pub fn open_requested<R: Runtime>(app: &AppHandle<R>, url: &Url, features: NewWindowFeatures) -> NewWindowResponse<R> {
    let Some(slot) = requested_slot(url.as_str()) else { return NewWindowResponse::Deny };
    let label = label_for(slot);
    if app.get_webview_window(&label).is_some() {
        log::warn!("[sticky] slot {slot} is already open; refused");
        return NewWindowResponse::Deny;
    }
    let Some(state) = app.try_state::<StickyState>() else { return NewWindowResponse::Deny };
    // Unbound = no note: the page binds before it opens (stickyShell.ts).
    let Some(binding) = state.binding(slot) else {
        log::warn!("[sticky] slot {slot} was opened without a note bound to it; refused");
        return NewWindowResponse::Deny;
    };
    let rec = state.record(&binding.place);
    let Ok(blank) = "about:blank".parse::<Url>() else { return NewWindowResponse::Deny };
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .window_features(features)
        .title("Sticky note")
        // The note draws its own coloured bar (drag, new, menu, close).
        // tao keeps a frameless resizable window resizable from its edges.
        .decorations(false)
        .shadow(true)
        .always_on_top(rec.on_top)
        // Twenty notes are not twenty taskbar buttons; the tray's Show
        // sticky notes and the global shortcut bring them back.
        .skip_taskbar(true)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .min_inner_size(MIN_W, MIN_H)
        .inner_size(DEFAULT_W, DEFAULT_H)
        .focused(binding.focus)
        // A picture dropped on the note reaches the page (StickyNoteView), as
        // in the main window (tauri.conf.json dragDropEnabled: false); with
        // Tauri's own handler the drop would never be a DOM event at all.
        .disable_drag_drop_handler()
        .visible(false)
        .on_document_title_changed(|w, t| {
            let _ = w.set_title(&window_title(&t));
        })
        .on_navigation(|u| crate::popout::popout_navigation_allowed(u.as_str()))
        .build();
    match built {
        Ok(w) => {
            position_new(app, &w, slot, rec);
            if let Some(d) = rec.dock {
                apply_dock(&w, &state, &binding.place, d.side);
            }
            track(&w, slot, binding.gen);
            let _ = w.show();
            if binding.focus {
                let _ = w.set_focus();
            }
            state.touch(&binding.place);
            log::info!("[sticky] opened slot {slot} (on_top={}, docked={})", rec.on_top, rec.dock.is_some());
            NewWindowResponse::Create { window: w }
        }
        Err(e) => {
            log::warn!("[sticky] could not build slot {slot}: {e}");
            NewWindowResponse::Deny
        }
    }
}

/// Put the window against `side`. The docked rectangle is recorded BEFORE
/// the window moves, so the Moved event the move itself raises lands where
/// the record already says and is not taken for the person dragging it off.
fn apply_dock<R: Runtime>(w: &WebviewWindow<R>, state: &StickyState, place: &str, side: Side) {
    let Some(m) = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten()) else { return };
    let wa = monitor_work_area(&m);
    let current = match (w.outer_position(), w.inner_size()) {
        (Ok(p), Ok(s)) => Rect { x: p.x, y: p.y, w: s.width, h: s.height },
        _ => return,
    };
    let min_w = (DOCK_MIN_W * m.scale_factor()).round() as u32;
    let r = docked_rect(current, wa, side, min_w, frame_of(w));
    state.update(place, |rec| rec.rect = Some(r));
    set_rect(w, r);
}

pub fn save_on_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<StickyState>() {
        if state.records.lock().map(|m| !m.is_empty()).unwrap_or(false) {
            state.save();
        }
        #[cfg(windows)]
        hotkey::stop(&state);
    }
}

/// Close every sticky window: the main page reloading or going away leaves
/// them with no opener, so nothing could ever fill them again. The page that
/// loads next opens the notes again itself.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, w) in app.webview_windows() {
        if is_sticky_label(&label) {
            let _ = w.destroy();
        }
    }
}

/// The window `label` is being closed by a close REQUEST (lib.rs's window
/// handler, before the window goes): tell the page which slot it was.
pub fn note_close_requested<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(slot) = slot_of_label(label) {
        use tauri::Emitter;
        let _ = app.emit_to("main", EVENT_CLOSED, slot);
    }
}

/// Hide or show every sticky window (the tray's Hide / Show sticky notes).
pub fn set_all_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    for (label, w) in app.webview_windows() {
        if is_sticky_label(&label) {
            let _ = if visible { w.show() } else { w.hide() };
        }
    }
}

fn slot_ok(slot: u32) -> Result<(), String> {
    if (1..=MAX_STICKIES).contains(&slot) {
        Ok(())
    } else {
        Err(format!("no sticky slot {slot}"))
    }
}

fn window_of<R: Runtime>(app: &AppHandle<R>, slot: u32) -> Result<WebviewWindow<R>, String> {
    slot_ok(slot)?;
    app.get_webview_window(&label_for(slot)).ok_or_else(|| format!("sticky slot {slot} is not open"))
}

fn bound_place<R: Runtime>(app: &AppHandle<R>, slot: u32) -> Result<String, String> {
    slot_ok(slot)?;
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    state.place_of(slot).ok_or_else(|| format!("sticky slot {slot} holds no note"))
}

/// Feature probe: a shell that answers this has sticky windows.
#[tauri::command]
pub fn sticky_supported() -> bool {
    true
}

/// Say which note `slot` holds, before opening its window (window.open).
#[tauri::command]
pub fn sticky_bind<R: Runtime>(app: AppHandle<R>, slot: u32, place: String, focus: Option<bool>) -> Result<(), String> {
    slot_ok(slot)?;
    if !valid_place(&place) {
        return Err("not a note".into());
    }
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    let gen = state.clock.fetch_add(1, Ordering::Relaxed) + 1;
    state.bound.lock().map_err(|e| e.to_string())?.insert(slot, Binding { place, focus: focus.unwrap_or(true), gen });
    Ok(())
}

/// The note in `slot` got another number while its window is open (a note
/// made offline, now saved): the window keeps its place, under the new one.
#[tauri::command]
pub fn sticky_rekey<R: Runtime>(app: AppHandle<R>, slot: u32, place: String) -> Result<(), String> {
    slot_ok(slot)?;
    if !valid_place(&place) {
        return Err("not a note".into());
    }
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    let mut bound = state.bound.lock().map_err(|e| e.to_string())?;
    let b = bound.get_mut(&slot).ok_or_else(|| format!("sticky slot {slot} holds no note"))?;
    if b.place != place {
        let rec = state.record(&b.place);
        state.forget(&b.place);
        state.update(&place, |r| *r = rec);
        b.place = place;
    }
    drop(bound);
    state.save();
    Ok(())
}

/// Close a sticky window from the app (the note's X, a deleted note, sign
/// out). Answers once the slot is FREE, as popout_close does and for the same
/// reason: until the window's Destroyed has run, its label is taken.
#[tauri::command]
pub async fn sticky_close<R: Runtime>(app: AppHandle<R>, slot: u32) -> Result<(), String> {
    slot_ok(slot)?;
    let label = label_for(slot);
    if let Some(w) = app.get_webview_window(&label) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    let freed = tauri::async_runtime::spawn_blocking(move || {
        crate::popout::wait_until(|| app.get_webview_window(&label).is_none(), CLOSE_WAIT, std::time::Duration::from_millis(10))
    })
    .await
    .map_err(|e| e.to_string())?;
    if freed {
        Ok(())
    } else {
        Err(format!("sticky slot {slot} is still closing"))
    }
}

/// Read (`on_top: None`) or set whether the note in `slot` stays on top.
#[tauri::command]
pub fn sticky_pin<R: Runtime>(app: AppHandle<R>, slot: u32, on_top: Option<bool>) -> Result<bool, String> {
    let place = bound_place(&app, slot)?;
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    if let Some(p) = on_top {
        state.update(&place, |r| r.on_top = p);
        if let Some(w) = app.get_webview_window(&label_for(slot)) {
            w.set_always_on_top(p).map_err(|e| e.to_string())?;
        }
        state.save();
    }
    Ok(state.record(&place).on_top)
}

/// Start moving the window: the note's bar was pressed. Called while the
/// mouse button is still down, as Tauri's own drag regions do.
#[tauri::command]
pub fn sticky_drag<R: Runtime>(app: AppHandle<R>, slot: u32) -> Result<(), String> {
    window_of(&app, slot)?.start_dragging().map_err(|e| e.to_string())
}

/// Bring a note's window to the front (it was asked for again while open).
#[tauri::command]
pub fn sticky_raise<R: Runtime>(app: AppHandle<R>, slot: u32) -> Result<(), String> {
    let w = window_of(&app, slot)?;
    let _ = w.show();
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())
}

/// Dock the note to a side of its screen (`side`), or take it off (`None`):
/// back where it was before it docked. Answers the side it is docked to now.
#[tauri::command]
pub fn sticky_dock<R: Runtime>(app: AppHandle<R>, slot: u32, side: Option<String>) -> Result<Option<String>, String> {
    let place = bound_place(&app, slot)?;
    let w = window_of(&app, slot)?;
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    let want = match side.as_deref() {
        None => None,
        Some(s) => Some(Side::parse(s).ok_or("not a side")?),
    };
    let rec = state.record(&place);
    match want {
        Some(s) => {
            // Keep the place it is leaving — unless it is already docked,
            // whose rectangle is the dock's, not the person's.
            let before = match rec.dock {
                Some(d) => d.before,
                None => rec.rect,
            };
            state.update(&place, |r| r.dock = Some(Dock { side: s, before }));
            apply_dock(&w, &state, &place, s);
        }
        None => {
            if let Some(d) = rec.dock {
                state.update(&place, |r| r.dock = None);
                if let Some(b) = d.before {
                    set_rect(&w, b);
                }
            }
        }
    }
    state.save();
    Ok(state.record(&place).dock.map(|d| d.side.as_str().to_string()))
}

/// The side the note in `slot` is docked to, if any.
#[tauri::command]
pub fn sticky_dock_state<R: Runtime>(app: AppHandle<R>, slot: u32) -> Result<Option<String>, String> {
    let place = bound_place(&app, slot)?;
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    Ok(state.record(&place).dock.map(|d| d.side.as_str().to_string()))
}

/// Bring Púca's own window up: a sticky note's Open in Notes, Ctrl+H, Ctrl+F.
#[tauri::command]
pub fn sticky_show_main<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Hide or show every sticky window.
#[tauri::command]
pub fn sticky_set_visible<R: Runtime>(app: AppHandle<R>, visible: bool) {
    set_all_visible(&app, visible);
}

/// Forget a note's place (it was deleted, or left the account).
#[tauri::command]
pub fn sticky_forget<R: Runtime>(app: AppHandle<R>, place: String) -> Result<(), String> {
    if !valid_place(&place) {
        return Err("not a note".into());
    }
    let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
    state.forget(&place);
    state.save();
    Ok(())
}

/// The global "new sticky note" shortcut, as the page stores it
/// (settingsStore.ts KeyBinding, plus the Windows key).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBinding {
    pub key_code: u32,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub win: bool,
}

/// Why a combination cannot be a global shortcut, or the RegisterHotKey
/// modifier bits for it. A combination without Ctrl, Alt or the Windows key
/// would take a key away from typing in every other app (Shift+N is a capital
/// N), and a modifier on its own is not a key.
pub fn hotkey_mods(b: &HotkeyBinding) -> Result<u32, &'static str> {
    // VK_SHIFT 0x10, VK_CONTROL 0x11, VK_MENU 0x12, VK_LWIN 0x5B, VK_RWIN 0x5C,
    // the left/right variants 0xA0..=0xA5; mouse buttons 0x01..=0x06.
    let k = b.key_code;
    if !(0x08..=0xFE).contains(&k) || (0x10..=0x12).contains(&k) || k == 0x5B || k == 0x5C || (0xA0..=0xA5).contains(&k) {
        return Err("not a key");
    }
    if !(b.ctrl || b.alt || b.win) {
        return Err("needs Ctrl, Alt or the Windows key");
    }
    // MOD_ALT 1, MOD_CONTROL 2, MOD_SHIFT 4, MOD_WIN 8, MOD_NOREPEAT 0x4000:
    // holding the keys makes ONE note, not one per auto-repeat.
    Ok((b.alt as u32) | ((b.ctrl as u32) << 1) | ((b.shift as u32) << 2) | ((b.win as u32) << 3) | 0x4000)
}

/// Register (or, with `None`, release) the global shortcut. An error names
/// why: Windows refuses a combination another app (or Windows) already
/// holds, and that is what the Settings row then says.
/// Async: registering waits for the shortcut's own thread to answer, and that
/// wait must not hold up the event loop that every other command runs on.
#[tauri::command]
pub async fn sticky_hotkey<R: Runtime>(app: AppHandle<R>, binding: Option<HotkeyBinding>) -> Result<(), String> {
    let mods = match binding.as_ref() {
        Some(b) => Some(hotkey_mods(b).map_err(str::to_string)?),
        None => None,
    };
    #[cfg(windows)]
    {
        let state = app.try_state::<StickyState>().ok_or("sticky state missing")?;
        hotkey::stop(&state);
        if let (Some(b), Some(m)) = (binding, mods) {
            let running = hotkey::start(app.clone(), m, b.key_code)?;
            if let Ok(mut slot) = state.hotkey.lock() {
                *slot = Some(running);
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, mods);
        if binding.is_some() {
            Err("global shortcuts are Windows-only".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
mod hotkey {
    //! One thread, one hot key, one message loop. Registration belongs to the
    //! thread that made it (WM_HOTKEY is posted to that thread's queue), so a
    //! new binding is a new thread: stop posts WM_QUIT, whose loop end
    //! unregisters, and start reports whether Windows accepted the key before
    //! it returns.
    use super::{StickyState, EVENT_NEW_NOTE};
    use std::sync::mpsc;
    use tauri::{AppHandle, Emitter, Runtime};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS};
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT, WM_USER};

    const ID: i32 = 0x5EA1;

    pub struct Running {
        tid: u32,
        join: Option<std::thread::JoinHandle<()>>,
    }

    enum Said {
        Thread(u32),
        Registered,
        Refused(String),
    }

    pub fn start<R: Runtime>(app: AppHandle<R>, mods: u32, vk: u32) -> Result<Running, String> {
        let (tx, rx) = mpsc::channel::<Said>();
        let join = std::thread::Builder::new()
            .name("sticky-hotkey".into())
            .spawn(move || unsafe {
                let mut msg = MSG::default();
                // Make this thread's queue before anyone can post to it, and
                // say which thread it is FIRST: a caller that stops waiting
                // can still end it, and with it a registration made late.
                let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
                let _ = tx.send(Said::Thread(GetCurrentThreadId()));
                if let Err(e) = RegisterHotKey(None, ID, HOT_KEY_MODIFIERS(mods), vk) {
                    let _ = tx.send(Said::Refused(if e.code().0 as u32 == 0x8007_0581 {
                        // ERROR_HOTKEY_ALREADY_REGISTERED
                        "taken".to_string()
                    } else {
                        e.to_string()
                    }));
                    return;
                }
                let _ = tx.send(Said::Registered);
                loop {
                    let r = GetMessageW(&mut msg, None, 0, 0).0;
                    if r == 0 || r == -1 {
                        break;
                    }
                    if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == ID {
                        log::info!("[sticky] the new-note shortcut was pressed");
                        let _ = app.emit_to("main", EVENT_NEW_NOTE, ());
                    }
                }
                let _ = UnregisterHotKey(None, ID);
            })
            .map_err(|e| e.to_string())?;
        let wait = std::time::Duration::from_secs(2);
        let tid = match rx.recv_timeout(wait) {
            Ok(Said::Thread(t)) => t,
            _ => return Err("the shortcut thread did not start".into()),
        };
        match rx.recv_timeout(wait) {
            Ok(Said::Registered) => {
                log::info!("[sticky] new-note shortcut registered");
                Ok(Running { tid, join: Some(join) })
            }
            Ok(Said::Refused(e)) => {
                let _ = join.join();
                log::info!("[sticky] new-note shortcut refused: {e}");
                Err(e)
            }
            _ => {
                // No answer in time: end the thread rather than leave a
                // registration nobody can take back holding the combination.
                // Its message loop sees WM_QUIT whenever it gets there, and
                // unregisters on the way out.
                unsafe {
                    let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
                }
                Err("the shortcut thread did not answer".into())
            }
        }
    }

    pub fn stop(state: &StickyState) {
        let running = state.hotkey.lock().ok().and_then(|mut s| s.take());
        if let Some(mut r) = running {
            unsafe {
                let _ = PostThreadMessageW(r.tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            if let Some(j) = r.join.take() {
                let _ = j.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_sticky_urls_are_accepted() {
        assert_eq!(requested_slot("about:blank#puca-sticky-1"), Some(1));
        assert_eq!(requested_slot(&format!("about:blank#puca-sticky-{MAX_STICKIES}")), Some(MAX_STICKIES));
        for bad in [
            "about:blank",
            "about:blank#puca-sticky-",
            "about:blank#puca-sticky-0",
            "about:blank#puca-sticky-01",
            "about:blank#puca-sticky--1",
            "about:blank#puca-sticky-+1",
            "about:blank#puca-sticky-1x",
            "about:blank#puca-sticky-1 ",
            "about:blank#puca-sticky-999",
            "about:blank#puca-pop-1",
            "https://evil.example/#puca-sticky-1",
            "about:srcdoc#puca-sticky-1",
            "",
        ] {
            assert_eq!(requested_slot(bad), None, "{bad:?} must be refused");
        }
        assert_eq!(requested_slot(&format!("about:blank#puca-sticky-{}", MAX_STICKIES + 1)), None);
        // The two filters never claim each other's windows.
        assert_eq!(crate::popout::requested_slot("about:blank#puca-sticky-1"), None);
    }

    #[test]
    fn the_filter_holds_after_url_parsing() {
        let ok: Url = "about:blank#puca-sticky-3".parse().unwrap();
        assert_eq!(requested_slot(ok.as_str()), Some(3));
        for bad in ["https://example.com/#puca-sticky-1", "data:text/html,#puca-sticky-1"] {
            let u: Url = bad.parse().unwrap();
            assert_eq!(requested_slot(u.as_str()), None, "{bad}");
        }
    }

    #[test]
    fn labels_round_trip_and_are_never_popouts() {
        for s in 1..=MAX_STICKIES {
            assert_eq!(slot_of_label(&label_for(s)), Some(s));
            assert!(!crate::popout::is_popout_label(&label_for(s)));
        }
        for bad in ["main", "sticky-", "sticky-0", "sticky-01", "pop-1", "Sticky-1", "sticky-1 "] {
            assert!(!is_sticky_label(bad), "{bad}");
        }
    }

    #[test]
    fn a_stickys_x_closes_it_rather_than_hiding_to_the_tray() {
        assert!(!crate::popout::close_hides_to_tray(&label_for(1), true));
    }

    #[test]
    fn places_are_an_account_and_a_note_key() {
        for ok in ["1/list:1", "42/list:9007199254740", "123456789012/channel:7", "1/temp:3", "1/new:12"] {
            assert!(valid_place(ok), "{ok}");
        }
        for bad in [
            "", "list:1", "1/list:", "1/list:0", "1/list:01", "0/list:1", "01/list:1", "1/List:1",
            "1/task:1", "1/list:1:2", "1/temp:-3", "1/new:0", "1/list:1/", "/list:1", "1//list:1", "1/list:-1", "1/list: 1",
            "1234567890123/list:1", "1/list:1234567890123456", "1/list:1\n",
        ] {
            assert!(!valid_place(bad), "{bad:?}");
        }
    }

    #[test]
    fn titles_are_bounded_and_clean() {
        assert_eq!(window_title("Shopping"), "Shopping");
        assert_eq!(window_title(""), "Sticky note");
        assert_eq!(window_title("about:blank#puca-sticky-3"), "Sticky note");
        assert_eq!(window_title("a\u{7}b"), "ab");
        assert_eq!(window_title(&"x".repeat(300)).chars().count(), 100);
    }

    const FHD: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };
    const RIGHT: Rect = Rect { x: 1920, y: 0, w: 2560, h: 1400 };

    #[test]
    fn a_new_note_opens_top_right_and_new_ones_cascade() {
        let one = place(None, &[FHD], FHD, (300, 300), (0, 0), 1);
        assert_eq!((one.w, one.h), (300, 300));
        assert_eq!(one.x + one.w as i32, FHD.w as i32 - MARGIN);
        assert_eq!(one.y, MARGIN);
        let two = place(None, &[FHD], FHD, (300, 300), (0, 0), 2);
        assert_eq!((two.x, two.y), (one.x - CASCADE, one.y + CASCADE));
    }

    #[test]
    fn a_remembered_note_comes_back_where_it_was() {
        let saved = Rect { x: 2400, y: 300, w: 420, h: 380 };
        assert_eq!(place(Some(saved), &[FHD, RIGHT], FHD, (300, 300), (0, 0), 5), saved);
        // Its monitor unplugged: a new note's place on the anchor.
        assert_eq!(place(Some(saved), &[FHD], FHD, (300, 300), (0, 0), 1), place(None, &[FHD], FHD, (300, 300), (0, 0), 1));
        // Hanging off the edge: pulled on, size kept.
        let off = Rect { x: 1800, y: 900, w: 300, h: 300 };
        let r = place(Some(off), &[FHD], FHD, (300, 300), (0, 0), 1);
        assert_eq!((r.w, r.h), (300, 300));
        assert!(r.x + r.w as i32 <= FHD.w as i32 && r.y + r.h as i32 <= FHD.h as i32);
    }

    #[test]
    fn docking_takes_the_full_height_of_its_side() {
        let current = Rect { x: 700, y: 400, w: 300, h: 300 };
        let r = docked_rect(current, FHD, Side::Right, 320, (0, 0));
        assert_eq!((r.w, r.h), (320, FHD.h), "a narrow note docks at the minimum width");
        assert_eq!(r.x + r.w as i32, FHD.w as i32);
        assert_eq!(r.y, FHD.y);
        let l = docked_rect(Rect { w: 500, ..current }, RIGHT, Side::Left, 320, (0, 0));
        assert_eq!((l.x, l.y, l.w, l.h), (RIGHT.x, 0, 500, RIGHT.h));
        // Never wider than half the screen.
        let wide = docked_rect(Rect { w: 1800, ..current }, FHD, Side::Right, 320, (0, 0));
        assert_eq!(wide.w, FHD.w / 2);
    }

    #[test]
    fn the_store_survives_garbage_and_drops_the_least_used() {
        assert!(parse_store("not json").is_empty());
        assert!(parse_store("{\"list:1\":{},\"x\":{}}").is_empty(), "a place with no account is refused");
        assert!(parse_store("{\"1/new:2\":{\"on_top\":true}}").is_empty(), "a draft's place does not outlive its session");
        let m = parse_store("{\"1/list:2\":{\"on_top\":true,\"used\":4},\"1/channel:3\":{\"rect\":{\"x\":1,\"y\":2,\"w\":3,\"h\":4},\"dock\":{\"side\":\"left\"}}}");
        assert!(m["1/list:2"].on_top);
        assert!(!m["1/channel:3"].on_top, "a note with no pin recorded is not on top");
        assert_eq!(m["1/channel:3"].dock, Some(Dock { side: Side::Left, before: None }));
        assert_eq!(parse_store(&render_store(&m)), m);
        let mut big: HashMap<String, Record> = (1..=10u64)
            .map(|i| (format!("1/list:{i}"), Record { used: i, ..Default::default() }))
            .collect();
        prune(&mut big, 7);
        assert_eq!(big.len(), 7);
        for gone in 1..=3 {
            assert!(!big.contains_key(&format!("1/list:{gone}")), "the least recently used go first");
        }
    }

    #[test]
    fn a_global_shortcut_needs_a_real_key_and_a_real_modifier() {
        let b = |key_code, ctrl, alt, shift, win| HotkeyBinding { key_code, ctrl, alt, shift, win };
        // Win+Shift+N: MOD_WIN | MOD_SHIFT | MOD_NOREPEAT.
        assert_eq!(hotkey_mods(&b(0x4E, false, false, true, true)), Ok(8 | 4 | 0x4000));
        assert_eq!(hotkey_mods(&b(0x4E, true, true, true, false)), Ok(2 | 1 | 4 | 0x4000));
        // Shift+N is typing a capital N; a bare N is typing an n.
        assert!(hotkey_mods(&b(0x4E, false, false, true, false)).is_err());
        assert!(hotkey_mods(&b(0x4E, false, false, false, false)).is_err());
        // A modifier is not a key; nor is a mouse button or nothing at all.
        for vk in [0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA5, 0x01, 0x05, 0x00, 0xFF, 0x1_0000] {
            assert!(hotkey_mods(&b(vk, true, false, false, false)).is_err(), "{vk:#x}");
        }
    }

    #[test]
    fn the_binding_reads_the_pages_shape() {
        let b: HotkeyBinding = serde_json::from_str("{\"keyCode\":78,\"ctrl\":false,\"alt\":false,\"shift\":true,\"win\":true,\"label\":\"N\"}").unwrap();
        assert_eq!(b, HotkeyBinding { key_code: 78, ctrl: false, alt: false, shift: true, win: true });
        // An older page's binding has no `win`.
        let old: HotkeyBinding = serde_json::from_str("{\"keyCode\":78,\"ctrl\":true,\"alt\":true,\"shift\":false}").unwrap();
        assert!(!old.win);
    }
}
