//! Puca's always-on LAN waker.
//!
//! WHY THIS EXISTS. A machine that is fully powered off cannot be woken by
//! anything running on it, and a Wake-on-LAN magic packet is a subnet broadcast
//! — so something already awake, on the target's own wire, has to emit it. The
//! owner's phone qualifies only while it is at home, which is precisely when the
//! power button is within reach. This binary is that something: a headless
//! Puca DEVICE on the LAN whose entire job is to answer one message.
//!
//! WHAT IT IS NOT. It is not a second client. It holds no account seed,
//! decrypts nothing, and takes part in no E2EE. It cannot read a message, start
//! a session, or see a screen. Compromising it yields a user token and the
//! ability to broadcast on one LAN — bad, but bounded, and deliberately so for a
//! process that runs unattended on a box the owner rarely looks at.
//!
//!   puca-waker init [ip]        mint an identity, WRITE the config, print the public keys
//!   puca-waker pair <uid> <tok> finish pairing: set the account and store the token
//!   puca-waker run [cfg]        hold the socket (what systemd runs)

mod config;
mod identity;
mod net;
mod wol;

use std::path::PathBuf;
use std::time::Duration;

/// How often to ask for a renewed token.
///
/// The server only renews inside the last 12 hours of a 24-hour token, so four
/// hours guarantees at least two attempts land inside that window. Cheap: one
/// small GET.
const REFRESH_EVERY: Duration = Duration::from_secs(4 * 3_600);

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_default();
    let arg = args.next();

    let code = match mode.as_str() {
        "init" => init(arg.as_deref()),
        "pair" => pair(arg.as_deref(), args.next().as_deref()),
        "run" => run(arg.map(PathBuf::from)),
        _ => {
            eprintln!("usage: puca-waker <init [lan-ip] | pair <user-id> <token> | run [config.json]>");
            2
        }
    };
    std::process::exit(code);
}

