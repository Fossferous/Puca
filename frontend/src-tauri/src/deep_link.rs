//! `puca://` links from OUTSIDE the app: an invite clicked in a browser, a
//! game launcher or another chat program opens THIS desktop app on the Join
//! screen, the way Discord's `discord://` does.
//!
//! WHERE THE LINK COMES FROM. Windows cannot hand an https link to a desktop
//! app, so the web invite page (frontend InviteLanding.tsx) offers
//! "Open in the Púca app", a link of exactly this shape:
//!
//! ```text
//! puca://invite/<code>?host=<the web app's host the invite came from>
//! ```
//!
//! The installer registers the scheme (HKCU\Software\Classes\puca, written by
//! installer-url-scheme.nsh for both the full and the Lite build) with
//! `"<install dir>\<exe>" "%1"`, so Windows starts the exe with the URL as its
//! one argument. Two ways that reaches the webview:
//!
//! - COLD start (the app was not running): `run()` reads the URL from its own
//!   argv BEFORE the builder runs and parks it in [`DeepLinkState`]; the page
//!   takes it with `deep_link_take` once it has booted (frontend
//!   api/deepLink.ts), and the pending-invite mechanism carries it through a
//!   sign-in exactly as it does for the web.
//! - WARM start (the app was already running): the single-instance plugin
//!   hands the SECOND launch's argv to the running app, which parks it the
//!   same way and emits [`EVENT`] with it, so a page that is up acts at once.
//!
//! WHY SO STRICT. Any website can fire a `puca://` link at this machine, with
//! any text in it, as often as it likes. So the only thing a link can do is
//! open the Join screen with an invite code looked up: it never joins, never
//! navigates the webview anywhere, never runs anything, and no byte of it
//! reaches the webview unless it parsed as exactly the shape above — what the
//! page receives is re-built from the parsed parts ([`InviteLink::to_url`]),
//! and the page parses it again under the same rules. Anything else is
//! dropped and logged WITHOUT its content (a refused link is attacker text).
//!
//! The rules match frontend/src/api/deepLink.ts, and one table of cases
//! (frontend/src/tests/fixtures/deep-link-cases.json) is asserted by both
//! sides' tests, so the two parsers cannot drift apart.

use std::sync::Mutex;

/// The event a running app's webview hears a warm-start link on. The payload
/// is the canonical URL ([`InviteLink::to_url`]), never the raw argument.
pub const EVENT: &str = "deep-link-invite";

/// The code rule: frontend/src/api/pendingInvite.ts's `CODE`,
/// `^[A-Za-z0-9_-]{4,64}$`.
const CODE_MIN: usize = 4;
const CODE_MAX: usize = 64;

/// Longer than any link this app builds (`puca://invite/` + a 64-character
/// code + `?host=` + a 253-character host is 337). Checked before anything
/// else looks at the text.
pub const MAX_URL_LEN: usize = 512;

/// A link that parsed: an invite code, and the web app host it came from when
/// the link named one. The host is lowercased; the code is kept exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteLink {
    code: String,
    host: Option<String>,
}

impl InviteLink {
    /// The one form the webview is ever handed, rebuilt from the parsed parts.
    pub fn to_url(&self) -> String {
        match &self.host {
            Some(h) => format!("puca://invite/{}?host={}", self.code, h),
            None => format!("puca://invite/{}", self.code),
        }
    }
}

