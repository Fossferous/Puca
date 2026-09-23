//! The migrator the server runs at startup.
//!
//! `sqlx::migrate!` embeds `./migrations` at compile time, and by default the
//! resulting `Migrator` REFUSES to start against a database that has applied a
//! migration it does not embed (`MigrateError::VersionMissing`). That default
//! makes every backend rollback a database restore: the moment a release that
//! adds migration N has booted once, no binary built before N will boot again,
//! and the only way back is the dump taken before the ship — losing every
//! write made since.
//!
//! `ignore_missing` turns that check off, and nothing else. Checksums of the
//! migrations this binary DOES embed are still compared (an edited applied
//! file still crash-loops, migrations/README.md), and anything unapplied is
//! still applied. What it permits is exactly "the database is newer than me":
//! an older binary boots over columns and tables it does not know about. That
//! is only safe because every migration here is additive (nullable columns,
//! new tables, `IF NOT EXISTS`) — which is the rule migrations/README.md
//! already sets for other reasons. A future migration that is NOT additive
//! (a dropped or renamed column an older binary still reads) breaks rollback
//! to anything before it, and its release notes must say so.
//!
//! This only helps binaries built WITH it. A release that predates this file
//! still runs the default check, so rolling back to one of those still needs
//! the database restore.

use sqlx::migrate::Migrator;

/// The startup migrator: every embedded migration, tolerant of applied
/// versions it does not embed (see the module header for why).
pub fn app_migrator() -> Migrator {
    let mut m = sqlx::migrate!("./migrations");
    m.set_ignore_missing(true);
    m
}

/// The database a DB-backed test may use: `TEST_DATABASE_URL`, and nothing
/// else. Never `DATABASE_URL` (nor a `.env` that sets it): the tests that call
/// this migrate the database, run sweeps that delete rows for every account
/// in it, and create and drop scratch databases on its server — a plain
/// `cargo test` in a checkout configured for a dev database must not do that
/// to it.
#[cfg(test)]
pub(crate) fn test_database_url() -> Option<String> {
    test_database_url_from(|k| std::env::var(k).ok())
}

#[cfg(test)]
fn test_database_url_from(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    get("TEST_DATABASE_URL").filter(|u| !u.trim().is_empty())
}

/// The pool every DB-backed test in this crate runs against: connected to
/// `TEST_DATABASE_URL` and migrated with the startup migrator. `None` (after
/// printing "skipping") ONLY when the variable is unset — that is the one
/// legitimate reason to skip. A variable that is set but names a database
/// that cannot be reached PANICS with the error: a gate run that meant to
/// exercise the database must not come back green because it was down, the
/// password was wrong or the database name was misspelt.
///
/// Migrating here, not in each caller, also closes a first-run race: suites
/// that did not migrate raced the ones that did on a fresh throwaway
/// database and failed with `relation "users" does not exist`.
/// (`tests/*.rs` cannot reach this — the crate is a binary with no library
/// target — so `tests/common/mod.rs` carries a copy of the same contract.)
#[cfg(test)]
pub(crate) async fn test_pool(max_connections: u32) -> Option<sqlx::PgPool> {
    test_database(max_connections).await.map(|(pool, _)| pool)
}

/// `test_pool` plus the URL, for a test that also needs its own connection
/// (a `PgListener`).
#[cfg(test)]
pub(crate) async fn test_database(max_connections: u32) -> Option<(sqlx::PgPool, String)> {
    test_database_from(test_database_url(), max_connections).await
}

#[cfg(test)]
async fn test_database_from(url: Option<String>, max_connections: u32) -> Option<(sqlx::PgPool, String)> {
    let Some(url) = url else {
        println!("skipping: TEST_DATABASE_URL not set");
        return None;
    };
    let pool = connect_test_database(&url, max_connections).await;
    app_migrator().run(&pool).await.expect("migrations apply");
    Some((pool, url))
}