/// Mint an identity and print a config the pairing step completes.
///
/// Prints rather than writes: the operator sees exactly what is about to hold a
/// credential, and the secret does not reach disk until they put it there.
fn init(ip: Option<&str>) -> i32 {
    let id = match identity::Identity::generate() {
        Ok(i) => i,
        Err(e) => {
            eprintln!("puca-waker: {e}");
            return 1;
        }
    };
    let lan: std::net::Ipv4Addr = match ip.unwrap_or("192.168.0.30").parse() {
        Ok(v) => v,
        Err(_) => {
            eprintln!("puca-waker: '{}' is not an IPv4 address", ip.unwrap_or(""));
            return 2;
        }
    };

    eprintln!("Give these three PUBLIC values to the Puca desktop app to pair:\n");
    println!("device_id  {}", id.device_id);
    println!("device_pub {}", id.device_pub);
    println!("sign_pub   {}", id.sign_pub);
    eprintln!("\nThen write this to {} (chmod 600), filling in user_id:\n", config::DEFAULT_CONFIG);

    let template = serde_json::json!({
        "api_base": "https://chat.example.com",
        "user_id": 0,
        "device_id": id.device_id,
        "device_pub": id.device_pub,
        "sign_pub": id.sign_pub,
        "sign_seed": identity::b64(&id.sign_seed),
        "bind_ip": lan,
        "broadcast": net::guess_broadcast(lan),
    });
    // WRITTEN, not printed. The template carries the Ed25519 seed, and asking
    // someone to copy that between machines puts the one secret this design
    // keeps local into a clipboard, a terminal scrollback and quite possibly a
    // chat window. It also removes the hand-editing step entirely: the only
    // thing left after this is two values the app hands back, and `pair` sets
    // those.
    let path = std::path::Path::new(config::DEFAULT_CONFIG);
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("puca-waker: cannot create {}: {e}", dir.display());
            return 1;
        }
    }
    if path.exists() {
        eprintln!(
            "puca-waker: {} already exists. Refusing to overwrite it — a new identity 
             would abandon the device already enrolled on the account. Delete it first if that 
             is really what you want.",
            path.display()
        );
        return 1;
    }
    let body = serde_json::to_string_pretty(&template).unwrap_or_default();
    if let Err(e) = std::fs::write(path, &body) {
        eprintln!("puca-waker: cannot write {}: {e}", path.display());
        return 1;
    }
    if let Err(e) = harden(path) {
        eprintln!("puca-waker: {e}");
        return 1;
    }

    eprintln!("Wrote {} (0600). The signing seed stays in that file and", config::DEFAULT_CONFIG);
    eprintln!("never needs to leave this machine.
");
    eprintln!("Paste these three PUBLIC values into Puca on your desktop:
");
    println!("device_id  {}", id.device_id);
    println!("device_pub {}", id.device_pub);
    println!("sign_pub   {}", id.sign_pub);
    0
}

/// Finish pairing: record which account this waker serves, and store its token.
///
/// Exists so the last step is ONE command instead of hand-editing JSON on a
/// second machine using output that may no longer be on screen. The token is
/// taken as an argument rather than read from stdin because the caller is
/// pasting it from a UI, and an interactive prompt over ssh is worse.
fn pair(user_id: Option<&str>, token: Option<&str>) -> i32 {
    let (uid, token) = match (user_id, token) {
        (Some(u), Some(t)) => (u, t.trim()),
        _ => {
            eprintln!("usage: puca-waker pair <user-id> <token>");
            return 2;
        }
    };
    let uid: i64 = match uid.parse() {
        Ok(v) if v > 0 => v,
        _ => {
            eprintln!("puca-waker: '{uid}' is not a user id");
            return 2;
        }
    };
    // A JWT has three dot-separated parts. Checking here turns "pasted the
    // wrong thing" into an immediate error instead of a socket that dials, is
    // refused, and reports as "the waker never comes online".
    if token.split('.').count() != 3 || token.len() < 40 {
        eprintln!("puca-waker: that does not look like a token (expected three dot-separated parts)");
        return 2;
    }

    let path = std::path::Path::new(config::DEFAULT_CONFIG);
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("puca-waker: cannot read {} ({e}). Run `init` first.", path.display());
            return 1;
        }
    };
    let mut cfg: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("puca-waker: {} is not valid JSON: {e}", path.display());
            return 1;
        }
    };
    cfg["user_id"] = serde_json::json!(uid);
    if let Err(e) = std::fs::write(path, serde_json::to_string_pretty(&cfg).unwrap_or_default()) {
        eprintln!("puca-waker: cannot write {}: {e}", path.display());
        return 1;
    }
    let _ = harden(path);

    let tok_path = std::path::Path::new(config::DEFAULT_TOKEN);
    if let Some(dir) = tok_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = config::write_token(tok_path, token) {
        eprintln!("puca-waker: {e}");
        return 1;
    }
    // This command runs as root (pct exec); the service runs unprivileged.
    // Ownership is fixed HERE, outside the sandbox, and deliberately not
    // inside write_token — the service's own renewals also call write_token,
    // and its seccomp filter turns a chown into SIGSYS, not EPERM.
    let _ = config::fix_owner_for_service(tok_path);

    // Validate what was just assembled rather than declaring success on two
    // successful writes: the point of this command is that the next thing the
    // operator does is `systemctl start`, and a config that fails there reports
    // as a crash-looping unit rather than as a bad pairing.
    match config::Config::load(path) {
        Ok(_) => {
            println!("paired to account {uid}; token stored.");
            println!("now: systemctl enable --now puca-waker");
            0
        }
        Err(e) => {
            eprintln!("puca-waker: written, but the config is still not valid: {e}");
            1
        }
    }
}

