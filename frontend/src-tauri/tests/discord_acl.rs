//! The capability set this BUILD compiled in, put through Tauri's own ACL. A
//! BACKSTOP: the Discord window is not a Tauri window at all (discord_host.rs
//! hosts WebView2 with no Tauri in its process), so nothing Tauri grants can
//! reach it. Should a Tauri webview ever carry the name reserved for it, or open
//! Discord's address, it is still refused every command, a plugin's and an
//! app's alike, while Púca's own window, the control, gets past the ACL with
//! commands its capability grants.
//!
//! An integration test, not a unit test, for one reason: building a Tauri app,
//! even a mock one, links Tauri's menu and dialog code, which imports
//! `TaskDialogIndirect` from comctl32 v6, and only a program with the
//! Common-Controls v6 manifest can load that. build.rs gives this target the
//! manifest (`rustc-link-arg-tests`), which Cargo applies to integration tests
//! and never to the shipped binary or the library's own unit-test program.

use app_lib::discord_window::{LABEL, START_URL};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Core and plugin commands, including every one Púca's own capability grants
/// its window (`core:default`, `notification:default`, `process:allow-*`,
/// `updater:default`).
const PLUGIN_COMMANDS: &[&str] = &[
    "plugin:event|listen",
    "plugin:event|emit",
    "plugin:window|title",
    "plugin:window|close",
    "plugin:window|set_title",
    "plugin:webview|create_webview_window",
    "plugin:app|version",
    "plugin:path|resolve_directory",
    "plugin:notification|notify",
    "plugin:notification|request_permission",
    "plugin:notification|is_permission_granted",
    "plugin:process|exit",
    "plugin:process|restart",
    "plugin:updater|check",
    "plugin:window-state|save_window_state",
];

/// App commands (Púca's own `invoke_handler`; the Discord process registers
/// none). Tauri asks the ACL about these only for a REMOTE page, so that is
/// where they are tried: a local page is not something the Discord window has.
const APP_COMMANDS: &[&str] = &["discord_window_open", "open_external", "attachment_save", "device_key_public"];

fn ask(webview: &tauri::WebviewWindow<MockRuntime>, cmd: &str, url: &str) -> Result<(), String> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Tauri's ACL refusals all read "<command> not allowed ..."
/// (tauri-2.x ipc/authority.rs, `resolve_access_message`).
fn refused_by_acl(result: &Result<(), String>) -> bool {
    matches!(result, Err(e) if e.contains(" not allowed"))
}

#[test]
fn the_built_capability_set_grants_the_discord_window_nothing() {
    let app = mock_builder().build(tauri::generate_context!(test = true)).expect("mock app");
    let discord = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(START_URL.parse().unwrap()))
        .build()
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default()).build().unwrap();
    let local = "http://localhost:5173/";
    for cmd in PLUGIN_COMMANDS {
        for page in [START_URL, "https://evil.example/", local] {
            let answer = ask(&discord, cmd, page);
            assert!(refused_by_acl(&answer), "{cmd} from the Discord window on {page}: {answer:?}");
        }
    }
    for cmd in APP_COMMANDS {
        for page in [START_URL, "https://cdn.discordapp.com/x"] {
            let answer = ask(&discord, cmd, page);
            assert!(refused_by_acl(&answer), "{cmd} from the Discord window on {page}: {answer:?}");
        }
    }
    // CONTROL: the same ACL lets Púca's own window through for commands its
    // capability grants (what follows is the plugin's own answer, or none).
    for cmd in ["plugin:event|listen", "plugin:notification|notify", "plugin:window|title", "plugin:app|version"] {
        let answer = ask(&main, cmd, local);
        assert!(!refused_by_acl(&answer), "control: {cmd} from Púca's window: {answer:?}");
    }
}
