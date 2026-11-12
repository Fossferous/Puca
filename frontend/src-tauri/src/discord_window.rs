//! Discord's own web app in a window of its own (docs/DISCORD.md says what it is,
//! how it is kept apart and what remains; docs/USER_GUIDE.md how to use it).
//!
//! WHAT IT IS. The Windows desktop app can open <https://discord.com/app> in a
//! window of its own. The owner signs in on Discord's own page and uses Discord as
//! Discord. Púca never reads, stores, relays or automates anything in that window:
//! no user token, no scripted click, no reading of the page, no script of Púca's
//! in it. Doing any of that would drive a Discord account through automation,
//! which Discord's terms forbid and the owner declined.
//!
//! HOW IT IS KEPT APART. The window is a second process of this executable,
//! `Puca.exe --discord-window` ([`LAUNCH_ARG`]), which `run()` in lib.rs sends here
//! before Tauri or anything else of Púca's starts. That process is a plain Win32
//! window hosting WebView2 directly (discord_host.rs), with NO Tauri in it: a
//! Tauri webview, remote or not, always carries Tauri's IPC bridge and its
//! `ipc`/`tauri` protocols (discord_host.rs says where, in Tauri's source). Its
//! WebView2 profile is a folder of its own ([`profile_dir`]), held exclusively
//! while the window is open. The Púca process only starts it, brings it forward
//! and closes it ([`discord_window_open`], [`discord_window_clear_data`]); it has
//! no handle on the page.
//!
//! THIS FILE is what is decided, as pure functions tested without a window:
//! where a top-level page may load ([`navigation`]), what a popup does
//! ([`new_window`]), how a permission request is answered
//! ([`permission_decision`]), what the title bar says ([`window_title`]), and
//! Púca's two commands.
//!
//! NAVIGATION. Only the top-level page is checked: WebView2 raises
//! `NavigationStarting` for the main frame only (frames have their own event,
//! which nothing here hooks). So everything Discord loads INTO its page is
//! untouched: its CDN and media hosts (cdn.discordapp.com, media.discordapp.net,
//! discord.media), its API and gateway sockets, and the captcha its sign-in shows
//! in a frame. Discord's web sign-in itself (password, QR code, passkey) happens
//! on discord.com. A page stays in the window only on Discord's own domains; any
//! other http(s) address goes to the system browser, and nothing else goes
//! anywhere.
//!
//! NEW WINDOWS. `window.open` and `target=_blank`: a Discord app address loads in
//! this window, anything else http(s) opens in the system browser. No popup
//! window is ever created: WebView2's default popup would be a browser window
//! with none of these rules. Discord's "Open in Browser" and the sign-in popups
//! of Connections (Spotify, Xbox, ...) therefore open in the browser.
//!
//! PERMISSIONS. Only Discord's own app origin may be granted anything, and
//! nothing is granted without someone being asked: the microphone, the camera
//! and clipboard reading get WebView2's own question (and Windows' own for the
//! microphone and camera); notifications, which WebView2 never asks about
//! ("Notifications ... never prompt", WebView2Feedback #4488;
//! `CoreWebView2PermissionKind.Notifications`: "no browser permission prompt will
//! be shown"), get Púca's question, and only when the owner pressed something in
//! Discord's page that asked; location and everything else are refused, for
//! every origin. Screen sharing goes through WebView2's own picker, from Discord's
//! app only.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Instant;

use url::Url;

/// A name reserved for this window. No Tauri window in either process has it
/// (the Discord window is not a Tauri window at all); the capability tests keep
/// any capability from ever matching it, in case one ever does.
pub const LABEL: &str = "discord";

/// The one argument that starts this process as the Discord window. Compared to
/// the first argument only: a `puca://` link or `--hidden` is never it.
pub const LAUNCH_ARG: &str = "--discord-window";

/// Where the window opens.
pub const START_URL: &str = "https://discord.com/app";

/// WebView2 user-data folder, under the app's local data directory.
const PROFILE_DIR: &str = "discord-profile";