/// 0600, and owned by whoever will run the service.
///
/// The ownership half is not cosmetic: `init` and `pair` are run by a human,
/// which on a Proxmox container means root, while the service runs unprivileged.
/// A root-owned config inside the service's 0700 directory makes the unit start,
/// report `active`, and fail for ever on Permission denied.
fn harden(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
        // Ownership via the shared helper, which skips the chown syscall when
        // there is nothing to fix. harden() is only called from the root-run
        // CLI paths (init/pair) today — but the previous inline version
        // carried the "unprivileged chown is a harmless error" belief, which
        // is FALSE under the service's seccomp filter (SIGSYS kill, the
        // 2026-08-17 outage). If this ever gets called from the service path,
        // the skip is what keeps it from being a landmine.
        config::fix_owner_for_service(path)?;
    }
    let _ = path;
    Ok(())
}

fn run(cfg_path: Option<PathBuf>) -> i32 {
    let path = cfg_path.unwrap_or_else(|| PathBuf::from(config::DEFAULT_CONFIG));
    let cfg = match config::Config::load(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("puca-waker: {e}");
            return 1;
        }
    };
    eprintln!("[waker] {} on {} (broadcast {})", cfg.device_id, cfg.bind_ip, cfg.broadcast);

    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("puca-waker: cannot start the runtime: {e}");
            return 1;
        }
    };

    rt.block_on(async move {
        let mut failures: u32 = 0;

        // THE REFRESH RUNS ON ITS OWN CLOCK, CONCURRENTLY WITH THE SOCKET.
        //
        // It used to live at the top of the reconnect loop below — which never
        // runs while a socket is UP, because `run_socket` does not return until
        // the connection dies. So the healthier the link, the more certainly
        // the token expired: measured on the live box, one socket stayed up for
        // 39 hours, the four-hour timer never ticked once, and the 24-hour
        // token lapsed underneath it. The waker went on looking perfectly
        // healthy — `systemctl status` said active, the process had logged
        // nothing since it connected — until the next reconnect, at which point
        // it could not authenticate at all and needed pairing again by hand.
        //
        // A separate task cannot be starved by the socket, and the two
        // communicate the way they already did: through the token FILE, which
        // the reconnect loop re-reads on every dial.
        let refresh_cfg = cfg.clone();
        // The handle is KEPT, and the task's death is FATAL to the process.
        //
        // This loop never returns by design, so it can only end by panicking —
        // and a fire-and-forget spawn turns that panic into the worst failure
        // shape this service has: a process that stays up, reports `active`,
        // holds its socket, answers wakes — and never refreshes again, so it
        // dies quietly when the token expires within 24 hours. That is the
        // 39-hour-socket bug's silhouette returning through a different door.
        // Exiting instead hands the problem to systemd (`Restart=always`),
        // which resurrects the whole process WITH a fresh refresh task, and
        // makes the panic visible in the journal instead of deferred a day.
        let refresh_task = tokio::spawn(async move {
            loop {
                match config::read_token(&refresh_cfg.token_path) {
                    Ok(tok) => match net::refresh(&refresh_cfg, &tok).await {
                        Ok(Some(fresh)) => {
                            if let Err(e) = config::write_token(&refresh_cfg.token_path, &fresh) {
                                eprintln!("[waker] could not persist the renewed token: {e}");
                            } else {
                                eprintln!("[waker] adopted a renewed token");
                            }
                        }
                        Ok(None) => {}
                        // NOT fatal, and deliberately so: the overwhelmingly
                        // common cause is the API being briefly unreachable,
                        // and a waker that exits on that is a waker that is
                        // gone by morning. A genuinely dead credential shows up
                        // as a refused dial in the loop below.
                        Err(e) => eprintln!("[waker] refresh failed: {e}"),
                    },
                    Err(e) => eprintln!("[waker] {e}"),
                }
                tokio::time::sleep(REFRESH_EVERY).await;
            }
        });
        // Polled via select! below. Boxed once so the reconnect loop can keep
        // selecting against it without moving it.
        tokio::pin!(refresh_task);

        loop {
            let token = match config::read_token(&cfg.token_path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[waker] {e}");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    continue;
                }
            };

            if net::should_redial_for_expiry(config::seconds_until_expiry(&token, now_unix())) {
                // Nothing to do here but say so: the refresher task is the only
                // thing that can produce a newer one, and it runs on its own
                // clock. Dialling anyway is correct — the server is the judge.
                eprintln!("[waker] the stored token is near or past expiry");
            }

            let dialled = std::time::Instant::now();
            let outcome = tokio::select! {
                r = net::run_socket(&cfg, &token) => r,
                // The refresh task finishing AT ALL means it panicked (its
                // loop has no exit). See the comment at the spawn.
                _ = &mut refresh_task => {
                    eprintln!("[waker] FATAL: the token-refresh task died; exiting so systemd restarts the whole process");
                    std::process::exit(1);
                }
            };
            // HOW LONG IT LIVED decides the pacing, not HOW it ended.
            //
            // The old rule — clean close resets the counter, error increments —
            // was wrong in both directions. A server that accepts the upgrade
            // and immediately closes CLEANLY (a misconfigured proxy, a reject
            // path that says goodbye politely) reset the counter every lap:
            // zero backoff, a full TLS dial per round trip, for ever. And a
            // socket that stayed up for hours and then died with an ERROR
            // incremented the counter every lap, ratcheting a healthy link
            // toward the 60s ceiling as if it were flapping. A connection that
            // LIVED is the thing worth resetting on; anything short-lived is a
            // failure whatever the close frame said.
            match &outcome {
                Ok(()) => eprintln!("[waker] socket closed; reconnecting"),
                Err(e) => eprintln!("[waker] {e}"),
            }
            failures = net::next_failure_count(failures, dialled.elapsed());
            let wait = net::backoff_secs(failures);
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
        }
    })
}

