//! The Discord window's own process, on Windows: a plain Win32 window that hosts
//! WebView2 directly (docs/DISCORD.md says it to people; discord_window.rs has
//! the policy and Púca's side).
//!
//! NO TAURI IN HERE, ON PURPOSE. A Tauri webview, local or remote, always gets
//! Tauri's IPC bridge: `window.__TAURI_INTERNALS__` with the invoke key and every
//! plugin's init script (tauri-2.11.5 `src/manager/webview.rs`,
//! `prepare_pending_webview`), a `WebMessageReceived` handler, and the `ipc` and
//! `tauri` protocols, which wry serves by intercepting `http://ipc.localhost/*`
//! and `http://tauri.localhost/*` for that webview (`register_uri_scheme_protocol`
//! there; wry-0.55.1 `src/webview2/mod.rs` adds a resource filter for each). The
//! ACL would refuse the commands, but the bridge, the invoke key and Púca's own
//! asset files would still be within reach of the page. This window has none of
//! it: no script is added to the page, no web message is accepted (and the page
//! has no `chrome.webview.postMessage` to send one), no host object, no resource
//! interception, no virtual host. `ipc.localhost` and `tauri.localhost` are just
//! names here, with nothing behind them. `tests::the_page_sees_no_bridge` loads a
//! page in this very webview and checks.
//!
//! WHAT THIS PROCESS DOES WITH THE PAGE: decides where a top-level navigation or
//! a new window goes (from its address), answers permission requests (from their
//! kind and origin), and puts the current host in the title bar (from the
//! address). It never reads the page, its title, its cookies or its storage, and
//! nothing it sees leaves this process except an address handed to the system
//! browser.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    take_pwstr, wait_with_pump, CoreWebView2EnvironmentOptions, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, LaunchingExternalUriSchemeEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
    ProcessFailedEventHandler, ScreenCaptureStartingEventHandler, SourceChangedEventHandler,
};
use wv2_windows::core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};
use wv2_windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT,
    WAIT_OBJECT_0, WPARAM,
};
use wv2_windows::Win32::Graphics::Gdi::{MonitorFromRect, MONITOR_DEFAULTTONULL};
use wv2_windows::Win32::System::LibraryLoader::GetModuleHandleW;
use wv2_windows::Win32::System::Ole::OleInitialize;
use wv2_windows::Win32::System::Threading::{
    CreateMutexW, OpenMutexW, OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, SYNCHRONIZATION_SYNCHRONIZE,
};
use wv2_windows::Win32::UI::HiDpi::{
    GetDpiForSystem, GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use wv2_windows::Win32::UI::WindowsAndMessaging::*;

use crate::discord_window::{
    navigation_action, parse_placement, permission_decision, popup_action, screen_capture_allowed, window_title,
    BrowserOpenLimiter, Navigation, NewWindow, PermissionAction, PermissionKind, Placement, START_URL,
};

/// The window's class: how a second open, and Púca's "sign out and clear", find it.
const WINDOW_CLASS: &str = "PucaDiscordWindow";

/// Size and place, kept INSIDE the Discord profile folder, so clearing Discord's
/// data takes it too and nothing of Discord's is anywhere else.
const PLACEMENT_FILE: &str = "window.json";

/// 96-dpi size of a first window.
const FIRST_SIZE: (i32, i32) = (1180, 800);
const MIN_SIZE: i32 = 420;

/// The owner's answer to the notification question, from its own thread.
const WM_APP_PERMISSION_ANSWER: u32 = WM_APP + 1;
/// A popup that loads in this window, run after the event that asked for it.
const WM_APP_LOAD_HERE: u32 = WM_APP + 2;

struct Host {
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    placement_file: PathBuf,
}

thread_local! {
    // The UI thread's own: everything WebView2 hands this process lives on it.
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
    /// The request waiting for the owner's answer, and the one-time number its
    /// answer must carry: another program on the PC posting "allowed" to this
    /// window cannot know it.
    static PENDING_QUESTION: RefCell<Option<(ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2Deferral, isize)>> =
        const { RefCell::new(None) };
    static PENDING_LOADS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static BROWSER_LIMITER: RefCell<BrowserOpenLimiter> = RefCell::new(BrowserOpenLimiter::default());
}

/// One question at a time.
static ASKING: AtomicBool = AtomicBool::new(false);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn hinstance() -> HINSTANCE {
    // SAFETY: the module handle of this process's own executable.
    unsafe { GetModuleHandleW(PCWSTR::null()).map(|m| HINSTANCE(m.0)).unwrap_or_default() }
}

fn controller() -> Option<ICoreWebView2Controller> {
    HOST.with(|h| h.borrow().as_ref().map(|h| h.controller.clone()))
}

fn webview() -> Option<ICoreWebView2> {
    HOST.with(|h| h.borrow().as_ref().map(|h| h.webview.clone()))
}

// ---------------------------------------------------------------------------
// The process.
// ---------------------------------------------------------------------------

/// Run this process as the Discord window, with `profile` as its WebView2 user
/// data folder. Returns when the window has closed.
pub fn run(profile: &Path) -> Result<(), String> {
    init_ui_thread()?;
    // One Discord window per Windows session: a second process (two quick clicks,
    // or Púca restarted while the window stayed open) brings the first forward
    // and goes, before it could ask WebView2 for a profile that is in use.
    let Some(_one_window) = SingleWindow::acquire() else {
        bring_forward_existing();
        return Ok(());
    };
    std::fs::create_dir_all(profile).map_err(|e| format!("could not create the Discord profile folder: {e}"))?;
    let placement_file = profile.join(PLACEMENT_FILE);

    let hwnd = create_window()?;
    let env = create_environment(profile)?;
    let (controller, webview) = create_controller(&env, hwnd)?;
    configure(&webview, hwnd)?;
    HOST.with(|h| {
        *h.borrow_mut() = Some(Host { controller: controller.clone(), webview: webview.clone(), placement_file: placement_file.clone() })
    });

    show_window(hwnd, &placement_file);
    // SAFETY: COM calls on the UI thread that created these objects.
    unsafe {
        let _ = controller.SetIsVisible(true);
        resize_to_client(hwnd, &controller);
        let _ = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        webview.Navigate(&HSTRING::from(START_URL)).map_err(|e| format!("could not open Discord: {e}"))?;
    }
    message_loop();
    Ok(())
}

/// Per-monitor DPI, and OLE for the webview's drag and drop. Once per UI thread.
fn init_ui_thread() -> Result<(), String> {
    // SAFETY: process/thread initialisation calls, before any window exists.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        OleInitialize(None).map_err(|e| format!("could not initialise OLE: {e}"))?;
    }
    Ok(())
}

