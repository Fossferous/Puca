//! The OS "Save As" dialog behind `chooseSavePath` (api/savePath.ts): a received
//! file, a downloaded attachment, a calendar or Notes export.
//!
//! WHY `rfd` DIRECTLY, AND NOT `tauri-plugin-dialog`. That plugin's `init()` also
//! registers an init script in every webview, on every desktop platform, which
//! replaces `window.alert` and `window.confirm` with calls into the plugin. Its
//! `confirm` is `async`, so it returns a Promise, and a Promise is truthy: every
//! `if (!confirm(...)) return` in the app went ahead as a yes. Nothing was shown
//! either, because this app granted the plugin nothing but its Save As. From 0.8.134
//! on that left the desktop app with no question before Disband Server, Kick or
//! Delete forever, and no error from any `alert`.
//! `src/tests/desktopScriptDialogs.test.ts` keeps the plugin out and shows the
//! shape that did it.
//!
//! With no override, the page's `confirm`, `alert` and `prompt` are the webview's own.
//! In WebView2, the released desktop app, `AreDefaultScriptDialogsEnabled` defaults to
//! TRUE and wry never sets it. WebKitGTK shows its own too. WKWebView does not: on
//! macOS, a build that exists and is not released, wry implements no JavaScript panel
//! delegate, so `confirm` answers No with nothing shown and `alert` shows nothing.
//! That refuses rather than destroys, and it is how macOS was before the plugin, but
//! a macOS release needs those delegate methods first.

use std::path::Path;

/// What the dialog's title bar says.
const TITLE: &str = "Save file";

/// The name the dialog starts with. It can come from another person (a received
/// file's name), so it gets the same treatment as a name going into the default
/// folder: only its last segment, so nobody else picks the folder this opens in.
fn suggested_file_name(raw: &str) -> String {
    crate::file_transfer::sanitize_file_name(raw)
}

/// The chosen path as the page will hand it back to `transfer_begin` or
/// `attachment_save`. A name that is not Unicode (Windows allows one) is refused:
/// a lossy copy would write to a file the person did not choose.
fn chosen_path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Púca can't save to a file with that name. Choose another name.".to_string())
}

/// Ask where to save. `Ok(None)` is the person cancelling.
///
/// Never blocks a thread that matters. An async command runs on the runtime, and
/// `save_file()` hands the dialog to a thread of its own (on macOS, to the main
/// run loop, which is why it is called from the main thread here), leaving this
/// task only a channel to wait on. Parented to the window that asked, as a modal.
#[tauri::command]
pub async fn choose_save_path(window: tauri::Window, suggested_name: String) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_title(TITLE)
        .set_file_name(suggested_file_name(&suggested_name))
        .set_can_create_directories(true)
        .set_parent(&window);
    let (answer, mut answered) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let chosen = dialog.save_file();
            tauri::async_runtime::spawn(async move {
                let _ = answer.send(chosen.await).await;
            });
        })
        .map_err(|e| e.to_string())?;
    let chosen = answered.recv().await.ok_or("The Save As dialog closed with the app.")?;
    chosen.map(|file| chosen_path_text(file.path())).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_name_is_kept_as_it_is() {
        assert_eq!(suggested_file_name("puca-notes-2026-09-29.md"), "puca-notes-2026-09-29.md");
        assert_eq!(suggested_file_name("Púca – notes.md"), "Púca – notes.md");
        assert_eq!(suggested_file_name("archive.tar.gz"), "archive.tar.gz");
    }

    /// The plugin read this as a path, so a sender's `dir\name` chose the folder
    /// the dialog opened in.
    #[test]
    fn a_name_from_someone_else_has_no_say_in_the_folder() {
        assert_eq!(suggested_file_name(r"..\..\Windows\System32\evil.dll"), "evil.dll");
        assert_eq!(suggested_file_name("/home/someone/evil.sh"), "evil.sh");
        assert_eq!(suggested_file_name(r"C:\Temp\thing.txt"), "thing.txt");
    }

    #[test]
    fn an_empty_name_still_gives_the_dialog_something_to_start_with() {
        assert_eq!(suggested_file_name(""), "file");
        assert_eq!(suggested_file_name(".."), "file");
    }

    #[test]
    fn a_chosen_path_comes_back_byte_for_byte() {
        let chosen = r"D:\Zoë's files\Púca – notes.md";
        assert_eq!(chosen_path_text(Path::new(chosen)).as_deref(), Ok(chosen));
    }

    /// A lone surrogate is a legal Windows file name and no Unicode string.
    #[cfg(windows)]
    #[test]
    fn a_path_that_is_not_unicode_is_refused_rather_than_rewritten() {
        use std::os::windows::ffi::OsStringExt;
        let wide: Vec<u16> = r"D:\keep\".encode_utf16().chain([0xD800]).chain(".txt".encode_utf16()).collect();
        let path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&wide));
        assert!(chosen_path_text(&path).is_err());
    }
}