/// Environment variables WebView2 reads that would undo this window's isolation:
/// another user-data folder (Púca's own, say), or extra browser arguments, such
/// as `--remote-debugging-port`, or a script-debugger pipe, either of which would
/// let another program drive the browser holding the owner's Discord session.
/// `SSLKEYLOGFILE` is the other: Chromium writes every TLS session key to the
/// file it names, and with them anyone could read the window's traffic to
/// Discord, sign-in included. Developer PCs often have it set for their own
/// debugging. (`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` stays: it picks which
/// WebView2 runs, the same one Púca's own window uses.)
const SCRUBBED_ENV: &[&str] = &[
    "WEBVIEW2_USER_DATA_FOLDER",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
    "SSLKEYLOGFILE",
];

// ---------------------------------------------------------------------------
// Policy. Pure, so it is tested without a window.
// ---------------------------------------------------------------------------

/// Discord's web app: the only origins that may be granted a permission, start a
/// screen share, or have a popup loaded in this window rather than the browser.
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

/// An https address on the default port with no user info, and its host.
fn https_host(url: &Url) -> Option<&str> {
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()
}

/// Is this origin (or address) Discord's web app itself?
pub fn is_app_origin(origin: &str) -> bool {
    Url::parse(origin).ok().as_ref().and_then(https_host).is_some_and(|h| APP_HOSTS.contains(&h))
}

