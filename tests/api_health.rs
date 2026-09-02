//! The health contract between the server's root route and the deploy tooling.
//!
//! WHAT WAS HERE BEFORE, AND WHY IT WAS DELETED. This file used to build its own
//! four-line axum Router, hand it the string it was about to assert, and then
//! assert it. Four green tests that exercised axum's routing and nothing this
//! project wrote — the application could have had its root route deleted
//! entirely and every one of them would still have passed.
//!
//! It was also actively misleading. It declared and tested a `/health`
//! endpoint. The real server has no such route: health is `GET /` returning
//! 200, which is what the deploy runbook says and what the ship script checks.
//! Anyone reading these tests would have pointed a monitor at `/health` and
//! collected 404s from a perfectly healthy box.
//!
//! The root package is a binary with no lib target, so an integration test
//! cannot call the real handler — which is exactly why the original
//! reimplemented it. What CAN be checked without one is the thing that actually
//! breaks in production: the server's root route and the ship script's health
//! grep are two halves of one contract, written in two different languages, in
//! two files nobody edits together. If they drift, `dual-ship.sh` reports every
//! host unhealthy and refuses to release, or worse, silently stops proving
//! anything.
//!
//! These tests read both real files and compare them to each other. Neither
//! literal is written in this file, so it cannot pass by agreeing with itself.

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is the package root, which is the repo root here.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(rel: &str) -> String {
    let p: PathBuf = repo_root().join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()))
}

/// The body the root route answers with, taken from the server source.
fn root_route_body() -> String {
    let src = read("src/main.rs");
    let marker = r#".route("/", get(|| async { ""#;
    let start = src
        .find(marker)
        .expect("no `.route(\"/\", get(...))` in src/main.rs — the root route moved");
    let rest = &src[start + marker.len()..];
    let end = rest.find('"').expect("unterminated root route literal");
    rest[..end].to_string()
}

/// The pattern `dual-ship.sh` greps the root response for.
fn ship_health_pattern() -> String {
    let sh = read("deploy/ops/dual-ship.sh");
    let line = sh
        .lines()
        .find(|l| l.contains("$health") && l.contains("grep -q"))
        .expect("dual-ship.sh no longer greps the health response");
    let start = line.find("grep -q \"").expect("unexpected grep form") + "grep -q \"".len();
    let rest = &line[start..];
    let end = rest.find('"').expect("unterminated grep pattern");
    rest[..end].to_string()
}

#[test]
fn ship_health_check_matches_what_the_root_route_answers() {
    let body = root_route_body();
    let pattern = ship_health_pattern();
    assert!(
        body.contains(&pattern),
        "dual-ship.sh greps for {pattern:?} but the root route answers {body:?}.\n\
         Every host would be reported unhealthy and the release would be refused."
    );
}

/// Positive control. The assertion above is a `contains`, which would also hold
/// if either extractor silently returned something useless like an empty string.
/// This proves both halves actually found real, non-trivial text.
#[test]
fn both_halves_of_the_contract_were_actually_found() {
    let body = root_route_body();
    let pattern = ship_health_pattern();
    assert!(body.len() > 5, "root route body looks empty: {body:?}");
    assert!(pattern.len() > 5, "health grep pattern looks empty: {pattern:?}");
    assert!(
        !body.contains("\\n") && !pattern.contains('$'),
        "extractor picked up shell/source syntax rather than a literal: {body:?} / {pattern:?}"
    );
}

/// The runbook states health is `GET /`; there is deliberately no `/health`.
/// A test that claimed otherwise is what made this file worth rewriting, so the
/// absence is now asserted rather than assumed.
#[test]
fn there_is_no_health_route() {
    let src = read("src/main.rs");
    assert!(
        !src.contains(r#".route("/health""#),
        "a /health route now exists. That is fine, but the deploy docs and \
         deploy/ops/healthcheck.sh both say health is `GET /` — update them together."
    );
}

/// The healthcheck cron probes the port over loopback. If that port ever moves,
/// the probe silently checks nothing that is listening.
#[test]
fn healthcheck_probes_the_port_the_server_binds() {
    // The probe URL used to be the literal `127.0.0.1:3000` inside
    // healthcheck.sh, and this test asserted that literal. It is now derived
    // per host in names.sh from the deployment's own `.env`, which is
    // strictly better — a host that runs on another PORT is probed on that
    // port instead of being declared unhealthy — so the contract to hold is
    // the derivation, not the constant.
    let hc = read("deploy/ops/healthcheck.sh");
    assert!(
        hc.contains("\"$HEALTH_URL\""),
        "healthcheck.sh no longer probes $HEALTH_URL; if the probe moved, this contract moved with it"
    );

    let names = read("deploy/ops/names.sh");
    assert!(
        names.contains("HEALTH_URL=") && names.contains("'^PORT='"),
        "names.sh no longer derives HEALTH_URL from the PORT in the deployment .env"
    );
    assert!(
        names.contains("_ops_port=3000"),
        "names.sh no longer falls back to 3000 when the .env has no PORT"
    );

    let provision = read("deploy/migrate/provision.sh");
    assert!(
        provision.contains("PORT=3000"),
        "provision.sh writes a PORT that names.sh would not fall back to"
    );
}

/// The probe must not quietly go back to a hard-coded API port: a host
/// provisioned on another PORT would then be restarted in a loop over a
/// probe that was never pointed at it. (The livekit and coturn probes in
/// that file are other services and keep their own defaults.)
#[test]
fn the_api_probe_is_not_hard_coded_to_a_port() {
    let hc = read("deploy/ops/healthcheck.sh");
    for line in hc.lines() {
        let l = line.trim_start();
        if l.starts_with('#') {
            continue;
        }
        assert!(
            !(l.contains("curl") && l.contains("127.0.0.1:")),
            "healthcheck.sh curls a hard-coded address: {l}"
        );
    }
}

#[test]
fn the_files_this_contract_spans_all_exist() {
    for f in [
        "src/main.rs",
        "deploy/ops/dual-ship.sh",
        "deploy/ops/healthcheck.sh",
        "deploy/migrate/provision.sh",
    ] {
        assert!(
            Path::new(&repo_root().join(f)).exists(),
            "{f} is missing; this contract test can no longer check anything"
        );
    }
}