fn message_loop() {
    let mut msg = MSG::default();
    // SAFETY: the standard Win32 message loop on the thread that owns the window.
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// The window, hidden until it has its size and place.
fn create_window() -> Result<HWND, String> {
    let class = wide(WINDOW_CLASS);
    let title = wide("Discord");
    // SAFETY: a window class and window of this process; the strings outlive the calls.
    unsafe {
        let instance = hinstance();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            hInstance: instance,
            // The app icon tauri-build puts in the executable (resource 32512).
            hIcon: LoadIconW(Some(instance), PCWSTR(32512 as *const u16)).unwrap_or_default(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: PCWSTR(class.as_ptr()),
            ..Default::default()
        };
        // A second registration in the same process (the tests) fails harmlessly.
        RegisterClassExW(&wc);
        let dpi = GetDpiForSystem().max(96) as i32;
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            FIRST_SIZE.0 * dpi / 96,
            FIRST_SIZE.1 * dpi / 96,
            None,
            None,
            Some(instance),
            None,
        )
        .map_err(|e| format!("could not create the Discord window: {e}"))
    }
}

/// The saved size and place, if it is still on a monitor; else Windows' default.
fn show_window(hwnd: HWND, placement_file: &Path) {
    let saved = std::fs::read_to_string(placement_file).ok().and_then(|t| parse_placement(&t));
    // SAFETY: our own window; a rectangle and a placement structure on the stack.
    unsafe {
        if let Some(p) = saved {
            let rect = RECT { left: p.left, top: p.top, right: p.right, bottom: p.bottom };
            if !MonitorFromRect(&rect, MONITOR_DEFAULTTONULL).is_invalid() {
                let wp = WINDOWPLACEMENT {
                    length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                    showCmd: if p.maximized { SW_SHOWMAXIMIZED.0 as u32 } else { SW_SHOWNORMAL.0 as u32 },
                    rcNormalPosition: rect,
                    ..Default::default()
                };
                if SetWindowPlacement(hwnd, &wp).is_ok() {
                    return;
                }
            }
        }
        let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
    }
}

fn save_placement(hwnd: HWND) {
    let Some(file) = HOST.with(|h| h.borrow().as_ref().map(|h| h.placement_file.clone())) else { return };
    let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
    // SAFETY: our own window.
    if unsafe { GetWindowPlacement(hwnd, &mut wp) }.is_err() {
        return;
    }
    let r = wp.rcNormalPosition;
    let placement = Placement {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        maximized: wp.showCmd == SW_SHOWMAXIMIZED.0 as u32,
    };
    if let Ok(text) = serde_json::to_string(&placement) {
        let _ = std::fs::write(file, text);
    }
}