fn is_code(s: &str) -> bool {
    (CODE_MIN..=CODE_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A plain DNS hostname: dot-separated labels of letters, digits and inner
/// hyphens, 1–63 characters each, 253 in all. No port, no user, no brackets
/// (IPv6), no trailing dot, no percent-encoding.
fn is_hostname(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.split('.').all(|label| {
            let b = label.as_bytes();
            !b.is_empty()
                && b.len() <= 63
                && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
                && b[0] != b'-'
                && b[b.len() - 1] != b'-'
        })
}

/// `s` without `prefix`, compared ASCII-case-insensitively (a URL's scheme and
/// host are case-insensitive, and some launchers change their case).
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

/// Parse one `puca://` URL, or refuse it. Accepted, exactly:
/// `puca://invite/<code>` with an optional `?host=<hostname>`, and at most one
/// trailing `/`. Everything else — another scheme or path, a missing or
/// malformed code, any other query parameter, a fragment, percent-encoding,
/// whitespace — is `None`.
pub fn parse_invite_url(raw: &str) -> Option<InviteLink> {
    if raw.len() > MAX_URL_LEN {
        return None;
    }
    let s = raw.strip_suffix('/').unwrap_or(raw);
    let rest = strip_prefix_ci(s, "puca://invite/")?;
    let (code, query) = match rest.split_once('?') {
        Some((c, q)) => (c, Some(q)),
        None => (rest, None),
    };
    if !is_code(code) {
        return None;
    }
    let host = match query {
        None => None,
        Some(q) => {
            let h = q.strip_prefix("host=")?;
            if !is_hostname(h) {
                return None;
            }
            Some(h.to_ascii_lowercase())
        }
    };
    Some(InviteLink { code: code.to_string(), host })
}

/// What a command line carried.
#[derive(Debug, PartialEq, Eq)]
pub enum ArgLink {
    /// No argument looks like a `puca:` link — an ordinary launch.
    None,
    /// Exactly one, and it parsed.
    Invite(InviteLink),
    /// A `puca:` argument that did not parse, or more than one. The reason is
    /// ours; the argument's text is never kept.
    Refused(&'static str),
}

/// Why a command line's link was refused — the only thing about it logged.
const MORE_THAN_ONE: &str = "more than one puca: link on the command line";
const TOO_LONG: &str = "a puca: link longer than any invite link";
const NOT_AN_INVITE: &str = "a puca: link that is not an invite link";

fn looks_like_puca(arg: &str) -> bool {
    strip_prefix_ci(arg, "puca:").is_some()
}

/// The link on a command line — `std::env::args()` for a cold start, or the
/// argv the single-instance plugin delivers for a warm one. Both start with
/// the executable's own path, which is skipped. The other arguments are left
/// alone: `--hidden` (autostart) and anything else are not ours to judge.
///
/// More than one `puca:` argument is refused outright rather than guessed at:
/// Windows passes a clicked link as ONE argument, and the plugin joins and
/// re-splits argv on `|`, so a second one means the text was not what a click
/// produces.
pub fn link_from_args<I, S>(args: I) -> ArgLink
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut found: Option<ArgLink> = None;
    for arg in args.into_iter().skip(1) {
        let arg = arg.as_ref();
        if !looks_like_puca(arg) {
            continue;
        }
        if found.is_some() {
            return ArgLink::Refused(MORE_THAN_ONE);
        }
        found = Some(if arg.len() > MAX_URL_LEN {
            // Not even looked at: no invite link is this long.
            ArgLink::Refused(TOO_LONG)
        } else {
            match parse_invite_url(arg) {
                Some(link) => ArgLink::Invite(link),
                None => ArgLink::Refused(NOT_AN_INVITE),
            }
        });
    }
    found.unwrap_or(ArgLink::None)
}

/// Start in the tray instead of showing a window: the autostart launch
/// (`--hidden`, see lib.rs) — unless the same command line carried an invite,
/// because opening one is the reason somebody launched the app.
pub fn starts_hidden<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter().skip(1).any(|a| a.as_ref() == "--hidden")
        && !matches!(link_from_args(args), ArgLink::Invite(_))
}

/// One line for the log about a command line's link, WITHOUT its content:
/// only whether there was one and, for a refusal, why.
pub fn describe(outcome: &ArgLink) -> Option<String> {
    match outcome {
        ArgLink::None => None,
        ArgLink::Invite(l) => Some(format!(
            "[deep-link] an invite link arrived{}",
            if l.host.is_some() { " (naming a web app host)" } else { "" }
        )),
        ArgLink::Refused(why) => Some(format!("[deep-link] ignored {why}")),
    }
}

/// The link waiting for the page: parked here by a cold start before the
/// webview exists, and by a warm start in case the page is not listening
/// (still loading, or reloading). The newest link wins; taking it empties it.
#[derive(Default)]
pub struct DeepLinkState(Mutex<Option<InviteLink>>);

impl DeepLinkState {
    pub fn new(initial: Option<InviteLink>) -> Self {
        Self(Mutex::new(initial))
    }

    pub fn put(&self, link: InviteLink) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(link);
    }

    pub fn take(&self) -> Option<InviteLink> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

/// The invite from `outcome`, when it is one.
pub fn invite(outcome: ArgLink) -> Option<InviteLink> {
    match outcome {
        ArgLink::Invite(l) => Some(l),
        _ => None,
    }
}

/// A second launch's argv, handed over by the single-instance plugin: park the
/// link and tell the page. The window has already been shown by the caller.
pub fn forward_second_instance(app: &tauri::AppHandle, argv: &[String]) {
    use tauri::{Emitter, Manager};
    let outcome = link_from_args(argv);
    if let Some(line) = describe(&outcome) {
        log::info!("{line} (second launch)");
    }
    let Some(link) = invite(outcome) else { return };
    let url = link.to_url();
    if let Some(state) = app.try_state::<DeepLinkState>() {
        state.put(link);
    }
    if let Err(e) = app.emit_to("main", EVENT, url) {
        log::warn!("[deep-link] could not tell the page about an invite link: {e}");
    }
}

/// The page takes the waiting link, if any: the canonical URL, once.
#[tauri::command]
pub fn deep_link_take(state: tauri::State<'_, DeepLinkState>) -> Option<String> {
    state.take().map(|l| l.to_url())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(code: &str, host: Option<&str>) -> InviteLink {
        InviteLink { code: code.to_string(), host: host.map(str::to_string) }
    }

    const EXE: &str = r"C:\Users\someone\AppData\Local\Púca\Puca.exe";

    // ---- the parser ------------------------------------------------------

    #[test]
    fn a_valid_invite_parses_with_and_without_a_host() {
        assert_eq!(
            parse_invite_url("puca://invite/aBc123Xy?host=app.example.com"),
            Some(link("aBc123Xy", Some("app.example.com")))
        );
        assert_eq!(parse_invite_url("puca://invite/aBc123Xy"), Some(link("aBc123Xy", None)));
        // The code keeps its case; the scheme, "invite" and the host do not matter.
        assert_eq!(
            parse_invite_url("PUCA://Invite/aBc123Xy?host=App.Example.COM"),
            Some(link("aBc123Xy", Some("app.example.com")))
        );
        // One trailing slash, which some launchers add.
        assert_eq!(parse_invite_url("puca://invite/aBc123Xy/"), Some(link("aBc123Xy", None)));
    }

    #[test]
    fn the_page_is_handed_only_the_rebuilt_url() {
        let l = parse_invite_url("PUCA://INVITE/aBc_12-3/").unwrap();
        assert_eq!(l.to_url(), "puca://invite/aBc_12-3");
        let l = parse_invite_url("puca://invite/aBc123Xy?host=APP.example.com").unwrap();
        assert_eq!(l.to_url(), "puca://invite/aBc123Xy?host=app.example.com");
        // And the rebuilt URL parses back to the same thing.
        assert_eq!(parse_invite_url(&l.to_url()), Some(l));
    }

    #[test]
    fn a_missing_code_is_refused() {
        for s in ["puca://invite/", "puca://invite", "puca://invite/?host=app.example.com", "puca://", "puca:"] {
            assert_eq!(parse_invite_url(s), None, "{s}");
        }
    }

    #[test]
    fn a_code_with_characters_outside_the_rule_is_refused() {
        for s in [
            "puca://invite/abc",                    // 3: too short
            "puca://invite/ab cd",
            "puca://invite/abc<d>",
            "puca://invite/abcd%20",                 // percent-encoding is not decoded, it is refused
            "puca://invite/%61bcd",
            "puca://invite/abcd\"",
            "puca://invite/abcd\n",
            "puca://invite/abcé",
            "puca://invite/abcd//",                  // one trailing slash, not two
            " puca://invite/abcd",
        ] {
            assert_eq!(parse_invite_url(s), None, "{s:?}");
        }
        let longest = "a".repeat(CODE_MAX);
        assert!(parse_invite_url(&format!("puca://invite/{longest}")).is_some(), "64 is allowed");
        assert_eq!(parse_invite_url(&format!("puca://invite/{longest}a")), None, "65 is not");
    }

    #[test]
    fn other_paths_are_refused() {
        for s in [
            "puca://join/abcd1234",
            "puca://invite/abcd1234/extra",
            "puca://invite/../settings",
            "puca://settings",
            "puca://invite/abcd1234#fragment",
            "puca://invite/abcd1234?",
            "puca://invite/abcd1234?host=",
            "puca://invite/abcd1234?host=app.example.com&next=/chat",
            "puca://invite/abcd1234?next=https://example.com",
            "puca://invite/abcd1234?Host=app.example.com",
            "puca:invite/abcd1234",
            "puca:/invite/abcd1234",
            "puca:///invite/abcd1234",
        ] {
            assert_eq!(parse_invite_url(s), None, "{s}");
        }
    }

    #[test]
    fn a_host_that_is_not_a_plain_hostname_is_refused() {
        for h in [
            "app.example.com:8443",
            "user@app.example.com",
            "app.example.com/path",
            "[::1]",
            "exa_mple.com",
            "-app.example.com",
            "app-.example.com",
            "app..example.com",
            "app.example.com.",
            "app%2eexample.com",
            "app example.com",
            "javascript:alert(1)",
        ] {
            assert_eq!(parse_invite_url(&format!("puca://invite/abcd1234?host={h}")), None, "{h}");
        }
        let label = "a".repeat(63);
        assert!(parse_invite_url(&format!("puca://invite/abcd1234?host={label}.com")).is_some());
        assert_eq!(parse_invite_url(&format!("puca://invite/abcd1234?host={label}a.com")), None);
        // IPv4 and single-label names are plain hostnames.
        assert!(parse_invite_url("puca://invite/abcd1234?host=127.0.0.1").is_some());
        assert!(parse_invite_url("puca://invite/abcd1234?host=localhost").is_some());
    }

    #[test]
    fn other_schemes_are_refused() {
        for s in [
            "https://app.example.com/invite/abcd1234",
            "http://app.example.com/invite/abcd1234",
            "pucax://invite/abcd1234",
            "puc://invite/abcd1234",
            "file:///C:/Windows/System32/calc.exe",
            "discord://invite/abcd1234",
        ] {
            assert_eq!(parse_invite_url(s), None, "{s}");
        }
    }

    #[test]
    fn javascript_urls_are_refused_on_every_path() {
        assert_eq!(parse_invite_url("javascript:alert(1)"), None);
        assert_eq!(parse_invite_url("puca:javascript:alert(1)"), None);
        assert_eq!(parse_invite_url("puca://invite/javascript:alert(1)"), None);
        // Not a puca: argument at all: an ordinary launch, no link.
        assert_eq!(link_from_args([EXE, "javascript:alert(1)"]), ArgLink::None);
        // A puca: argument that smuggles one: refused.
        assert!(matches!(link_from_args([EXE, "puca:javascript:alert(1)"]), ArgLink::Refused(_)));
    }

    #[test]
    fn very_long_input_is_refused_and_a_command_line_never_parses_it() {
        let huge = format!("puca://invite/abcd1234?host={}", "a.".repeat(100_000) + "com");
        assert_eq!(parse_invite_url(&huge), None);
        // Just over the cap, with a shape that would otherwise be close to valid.
        let over = format!("puca://invite/abcd1234?host={}", "a".repeat(MAX_URL_LEN));
        assert!(over.len() > MAX_URL_LEN);
        assert_eq!(parse_invite_url(&over), None);
        // On a command line the cap is checked BEFORE the parser runs, and says so.
        assert_eq!(link_from_args([EXE, huge.as_str()]), ArgLink::Refused(TOO_LONG));
        assert_eq!(link_from_args([EXE, over.as_str()]), ArgLink::Refused(TOO_LONG));
        assert_eq!(link_from_args([EXE, "puca://invite/abc"]), ArgLink::Refused(NOT_AN_INVITE));
        // The longest link this app can build is under the cap.
        let host = vec!["b".repeat(63); 3].join(".") + "." + &"c".repeat(61);
        assert_eq!(host.len(), 253);
        let longest = format!("puca://invite/{}?host={}", "a".repeat(CODE_MAX), host);
        assert!(parse_invite_url(&longest).is_some(), "the longest valid link is accepted");
        assert!(longest.len() <= MAX_URL_LEN, "{}", longest.len());
    }

    #[test]
    fn a_multibyte_character_at_the_prefix_boundary_does_not_panic() {
        // `get(..n)` rather than slicing: a byte index inside a character must
        // be a refusal, never a panic in the single-instance callback.
        for s in ["pucé://invite/abcd", "puca://invité/abcd", "é", "puca://inv"] {
            assert_eq!(parse_invite_url(s), None, "{s}");
            let _ = link_from_args([EXE, s]);
        }
    }

    /// One table, asserted here AND by the webview's parser
    /// (src/tests/deepLink.test.ts), so the two cannot disagree about a link.
    #[test]
    fn the_shared_case_table_agrees_with_this_parser() {
        #[derive(serde::Deserialize)]
        struct Case {
            url: String,
            /// The canonical URL the page is handed, or null for a refusal.
            canonical: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Table {
            cases: Vec<Case>,
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/tests/fixtures/deep-link-cases.json");
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("cannot read the shared case table at {path}: {e}"));
        let table: Table = serde_json::from_str(&raw).expect("the case table is valid JSON");
        assert!(table.cases.len() >= 20, "the table lost its cases");
        let (mut accepted, mut refused) = (0, 0);
        for c in &table.cases {
            let got = parse_invite_url(&c.url).map(|l| l.to_url());
            assert_eq!(got, c.canonical, "{:?}", c.url);
            if got.is_some() { accepted += 1 } else { refused += 1 }
        }
        // Both verdicts are exercised: a table of refusals alone would pass a
        // parser that refused everything.
        assert!(accepted >= 3 && refused >= 10, "{accepted} accepted, {refused} refused");
    }

    // ---- the command line: cold start ------------------------------------

    #[test]
    fn cold_start_argv_with_the_link_windows_passes() {
        // Exactly what the registered command line produces:
        // "<install dir>\Puca.exe" "%1"
        let argv = [EXE, "puca://invite/aBc123Xy?host=app.example.com"];
        assert_eq!(link_from_args(argv), ArgLink::Invite(link("aBc123Xy", Some("app.example.com"))));
        assert!(!starts_hidden(&argv));
    }

    #[test]
    fn cold_start_without_a_link_is_an_ordinary_launch() {
        assert_eq!(link_from_args([EXE]), ArgLink::None);
        assert_eq!(link_from_args(Vec::<String>::new()), ArgLink::None);
        assert_eq!(link_from_args([EXE, "--some-flag", "C:\\a file.txt"]), ArgLink::None);
        assert_eq!(describe(&ArgLink::None), None);
    }

    #[test]
    fn the_autostart_hidden_flag_still_starts_in_the_tray() {
        // Autostart (tauri_plugin_autostart, Some(vec!["--hidden"])): no link.
        let argv = [EXE, "--hidden"];
        assert_eq!(link_from_args(argv), ArgLink::None);
        assert!(starts_hidden(&argv));
        // Positive control for the rule below: --hidden alone is what hides.
        assert!(!starts_hidden(&[EXE]));
    }

    #[test]
    fn an_invite_alongside_hidden_is_found_and_shows_the_window() {
        let argv = [EXE, "--hidden", "puca://invite/aBc123Xy"];
        assert_eq!(link_from_args(argv), ArgLink::Invite(link("aBc123Xy", None)));
        assert!(!starts_hidden(&argv), "a click on an invite must not start hidden in the tray");
        // Either order.
        assert!(!starts_hidden(&[EXE, "puca://invite/aBc123Xy", "--hidden"]));
        // A refused link does not un-hide an autostart.
        assert!(starts_hidden(&[EXE, "--hidden", "puca://nope"]));
    }

    #[test]
    fn the_executables_own_path_is_never_read_as_the_link() {
        assert_eq!(link_from_args(["puca://invite/aBc123Xy"]), ArgLink::None);
    }

    #[test]
    fn more_than_one_link_is_refused() {
        let argv = [EXE, "puca://invite/aaaa1111", "puca://invite/bbbb2222"];
        assert_eq!(link_from_args(argv), ArgLink::Refused(MORE_THAN_ONE));
        // Even when one of them is fine and the other is not, in either order.
        assert_eq!(link_from_args([EXE, "puca://nope", "puca://invite/bbbb2222"]), ArgLink::Refused(MORE_THAN_ONE));
        assert_eq!(link_from_args([EXE, "puca://invite/bbbb2222", "puca://nope"]), ArgLink::Refused(MORE_THAN_ONE));
    }

    #[test]
    fn a_refusal_is_logged_without_the_links_text() {
        let secret = "puca://invite/abcd1234?host=evil.example.com&x=<script>";
        let outcome = link_from_args([EXE, secret]);
        let line = describe(&outcome).expect("a refusal is logged");
        assert!(line.contains("ignored"), "{line}");
        for part in ["abcd1234", "evil", "script", "host="] {
            assert!(!line.contains(part), "the log line carries link text: {line}");
        }
        // An accepted link is not written out either — the code is a secret
        // of sorts (it lets its holder in).
        let ok = describe(&link_from_args([EXE, "puca://invite/aBc123Xy?host=app.example.com"])).unwrap();
        assert!(!ok.contains("aBc123Xy") && !ok.contains("app.example.com"), "{ok}");
    }

    // ---- the command line: warm start (single-instance argv) --------------

    #[test]
    fn warm_start_argv_as_the_single_instance_plugin_delivers_it() {
        // The plugin sends the second launch's std::env::args() joined on '|'
        // and splits it again on the receiving side. Simulate exactly that.
        let second_launch = [EXE, "puca://invite/aBc123Xy?host=app.example.com"];
        let wire = second_launch.join("|");
        let delivered: Vec<String> = wire.split('|').map(str::to_string).collect();
        assert_eq!(
            link_from_args(&delivered),
            ArgLink::Invite(link("aBc123Xy", Some("app.example.com")))
        );
        // A plain second launch (shortcut double-click) carries no link: the
        // callback only shows the window.
        let plain: Vec<String> = [EXE].join("|").split('|').map(str::to_string).collect();
        assert_eq!(link_from_args(&plain), ArgLink::None);
    }

    #[test]
    fn warm_start_a_pipe_in_the_link_cannot_smuggle_a_second_argument_through() {
        // '|' is the plugin's separator, so one URL with a '|' arrives as two
        // arguments. The first half must not quietly pass as a shorter code
        // with the rest ignored if the rest is another link.
        let second_launch = [EXE, "puca://invite/aaaa1111|puca://invite/bbbb2222"];
        let delivered: Vec<String> = second_launch.join("|").split('|').map(str::to_string).collect();
        assert_eq!(delivered.len(), 3);
        assert_eq!(link_from_args(&delivered), ArgLink::Refused(MORE_THAN_ONE));
        // A '|' followed by something that is not a link leaves only what a
        // website could have sent directly: the Join screen for that code.
        let second_launch = [EXE, "puca://invite/aaaa1111|--hidden"];
        let delivered: Vec<String> = second_launch.join("|").split('|').map(str::to_string).collect();
        assert_eq!(link_from_args(&delivered), ArgLink::Invite(link("aaaa1111", None)));
    }

    // ---- the parked link -------------------------------------------------

    #[test]
    fn the_parked_link_is_taken_once_and_the_newest_wins() {
        let state = DeepLinkState::new(invite(link_from_args([EXE, "puca://invite/aaaa1111"])));
        assert_eq!(state.take(), Some(link("aaaa1111", None)));
        assert_eq!(state.take(), None, "taken once");
        state.put(link("bbbb2222", None));
        state.put(link("cccc3333", Some("app.example.com")));
        assert_eq!(state.take().map(|l| l.to_url()), Some("puca://invite/cccc3333?host=app.example.com".to_string()));
        assert_eq!(state.take(), None);
        // A cold start with no link parks nothing.
        assert_eq!(DeepLinkState::new(invite(link_from_args([EXE, "--hidden"]))).take(), None);
    }
}