/// Connect to a configured test database or panic saying why. One plain
/// connection goes first because sqlx's POOL retries a refused connection
/// until its 30 s acquire timeout: every test would sit out half a minute
/// before failing. The error text never includes the URL (it carries the
/// password).
#[cfg(test)]
pub(crate) async fn connect_test_database(url: &str, max_connections: u32) -> sqlx::PgPool {
    use sqlx::Connection;
    let unreachable = |e: sqlx::Error| -> ! {
        panic!(
            "TEST_DATABASE_URL is set but the database is unreachable: {e}. \
             Start that database, or unset TEST_DATABASE_URL to skip the DB-backed tests."
        )
    };
    match sqlx::postgres::PgConnection::connect(url).await {
        Ok(probe) => {
            let _ = probe.close().await;
        }
        Err(e) => unreachable(e),
    }
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(url)
        .await
        .unwrap_or_else(|e| unreachable(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_migrator_tolerates_newer_databases_and_embeds_everything() {
        let m = app_migrator();
        assert!(m.ignore_missing, "an older binary must boot against a database a newer one migrated");
        // Still the full set: every `<version>_<name>.sql` in migrations/ is
        // embedded, no more and no fewer — read from the directory at test
        // time, not from a second expansion of the same macro.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut on_disk: Vec<i64> = std::fs::read_dir(&dir)
            .expect("migrations/ is readable")
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.ends_with(".sql"))
            .filter_map(|n| n.split_once('_')?.0.parse::<i64>().ok())
            .collect();
        on_disk.sort_unstable();
        let embedded: Vec<i64> = m.iter().map(|mig| mig.version).collect();
        assert!(on_disk.len() >= 65, "positive control: the directory scan found the migrations ({})", on_disk.len());
        assert_eq!(embedded, on_disk, "the startup migrator embeds exactly migrations/*.sql");
    }

    #[test]
    fn db_tests_use_test_database_url_and_never_database_url() {
        let only_dev = |k: &str| (k == "DATABASE_URL").then(|| "postgres://dev/puca".to_string());
        assert_eq!(test_database_url_from(only_dev), None, "a dev DATABASE_URL must never be picked up");
        let both = |k: &str| match k {
            "TEST_DATABASE_URL" => Some("postgres://test/scratch".to_string()),
            "DATABASE_URL" => Some("postgres://dev/puca".to_string()),
            _ => None,
        };
        assert_eq!(test_database_url_from(both).as_deref(), Some("postgres://test/scratch"), "positive control");
        assert_eq!(test_database_url_from(|_| Some("  ".to_string())), None, "blank is unset");
    }

    /// A URL nothing listens on: a port the OS just handed out, released
    /// again. No fixed port, so it cannot collide with anything running.
    fn closed_database_url() -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = l.local_addr().expect("local addr").port();
        drop(l);
        format!("postgres://nobody:nothing@127.0.0.1:{port}/none")
    }

    /// Configured but unreachable is a FAILURE, never a skip: the old
    /// per-suite setups printed a skip line on a failed connect and returned,
    /// so a gate run against a stopped throwaway cluster came back green.
    #[tokio::test]
    #[should_panic(expected = "TEST_DATABASE_URL is set but the database is unreachable")]
    async fn a_configured_but_unreachable_test_database_fails_instead_of_skipping() {
        let _ = test_database_from(Some(closed_database_url()), 1).await;
    }

    /// Positive control for the panic above: unset is still the one skip,
    /// and it returns before any connection is attempted.
    #[tokio::test]
    async fn an_unset_test_database_is_the_only_skip() {
        assert!(test_database_from(None, 1).await.is_none());
    }

    // ---- The DB-test tripwire ----------------------------------------------
    //
    // A textual scan of every Rust file in src/ and tests/, restricted to TEST
    // code: all of each file under tests/, and in src/ each item carrying
    // `#[cfg(test)]`, found by brace matching on the source with its strings,
    // char literals and comments blanked out. Product code is never scanned:
    // the server itself loads its configuration and opens its pool, and may
    // move that code to any file it likes. In test code it flags
    //  - a read of the dev database's variable, or a call into the crate that
    //    loads `.env` (finding #13);
    //  - the wording of the old skip lines (finding #14); and
    //  - any eager connect (`.connect(`, `::connect(`, `connect_with(`) whose
    //    `.await` is not IMMEDIATELY `.expect(..)` or `.unwrap()`. Handing the
    //    error to anything else (`.ok()`, `let Ok(..) = .. else`, a `match`)
    //    is how "configured but unreachable" was turned into a green skip, in
    //    several different spellings. The helper and its tests/ copy are the only
    //    files exempt: they are where that error becomes a panic.
    // Known limits: a variable name built at run time, or a connect wrapped
    // in a product-code function, is invisible to it; a `#[cfg(test)] mod x;`
    // declared out of line is not followed to its file. It is a tripwire, not
    // a proof. The needles are assembled with concat! so this file does not
    // match itself.

    const NEEDLE_DB_VAR: &str = concat!("var(\"", "DATABASE_URL\")");
    const NEEDLE_DOTENV: &str = concat!("dot", "env::");
    /// The old skip lines, lowercased; each printed one and returned.
    const NEEDLES_OLD_SKIP: [&str; 4] = [
        concat!("database", " unreachable"),
        concat!("could not", " connect"),
        concat!("no database", " connection"),
        concat!("skipping: no", " database"),
    ];
    /// Where a connect may hand its error to code: the helper that turns it
    /// into a panic, and the copy of that helper for tests/*.rs.
    const MAY_CONNECT: [&str; 2] = ["src/migrator.rs", "tests/common/mod.rs"];

    /// `src` with every string, char literal and comment replaced by spaces
    /// (newlines kept), so offsets and line numbers still line up with it.
    fn blank_literals_and_comments(src: &str) -> Vec<u8> {
        let b = src.as_bytes();
        let mut out = b.to_vec();
        let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
            for c in &mut out[from..to.min(b.len())] {
                if *c != b'\n' {
                    *c = b' ';
                }
            }
        };
        let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            let next = b.get(i + 1).copied();
            if c == b'/' && next == Some(b'/') {
                let end = b[i..].iter().position(|&x| x == b'\n').map_or(b.len(), |p| i + p);
                blank(&mut out, i, end);
                i = end;
            } else if c == b'/' && next == Some(b'*') {
                let (mut depth, mut j) = (0usize, i);
                while j < b.len() {
                    if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                        depth += 1;
                        j += 2;
                    } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                        depth -= 1;
                        j += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        j += 1;
                    }
                }
                blank(&mut out, i, j);
                i = j;
            } else if (c == b'r' || (c == b'b' && next == Some(b'r'))) && (i == 0 || !is_ident(b[i - 1])) && {
                // A raw string: r"..", r#".."#, br".." (not a raw identifier).
                let mut j = i + if c == b'b' { 2 } else { 1 };
                while b.get(j) == Some(&b'#') {
                    j += 1;
                }
                b.get(j) == Some(&b'"')
            } {
                let open = i + if c == b'b' { 2 } else { 1 };
                let hashes = b[open..].iter().take_while(|&&x| x == b'#').count();
                let body = open + hashes + 1;
                let mut close = vec![b'"'];
                close.extend(vec![b'#'; hashes]);
                let end = b[body..].windows(close.len()).position(|w| w == close.as_slice()).map_or(b.len(), |p| body + p + close.len());
                blank(&mut out, i, end);
                i = end;
            } else if c == b'"' {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                blank(&mut out, i, j + 1);
                i = j + 1;
            } else if c == b'\'' {
                // A char literal ('x', '\n', '\u{7b}', a multi-byte char), or a lifetime ('a).
                if next == Some(b'\\') {
                    // Search from past the escaped char, so '\'' ends at its own quote.
                    let end = b.get(i + 3..).and_then(|r| r.iter().position(|&x| x == b'\'')).map_or(b.len(), |p| i + 3 + p + 1);
                    blank(&mut out, i, end);
                    i = end;
                } else {
                    let len = src[i + 1..].chars().next().map_or(0, char::len_utf8);
                    if len > 0 && b.get(i + 1 + len) == Some(&b'\'') {
                        blank(&mut out, i, i + 2 + len);
                        i += 2 + len;
                    } else {
                        i += 1;
                    }
                }
            } else {
                i += 1;
            }
        }
        out
    }

    fn find_from(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
        hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|p| from + p)
    }

    /// The index just past the bracket that closes the one at `open`.
    fn past_matching(masked: &[u8], open: usize, (o, c): (u8, u8)) -> usize {
        let mut depth = 0usize;
        for (k, &x) in masked.iter().enumerate().skip(open) {
            if x == o {
                depth += 1;
            } else if x == c {
                depth -= 1;
                if depth == 0 {
                    return k + 1;
                }
            }
        }
        masked.len()
    }

    /// Byte ranges of test code: each item carrying `#[cfg(test)]`, up to the
    /// `;` that ends it or the brace that closes its body.
    fn cfg_test_items(masked: &[u8]) -> Vec<(usize, usize)> {
        let attr = b"#[cfg(test)]";
        let mut items = Vec::new();
        let mut from = 0;
        while let Some(start) = find_from(masked, attr, from) {
            let mut end = masked.len();
            let mut depth = 0i32; // ( and [: a `;` in `[u8; 4]` does not end the item
            for (j, &x) in masked.iter().enumerate().skip(start + attr.len()) {
                match x {
                    b'(' | b'[' => depth += 1,
                    b')' | b']' => depth -= 1,
                    b';' if depth == 0 => {
                        end = j + 1;
                        break;
                    }
                    b'{' => {
                        end = past_matching(masked, j, (b'{', b'}'));
                        break;
                    }
                    _ => {}
                }
            }
            items.push((start, end));
            from = end;
        }
        items
    }

    #[derive(Default)]
    struct TripwireScan {
        /// (1-based line, what) for each violation.
        violations: Vec<(usize, String)>,
        /// 1-based lines of every connect seen in test code, allowed or not.
        connects: Vec<usize>,
        /// How many test regions the file has.
        regions: usize,
    }

    fn scan_for_db_test_violations(text: &str, whole_file_is_test: bool, may_connect: bool) -> TripwireScan {
        let masked = blank_literals_and_comments(text);
        let regions = if whole_file_is_test { vec![(0, masked.len())] } else { cfg_test_items(&masked) };
        let in_test = |from: usize, to: usize| regions.iter().any(|&(s, e)| s < to.max(from + 1) && from < e);
        let line_of = |at: usize| masked[..at].iter().filter(|&&x| x == b'\n').count() + 1;
        let mut scan = TripwireScan { regions: regions.len(), ..Default::default() };

        let mut at = 0;
        for (n, line) in text.split('\n').enumerate() {
            let (from, to) = (at, at + line.len());
            at = to + 1;
            if !in_test(from, to) {
                continue;
            }
            let lower = line.to_lowercase();
            for needle in [NEEDLE_DB_VAR, NEEDLE_DOTENV] {
                if line.contains(needle) {
                    scan.violations.push((n + 1, needle.to_string()));
                }
            }
            for needle in NEEDLES_OLD_SKIP {
                if lower.contains(needle) {
                    scan.violations.push((n + 1, format!("the old skip line \"{needle}\"")));
                }
            }
        }

        for name in [&b"connect("[..], b"connect_with("] {
            let mut from = 0;
            while let Some(p) = find_from(&masked, name, from) {
                from = p + 1;
                if p == 0 || !matches!(masked[p - 1], b'.' | b':') || !in_test(p, p + 1) {
                    continue;
                }
                scan.connects.push(line_of(p));
                let skip_ws = |k: usize| k + masked[k..].iter().take_while(|x| x.is_ascii_whitespace()).count();
                let after_call = skip_ws(past_matching(&masked, p + name.len() - 1, (b'(', b')')));
                let panics_on_error = masked[after_call..].starts_with(b".await") && {
                    let r = skip_ws(after_call + b".await".len());
                    masked[r..].starts_with(b".expect(") || masked[r..].starts_with(b".unwrap()")
                };
                if !panics_on_error && !may_connect {
                    scan.violations.push((
                        line_of(p),
                        "a connect whose error is not .expect()ed or .unwrap()ped on the spot".to_string(),
                    ));
                }
            }
        }
        scan.violations.sort();
        scan
    }

    /// The scanner against a sample whose expected hits are marked `// <-`:
    /// test code is flagged, product code around it is not, a brace inside a
    /// string, a char literal or a comment does not end a test item early,
    /// and a connect that panics on its error passes.
    #[test]
    fn the_db_test_tripwire_flags_test_code_and_only_test_code() {
        let sample = r##"
pub fn config() -> String {
    @DOTENV@dotenv().ok();
    let url = std::env::@VAR@.unwrap();
    let _pool = PgPoolOptions::new().connect(&url).await?;
    url
}

#[cfg(test)]
fn helper() -> [u8; 2] { let _brace = "}"; let _c = '{'; [0; 2] }

#[cfg(test)]
mod tests {
    // a closing brace in a comment: }
    fn a() { let _ = std::env::@VAR@; } // <-
    fn b() { @DOTENV@dotenv().ok(); } // <-
    async fn c(url: &str) -> Option<PgPool> { PgPoolOptions::new().max_connections(2).connect(url).await.ok() } // <-
    async fn d(url: &str) -> Option<PgPool> {
        let Ok(pool) = PgPoolOptions::new()
            .connect(url) // <-
            .await
        else {
            println!("@SKIP1@"); // <-
            return None;
        };
        Some(pool)
    }
    async fn e(url: &str) { match PgConnection::connect(url).await { Ok(_) => {} Err(_) => println!("@SKIP2@") } } // <-
    async fn f(url: &str) { let _ = PgPoolOptions::new().connect_with(opts(url)).await.ok(); } // <-
    async fn fine(url: &str) {
        let _ = PgPoolOptions::new().connect(url).await.expect("x");
        let _ = PgListener::connect(url)
            .await
            .unwrap();
        let _ = PgPoolOptions::new().connect_lazy(url).unwrap();
        let _ = "a test may mention the connect( method in a string";
    }
}

pub fn after_the_tests() -> Option<String> { let _ = @DOTENV@dotenv(); std::env::@VAR@.ok() }
"##
        .replace("@VAR@", NEEDLE_DB_VAR)
        .replace("@DOTENV@", NEEDLE_DOTENV)
        .replace("@SKIP1@", concat!("Skipping: Could Not", " Connect"))
        .replace("@SKIP2@", &format!("skipping: {}", NEEDLES_OLD_SKIP[0]));
        let marked: Vec<usize> =
            sample.lines().enumerate().filter(|(_, l)| l.trim_end().ends_with("// <-")).map(|(n, _)| n + 1).collect();
        let scan = scan_for_db_test_violations(&sample, false, false);
        let mut flagged: Vec<usize> = scan.violations.iter().map(|(n, _)| *n).collect();
        flagged.dedup();
        assert_eq!(scan.regions, 2, "the helper fn and the tests module");
        assert_eq!(marked.len(), 7, "positive control: the sample's markers");
        assert_eq!(flagged, marked, "violations: {:?}", scan.violations);
        assert_eq!(scan.connects.len(), 6, "every connect in test code is seen, the lazy one is not: {:?}", scan.connects);
        let exempt = scan_for_db_test_violations(&sample, false, true);
        assert_eq!(exempt.violations.len(), 4, "the helper's files may connect, nothing else is excused: {:?}", exempt.violations);
    }

    /// The tripwire over the real tree. No test may read the dev database's
    /// variable, load `.env`, print an old skip line, or connect without
    /// panicking on the error — see the tripwire notes above.
    #[test]
    fn no_test_reads_database_url_loads_dotenv_or_swallows_a_connect_error() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        let mut dirs = vec![root.join("src"), root.join("tests")];
        while let Some(dir) = dirs.pop() {
            for e in std::fs::read_dir(&dir).expect("readable source dir").flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    files.push(p);
                }
            }
        }
        assert!(files.len() > 40, "positive control: the walk found the sources ({})", files.len());
        let mut hits = Vec::new();
        let mut scans = std::collections::HashMap::new();
        for f in &files {
            let label = f
                .strip_prefix(root)
                .unwrap_or(f)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let text = String::from_utf8_lossy(&std::fs::read(f).expect("readable")).into_owned();
            let scan = scan_for_db_test_violations(&text, label.starts_with("tests/"), MAY_CONNECT.contains(&label.as_str()));
            hits.extend(scan.violations.iter().map(|(n, what)| format!("{label}:{n}: {what}")));
            scans.insert(label, (scan, text));
        }
        // Positive controls on real code. main.rs reads the variable, loads
        // `.env` and connects, all in PRODUCT code: none of it may be seen,
        // while its own test modules are.
        let (main, main_text) = &scans["src/main.rs"];
        assert!(main_text.contains(NEEDLE_DB_VAR) && main_text.contains(NEEDLE_DOTENV), "main.rs still loads its configuration");
        assert!(main.regions >= 1 && main.connects.is_empty(), "main.rs: test modules found, its product connect not scanned");
        assert!(scans["src/migrator.rs"].0.connects.len() >= 3, "the helper's connects are seen");
        assert!(scans["tests/common/mod.rs"].0.connects.len() >= 2, "the tests/ helper's connects are seen");
        let regions: usize = scans.iter().filter(|(l, _)| l.starts_with("src/")).map(|(_, (s, _))| s.regions).sum();
        assert!(regions > 40, "positive control: cfg(test) items found in src/ ({regions})");
        assert!(
            hits.is_empty(),
            "DB-backed tests must get their database from migrator::test_pool (tests/common for tests/*.rs), \
             which reads TEST_DATABASE_URL only and panics when it is set but unreachable. \
             A connect in test code that is not a database must still .expect() its error:\n{}",
            hits.join("\n")
        );
    }

    /// Against a real database: a version this binary does not embed is
    /// recorded as applied (what a NEWER release leaves behind), and the
    /// startup migrator still runs to completion — while the sqlx default
    /// refuses, which is the positive control proving the fixture is the
    /// situation a rollback meets. Uses a database of its own, created and
    /// dropped here, because a foreign version in a shared test database
    /// would make every OTHER test's default migrator refuse. Skips (prints)
    /// without TEST_DATABASE_URL — never DATABASE_URL (test_database_url).
    #[tokio::test]
    async fn a_database_migrated_by_a_newer_release_still_boots_this_one() {
        let Some(url) = test_database_url() else {
            println!("skipping: TEST_DATABASE_URL not set");
            return;
        };
        // Not test_pool: this needs an admin connection only, and must not
        // depend on the shared database's own migration state.
        let admin = connect_test_database(&url, 1).await;
        let name = format!("puca_migtest_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&admin).await.expect("create scratch database");
        // Same server, the scratch database: swap the path of the URL.
        let base = url.rsplit_once('/').map(|(b, _)| b).expect("a database URL has a path");
        let scratch_url = format!("{base}/{name}");
        let result = async {
            let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect(&scratch_url).await.expect("connect scratch");
            app_migrator().run(&pool).await.expect("a fresh database migrates");
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
                 VALUES (999999, 'from a newer release', TRUE, '\\x00'::bytea, 0)",
            )
            .execute(&pool)
            .await
            .expect("record a foreign version");

            let default = sqlx::migrate!("./migrations").run(&pool).await;
            let tolerant = app_migrator().run(&pool).await;
            pool.close().await;
            (default, tolerant)
        }
        .await;
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&admin).await;

        let (default, tolerant) = result;
        assert!(
            matches!(default, Err(sqlx::migrate::MigrateError::VersionMissing(999999))),
            "positive control: sqlx's default refuses a database with a version it does not embed, got {default:?}"
        );
        assert!(tolerant.is_ok(), "the startup migrator must boot over it, got {tolerant:?}");
    }
}