fn resize_to_client(hwnd: HWND, controller: &ICoreWebView2Controller) {
    let mut rect = RECT::default();
    // SAFETY: our own window and controller, on the UI thread.
    unsafe {
        if GetClientRect(hwnd, &mut rect).is_ok() {
            let _ = controller.SetBounds(rect);
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_SIZE => {
            if let Some(c) = controller() {
                resize_to_client(hwnd, &c);
            }
            LRESULT(0)
        }
        WM_MOVE | WM_MOVING => {
            if let Some(c) = controller() {
                let _ = c.NotifyParentWindowPositionChanged();
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_SETFOCUS => {
            if let Some(c) = controller() {
                let _ = c.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            }
            LRESULT(0)
        }
        WM_DPICHANGED => {
            // SAFETY: WM_DPICHANGED's lParam is the suggested RECT, valid for this call.
            let r = &*(lparam.0 as *const RECT);
            let _ = SetWindowPos(
                hwnd,
                None,
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            LRESULT(0)
        }
        WM_GETMINMAXINFO => {
            // SAFETY: WM_GETMINMAXINFO's lParam is a MINMAXINFO for this call.
            let info = &mut *(lparam.0 as *mut MINMAXINFO);
            let dpi = GetDpiForWindow(hwnd).max(96) as i32;
            info.ptMinTrackSize = POINT { x: MIN_SIZE * dpi / 96, y: MIN_SIZE * dpi / 96 };
            LRESULT(0)
        }
        WM_APP_PERMISSION_ANSWER => {
            answer_pending_question(wparam.0 == 1, lparam.0);
            LRESULT(0)
        }
        WM_APP_LOAD_HERE => {
            let urls = PENDING_LOADS.with(|p| std::mem::take(&mut *p.borrow_mut()));
            if let (Some(w), Some(url)) = (webview(), urls.into_iter().last()) {
                let _ = w.Navigate(&HSTRING::from(url));
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            save_placement(hwnd);
            if let Some(host) = HOST.with(|h| h.borrow_mut().take()) {
                let _ = host.controller.Close();
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ---------------------------------------------------------------------------
// WebView2.
// ---------------------------------------------------------------------------

/// The environment: this profile folder, NOTHING added to the browser's command
/// line (so SmartScreen and every other default stays as Edge has it), no
/// extensions, no signing in to sites with the Windows account, and the folder
/// held exclusively, so no other process (Púca's own included) can open a
/// webview on Discord's profile while this one runs.
fn create_environment(user_data: &Path) -> Result<ICoreWebView2Environment, String> {
    environment_from(user_data, environment_options())
}

/// The window's environment options (above). Apart so that a test can start an
/// environment from exactly these: `the_page_sees_no_bridge` adds one browser
/// argument in the TEST module, never here (`nothing_above_the_tests_can_put_
/// anything_into_the_page` refuses one anywhere above the tests).
fn environment_options() -> CoreWebView2EnvironmentOptions {
    let options = CoreWebView2EnvironmentOptions::default();
    // SAFETY: setters on an options object this function owns.
    unsafe {
        options.set_are_browser_extensions_enabled(false);
        options.set_allow_single_sign_on_using_os_primary_account(false);
        options.set_exclusive_user_data_folder_access(true);
    }
    options
}

fn environment_from(user_data: &Path, options: CoreWebView2EnvironmentOptions) -> Result<ICoreWebView2Environment, String> {
    let (tx, rx) = mpsc::channel();
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |error, env| {
        let _ = tx.send(error.and_then(|_| env.ok_or_else(|| wv2_windows::core::Error::from_hresult(wv2_windows::Win32::Foundation::E_POINTER))));
        Ok(())
    }));
    // SAFETY: the documented creation call; completion arrives through the pump.
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &HSTRING::from(user_data.as_os_str()),
            &ICoreWebView2EnvironmentOptions::from(options),
            &handler,
        )
        .map_err(|e| format!("WebView2 could not start: {e}"))?;
    }
    wait_with_pump(rx)
        .map_err(|e| format!("WebView2 could not start: {e:?}"))?
        .map_err(|e| format!("WebView2 could not start: {e}"))
}

fn create_controller(env: &ICoreWebView2Environment, hwnd: HWND) -> Result<(ICoreWebView2Controller, ICoreWebView2), String> {
    let (tx, rx) = mpsc::channel();
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |error, controller| {
        let _ = tx.send(error.and_then(|_| {
            controller.ok_or_else(|| wv2_windows::core::Error::from_hresult(wv2_windows::Win32::Foundation::E_POINTER))
        }));
        Ok(())
    }));
    // SAFETY: the documented creation call; completion arrives through the pump.
    unsafe {
        env.CreateCoreWebView2Controller(hwnd, &handler).map_err(|e| format!("WebView2 could not start: {e}"))?;
    }
    let controller = wait_with_pump(rx)
        .map_err(|e| format!("WebView2 could not start: {e:?}"))?
        .map_err(|e| format!("WebView2 could not start: {e}"))?;
    // SAFETY: on the UI thread, from the controller just created.
    let webview = unsafe { controller.CoreWebView2() }.map_err(|e| format!("WebView2 could not start: {e}"))?;
    Ok((controller, webview))
}

/// Everything this window allows, refuses and listens to. The same function the
/// tests put a page through.
fn configure(webview: &ICoreWebView2, hwnd: HWND) -> Result<(), String> {
    let owner = hwnd.0 as isize;
    let fail = |e: wv2_windows::core::Error| format!("could not set up the Discord window: {e}");
    // SAFETY: COM calls on the UI thread that owns the webview; every handler runs there too.
    unsafe {
        let settings = webview.Settings().map_err(fail)?;
        // No channel from the page to this process, and none back.
        settings.SetIsWebMessageEnabled(false).map_err(fail)?;
        settings.SetAreHostObjectsAllowed(false).map_err(fail)?;
        // No console to paste "this code" into: that is how Discord accounts are
        // stolen, and why Discord's own console warns about it.
        settings.SetAreDevToolsEnabled(false).map_err(fail)?;
        // A browser's own parts: the link address shown at the bottom while the
        // mouse is on a link, the right-click menu, zoom, alert/confirm.
        settings.SetIsStatusBarEnabled(true).map_err(fail)?;
        settings.SetAreDefaultContextMenusEnabled(true).map_err(fail)?;
        settings.SetIsZoomControlEnabled(true).map_err(fail)?;
        settings.SetAreDefaultScriptDialogsEnabled(true).map_err(fail)?;
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            // WebView2 offers to save neither the password nor anything typed into forms.
            let _ = s4.SetIsPasswordAutosaveEnabled(false);
            let _ = s4.SetIsGeneralAutofillEnabled(false);
        }
        if let Ok(s8) = settings.cast::<ICoreWebView2Settings8>() {
            // SmartScreen on pages and downloads, as in Edge.
            let _ = s8.SetIsReputationCheckingRequired(true);
        }

        let mut token = Default::default();
        webview
            .add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    // Fails closed: an address the URL standard cannot read, or a
                    // question WebView2 cannot answer, is a refusal, never a pass.
                    let read = || -> wv2_windows::core::Result<(String, bool)> {
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let mut pressed = BOOL::default();
                        args.IsUserInitiated(&mut pressed)?;
                        Ok((take_pwstr(uri), pressed.as_bool()))
                    };
                    let (uri, verdict) = match read() {
                        Ok((uri, pressed)) => {
                            let verdict = url::Url::parse(&uri)
                                .map(|u| navigation_action(&u, pressed))
                                .unwrap_or(Navigation::Refuse);
                            (uri, verdict)
                        }
                        Err(_) => (String::new(), Navigation::Refuse),
                    };
                    if verdict != Navigation::Stay {
                        args.SetCancel(true)?;
                    }
                    if verdict == Navigation::OpenInBrowser {
                        open_in_browser(&uri);
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(fail)?;

        webview
            .add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    // Never a window: Handled with no window given opens nothing.
                    args.SetHandled(true)?;
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let mut pressed = BOOL::default();
                    args.IsUserInitiated(&mut pressed)?;
                    match url::Url::parse(&uri).map(|u| popup_action(&u, pressed.as_bool())).unwrap_or(NewWindow::Refuse) {
                        NewWindow::LoadHere => {
                            PENDING_LOADS.with(|p| p.borrow_mut().push(uri));
                            let _ = PostMessageW(Some(HWND(owner as *mut core::ffi::c_void)), WM_APP_LOAD_HERE, WPARAM(0), LPARAM(0));
                        }
                        NewWindow::OpenInBrowser => open_in_browser(&uri),
                        NewWindow::Refuse => {}
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(fail)?;

        webview
            .add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    on_permission_requested(args, owner)
                })),
                &mut token,
            )
            .map_err(fail)?;

        // A WebView2 too old for either gate below gets no Discord window, rather
        // than one without them (Windows keeps the runtime current with Edge).
        let too_old = |_| "WebView2 on this PC is too old for the Discord window. Update Microsoft Edge, then try again.".to_string();

        // A link to another program (`ms-msdt:`, `search-ms:`, `steam:`, ...) from
        // any frame: WebView2 would ask "Open app?", with an "always" box. Never.
        let w18 = webview.cast::<ICoreWebView2_18>().map_err(too_old)?;
        w18.add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )
        .map_err(fail)?;

        // Screen sharing (WebView2's own picker): only Discord's app may start it.
        let w27 = webview.cast::<ICoreWebView2_27>().map_err(too_old)?;
        w27.add_ScreenCaptureStarting(
            &ScreenCaptureStartingEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                // Fails closed: a frame whose address cannot be read may not share.
                let origin = (|| -> wv2_windows::core::Result<String> {
                    let mut source = PWSTR::null();
                    args.OriginalSourceFrameInfo()?.Source(&mut source)?;
                    Ok(take_pwstr(source))
                })()
                .unwrap_or_default();
                if !screen_capture_allowed(&origin) {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )
        .map_err(fail)?;

        // The title bar says where the window is: the host, from the address,
        // on every navigation (never the page's own title).
        webview
            .add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    let Some(sender) = sender else { return Ok(()) };
                    let mut source = PWSTR::null();
                    sender.Source(&mut source)?;
                    let title = wide(&window_title(&take_pwstr(source)));
                    let _ = SetWindowTextW(HWND(owner as *mut core::ffi::c_void), PCWSTR(title.as_ptr()));
                    Ok(())
                })),
                &mut token,
            )
            .map_err(fail)?;

        // The browser process gone means this window can show nothing more.
        webview
            .add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    args.ProcessFailedKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                        let _ = PostMessageW(Some(HWND(owner as *mut core::ffi::c_void)), WM_CLOSE, WPARAM(0), LPARAM(0));
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(fail)?;
        // DownloadStarting is deliberately not handled: WebView2's own download
        // flow saves to the Downloads folder with its download list, as Edge does,
        // checked by SmartScreen, and opens nothing by itself.
    }
    Ok(())
}

