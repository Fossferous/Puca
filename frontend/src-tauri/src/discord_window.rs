//! Discord's own web app in a window of its own (docs/USER_GUIDE.md, *Discord in
//! a window of its own*).
//!
//! WHAT IT IS. The desktop app can open <https://discord.com/app> in a separate
//! window. The owner signs in on Discord's own page and uses Discord as Discord:
//! his DMs, his servers, his replies, Discord's own notifications. Púca never
//! reads, stores, relays or automates anything in that window. There is no user
//! token, no scripted click, no reading of the page, no script of Púca's in it.
//! Doing any of that would drive a Discord account through automation, which
//! Discord's terms forbid and the owner declined.
//!
//! WHY A SECOND PROCESS. Tauri puts the same scripts into EVERY webview it creates
//! in a process (tauri-2.11.5 `manager/webview.rs`, `prepare_pending_webview`):
//! `window.__TAURI_INTERNALS__` with the invoke key, and every plugin's init script.
//! tauri-plugin-notification's script REPLACES `window.Notification` with one that
//! calls the plugin; on Windows it reports `"denied"` at once
//! (`tauri-plugin-notification-2.4.0/src/init-iife.js`), and a remote page holding
//! no capability is refused every call. A Discord webview inside Púca's own process
//! could therefore never show a notification. It would also share that process's
//! channel-data queue: `plugin:__TAURI_CHANNEL__|fetch` is the one command the ACL
//! never checks (`webview/mod.rs`, `on_message`), and its ids are a process-wide
//! counter. So Discord gets a process of its own: `Puca.exe --discord-window`
//! ([`LAUNCH_ARG`]), started by [`discord_window_open`]. That process registers no
//! command and no plugin that carries one except the window-state plugin, whose
//! commands no capability grants. Púca's keys, sockets, messages and calls are
//! never in it. tests/discord_acl.rs runs Tauri's own ACL over the capability
//! set the build compiled in.
//!
//! WHAT IS STILL IN THE PAGE. Tauri's own core script, which no Tauri webview
//! can be built without: `window.isTauri`, `window.__TAURI_INTERNALS__` (with
//! the invoke key and this window's label) and the core plugins' helpers (event
//! unlisten, the window's drag-region listener, the devtools shortcut, path).
//! Every call they can make is one the ACL refuses here, and the only one it
//! never checks, the channel-data fetch, reads this process's own queue, which
//! nothing ever fills. No script of Púca's is in the page, and `withGlobalTauri`
//! stays off (`window.__TAURI__` would be the whole API under one name).
//!
//! ITS OWN PROFILE. [`profile_dir`] is a WebView2 user-data folder of its own, so
//! Discord's cookies and storage never meet Púca's, and a different folder means a
//! different WebView2 browser process. [`scrub_webview2_env`] drops the two
//! environment variables that could point it somewhere else or add a debugging
//! port to the browser that holds the owner's Discord session.
//!
//! NAVIGATION. Only the top-level page is checked: wry hooks `NavigationStarting`,
//! which WebView2 raises for the main frame only (`wry-0.55.1/src/webview2/mod.rs`).
//! So everything Discord loads INTO its page is untouched: its CDN and media hosts
//! (cdn.discordapp.com, media.discordapp.net, discord.media), its API and gateway
//! sockets, and the captcha its sign-in shows in an iframe. Discord's web sign-in
//! itself (password, QR code, passkey) happens on discord.com. A top-level page
//! stays in the window only on Discord's own app domains ([`navigation`]); any
//! other http(s) address goes to the system browser, and nothing else goes anywhere.
//!
//! NEW WINDOWS. `window.open` and `target=_blank` ([`new_window`]): a Discord app
//! address loads in this window (one Discord window, never a second one sharing its
//! profile), anything else http(s) opens in the system browser. No popup window is
//! ever created: WebView2's default popup would be a browser window with none of
//! these rules. Discord's "Open in Browser" and the sign-in popups of Connections
//! (Spotify, Xbox, ...) therefore open in the browser, where that flow then
//! finishes.
//!
//! NOTIFICATIONS. WebView2 shows no prompt of its own for notifications: unless the
//! host handles `PermissionRequested`, they are refused ("by default we match the
//! browser behavior ... Notifications ... never prompt", WebView2Feedback #4488;
//! `CoreWebView2PermissionKind.Notifications`: "no browser permission prompt will
//! be shown"). So this process asks, once, and only when the owner pressed
//! something in Discord's page that asked ([`notification_request`]). Yes is
//! remembered in the profile; No is not, so Discord's own "enable notifications"
//! can ask again. Púca never handles `NotificationReceived`: the notification goes
//! from Discord's page to WebView2's own notification UI and Púca never sees it.
//! Microphone and camera (a Discord call) are WebView2's own prompt, untouched.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::Url;

