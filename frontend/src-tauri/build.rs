use std::path::Path;

/// Expose the app's `identifier` to the crate as `PUCA_IDENTIFIER`.
///
/// WHY. `identifier` is what Tauri keys the app data directory off — on
/// Windows `%LOCALAPPDATA%\<identifier>` — and several modules build paths
/// under it by hand (the device keypair, the WebView2 permission reset, the
/// display-topology marker). Every one of them had the string
/// "com.sovereign.chat" written out literally, which is correct only while
/// exactly one build of this app exists.
///
/// The lite variant deliberately SHARES this identifier with the full build —
/// that shared data directory is what keeps you signed in when you switch
/// between them — so the literals are not actively wrong today. This is not
/// load-bearing; it is the single source of truth those paths should always
/// have had. Any future build that does change the identifier (a second
/// deployment, a beta channel) would otherwise read the wrong app's device
/// private key and clear the wrong app's WebView data, silently, because both
/// paths exist and neither call fails.
///
/// Read from the same place Tauri reads it, including the `TAURI_CONFIG`
/// override the CLI sets for `--config` overlays, so this constant cannot
/// disagree with the identifier the bundle is actually built with.
fn emit_identifier() {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    // The CLI passes the MERGED config here when `--config` overlays are in
    // play; it is the authority whenever present.
    let from_env = std::env::var("TAURI_CONFIG").ok().and_then(|raw| {
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("identifier")?.as_str().map(str::to_owned))
    });

    let identifier = from_env.unwrap_or_else(|| {
        let raw = std::fs::read_to_string(Path::new("tauri.conf.json"))
            .expect("tauri.conf.json must be readable to resolve the app identifier");
        serde_json::from_str::<serde_json::Value>(&raw)
            .expect("tauri.conf.json must be valid JSON")
            .get("identifier")
            .and_then(|v| v.as_str())
            .expect("tauri.conf.json must declare an identifier")
            .to_owned()
    });

    // A path component. Refuse anything that could escape the data directory
    // rather than discovering it as a mangled path at runtime.
    assert!(
        !identifier.is_empty()
            && !identifier.contains('/')
            && !identifier.contains('\\')
            && !identifier.contains(".."),
        "identifier {identifier:?} is not usable as a directory name",
    );

    println!("cargo:rustc-env=PUCA_IDENTIFIER={identifier}");
}

fn main() {
    emit_identifier();
    tauri_build::build()
}