fn kind_of(kind: COREWEBVIEW2_PERMISSION_KIND) -> PermissionKind {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => PermissionKind::Microphone,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => PermissionKind::Camera,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => PermissionKind::Notifications,
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => PermissionKind::ClipboardRead,
        COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => PermissionKind::Autoplay,
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => PermissionKind::Geolocation,
        _ => PermissionKind::Other,
    }
}

/// SAFETY: call on the UI thread, with the args WebView2 just handed it.
unsafe fn refuse(args: &ICoreWebView2PermissionRequestedEventArgs) {
    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
    // Not remembered: a remembered block would answer later requests with no
    // question, and Discord's own switch would silently do nothing.
    if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
        let _ = args3.SetSavesInProfile(false);
    }
}

unsafe fn on_permission_requested(args: ICoreWebView2PermissionRequestedEventArgs, owner: isize) -> wv2_windows::core::Result<()> {
    // Fails closed: a request WebView2 cannot describe is refused, never left
    // at its default (which would be WebView2's question, for any site).
    let read = || -> wv2_windows::core::Result<(COREWEBVIEW2_PERMISSION_KIND, String, bool)> {
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        args.PermissionKind(&mut kind)?;
        let mut uri = PWSTR::null();
        args.Uri(&mut uri)?;
        let mut user_initiated = BOOL::default();
        args.IsUserInitiated(&mut user_initiated)?;
        Ok((kind, take_pwstr(uri), user_initiated.as_bool()))
    };
    let Ok((kind, origin, user_initiated)) = read() else {
        refuse(&args);
        return Ok(());
    };
    match permission_decision(kind_of(kind), &origin, user_initiated) {
        // Left at its default state: for the microphone, the camera and the
        // clipboard WebView2 shows its own question (and Windows its own, for
        // the microphone and camera); for autoplay it asks nothing and its own
        // rule decides.
        PermissionAction::WebView2Prompt => Ok(()),
        PermissionAction::Deny => {
            refuse(&args);
            Ok(())
        }
        PermissionAction::AskOwner => {
            if ASKING.load(Ordering::SeqCst) {
                refuse(&args);
                return Ok(());
            }
            // Answered later, outside this handler: a question shown from inside a
            // WebView2 event handler is the re-entrancy WebView2's threading model
            // warns about. The args and the deferral stay on this thread; the
            // question's thread only posts the answer back.
            let Ok(deferral) = args.GetDeferral() else {
                refuse(&args);
                return Ok(());
            };
            ASKING.store(true, Ordering::SeqCst);
            let nonce = rand::random::<i64>() as isize;
            PENDING_QUESTION.with(|p| *p.borrow_mut() = Some((args, deferral, nonce)));
            let spawned = std::thread::Builder::new().name("discord-notification-question".into()).spawn(move || {
                let allowed = ask_owner(owner);
                // SAFETY: posting to a window handle; a stale one fails harmlessly.
                let _ = unsafe {
                    PostMessageW(
                        Some(HWND(owner as *mut core::ffi::c_void)),
                        WM_APP_PERMISSION_ANSWER,
                        WPARAM(allowed as usize),
                        LPARAM(nonce),
                    )
                };
            });
            if spawned.is_err() {
                answer_pending_question(false, nonce);
            }
            Ok(())
        }
    }
}

/// On the UI thread: apply the owner's answer to the request that is waiting,
/// if `nonce` is the one its question was given. Any other message is ignored.
fn answer_pending_question(allowed: bool, nonce: isize) {
    let pending = PENDING_QUESTION.with(|p| {
        let mut p = p.borrow_mut();
        match p.as_ref() {
            Some((_, _, expected)) if *expected == nonce => p.take(),
            _ => None,
        }
    });
    let Some((args, deferral, _)) = pending else { return };
    // SAFETY: on the UI thread that received these objects.
    unsafe {
        if allowed {
            // Remembered in Discord's profile: he said yes.
            let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
        } else {
            refuse(&args);
        }
        let _ = deferral.Complete();
    }
    ASKING.store(false, Ordering::SeqCst);
}