#[cfg(test)]
mod run_loop_tests {
    /// The token refresh must not live inside the reconnect loop.
    ///
    /// MEASURED FAILURE, not a hypothetical. It used to sit at the top of that
    /// loop, and the loop does not come round while a socket is UP —
    /// `run_socket` returns only when the connection dies. On the live box one
    /// socket stayed up for 39 hours, so the four-hour timer never ticked, the
    /// 24-hour token expired underneath it, and the waker could not
    /// authenticate at its next dial. It needed re-pairing by hand, and until
    /// someone did that the Wake button had nothing on the LAN able to send a
    /// magic packet. The better the connection, the more certain the failure.
    ///
    /// Scanned from the NON-TEST source: `include_str!` pulls in this module
    /// too, so a scan of the whole file would find these very sentences and
    /// pass whatever the real code did.
    #[test]
    fn the_refresh_runs_concurrently_with_the_socket_not_between_reconnects() {
        let src = include_str!("main.rs").split("#[cfg(test)]").next().unwrap();

        let spawn_at = src.find("tokio::spawn(").expect("the refresher must be its own task");
        let loop_at = src.rfind("loop {").expect("the reconnect loop");
        let socket_at = src.find("net::run_socket(").expect("the socket call");

        // The refresher is spawned BEFORE the reconnect loop begins...
        assert!(spawn_at < loop_at, "the refresher must start before the reconnect loop");
        // ...and `net::refresh` is reached from inside that spawned task, not
        // from the loop that blocks on the socket.
        let spawned = &src[spawn_at..loop_at];
        assert!(
            spawned.contains("net::refresh("),
            "the refresh belongs in the spawned task: {spawned}"
        );
        let after_loop = &src[loop_at..];
        assert!(
            !after_loop.contains("net::refresh("),
            "the reconnect loop must NOT be what drives the refresh — it cannot run while \
             run_socket is awaiting a live connection"
        );
        assert!(after_loop.contains("net::run_socket("), "sanity: the loop still dials");
        assert!(socket_at > spawn_at, "sanity: the socket is dialled after the spawn");
    }
}