/// The window's label. Nothing in Púca's own process ever has this label; the
/// capability test pins that no capability can match it.
pub const LABEL: &str = "discord";

/// The one argument that starts this process as the Discord window. Compared to
/// the first argument only: a `puca://` link or `--hidden` is never it.
pub const LAUNCH_ARG: &str = "--discord-window";

/// Where the window opens.
pub const START_URL: &str = "https://discord.com/app";

/// The window's Win32 class, which is how a second open finds the first.
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOW_CLASS: &str = "PucaDiscordWindow";

/// WebView2 user-data folder, under the app's local data directory.
const PROFILE_DIR: &str = "discord-profile";

/// Size and place, in the app config directory, beside (never inside) the main
/// window's `.window-state.json`: one file per process, or each would overwrite
/// the other's.
const STATE_FILE: &str = ".discord-window-state.json";

const TITLE: &str = "Discord - Púca";

/// wry's default arguments are `--disable-features=msWebOOUI,msPdfOOUI,
/// msSmartScreenProtection`. This window downloads files from the internet
/// (Discord attachments), so it keeps SmartScreen on.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

/// Environment variables WebView2 reads that would undo this window's isolation:
/// another user-data folder (Púca's own, say), or extra browser arguments, such as
/// `--remote-debugging-port`, which would let any program on the PC drive the
/// browser holding the owner's Discord session.
const SCRUBBED_ENV: &[&str] = &["WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"];

// ---------------------------------------------------------------------------
// Policy. Pure, so it is tested without a window.
// ---------------------------------------------------------------------------

/// Discord's web app. The only hosts whose pages may ask for notifications, and
/// the only popup targets loaded in this window rather than the browser.
const APP_HOSTS: &[&str] = &["discord.com", "ptb.discord.com", "canary.discord.com"];

/// Hosts a top-level page may come from and stay in the window: discord.com and
/// every subdomain of it (the app, its help centre, its other pages), discord.gg
/// (invites, which redirect to discord.com/invite) and discordapp.com, the app's
/// old domain, which redirects to discord.com. NOT the subdomains of
/// discordapp.com: those are its CDN (cdn.discordapp.com), whose files the page
/// loads as resources, which no navigation rule touches. A file opened as a page
/// of its own goes to the browser, which is built for that.
fn stays_in_window(host: &str) -> bool {
    host == "discord.com"
        || host.ends_with(".discord.com")
        || host == "discord.gg"
        || host == "discordapp.com"
        || host == "www.discordapp.com"
}

/// An https address on Discord's default port with no user info, and its host.
fn https_host(url: &Url) -> Option<&str> {
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()
}

/// May this address be handed to the system browser at all? http(s) with a host
/// only: never `file:`, `javascript:`, `data:`, `blob:`, `about:`, or a custom
/// scheme (`ms-msdt:`, `search-ms:`, `steam:`), which would start some program on
/// the PC with an argument a web page chose.
fn browser_may_open(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    /// Load it in the Discord window.
    Stay,
    /// Cancel it here and open it in the system browser.
    OpenInBrowser,
    /// Cancel it; open nothing anywhere.
    Refuse,
}