/// May this address be handed to the system browser at all? http(s) with a host
/// only: never `file:`, `javascript:`, `data:`, `blob:`, `about:`, or a custom
/// scheme (`ms-msdt:`, `search-ms:`, `steam:`), which would start some program on
/// the PC with an argument a web page chose.
pub fn browser_may_open(url: &Url) -> bool {
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
    // An empty page shows nothing and reaches nothing. Nothing else under about:.
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

/// [`navigation`], with whether a person's press started it. A page may move
/// itself around Discord's own domains as it likes, but it hands an address to
/// the owner's browser only when he clicked: WebView2 has no popup blocker of
/// its own, so without this a page could open one site after another in his
/// real, signed-in browser by itself.
pub fn navigation_action(url: &Url, user_initiated: bool) -> Navigation {
    match navigation(url) {
        Navigation::OpenInBrowser if !user_initiated => Navigation::Refuse,
        other => other,
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

/// [`new_window`], with whether a person's press started it. A popup nobody
/// clicked for opens nothing, here or in the browser (WebView2 leaves popup
/// blocking to the host).
pub fn popup_action(url: &Url, user_initiated: bool) -> NewWindow {
    if user_initiated {
        new_window(url)
    } else {
        NewWindow::Refuse
    }
}

/// The kinds of permission WebView2 asks the host about, as far as this window
/// tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    Microphone,
    Camera,
    Notifications,
    ClipboardRead,
    Autoplay,
    Geolocation,
    /// Sensors, MIDI, local fonts, the file system, window placement, persistent
    /// storage, several automatic downloads, and whatever WebView2 adds later.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAction {
    /// Left to WebView2: it asks with its own question (and Windows with its own,
    /// for the microphone and camera), and remembers the answer in Discord's
    /// profile, as Edge does.
    WebView2Prompt,
    /// Púca asks the owner, because WebView2 never does for this kind.
    AskOwner,
    /// Refused without asking, and not remembered.
    Deny,
}

/// How a permission request from `origin` is answered.
///
/// Never granted without a question, and only ever for Discord's own app:
/// - a call needs the microphone and camera, and pasting a picture can need the
///   clipboard: WebView2's own question;
/// - notifications: WebView2 has no question of its own, so Púca asks, and only
///   when the owner pressed something in Discord's page that asked
///   (`user_initiated`). A request the page makes by itself is refused quietly
///   and not remembered, so it never becomes a question nobody asked for, and
///   Discord's own "enable notifications" can still ask later;
/// - autoplay is WebView2's own rule for playing sound without a click;
/// - location, and every other kind: Discord's web app has no use for them.
pub fn permission_decision(kind: PermissionKind, origin: &str, user_initiated: bool) -> PermissionAction {
    if !is_app_origin(origin) {
        return PermissionAction::Deny;
    }
    match kind {
        PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::ClipboardRead | PermissionKind::Autoplay => {
            PermissionAction::WebView2Prompt
        }
        PermissionKind::Notifications if user_initiated => PermissionAction::AskOwner,
        PermissionKind::Notifications | PermissionKind::Geolocation | PermissionKind::Other => PermissionAction::Deny,
    }
}

/// May a frame from `origin` start a screen share (WebView2's own picker)?
pub fn screen_capture_allowed(origin: &str) -> bool {
    is_app_origin(origin)
}

/// The title bar: where the window is, from its address, on every navigation
/// ("Discord · discord.com"). There is no address bar, so this is how a person
/// sees where they are. Never the page's own title. A host is shown as the URL
/// standard writes it (an IDN as `xn--`), so a lookalike cannot borrow the look
/// of a real name; the navigation rules keep anything but Discord's own domains
/// out anyway.
pub fn window_title(address: &str) -> String {
    match Url::parse(address).ok().as_ref().filter(|u| matches!(u.scheme(), "http" | "https")).and_then(|u| u.host_str()) {
        Some(host) => format!("Discord · {host}"),
        None => "Discord".to_string(),
    }
}

/// The window's size and place, as Windows' own placement (normal position,
/// maximized or not), kept in the Discord profile folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Placement {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub maximized: bool,
}

/// A saved placement, if it is one a window could have. Whether it is still on a
/// monitor is the host's question to Windows.
pub fn parse_placement(text: &str) -> Option<Placement> {
    let p: Placement = serde_json::from_str(text).ok()?;
    let (w, h) = (i64::from(p.right) - i64::from(p.left), i64::from(p.bottom) - i64::from(p.top));
    ((200..=32_000).contains(&w) && (200..=32_000).contains(&h)).then_some(p)
}

/// How many addresses may go to the system browser in a burst, and how fast
/// that refills. Only a press can send one at all ([`navigation_action`],
/// [`popup_action`]); this is the backstop behind that, so a page that turns one
/// press into many still opens a handful of tabs, not dozens.
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

/// The Discord window's WebView2 user-data folder, under the app's local data
/// folder. Never Púca's own (`<local data>\EBWebView`), never inside it.
pub fn profile_dir(local_data: &Path) -> PathBuf {
    local_data.join(PROFILE_DIR)
}

/// [`profile_dir`] from `%LOCALAPPDATA%` (the same base the app's own WebView2
/// data and its startup permission reset use), or `None` without an absolute one.
/// The ONLY path "sign out and clear" ever deletes.
pub fn profile_dir_from_env(local_app_data: Option<OsString>) -> Option<PathBuf> {
    let base = PathBuf::from(local_app_data?);
    if !base.is_absolute() {
        return None;
    }
    Some(profile_dir(&base.join(env!("PUCA_IDENTIFIER"))))
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
// Púca's own process: open the window, bring it forward, sign out and clear.
// ---------------------------------------------------------------------------

/// Open the Discord window, or bring the open one forward. Called from Púca's
/// own window (the rail's entry, which Settings > Advanced turns on).
#[tauri::command]
pub fn discord_window_open() -> Result<(), String> {
    #[cfg(windows)]
    {
        if crate::discord_host::bring_forward_existing() {
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
        crate::discord_host::allow_foreground(child.id());
        // Only that it opened: nothing about the page, ever.
        log::info!("[discord] opened the Discord window");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Discord in a window of its own is in the Windows desktop app.".to_string())
    }
}

/// "Sign out of Discord and clear its data on this PC": close the Discord window
/// if it is open, wait for it to go, then delete its WebView2 profile folder
/// ([`profile_dir_from_env`], and nothing else), which holds Discord's sign-in,
/// cookies, cache and settings and the window's size and place. `"cleared"`, or
/// `"nothing"` when there was nothing to delete. The Discord account itself is
/// untouched.
#[tauri::command]
pub async fn discord_window_clear_data() -> Result<String, String> {
    #[cfg(windows)]
    {
        let profile = profile_dir_from_env(std::env::var_os("LOCALAPPDATA"))
            .ok_or("Púca could not find where Discord's data is kept on this PC.")?;
        tauri::async_runtime::spawn_blocking(move || close_and_clear(&profile))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("Discord in a window of its own is in the Windows desktop app.".to_string())
    }
}

#[cfg(windows)]
fn close_and_clear(profile: &Path) -> Result<String, String> {
    use std::time::Duration;
    if !crate::discord_host::close_and_wait(Duration::from_secs(10)) {
        return Err("The Discord window did not close. Close it, then try again.".into());
    }
    if !profile.exists() {
        log::info!("[discord] clear data: nothing stored");
        return Ok("nothing".into());
    }
    // WebView2's own processes for that profile go a moment after the window:
    // until they do, some of its files are still open.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match std::fs::remove_dir_all(profile) {
            Ok(()) => {
                log::info!("[discord] clear data: Discord's profile removed");
                return Ok("cleared".into());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("cleared".into()),
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(500)),
            Err(e) => {
                log::warn!("[discord] clear data failed: {e}");
                return Err("Some of Discord's data is still in use. Wait a moment, then try again.".into());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The Discord window's own process.
// ---------------------------------------------------------------------------

/// Run this process as the Discord window. Returns when the window has closed.
pub fn run_window_process() {
    scrub_webview2_env();
    #[cfg(windows)]
    {
        let Some(profile) = profile_dir_from_env(std::env::var_os("LOCALAPPDATA")) else {
            eprintln!("discord window: no %LOCALAPPDATA%");
            return;
        };
        if let Err(e) = crate::discord_host::run(&profile) {
            eprintln!("discord window: {e}");
        }
    }
    #[cfg(not(windows))]
    eprintln!("discord window: Windows only");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn discord_pages_stay_in_the_window() {
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
            "https://dìscord.com/app", // a lookalike
            "https://cdn.discordapp.com/attachments/1/2/x.png",
            "https://media.discordapp.net/attachments/1/2/x.png",
            "https://discord.media/",
            "https://accounts.spotify.com/authorize",
            "http://discord.com/app",
            "https://discord.com:8443/app",
            "https://user@discord.com/app",
            "https://discord.com./app",
            "http://ipc.localhost/plugin",
            "http://tauri.localhost/index.html",
        ] {
            assert_eq!(navigation(&u(s)), Navigation::OpenInBrowser, "{s}");
        }
        for s in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "data:text/html,hi",
            "blob:https://discord.com/0b1c",
            "ms-msdt:/id",
            "search-ms:query=x",
            "steam://run/1",
            "tauri://localhost/",
            "ipc://localhost/",
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
        for s in ["about:blank", "javascript:void(0)", "file:///C:/x", "ms-settings:privacy", "tauri://localhost/"] {
            assert_eq!(new_window(&u(s)), NewWindow::Refuse, "{s}");
        }
    }

    #[test]
    fn only_discords_app_is_ever_granted_anything_and_never_without_a_question() {
        use PermissionAction::*;
        use PermissionKind::*;
        let discord = "https://discord.com/";
        assert_eq!(permission_decision(Microphone, discord, false), WebView2Prompt);
        assert_eq!(permission_decision(Camera, discord, true), WebView2Prompt);
        assert_eq!(permission_decision(ClipboardRead, discord, true), WebView2Prompt);
        assert_eq!(permission_decision(Autoplay, discord, false), WebView2Prompt);
        assert_eq!(permission_decision(Notifications, discord, true), AskOwner);
        assert_eq!(permission_decision(Notifications, "https://canary.discord.com", true), AskOwner);
        // The page asking by itself: refused, no question.
        assert_eq!(permission_decision(Notifications, discord, false), Deny);
        assert_eq!(permission_decision(Geolocation, discord, true), Deny);
        assert_eq!(permission_decision(Other, discord, true), Deny);
        // Anything that is not Discord's app, whatever it asks for.
        for origin in [
            "https://support.discord.com/",
            "https://www.youtube.com/",
            "https://evil.example/",
            "http://discord.com/",
            "https://discord.com:444/",
            "https://discord.com.evil.example/",
            "null",
            "",
        ] {
            for kind in [Microphone, Camera, Notifications, ClipboardRead, Autoplay, Geolocation, Other] {
                assert_eq!(permission_decision(kind, origin, true), Deny, "{kind:?} from {origin}");
            }
        }
        assert!(screen_capture_allowed("https://discord.com/"));
        assert!(!screen_capture_allowed("https://www.youtube.com/"));
        assert!(!screen_capture_allowed(""));
    }

    #[test]
    fn the_title_says_where_the_window_is() {
        assert_eq!(window_title("https://discord.com/channels/@me"), "Discord · discord.com");
        assert_eq!(window_title("https://support.discord.com/hc"), "Discord · support.discord.com");
        assert_eq!(window_title("https://DISCORD.com/app"), "Discord · discord.com");
        // A lookalike shows as what it is.
        assert!(window_title("https://dìscord.com/").starts_with("Discord · xn--"), "{}", window_title("https://dìscord.com/"));
        assert_eq!(window_title("about:blank"), "Discord");
        assert_eq!(window_title(""), "Discord");
        assert_eq!(window_title("data:text/html,x"), "Discord");
    }

    #[test]
    fn a_saved_place_is_kept_only_if_a_window_could_have_it() {
        let ok = r#"{"left":10,"top":20,"right":1210,"bottom":820,"maximized":true}"#;
        assert_eq!(parse_placement(ok), Some(Placement { left: 10, top: 20, right: 1210, bottom: 820, maximized: true }));
        assert_eq!(parse_placement(&serde_json::to_string(&parse_placement(ok).unwrap()).unwrap()), parse_placement(ok));
        for bad in [
            "",
            "{}",
            "not json",
            r#"{"left":0,"top":0,"right":50,"bottom":800,"maximized":false}"#,
            r#"{"left":0,"top":0,"right":800,"bottom":-5,"maximized":false}"#,
            r#"{"left":-2147483648,"top":0,"right":2147483647,"bottom":800,"maximized":false}"#,
        ] {
            assert_eq!(parse_placement(bad), None, "{bad}");
        }
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
        let puca = local.join("EBWebView");
        assert!(!profile.starts_with(&puca));
        assert!(!puca.starts_with(&profile));
    }

    #[test]
    fn clearing_can_only_ever_reach_the_discord_profile() {
        let got = profile_dir_from_env(Some(r"C:\Users\x\AppData\Local".into())).unwrap();
        assert_eq!(got, Path::new(r"C:\Users\x\AppData\Local").join(env!("PUCA_IDENTIFIER")).join("discord-profile"));
        assert_eq!(profile_dir_from_env(None), None);
        assert_eq!(profile_dir_from_env(Some("".into())), None);
        assert_eq!(profile_dir_from_env(Some(r"relative\dir".into())), None);
    }

    #[test]
    fn the_webview2_variables_that_undo_the_isolation_are_scrubbed() {
        assert!(SCRUBBED_ENV.contains(&"WEBVIEW2_USER_DATA_FOLDER"));
        assert!(SCRUBBED_ENV.contains(&"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"));
        assert!(SCRUBBED_ENV.contains(&"WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER"));
        assert!(SCRUBBED_ENV.contains(&"SSLKEYLOGFILE"));
    }

    #[test]
    fn only_a_press_sends_anything_to_the_browser() {
        let out = u("https://www.youtube.com/watch?v=x");
        assert_eq!(navigation_action(&out, true), Navigation::OpenInBrowser);
        assert_eq!(navigation_action(&out, false), Navigation::Refuse);
        // Moving around Discord's own domains needs no press (its own redirects).
        assert_eq!(navigation_action(&u("https://discord.com/login"), false), Navigation::Stay);
        assert_eq!(navigation_action(&u("javascript:x"), true), Navigation::Refuse);
        assert_eq!(popup_action(&out, true), NewWindow::OpenInBrowser);
        assert_eq!(popup_action(&out, false), NewWindow::Refuse);
        assert_eq!(popup_action(&u("https://discord.com/channels/1/2"), true), NewWindow::LoadHere);
        assert_eq!(popup_action(&u("https://discord.com/channels/1/2"), false), NewWindow::Refuse);
    }

    /// The Discord process is sent away before any of Púca's set-up, Tauri's
    /// included: in lib.rs `run()`, the branch comes before `tauri::Builder`.
    #[test]
    fn the_discord_process_starts_nothing_of_puca_s() {
        let lib = include_str!("lib.rs");
        let run = lib.find("pub fn run() {").expect("run()");
        let branch = lib[run..].find("discord_window::is_window_launch").expect("the branch") + run;
        let builder = lib[run..].find("tauri::Builder::default()").expect("the builder") + run;
        let first_setup = lib[run..].find("check_and_clear_permissions_on_startup();").expect("set-up") + run;
        assert!(branch < builder && branch < first_setup, "the Discord branch must come first in run()");
        // And Púca's commands never touch a webview of that name.
        for (name, text) in [("lib.rs", lib), ("popout.rs", include_str!("popout.rs"))] {
            assert!(!text.contains("\"discord\""), "{name} names a webview \"discord\"");
        }
    }
}

/// The capability files and the configs, read as text: every capability names
/// its windows, none can match the name reserved for the Discord window, none grants a remote origin,
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