/// Say why the Discord window could not open: a WebView2 too old for its gates,
/// or one that would not start. Only after the owner pressed the button.
pub fn tell_owner(error: &str) {
    let title = wide("Discord - Púca");
    let text = wide(&format!("The Discord window could not open.\n\n{error}"));
    // SAFETY: two NUL-terminated wide strings that outlive the call; no owner.
    unsafe {
        MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONWARNING);
    }
}

/// The notification question. WebView2 has none of its own for notifications. On
/// a thread of its own, owned by the Discord window: the window keeps drawing,
/// and the question sits on top of the window that asked. OK and Cancel, with
/// Cancel the default: Enter, Space and Esc all allow nothing, and neither button
/// has a letter key (Yes/No would: a "y" typed into Discord would answer it).
fn ask_owner(owner: isize) -> bool {
    let title = wide("Discord notifications - Púca");
    let text = wide(
        "Discord is asking to show notifications on this PC.\n\n\
         Press OK to allow them. Windows shows them straight from Discord's page; \
         Púca does not see them.\n\n\
         You can turn them off later in Discord: User Settings > Notifications.",
    );
    // SAFETY: two NUL-terminated wide strings that outlive the call.
    let answer = unsafe {
        MessageBoxW(
            Some(HWND(owner as *mut core::ffi::c_void)),
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2,
        )
    };
    answer == IDOK
}

/// An address to the system browser: http(s) only (discord_window.rs,
/// `browser_may_open`), within the burst limit, off the UI thread (ShellExecute
/// can wait on the program it starts).
fn open_in_browser(uri: &str) {
    let Ok(url) = url::Url::parse(uri) else { return };
    if !crate::discord_window::browser_may_open(&url) {
        return;
    }
    if !BROWSER_LIMITER.with(|l| l.borrow_mut().allow(Instant::now())) {
        return;
    }
    let url = url.to_string();
    // A test never opens the owner's browser: it is told what would have gone.
    #[cfg(test)]
    {
        tests::OPENED.with(|o| o.borrow_mut().push(url));
        return;
    }
    #[cfg(not(test))]
    std::thread::Builder::new()
        .name("discord-open-in-browser".into())
        .spawn(move || {
            let _ = opener::open(&url);
        })
        .ok();
}

// ---------------------------------------------------------------------------
// One window, and finding it from Púca.
// ---------------------------------------------------------------------------

/// Held for the life of the Discord window's process.
struct SingleWindow(HANDLE);

fn single_window_name() -> HSTRING {
    HSTRING::from(format!("Local\\{}.discord-window", env!("PUCA_IDENTIFIER")))
}

/// Is a Discord window process alive, even one still starting, whose window
/// does not exist yet? It holds the single-window mutex from its first moment.
fn window_process_alive() -> bool {
    // SAFETY: opening a named mutex only to see that it exists; closed at once.
    unsafe {
        match OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &single_window_name()) {
            Ok(handle) => {
                let _ = CloseHandle(handle);
                true
            }
            Err(_) => false,
        }
    }
}

impl SingleWindow {
    /// `None` when another Discord window process already holds it.
    fn acquire() -> Option<Self> {
        let name = single_window_name();
        // SAFETY: a named mutex; the handle is closed in Drop or right here.
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
    let class = wide(WINDOW_CLASS);
    // SAFETY: a NUL-terminated class name, and no title.
    unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR::null()).ok() }.filter(|h| !h.is_invalid())
}

/// Bring an open Discord window forward. `false` when there is none.
pub fn bring_forward_existing() -> bool {
    let Some(hwnd) = find_window() else { return false };
    // SAFETY: a handle FindWindowW just returned; a stale one fails harmlessly.
    unsafe {
        // Async: the window belongs to another process, and a hung one must not
        // hang whoever asked (Púca's own window, for one).
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
    true
}

/// The owner just pressed the button in Púca, so Púca is in front and may pass
/// that on: the new window opens in front of Púca, not behind it.
pub fn allow_foreground(pid: u32) {
    // SAFETY: plain call; failure only means the window may open behind.
    unsafe {
        let _ = AllowSetForegroundWindow(pid);
    }
}

/// Close the Discord window if it is open and wait for its process to end, or
/// for one still starting to show itself and be closed. `false` when one is
/// still running after `wait`.
pub fn close_and_wait(wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if find_window().is_some() {
            let left = deadline.saturating_duration_since(Instant::now());
            if !close_window_and_wait(left) {
                return false;
            }
        }
        if !window_process_alive() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn close_window_and_wait(wait: Duration) -> bool {
    let Some(hwnd) = find_window() else { return true };
    let mut pid = 0u32;
    // SAFETY: a handle FindWindowW returned; WM_CLOSE runs the window's own close
    // (it saves its place and closes WebView2 first).
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = if pid != 0 { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok() } else { None };
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        match process {
            Some(p) => {
                let done = WaitForSingleObject(p, wait.as_millis().min(u32::MAX as u128) as u32) == WAIT_OBJECT_0;
                let _ = CloseHandle(p);
                done
            }
            None => {
                let deadline = Instant::now() + wait;
                while find_window().is_some() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(100));
                }
                find_window().is_none()
            }
        }
    }
}