/// What a top-level navigation of the Discord window does.
pub fn navigation(url: &Url) -> Navigation {
    // The window's own first page: it is created on about:blank so the
    // notification handler is in place before Discord's page exists
    // (`open_window`). Nothing else under about: is a page.
    if url.as_str() == "about:blank" {
        return Navigation::Stay;
    }
    if https_host(url).is_some_and(stays_in_window) {
        return Navigation::Stay;
    }
    if browser_may_open(url) {
        Navigation::OpenInBrowser
    } else {
        Navigation::Refuse
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewWindow {
    /// Load the address in the Discord window instead.
    LoadHere,
    /// Open it in the system browser.
    OpenInBrowser,
    /// Open nothing.
    Refuse,
}

/// What a `window.open` / `target=_blank` from the Discord window does. Never a
/// new window: see the module header.
pub fn new_window(url: &Url) -> NewWindow {
    if https_host(url).is_some_and(|h| APP_HOSTS.contains(&h) || h == "discord.gg") {
        return NewWindow::LoadHere;
    }
    if browser_may_open(url) {
        NewWindow::OpenInBrowser
    } else {
        NewWindow::Refuse
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationAsk {
    /// Ask the owner, now.
    AskOwner,
    /// Refuse it without asking, and remember nothing.
    Refuse,
}

/// A notification permission request: from Discord's app, and started by the
/// owner pressing something in its page? Only then is he asked. A request the page
/// makes on its own (on load, say) is refused quietly and not remembered, so it
/// never becomes a question nobody asked for, and Discord's own "enable
/// notifications" can still ask later.
pub fn notification_request(origin: &str, user_initiated: bool) -> NotificationAsk {
    let from_discord = Url::parse(origin)
        .ok()
        .as_ref()
        .and_then(https_host)
        .is_some_and(|h| APP_HOSTS.contains(&h));
    if from_discord && user_initiated {
        NotificationAsk::AskOwner
    } else {
        NotificationAsk::Refuse
    }
}

/// What a permission request is answered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionAnswer {
    pub allow: bool,
    /// Saved in the Discord profile (WebView2's default), so it is not asked again.
    pub remember: bool,
}

/// The owner's answer, as WebView2 is told it. Yes is remembered: he said so, and
/// asking at every visit is what makes people say no. No is NOT remembered: a
/// remembered block would answer every later request with no question, and
/// Discord's own switch to turn notifications on would silently do nothing.
pub fn answer_for(owner_allowed: bool) -> PermissionAnswer {
    PermissionAnswer { allow: owner_allowed, remember: owner_allowed }
}

/// How many addresses the page may hand the system browser in a burst, and how
/// fast that refills. A person clicking links is well inside it; a page opening
/// one tab after another in the owner's real browser, where he is signed in to
/// everything, is not.
const BROWSER_BURST: f64 = 4.0;
const BROWSER_REFILL_PER_SEC: f64 = 1.0;

/// A token bucket for [`BROWSER_BURST`]. Pure: the caller supplies the time.
#[derive(Debug)]
pub struct BrowserOpenLimiter {
    tokens: f64,
    last: Option<Instant>,
}

impl Default for BrowserOpenLimiter {
    fn default() -> Self {
        Self { tokens: BROWSER_BURST, last: None }
    }
}

impl BrowserOpenLimiter {
    /// May one more address go to the browser at `now`?
    pub fn allow(&mut self, now: Instant) -> bool {
        if let Some(last) = self.last {
            let elapsed = now.saturating_duration_since(last).as_secs_f64();
            self.tokens = (self.tokens + elapsed * BROWSER_REFILL_PER_SEC).min(BROWSER_BURST);
        }
        self.last = Some(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Is this process the Discord window? Only when the FIRST argument is
/// [`LAUNCH_ARG`].
pub fn is_window_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter().nth(1).is_some_and(|a| a.as_ref() == OsStr::new(LAUNCH_ARG))
}

/// The Discord window's WebView2 user-data folder. Never Púca's own
/// (`<local data>\EBWebView`), never inside it.
pub fn profile_dir(local_data: &Path) -> PathBuf {
    local_data.join(PROFILE_DIR)
}

/// Take out what [`SCRUBBED_ENV`] lists, before any WebView2 exists in this process.
fn scrub_webview2_env() {
    for name in SCRUBBED_ENV {
        // Edition 2021: safe. Called first thing in a fresh process, before any
        // other thread exists.
        std::env::remove_var(name);
    }
}

// ---------------------------------------------------------------------------
// Púca's own process: open the window, or bring it forward.
// ---------------------------------------------------------------------------

/// Open the Discord window, or bring the open one forward. Called from Púca's
/// own window (Settings > Desktop App shows the rail's entry).
#[tauri::command]
pub fn discord_window_open() -> Result<(), String> {
    #[cfg(windows)]
    {
        if win::bring_forward_existing() {
            log::info!("[discord] brought the open window forward");
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        // No console, even for a debug build (which is a console program).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|e| format!("Could not find Púca's program file: {e}"))?;
        let child = Command::new(exe)
            .arg(LAUNCH_ARG)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Could not open the Discord window: {e}"))?;
        // The owner just pressed the button, so this process is in front and may
        // pass that on: the new window opens in front, not behind Púca.
        win::allow_foreground(child.id());
        // Never the pid's process tree or anything about the page: only that it opened.
        log::info!("[discord] opened the Discord window");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Discord in a window of its own is in the Windows desktop app.".to_string())
    }
}

// ---------------------------------------------------------------------------
// The Discord window's own process.
// ---------------------------------------------------------------------------

/// Run this process as the Discord window. Returns when the window has closed.
pub fn run_window_process(context: tauri::Context<tauri::Wry>) {
    scrub_webview2_env();

    // One Discord window per Windows session: a second process (two quick clicks,
    // or Púca restarted while the window stayed open) brings the first forward and
    // goes, before a second WebView2 could find the profile locked and come up blank.
    #[cfg(windows)]
    let _one_window = match win::SingleWindow::acquire() {
        Some(guard) => guard,
        None => {
            win::bring_forward_existing();
            return;
        }
    };

    let built = tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filename(STATE_FILE)
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            open_window(app.handle())?;
            Ok(())
        })
        // No invoke_handler: this process has no command of its own.
        .build(context);
    match built {
        Ok(app) => app.run(|_, _| {}),
        Err(e) => eprintln!("discord window: could not start: {e}"),
    }
}

/// Hand an address to the system browser, off the UI thread (ShellExecute can
/// wait on the program it starts), within [`BrowserOpenLimiter`].
fn open_in_browser(url: &Url, limiter: &std::sync::Mutex<BrowserOpenLimiter>) {
    if !browser_may_open(url) {
        return;
    }
    let allowed = limiter.lock().map(|mut l| l.allow(Instant::now())).unwrap_or(false);
    if !allowed {
        return;
    }
    let url = url.to_string();
    std::thread::Builder::new()
        .name("discord-open-in-browser".into())
        .spawn(move || {
            let _ = opener::open(&url);
        })
        .ok();
}

fn open_window(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::{Arc, Mutex};
    use tauri::webview::NewWindowResponse;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let profile = profile_dir(&app.path().app_local_data_dir()?);
    let limiter = Arc::new(Mutex::new(BrowserOpenLimiter::default()));
    let nav_limiter = limiter.clone();
    let popup_app = app.clone();

    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse()?))
        .title(TITLE)
        .inner_size(1180.0, 800.0)
        .min_inner_size(420.0, 420.0)
        // Shown once the saved size and place are back (the window-state plugin
        // restores while the window is built).
        .visible(false)
        .data_directory(profile)
        .additional_browser_args(BROWSER_ARGS)
        // Discord's own warning about pasting code into the console exists because
        // that is how accounts are stolen; this window has no console to paste into.
        .devtools(false)
        // A browser's Ctrl+wheel and Ctrl+plus/minus.
        .zoom_hotkeys_enabled(true)
        // A file dragged onto Discord's page is Discord's upload, as in a
        // browser. Tauri's own handler (on by default) would take the drop for
        // itself, and this process has nobody listening for it.
        .disable_drag_drop_handler()
        .on_navigation(move |url| match navigation(url) {
            Navigation::Stay => true,
            Navigation::OpenInBrowser => {
                open_in_browser(url, &nav_limiter);
                false
            }
            Navigation::Refuse => false,
        })
        .on_new_window(move |url, _features| {
            match new_window(&url) {
                NewWindow::LoadHere => {
                    if let Some(w) = popup_app.get_webview_window(LABEL) {
                        let _ = w.navigate(url);
                    }
                }
                NewWindow::OpenInBrowser => open_in_browser(&url, &limiter),
                NewWindow::Refuse => {}
            }
            NewWindowResponse::Deny
        });
    #[cfg(windows)]
    let builder = builder.window_classname(WINDOW_CLASS);
    let window = builder.build()?;

    // The notification handler first, THEN Discord's page, so no request can
    // arrive before there is something to answer it.
    #[cfg(windows)]
    win::answer_notification_requests_then_open(&window, app.clone())?;
    #[cfg(not(windows))]
    window.navigate(START_URL.parse()?)?;

    window.show()?;
    let _ = window.set_focus();
    Ok(())
}

#[cfg(windows)]
mod win {
    //! Windows: one window, bringing it forward, and the notification question.
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2PermissionRequestedEventArgs3,
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND};
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, FindWindowW, IsIconic, MessageBoxW, SetForegroundWindow, ShowWindow,
        IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_YESNO, SW_RESTORE,
    };
    use wv2_core::Interface;

    /// Held for the life of the Discord window's process.
    pub struct SingleWindow(HANDLE);

    impl SingleWindow {
        /// `None` when another Discord window process already holds it.
        pub fn acquire() -> Option<Self> {
            let name = HSTRING::from(format!("Local\\{}.discord-window", env!("PUCA_IDENTIFIER")));
            // SAFETY: a named mutex; the handle is closed in Drop or, when another
            // process holds the name, right here.
            unsafe {
                let handle = CreateMutexW(None, false, &name).ok()?;
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = CloseHandle(handle);
                    return None;
                }
                Some(Self(handle))
            }
        }
    }

    impl Drop for SingleWindow {
        fn drop(&mut self) {
            // SAFETY: our own handle, closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn find_window() -> Option<HWND> {
        let class = HSTRING::from(WINDOW_CLASS);
        // SAFETY: two valid wide strings (the class, and no title).
        unsafe { FindWindowW(&class, PCWSTR::null()).ok() }.filter(|h| !h.is_invalid())
    }

    /// Bring an open Discord window forward. `false` when there is none.
    pub fn bring_forward_existing() -> bool {
        let Some(hwnd) = find_window() else { return false };
        // SAFETY: a window handle FindWindowW just returned; a stale one fails harmlessly.
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }
        true
    }

    pub fn allow_foreground(pid: u32) {
        // SAFETY: plain call; failure only means the window may open behind.
        unsafe {
            let _ = AllowSetForegroundWindow(pid);
        }
    }

    /// COM objects WebView2 handed this process on its UI thread, carried to a
    /// task that runs on that same thread. `run_on_main_thread` wants `Send`; the
    /// objects only ride along, and are never used or released anywhere else (if
    /// the task is never run, the app is closing and they are leaked, not
    /// released on the wrong thread).
    struct UiThreadOnly<T>(std::mem::ManuallyDrop<T>);
    // SAFETY: see the type's comment. Built on the UI thread; `into_inner` is called
    // only inside a task `run_on_main_thread` runs on the UI thread.
    unsafe impl<T> Send for UiThreadOnly<T> {}
    impl<T> UiThreadOnly<T> {
        fn new(value: T) -> Self {
            Self(std::mem::ManuallyDrop::new(value))
        }
        /// SAFETY: call on the UI thread only.
        unsafe fn into_inner(self) -> T {
            std::mem::ManuallyDrop::into_inner(self.0)
        }
    }

    /// One question at a time.
    static ASKING: AtomicBool = AtomicBool::new(false);

    fn apply(args: &ICoreWebView2PermissionRequestedEventArgs, answer: PermissionAnswer) {
        // SAFETY: WebView2 calls on the UI thread, where `args` was handed to us.
        unsafe {
            let state = if answer.allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
            let _ = args.SetState(state);
            if !answer.remember {
                if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    let _ = args3.SetSavesInProfile(false);
                }
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The question. WebView2 has none of its own for notifications. On a thread
    /// of its own, owned by the Discord window: the window's UI thread keeps
    /// running, and the question sits on top of the window that asked. No is the
    /// default button, so a stray Enter allows nothing.
    fn ask_owner(owner: isize) -> bool {
        let title = wide("Discord notifications - Púca");
        let text = wide(
            "Discord is asking to show notifications on this PC.\n\n\
             Allow them? Windows shows them straight from Discord's page; \
             Púca does not read them.\n\n\
             You can turn them off later in Discord: User Settings > Notifications.",
        );
        // SAFETY: two NUL-terminated wide strings that outlive the call; the
        // owner is a window handle of this process (or null).
        let answer = unsafe {
            MessageBoxW(
                HWND(owner as *mut core::ffi::c_void),
                PCWSTR(text.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
            )
        };
        answer == IDYES
    }

    /// Register the notification handler on the window's webview, then open
    /// Discord's page.
    pub fn answer_notification_requests_then_open(
        window: &tauri::WebviewWindow,
        app: tauri::AppHandle,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        window.with_webview(move |platform| {
            // SAFETY: WebView2 COM calls on the UI thread this closure runs on.
            unsafe {
                let Ok(core) = platform.controller().CoreWebView2() else { return };
                let app_for_handler = app.clone();
                let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind != COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        // Microphone, camera, ...: WebView2's own prompt.
                        return Ok(());
                    }
                    let mut uri = wv2_core::PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let mut user_initiated = wv2_core::BOOL::default();
                    args.IsUserInitiated(&mut user_initiated)?;
                    let ask = notification_request(&uri, user_initiated.as_bool());
                    if ask == NotificationAsk::Refuse || ASKING.swap(true, Ordering::SeqCst) {
                        apply(&args, answer_for(false));
                        return Ok(());
                    }
                    // Answered later, outside this handler: a question shown from
                    // inside a WebView2 event handler is the re-entrancy Microsoft's
                    // threading model warns about.
                    let deferral = args.GetDeferral()?;
                    let job = UiThreadOnly::new((args, deferral));
                    let app = app_for_handler.clone();
                    let spawned = std::thread::Builder::new().name("discord-notification-question".into()).spawn(move || {
                        let allowed = ask_owner(owner);
                        // From this thread, so the task is queued, not run here.
                        let _ = app.run_on_main_thread(move || {
                            // SAFETY (inside the block above): run_on_main_thread
                            // runs this on the UI thread.
                            let (args, deferral) = job.into_inner();
                            apply(&args, answer_for(allowed));
                            let _ = deferral.Complete();
                            ASKING.store(false, Ordering::SeqCst);
                        });
                    });
                    if spawned.is_err() {
                        ASKING.store(false, Ordering::SeqCst);
                    }
                    Ok(())
                }));
                let mut token = Default::default();
                // Should WebView2 refuse the handler, Discord still opens: its
                // notifications then stay off (WebView2's own quiet refusal).
                let _ = core.add_PermissionRequested(&handler, &mut token);
                let _ = core.Navigate(&wv2_core::HSTRING::from(START_URL));
            }
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn discord_app_pages_stay_in_the_window() {
        for s in [
            "https://discord.com/app",
            "https://discord.com/login",
            "https://discord.com/channels/@me",
            "https://discord.com/channels/123/456",
            "https://ptb.discord.com/app",
            "https://canary.discord.com/app",
            "https://support.discord.com/hc/en-us",
            "https://discord.gg/abcdef",
            "https://discordapp.com/channels/@me",
            "https://www.discordapp.com/",
            "https://DISCORD.com/app",
            "about:blank",
        ] {
            assert_eq!(navigation(&u(s)), Navigation::Stay, "{s}");
        }
    }

    #[test]
    fn everything_else_goes_to_the_browser_or_nowhere() {
        for s in [
            "https://example.com/",
            "https://evil-discord.com/app",
            "https://discord.com.evil.example/app",
            "https://discordapp.com.evil.example/",
            "https://cdn.discordapp.com/attachments/1/2/x.png",
            "https://media.discordapp.net/attachments/1/2/x.png",
            "https://discord.media/",
            "https://accounts.spotify.com/authorize",
            "http://discord.com/app",
            "https://discord.com:8443/app",
            "https://user@discord.com/app",
            "https://discord.com.:443/app",
        ] {
            assert_eq!(navigation(&u(s)), Navigation::OpenInBrowser, "{s}");
        }
        for s in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ms-msdt:/id",
            "search-ms:query=x",
            "steam://run/1",
            "about:srcdoc",
            "edge://settings",
            "mailto:someone@example.com",
        ] {
            assert_eq!(navigation(&u(s)), Navigation::Refuse, "{s}");
        }
    }

    #[test]
    fn popups_never_make_a_window() {
        for s in ["https://discord.com/channels/1/2", "https://canary.discord.com/app", "https://discord.gg/x"] {
            assert_eq!(new_window(&u(s)), NewWindow::LoadHere, "{s}");
        }
        // Open in Browser on an attachment, a Connections sign-in, a help article.
        for s in [
            "https://cdn.discordapp.com/attachments/1/2/x.png",
            "https://accounts.spotify.com/authorize?client_id=x",
            "https://login.live.com/oauth20_authorize.srf",
            "https://support.discord.com/hc/en-us/articles/1",
            "https://dis.gd/notifications",
            "http://example.com/",
        ] {
            assert_eq!(new_window(&u(s)), NewWindow::OpenInBrowser, "{s}");
        }
        for s in ["about:blank", "javascript:void(0)", "file:///C:/x", "ms-settings:privacy"] {
            assert_eq!(new_window(&u(s)), NewWindow::Refuse, "{s}");
        }
    }

    #[test]
    fn only_a_press_in_discords_own_page_asks_about_notifications() {
        assert_eq!(notification_request("https://discord.com/", true), NotificationAsk::AskOwner);
        assert_eq!(notification_request("https://canary.discord.com", true), NotificationAsk::AskOwner);
        // The page asking on its own: refused, no question.
        assert_eq!(notification_request("https://discord.com/", false), NotificationAsk::Refuse);
        // Anything that is not Discord's app, pressed or not.
        for origin in [
            "https://support.discord.com/",
            "https://evil.example/",
            "http://discord.com/",
            "https://discord.com.evil.example/",
            "null",
            "",
        ] {
            assert_eq!(notification_request(origin, true), NotificationAsk::Refuse, "{origin}");
        }
    }

    #[test]
    fn yes_is_remembered_and_no_is_not() {
        assert_eq!(answer_for(true), PermissionAnswer { allow: true, remember: true });
        assert_eq!(answer_for(false), PermissionAnswer { allow: false, remember: false });
    }

    #[test]
    fn the_browser_gets_a_burst_then_one_a_second() {
        let mut limiter = BrowserOpenLimiter::default();
        let t0 = Instant::now();
        for i in 0..4 {
            assert!(limiter.allow(t0), "click {i} of a burst");
        }
        assert!(!limiter.allow(t0), "a fifth at once is refused");
        assert!(!limiter.allow(t0 + Duration::from_millis(500)), "half a second refills less than one");
        assert!(limiter.allow(t0 + Duration::from_millis(1100)), "one a second after that");
        assert!(!limiter.allow(t0 + Duration::from_millis(1200)));
        // A long pause gives back the burst, no more.
        let later = t0 + Duration::from_secs(60);
        for _ in 0..4 {
            assert!(limiter.allow(later));
        }
        assert!(!limiter.allow(later));
    }

    #[test]
    fn only_the_first_argument_starts_the_discord_window() {
        assert!(is_window_launch(["Puca.exe", "--discord-window"]));
        assert!(!is_window_launch(["Puca.exe"]));
        assert!(!is_window_launch(["Puca.exe", "--hidden"]));
        assert!(!is_window_launch(["Puca.exe", "--hidden", "--discord-window"]));
        assert!(!is_window_launch(["Puca.exe", "puca://invite/--discord-window"]));
        assert!(!is_window_launch(["Puca.exe", "--discord-window=1"]));
    }

    #[test]
    fn the_profile_is_its_own_folder_beside_puca_s() {
        let local = Path::new(r"C:\Users\x\AppData\Local\com.sovereign.chat");
        let profile = profile_dir(local);
        assert_eq!(profile, local.join("discord-profile"));
        // Púca's own WebView2 data is <local>\EBWebView: not this, not inside it.
        let puca = local.join("EBWebView");
        assert!(!profile.starts_with(&puca));
        assert!(!puca.starts_with(&profile));
        assert_ne!(STATE_FILE, ".window-state.json");
    }

    #[test]
    fn the_webview2_variables_that_undo_the_isolation_are_scrubbed() {
        assert!(SCRUBBED_ENV.contains(&"WEBVIEW2_USER_DATA_FOLDER"));
        assert!(SCRUBBED_ENV.contains(&"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"));
        assert!(!BROWSER_ARGS.contains("msSmartScreenProtection"), "SmartScreen stays on in a window that downloads");
    }
}

/// The capability files and the configs, read as text: every capability names
/// its windows, none can match the Discord window, none grants a remote origin,
/// and no config exposes `window.__TAURI__`. A wildcard added later fails here.
#[cfg(test)]
mod capability_files {
    use super::LABEL;
    use std::path::Path;

    fn manifest_dir() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
    }

    /// Tauri matches a capability's `windows`/`webviews` entries as glob patterns
    /// (`*`, `?`, `[...]`). Whether `pattern` could match `label`.
    fn glob_matches(pattern: &str, label: &str) -> bool {
        fn go(p: &[char], s: &[char]) -> bool {
            match p.first() {
                None => s.is_empty(),
                Some('*') => (0..=s.len()).any(|i| go(&p[1..], &s[i..])),
                Some('?') => !s.is_empty() && go(&p[1..], &s[1..]),
                // A character class: treated as matching any one character, the
                // conservative reading for a check that must not miss a match.
                Some('[') => match p.iter().position(|&c| c == ']') {
                    Some(end) => !s.is_empty() && go(&p[end + 1..], &s[1..]),
                    None => !s.is_empty() && s[0] == '[' && go(&p[1..], &s[1..]),
                },
                Some(&c) => s.first() == Some(&c) && go(&p[1..], &s[1..]),
            }
        }
        let p: Vec<char> = pattern.chars().collect();
        let s: Vec<char> = label.chars().collect();
        go(&p, &s)
    }

    /// Problems with one capability object, by the rules above.
    fn capability_problems(name: &str, cap: &serde_json::Value) -> Vec<String> {
        let mut problems = Vec::new();
        let windows: Vec<&str> = cap
            .get("windows")
            .and_then(|w| w.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let webviews: Vec<&str> = cap
            .get("webviews")
            .and_then(|w| w.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        if windows.is_empty() && webviews.is_empty() {
            problems.push(format!("{name}: names no windows (it must name them explicitly)"));
        }
        for pattern in windows.iter().chain(webviews.iter()) {
            if glob_matches(pattern, LABEL) {
                problems.push(format!("{name}: \"{pattern}\" matches the Discord window's label \"{LABEL}\""));
            }
        }
        if cap.get("remote").is_some() {
            problems.push(format!("{name}: grants a remote origin (\"remote\")"));
        }
        problems
    }

    fn capability_files() -> Vec<(String, serde_json::Value)> {
        let dir = manifest_dir().join("capabilities");
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("capabilities/ is readable") {
            let path = entry.unwrap().path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            assert!(ext == "json", "{}: only JSON capabilities are checked here; check this one too", path.display());
            let text = std::fs::read_to_string(&path).unwrap();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            // A file may hold one capability or a list of them.
            match &value {
                serde_json::Value::Array(caps) => {
                    out.extend(caps.iter().map(|c| (name.clone(), c.clone())));
                }
                _ => out.push((name, value)),
            }
        }
        out
    }

    #[test]
    fn the_glob_reading_is_not_vacuous() {
        for p in ["*", "d*", "disc?rd", "[a-z]iscord", "*cord", "discord"] {
            assert!(glob_matches(p, "discord"), "{p}");
        }
        for p in ["main", "puca-pop-*", "discord-*", "?"] {
            assert!(!glob_matches(p, "discord"), "{p}");
        }
    }

    #[test]
    fn no_capability_file_reaches_the_discord_window() {
        let caps = capability_files();
        assert!(!caps.is_empty(), "the capability directory was read");
        let problems: Vec<String> = caps.iter().flat_map(|(n, c)| capability_problems(n, c)).collect();
        assert!(problems.is_empty(), "{problems:#?}");
    }

    #[test]
    fn the_checks_catch_what_they_are_for() {
        // NEGATIVE CONTROLS: the shapes a later change could add.
        let wildcard = serde_json::json!({ "identifier": "x", "windows": ["*"], "permissions": ["core:default"] });
        assert!(!capability_problems("wildcard", &wildcard).is_empty());
        let unnamed = serde_json::json!({ "identifier": "x", "permissions": ["core:default"] });
        assert!(!capability_problems("unnamed", &unnamed).is_empty());
        let remote = serde_json::json!({
            "identifier": "x", "windows": ["main"],
            "remote": { "urls": ["https://*.discord.com"] }, "permissions": ["core:default"]
        });
        assert!(!capability_problems("remote", &remote).is_empty());
        let webview = serde_json::json!({ "identifier": "x", "webviews": ["disc*"], "permissions": [] });
        assert!(!capability_problems("webview", &webview).is_empty());
        // CONTROL: today's shape passes.
        let ok = serde_json::json!({ "identifier": "default", "windows": ["main"], "permissions": ["core:default"] });
        assert!(capability_problems("ok", &ok).is_empty());
    }

    #[test]
    fn no_config_inlines_a_capability_or_exposes_the_global_api() {
        for file in ["tauri.conf.json", "tauri.lite.conf.json", "tauri.windows.conf.json"] {
            let text = std::fs::read_to_string(manifest_dir().join(file)).unwrap();
            let config: serde_json::Value = serde_json::from_str(&text).unwrap();
            let app = config.get("app");
            assert_ne!(
                app.and_then(|a| a.get("withGlobalTauri")).and_then(|v| v.as_bool()),
                Some(true),
                "{file}: withGlobalTauri would put window.__TAURI__ in every page, Discord's included"
            );
            if let Some(inline) = app.and_then(|a| a.get("security")).and_then(|s| s.get("capabilities")) {
                for cap in inline.as_array().into_iter().flatten() {
                    // An inline entry is a capability object or a file's identifier.
                    if cap.is_object() {
                        let problems = capability_problems(file, cap);
                        assert!(problems.is_empty(), "{problems:#?}");
                    }
                }
            }
        }
    }
}