// ---- tests ----------------------------------------------------------------
// Everything above this line is the window; the no-injection scan
// (`tests::nothing_above_the_tests_can_put_anything_into_the_page`) reads it.

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;
    use webview2_com::DocumentTitleChangedEventHandler;

    thread_local! {
        /// What `open_in_browser` would have handed the system browser.
        pub(super) static OPENED: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// The window's own code, without these tests (which do read a page: their own).
    fn window_source() -> &'static str {
        let all = include_str!("discord_host.rs");
        let end = all.find("// ---- tests ---").expect("the tests marker");
        &all[..end]
    }

    /// Every WebView2 call the window makes. A call not on this list fails the
    /// scan below, whatever it is: one that runs or adds a script, passes web
    /// messages, adds a host object, intercepts or watches requests (their
    /// headers carry Discord's sign-in), reads the page, its title or cookies,
    /// captures it, or opens a debugging channel. Adding one means saying here
    /// why the page cannot use it.
    const ALLOWED_CALLS: &[&str] = &[
        // controller
        "SetIsVisible", "MoveFocus", "SetBounds", "NotifyParentWindowPositionChanged", "Close", "CoreWebView2",
        // environment
        "CreateCoreWebView2Controller",
        // the webview: going to Discord, and the events the window answers
        "Navigate", "Settings", "Source", "add_NavigationStarting", "add_NewWindowRequested",
        "add_PermissionRequested", "add_LaunchingExternalUriScheme", "add_ScreenCaptureStarting",
        "add_SourceChanged", "add_ProcessFailed",
        // settings, all of them switching something OFF or keeping a browser's own part
        "SetIsWebMessageEnabled", "SetAreHostObjectsAllowed", "SetAreDevToolsEnabled", "SetIsStatusBarEnabled",
        "SetAreDefaultContextMenusEnabled", "SetIsZoomControlEnabled", "SetAreDefaultScriptDialogsEnabled",
        "SetIsPasswordAutosaveEnabled", "SetIsGeneralAutofillEnabled", "SetIsReputationCheckingRequired",
        // event arguments: reading the address, kind and press, answering
        "Uri", "IsUserInitiated", "SetCancel", "SetHandled", "PermissionKind", "SetState", "SetSavesInProfile",
        "GetDeferral", "Complete", "OriginalSourceFrameInfo", "ProcessFailedKind",
        // environment options (webview2-com's setters)
        "set_are_browser_extensions_enabled", "set_allow_single_sign_on_using_os_primary_account",
        "set_exclusive_user_data_folder_access",
    ];

    /// The names called as `.Name(` or `Type::Name(` (spaces before the bracket
    /// allowed) that look like COM methods: a capital, or webview2-com's `add_` /
    /// `remove_` / `set_`. In order of appearance.
    fn com_calls(source: &str) -> Vec<String> {
        let mut calls = Vec::new();
        let starts = source.match_indices('.').map(|(i, _)| i + 1).chain(source.match_indices("::").map(|(i, _)| i + 2));
        for start in starts {
            let rest = &source[start..];
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if name.is_empty() || !rest[name.len()..].trim_start_matches([' ', '\t']).starts_with('(') {
                continue;
            }
            let com_like = name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                || name.starts_with("add_")
                || name.starts_with("remove_")
                || name.starts_with("set_");
            if com_like {
                calls.push(name);
            }
        }
        calls
    }

    #[test]
    fn nothing_above_the_tests_can_put_anything_into_the_page() {
        let source = window_source();
        let calls = com_calls(source);
        assert!(calls.len() > 30, "the scan found the window's calls: {calls:?}");
        for call in &calls {
            assert!(ALLOWED_CALLS.contains(&call.as_str()), "discord_host.rs calls {call}, which is not on ALLOWED_CALLS");
        }
        for required in ["SetIsWebMessageEnabled(false)", "SetAreHostObjectsAllowed(false)", "SetAreDevToolsEnabled(false)"] {
            assert!(source.contains(required), "discord_host.rs no longer says {required}");
        }
        for forbidden in ["set_additional_browser_arguments", "tauri::", "eval("] {
            assert!(!source.contains(forbidden), "discord_host.rs has {forbidden}");
        }
        // The window only ever goes to Discord's start page, or to an address
        // a popup asked for that passed the popup rules (https, Discord's app).
        let navigates: Vec<&str> = source.match_indices(".Navigate(").map(|(i, _)| {
            let rest = &source[i + ".Navigate(".len()..];
            &rest[..rest.find(')').unwrap() + 1]
        }).collect();
        assert_eq!(navigates, ["&HSTRING::from(START_URL)", "&HSTRING::from(url)"], "Navigate's arguments");
        // NEGATIVE CONTROL: the scan sees the calls that matter, however written.
        for injected in [
            "webview.ExecuteScript(&x, &h)",
            "webview.add_WebResourceResponseReceived(&h, &mut t)",
            "ICoreWebView2_2::add_WebResourceResponseReceived(&webview, &h, &mut t)",
            "webview.AddScriptToExecuteOnDocumentCreated (&x, &h)",
            "options.set_additional_browser_arguments(x)",
        ] {
            let found = com_calls(injected);
            assert!(found.iter().any(|c| !ALLOWED_CALLS.contains(&c.as_str())), "the scan misses {injected}");
        }
    }

    /// No other source file can host a call on that webview: WebView2 itself is
    /// named in this file alone.
    #[test]
    fn webview2_is_used_in_this_file_alone() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            seen += 1;
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).unwrap();
            if name == "discord_host.rs" {
                assert!(text.contains("webview2_com"), "the control: this file is found and does use it");
                continue;
            }
            for needle in ["webview2_com", "ICoreWebView2"] {
                assert!(!text.contains(needle), "{name} names {needle}: WebView2 calls belong in discord_host.rs");
            }
        }
        assert!(seen > 30, "src/ was read ({seen} files)");
    }

    /// The test environment's only extra argument (the window's own environment
    /// has none): Tauri's IPC and asset names resolve to nothing, so only an
    /// intercepted request can be answered on them.
    const PROBE_RESOLVER_RULES: &str = r#"--host-resolver-rules="MAP ipc.localhost ~NOTFOUND, MAP tauri.localhost ~NOTFOUND""#;

    /// What the test asks of the page: what can it see of a host? Run in the
    /// page's own world by the TEST (the window above never runs a script).
    const PROBE: &str = r#"(async () => {
  const r = {};
  r.internals = typeof window.__TAURI_INTERNALS__;
  r.tauri = typeof window.__TAURI__;
  r.isTauri = typeof window.isTauri;
  r.ipc = typeof window.ipc;
  const cw = window.chrome && window.chrome.webview;
  // A message to the host: whether it ARRIVES is what the test counts.
  try { cw.postMessage('probe'); } catch (e) { }
  async function probe(url, init) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: c.signal }));
      return 'answered:' + (res.headers.get('Tauri-Response') || '') + ':' + res.status;
    } catch (e) { return 'error'; } finally { clearTimeout(t); }
  }
  r.ipcFetch = await probe('http://ipc.localhost/plugin%3Aapp%7Cversion', { method: 'POST', body: '{}' });
  // no-cors: a server's answer resolves (opaque) whatever its CORS headers say,
  // as Tauri's asset protocol would, and only a network error rejects. An image,
  // because Chromium's opaque-response blocking may turn an HTML answer into a
  // network error; the question is only whether anything answers at all.
  // The IPC once more in no-cors: in cors mode an intercepted IPC that answers
  // without Tauri's CORS headers reads as an error whatever its status, yet the
  // page reached the host.
  r.ipcNoCors = await probe('http://ipc.localhost/plugin%3Aapp%7Cversion', { method: 'POST', body: '{}', mode: 'no-cors' });
  r.assetFetch = await probe('http://tauri.localhost/assets/probe.png', { mode: 'no-cors' });
  // And a picture Púca's own files really have: a folder mapped onto the name
  // answers a file it does not have with a network error, not a 404.
  r.iconFetch = await probe('http://tauri.localhost/apple-touch-icon.png', { mode: 'no-cors' });
  document.title = 'RESULT:' + JSON.stringify(r);
})();"#;

    struct Probe {
        hwnd: HWND,
        controller: ICoreWebView2Controller,
        /// What the page said, and how many web messages reached the host.
        seen: serde_json::Value,
        messages: Rc<RefCell<usize>>,
    }

    /// A hidden window (never shown, never activated) with the window's own
    /// webview set-up and `extra` run on it, on `about:blank`: the one page the
    /// window's rules let load without the network (NavigateToString is a
    /// `data:` address, which they refuse, as they should), with the probe run
    /// in it once it has loaded.
    fn load_probe(env: &ICoreWebView2Environment, extra: impl FnOnce(&ICoreWebView2Environment, &ICoreWebView2)) -> Probe {
        let hwnd = create_window().expect("hidden window");
        let (controller, webview) = create_controller(env, hwnd).expect("WebView2 controller");
        configure(&webview, hwnd).expect("the window's own set-up");
        extra(env, &webview);
        let title: Rc<RefCell<String>> = Rc::default();
        let uris: Rc<RefCell<Vec<String>>> = Rc::default();
        let messages: Rc<RefCell<usize>> = Rc::default();
        let seen = title.clone();
        let mut token = Default::default();
        // SAFETY: COM on this test's UI thread. Reading the title is the test's
        // way to hear from its OWN page; the window above never does.
        unsafe {
            webview
                .add_DocumentTitleChanged(
                    &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                        if let Some(sender) = sender {
                            let mut t = PWSTR::null();
                            sender.DocumentTitle(&mut t)?;
                            *seen.borrow_mut() = take_pwstr(t);
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .unwrap();
            // The test listens for web messages the way a bridge would: none
            // may arrive unless web messaging is on (the control).
            let counted = messages.clone();
            webview
                .add_WebMessageReceived(
                    &webview2_com::WebMessageReceivedEventHandler::create(Box::new(move |_, _| {
                        *counted.borrow_mut() += 1;
                        Ok(())
                    })),
                    &mut token,
                )
                .unwrap();
            let seen_uris = uris.clone();
            webview
                .add_NavigationStarting(
                    &webview2_com::NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            seen_uris.borrow_mut().push(take_pwstr(uri));
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .unwrap();
            let loaded: Rc<RefCell<bool>> = Rc::default();
            let done = loaded.clone();
            webview
                .add_NavigationCompleted(
                    &webview2_com::NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                        *done.borrow_mut() = true;
                        Ok(())
                    })),
                    &mut token,
                )
                .unwrap();
            webview.Navigate(&HSTRING::from("about:blank")).unwrap();
            pump_until(|| *loaded.borrow(), "about:blank never loaded", &uris);
            webview
                .ExecuteScript(
                    &HSTRING::from(PROBE),
                    &webview2_com::ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                )
                .unwrap();
        }
        pump_until(|| title.borrow().starts_with("RESULT:"), "the probe never answered", &uris);
        // Time for a message posted before the answer to have arrived, if it can.
        let settle = Instant::now() + Duration::from_millis(750);
        pump_until(|| Instant::now() >= settle, "settling", &uris);
        let seen: serde_json::Value = serde_json::from_str(&title.borrow()["RESULT:".len()..]).unwrap();
        Probe { hwnd, controller, seen, messages }
    }

    /// Pump this thread's messages until `ready`, or fail saying what was seen.
    fn pump_until(ready: impl Fn() -> bool, what: &str, uris: &Rc<RefCell<Vec<String>>>) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut msg = MSG::default();
        while !ready() {
            assert!(
                Instant::now() < deadline,
                "{what} (navigations {:?})",
                uris.borrow().iter().map(|u| u.chars().take(60).collect::<String>()).collect::<Vec<_>>()
            );
            // SAFETY: pumping this thread's own messages.
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            // SAFETY: this test's own controller and window.
            unsafe {
                let _ = self.controller.Close();
                let _ = DestroyWindow(self.hwnd);
            }
        }
    }

    /// The Discord window's webview, on a page of the test's own (never
    /// Discord's, nothing from the network), in a hidden window, on a throwaway
    /// profile. The page finds no bridge to anything; with the bridge put there
    /// on purpose (the NEGATIVE CONTROL), the same page does find it.
    #[test]
    fn the_page_sees_no_bridge() {
        init_ui_thread().expect("UI thread");
        let profile = std::env::temp_dir().join(format!("puca-discord-probe-{}", std::process::id()));
        // Tauri's two names are loopback names, so without this whatever this PC
        // serves on port 80 answers the probe below (GitHub's windows-2025 runner
        // does, and the test once failed there with nothing of Púca's answering).
        // Pointed at nothing, a name is reachable ONLY by intercepting it, which is
        // how Tauri serves its IPC and its files, and what the negative control
        // at the end does with these same names in this same environment.
        let options = environment_options();
        // SAFETY: a setter on an options object this test owns.
        unsafe { options.set_additional_browser_arguments(PROBE_RESOLVER_RULES.to_owned()) };
        let env = environment_from(&profile, options).expect("WebView2 runtime (Windows has it)");

        let plain = load_probe(&env, |_, _| {});
        let seen = &plain.seen;
        for key in ["internals", "tauri", "isTauri", "ipc"] {
            assert_eq!(seen[key], "undefined", "the page sees {key}: {seen}");
        }
        // WebView2's own `chrome.webview` object is in every WebView2 page; with
        // web messaging off, nothing the page posts reaches the host.
        assert_eq!(*plain.messages.borrow(), 0, "a web message reached the host: {seen}");
        // Nothing answers on Tauri's IPC or asset names: no bridge, no Púca files.
        // The no-cors probes fail on any answer at all, a 404 included (an
        // intercepted name that answered "not found" would still be a way in);
        // the cors one reads Tauri's own header. A web server on this PC's port
        // 80 cannot answer any of them: the names resolve to nothing.
        for key in ["ipcFetch", "ipcNoCors", "assetFetch", "iconFetch"] {
            assert_eq!(seen[key], "error", "{key} was answered: {seen}");
        }

        // Where the page may send things, in the real webview. `.invalid` names
        // nothing, should anything slip, and in a test the browser hand-off only
        // records (`OPENED`): no test ever opens the owner's browser.
        let webview = unsafe { plain.controller.CoreWebView2() }.unwrap();
        let run = |script: &str| unsafe {
            webview
                .ExecuteScript(
                    &HSTRING::from(script),
                    &webview2_com::ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                )
                .unwrap();
        };
        let wait = |ms: u64| {
            let until = Instant::now() + Duration::from_millis(ms);
            pump_until(|| Instant::now() >= until, "settling", &Rc::default());
        };
        let source = || {
            let mut source = PWSTR::null();
            unsafe { webview.Source(&mut source) }.unwrap();
            take_pwstr(source)
        };
        // CONTROL: a script the host runs carries a press (WebView2 counts its own
        // calls as user-initiated), so this one goes to the browser, the window
        // staying where it was: the hand-off works, and the next check means something.
        run("location.href = 'https://pressed.invalid/a';");
        wait(1500);
        assert_eq!(source(), "about:blank", "the page left for another site");
        OPENED.with(|o| assert_eq!(*o.borrow(), ["https://pressed.invalid/a"], "control: a press reaches the browser"));
        OPENED.with(|o| o.borrow_mut().clear());
        // The page on its own, after Chromium's 5 s of user activation have run
        // out: it sends itself elsewhere and opens a popup. Nothing moves, no
        // window, nothing for the browser.
        run("setTimeout(() => { location.href = 'https://elsewhere.invalid/x'; window.open('https://popup.invalid/y'); }, 6000);");
        wait(7500);
        assert_eq!(source(), "about:blank", "the page left for another site");
        OPENED.with(|o| assert!(o.borrow().is_empty(), "handed to the browser with no press: {:?}", o.borrow()));

        // NEGATIVE CONTROL: what the probe reports when there IS a bridge.
        // (Both windows stay until the end: destroying one posts WM_QUIT.)
        let bridged = load_probe(&env, |env, webview| unsafe {
            let settings = webview.Settings().unwrap();
            settings.SetIsWebMessageEnabled(true).unwrap();
            // Tauri's way of serving its IPC and its files: intercept the two names,
            // with Tauri's own headers (its IPC answers any origin; its asset
            // protocol answers only its own window's origin, never this page's).
            for name in ["http://ipc.localhost/*", "http://tauri.localhost/*"] {
                webview.AddWebResourceRequestedFilter(&HSTRING::from(name), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL).unwrap();
            }
            let env = env.clone();
            let mut token = Default::default();
            webview
                .add_WebResourceRequested(
                    &webview2_com::WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut uri = PWSTR::null();
                            args.Request()?.Uri(&mut uri)?;
                            let headers = if take_pwstr(uri).starts_with("http://ipc.localhost/") {
                                "Tauri-Response: ok\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Tauri-Response"
                            } else {
                                "Content-Type: image/png\r\nAccess-Control-Allow-Origin: http://tauri.localhost"
                            };
                            let response =
                                env.CreateWebResourceResponse(None, 200, &HSTRING::from("OK"), &HSTRING::from(headers))?;
                            args.SetResponse(&response)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .unwrap();
            let (tx, rx) = mpsc::channel();
            webview
                .AddScriptToExecuteOnDocumentCreated(
                    &HSTRING::from("Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke() {} } });"),
                    &webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |_, _| {
                        let _ = tx.send(());
                        Ok(())
                    })),
                )
                .unwrap();
            wait_with_pump(rx).unwrap();
        });
        let seen = &bridged.seen;
        assert_eq!(seen["internals"], "object", "control: an injected bridge is seen: {seen}");
        assert!(*bridged.messages.borrow() >= 1, "control: with web messaging on, the message arrives: {seen}");
        assert_eq!(seen["ipcFetch"], "answered:ok:200", "control: an intercepted IPC is seen: {seen}");
        // An opaque answer: no headers, status 0, but an answer.
        assert_eq!(seen["assetFetch"], "answered::0", "control: an intercepted asset server is seen: {seen}");
        assert_eq!(seen["ipcNoCors"], "answered::0", "control: an intercepted IPC is seen in no-cors too: {seen}");
        assert_eq!(seen["iconFetch"], "answered::0", "control: a file asked for by name is seen: {seen}");
        drop(bridged);
        drop(plain);

        drop(env);
        let _ = std::fs::remove_dir_all(&profile);
    }
}
