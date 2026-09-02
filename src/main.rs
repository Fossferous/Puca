use axum::body::Body;
use axum::response::Response;
use axum::{
    http::{header, Method},
    middleware as axum_middleware,
    routing::{delete, get, patch, post},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use std::net::{IpAddr, SocketAddr};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod category_handlers;
mod channel_handlers;
mod clip_handlers;
mod device_handlers;
mod device_token;
mod dm_handlers;
mod email;
mod email_handlers;
mod envelope_version;
mod friend_handlers;
mod handlers;
mod invite_handlers;
mod logtag;
mod source_offer;
mod key_handlers;
mod message_handlers;
mod middleware;
mod models;
mod moderation_handlers;
mod permissions;
mod protocol;
mod public_config;
mod push_handlers;
mod reaction_handlers;
mod recovery_handlers;
mod retention;
mod role_handlers;
mod server_handlers;
mod sfu;
mod signaling;
mod state;
mod task_handlers;
mod update_routes;
mod upload_handlers;
mod wake;
mod ws;

use email::{EmailConfig, EmailService};
use state::AppState;

/// Keep a `RUST_LOG` written against an older crate name working.
///
/// The crate name IS the tracing target, so renaming the package silently
/// invalidates any existing filter: `RUST_LOG=sovereign=info,tower_http=warn`
/// still parses, still applies, and simply matches nothing this binary emits.
/// The service starts, serves traffic, and goes quiet — a failure nobody
/// notices until the logs are the thing they need.
///
/// A deployment older than the rename has exactly that in its `.env`. Rather
/// than depend on someone remembering to edit it on every host during the one
/// release where it matters, mirror any legacy directive onto the current
/// crate name. An explicit directive for the current name always wins, so this
/// can only ever add output, never suppress it.
fn normalize_log_filter(raw: &str) -> String {
    const LEGACY_TARGETS: [&str; 1] = ["sovereign"];
    let current = env!("CARGO_PKG_NAME");

    let directive_target = |d: &str| -> String {
        d.trim()
            .split('=')
            .next()
            .unwrap_or("")
            .trim()
            .replace('-', "_")
    };

    // If the operator already said something about the current target, respect
    // it verbatim and do nothing.
    if raw
        .split(',')
        .any(|d| directive_target(d) == current.replace('-', "_"))
    {
        return raw.to_string();
    }

    let mut out: Vec<String> = raw.split(',').map(|d| d.trim().to_string()).collect();
    let mut added = Vec::new();
    for d in raw.split(',') {
        let target = directive_target(d);
        if LEGACY_TARGETS.contains(&target.as_str()) {
            // Carry the level across; a bare target means "trace" to EnvFilter.
            added.push(match d.trim().split_once('=') {
                Some((_, level)) => format!("{}={}", current, level.trim()),
                None => current.to_string(),
            });
        }
    }
    if added.is_empty() {
        return raw.to_string();
    }
    out.extend(added);
    out.retain(|d| !d.is_empty());
    out.join(",")
}

#[cfg(test)]
mod log_filter_tests {
    use super::normalize_log_filter;

    fn current() -> String {
        env!("CARGO_PKG_NAME").to_string()
    }

    #[test]
    fn legacy_target_is_mirrored_onto_the_current_crate_name() {
        let got = normalize_log_filter("sovereign=info,tower_http=warn");
        assert!(
            got.contains(&format!("{}=info", current())),
            "legacy directive was not mirrored: {got}"
        );
        // The original must survive: other crates may still use that target.
        assert!(got.contains("sovereign=info"), "{got}");
        assert!(got.contains("tower_http=warn"), "{got}");
    }

    #[test]
    fn bare_legacy_target_is_mirrored_without_a_level() {
        let got = normalize_log_filter("sovereign");
        assert!(got.split(',').any(|d| d == current()), "{got}");
    }

    #[test]
    fn an_explicit_current_directive_is_left_alone() {
        let raw = format!("{}=warn,sovereign=trace", current());
        assert_eq!(normalize_log_filter(&raw), raw);
    }

    #[test]
    fn unrelated_filters_pass_through_untouched() {
        for raw in ["info", "tower_http=warn", "sqlx=error,hyper=off"] {
            assert_eq!(normalize_log_filter(raw), raw, "mangled {raw}");
        }
    }

    /// Positive control: proves the test above can actually observe a failure,
    /// rather than passing because nothing is ever mirrored.
    #[test]
    fn the_mirror_is_observable() {
        let before = normalize_log_filter("tower_http=warn");
        let after = normalize_log_filter("sovereign=info,tower_http=warn");
        assert!(
            !before.contains(&format!("{}=", current())),
            "a filter with no legacy target must not gain one: {before}"
        );
        assert!(
            after.contains(&format!("{}=", current())),
            "a filter WITH a legacy target must gain one: {after}"
        );
    }
}

/// A JWT secret that must not protect an exposed server: too short, a
/// placeholder in any of the words the docs and examples have ever used
/// (so the guard no longer depends on which wording a copied line carried),
/// or so repetitive it cannot be random.
fn jwt_secret_is_weak(secret: &str) -> bool {
    let lower = secret.to_lowercase();
    let placeholder = ["change", "generate", "placeholder", "example", "here", "for-local", "secret_key"]
        .iter()
        .any(|w| lower.contains(w));
    let distinct = {
        let mut seen = std::collections::HashSet::new();
        secret.chars().filter(|c| seen.insert(*c)).count()
    };
    secret.len() < 32 || placeholder || distinct < 16
}

#[cfg(test)]
mod jwt_secret_tests {
    use super::jwt_secret_is_weak;

    #[test]
    fn placeholders_and_low_entropy_are_weak_and_a_real_secret_is_not() {
        assert!(jwt_secret_is_weak("sovereign_default_secret_change_me"));
        assert!(jwt_secret_is_weak("GENERATE_A_LONG_RANDOM_STRING_HERE_PLEASE_OK"), "the retired deployment doc's line");
        assert!(jwt_secret_is_weak("any-long-random-string-for-local-testing-use"), "the local testing doc's line");
        assert!(jwt_secret_is_weak("puca_super_secret_key_change_in_production"), "the harness secret");
        assert!(jwt_secret_is_weak("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "44 chars of one letter");
        assert!(jwt_secret_is_weak("0123456789abcdef0123456789abcde"), "31 chars");
        assert!(!jwt_secret_is_weak("3f9a1c7e5b2d8046a9e1f3c5d7b9a0e2c4f6a8b0d2e4f6a8c0b2d4e6f8a0c2e4"), "openssl rand -hex 32");
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv::dotenv().ok();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(normalize_log_filter(
            &std::env::var("RUST_LOG")
                .unwrap_or_else(|_| format!("{}=debug", env!("CARGO_PKG_NAME"))),
        )))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    // Treat APP_ENV=production (or "prod") as production; anything else is dev.
    let app_env = std::env::var("APP_ENV").unwrap_or_else(|_| "development".to_string());
    let is_production =
        app_env.eq_ignore_ascii_case("production") || app_env.eq_ignore_ascii_case("prod");

    // JWT secret. A default/placeholder secret lets anyone forge auth tokens, so in
    // production we refuse to boot unless a strong, non-placeholder secret is set.
    let jwt_secret = match std::env::var("JWT_SECRET") {
        Ok(s) => s,
        Err(_) => {
            if is_production {
                panic!("JWT_SECRET must be set in production (APP_ENV=production). Generate one with `openssl rand -hex 32`.");
            }
            tracing::warn!("JWT_SECRET not set — using an insecure development default. DO NOT use in production.");
            "sovereign_default_secret_change_me".to_string()
        }
    };
    // A non-loopback bind is a strong signal of a real deployment even when
    // APP_ENV was not set to production (the misconfiguration this guards). A
    // server reachable off-box while trusting the publicly-known default secret
    // lets anyone forge tokens, so treat "exposed" the same as "production" for
    // the secret guard below. Loopback-only dev is unaffected.
    let bind_is_exposed = std::env::var("BIND_ADDR")
        .ok()
        .and_then(|h| h.trim().parse::<IpAddr>().ok())
        .map(|ip| !ip.is_loopback())
        .unwrap_or(false);

    let secret_is_weak = jwt_secret_is_weak(&jwt_secret);
    if secret_is_weak {
        if is_production || bind_is_exposed {
            panic!("JWT_SECRET is weak or a placeholder (needs >=32 chars and no 'change' placeholder) and this server is exposed (APP_ENV=production or a non-loopback BIND_ADDR). Anyone could forge auth tokens. Generate one with `openssl rand -hex 32`.");
        }
        tracing::warn!("JWT_SECRET looks weak/placeholder — OK for dev, but set a strong 32+ char secret before going to production.");
    }

    // Configurable database pool size. Default raised 5 → 20: a 5-connection
    // pool made the (previously un-throttled) WS path a cheap way to stall all
    // DB-backed requests. Combined with the per-connection WS rate limit and the
    // acquire timeout below, a saturated pool now returns errors fast instead of
    // hanging every request behind pool acquisition.
    let max_connections = std::env::var("DATABASE_MAX_CONNECTIONS")
        .unwrap_or_else(|_| "20".to_string())
        .parse::<u32>()
        .unwrap_or(20);

    tracing::info!("Database pool max connections: {}", max_connections);

    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        // Bound how long a handler waits for a free connection. Without this, a
        // saturated pool blocks every request indefinitely (a hang); with it,
        // the query returns a pool-timeout error the handler maps to 500 and the
        // request completes quickly, keeping the server responsive under load.
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&db_url)
        .await?;

    // Uploads are written to ./uploads relative to the working directory; make sure
    // it exists so a fresh deployment doesn't 500 on the first file upload.
    tokio::fs::create_dir_all("uploads")
        .await
        .expect("Failed to create uploads directory");

    // Run database migrations on startup.
    // NOTE: sqlx::migrate! embeds the migrations dir at COMPILE time — when you
    // add a migration, this file must be recompiled for the macro to re-expand
    // (an incremental build that skips main.rs won't pick it up). Latest: 057.
    //
    // Read migrations/README.md before adding or editing anything in there: an
    // APPLIED migration is frozen bytes (sqlx checksums the file and compares it
    // against _sqlx_migrations, so editing one — comments and line endings
    // included — crash-loops this call), and two already-applied files carry
    // dormant landmines that are documented there rather than patched.
    // Non-.sql files in that directory are ignored by the resolver, which is
    // what makes the README safe to keep next to them.
    tracing::info!("Running database migrations...");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");
    tracing::info!("Migrations complete");

    // Create shared application state
    let email_service = EmailConfig::from_env().map(|config| {
        tracing::info!(
            "Email service configured with SMTP host: {}",
            config.smtp_host
        );
        EmailService::new(config)
    });

    if email_service.is_none() {
        tracing::warn!("Email service not configured. Set SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM to enable.");
    }

    // Wake-signal transport. All-or-nothing like the SFU and email blocks; the
    // signal is a CONSTANT over FCM (src/wake) — never data. Unset = the
    // doorbell is off and the native delivery socket alone carries delivery,
    // with its documented Doze limits. Set-but-broken ABORTS the boot: a
    // deployment that configured wakes and silently got none is the failure
    // class this repo already paid for once.
    let getenv = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let wake: std::sync::Arc<dyn wake::WakeTransport> =
        match (getenv("FCM_PROJECT_ID"), getenv("FCM_SERVICE_ACCOUNT_FILE")) {
            (Some(project_id), Some(path)) => {
                let json = std::fs::read_to_string(&path).map_err(|e| {
                    anyhow::anyhow!("FCM_SERVICE_ACCOUNT_FILE is set to {path} but cannot be read: {e}")
                })?;
                let t = wake::fcm::FcmWake::new(project_id.clone(), &json)?;
                tracing::info!("Wake signals enabled (FCM project {project_id}, constant payload)");
                std::sync::Arc::new(t)
            }
            _ => {
                tracing::info!(
                    "Wake signals not configured. Set FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE                      to enable Doze-piercing delivery wakes; without them, background delivery                      relies on the native socket alone."
                );
                std::sync::Arc::new(wake::NullWake)
            }
        };

    let app_state = AppState::new(pool.clone(), jwt_secret, email_service, wake);

    // CORS configuration - lockdown for production if CORS_ORIGINS is set
    let cors = if let Ok(origins_str) = std::env::var("CORS_ORIGINS") {
        let origins: Vec<_> = origins_str
            .split(',')
            .filter_map(|s| s.trim().parse::<axum::http::HeaderValue>().ok())
            .collect();
        tracing::info!("CORS configured with {} allowed origins", origins.len());
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::DELETE,
                Method::PATCH,
                Method::PUT,
                Method::OPTIONS,
            ])
            // The file-capability headers (upload_handlers.rs). Every client is
            // cross-origin (app.<domain>, tauri://, capacitor://), so a custom request
            // header that is not listed here fails preflight and the fetch never happens.
            .allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                header::ACCEPT,
                header::HeaderName::from_static("x-puca-file-cap"),
                header::HeaderName::from_static("x-puca-want-cap"),
                header::HeaderName::from_static("x-puca-channel"),
            ])
            // Sliding-session renewal rides on a response header; without this
            // the browser hides it cross-origin and sessions still die at 24 h.
            .expose_headers([header::HeaderName::from_static(
                crate::auth::RENEWED_TOKEN_HEADER,
            )])
    } else if is_production {
        // Fail closed: a production server must name its allowed origins. Every
        // documented deploy sets CORS_ORIGINS (chat + app + tauri/capacitor
        // origins), so this only fires on a misconfiguration — and `Any` in
        // production would let any website drive the API on a signed-in user's
        // behalf. Match the JWT_SECRET boot guard rather than silently widening.
        panic!("CORS_ORIGINS must be set in production (APP_ENV=production). List your origins, e.g. https://chat.example.com,https://app.example.com,tauri://localhost");
    } else {
        tracing::warn!("CORS_ORIGINS not set, allowing all origins (INSECURE for production!)");
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::DELETE,
                Method::PATCH,
                Method::PUT,
                Method::OPTIONS,
            ])
            // The file-capability headers (upload_handlers.rs). Every client is
            // cross-origin (app.<domain>, tauri://, capacitor://), so a custom request
            // header that is not listed here fails preflight and the fetch never happens.
            .allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                header::ACCEPT,
                header::HeaderName::from_static("x-puca-file-cap"),
                header::HeaderName::from_static("x-puca-want-cap"),
                header::HeaderName::from_static("x-puca-channel"),
            ])
            // Sliding-session renewal rides on a response header; without this
            // the browser hides it cross-origin and sessions still die at 24 h.
            .expose_headers([header::HeaderName::from_static(
                crate::auth::RENEWED_TOKEN_HEADER,
            )])
    };

    // Routes that require JWT authentication
    let protected_routes = Router::new()
        // Server endpoints
        .route("/servers", post(server_handlers::create_server))
        .route("/servers", get(server_handlers::list_servers))
        // Per-user server-rail drag-and-drop order (static segment beats :server_id)
        .route("/servers/reorder", patch(server_handlers::reorder_servers))
        .route(
            "/servers/:server_id/join",
            post(server_handlers::join_server),
        )
        .route(
            "/servers/:server_id/leave",
            post(server_handlers::leave_server),
        )
        .route(
            "/servers/:server_id",
            delete(server_handlers::delete_server),
        )
        .route(
            "/servers/:server_id/channels",
            get(channel_handlers::list_channels),
        )
        .route(
            "/servers/:server_id/channels",
            post(channel_handlers::create_channel),
        )
        .route(
            "/servers/:server_id/channels/reorder",
            post(channel_handlers::reorder_channels),
        )
        .route(
            "/servers/:server_id/members",
            get(server_handlers::list_server_members),
        )
        .route(
            "/servers/:server_id/members-with-roles",
            get(role_handlers::list_members_with_roles),
        )
        .route(
            "/servers/:server_id/settings",
            patch(server_handlers::update_server_settings),
        )
        // Invite endpoints
        // Invite endpoints
        .route(
            "/servers/:server_id/invites",
            post(invite_handlers::create_invite),
        )
        .route(
            "/servers/:server_id/invites",
            get(invite_handlers::list_invites),
        )
        .route(
            "/servers/:server_id/invites/:code",
            delete(invite_handlers::delete_invite),
        )
        .route(
            "/invites/:code/join",
            post(invite_handlers::join_via_invite),
        )
        // Role endpoints
        .route("/servers/:server_id/roles", get(role_handlers::list_roles))
        .route(
            "/servers/:server_id/roles",
            post(role_handlers::create_role),
        )
        .route(
            "/servers/:server_id/roles/:role_id",
            patch(role_handlers::update_role),
        )
        .route(
            "/servers/:server_id/roles/:role_id",
            delete(role_handlers::delete_role),
        )
        .route(
            "/servers/:server_id/members/:user_id/roles/:role_id",
            axum::routing::put(role_handlers::assign_role),
        )
        .route(
            "/servers/:server_id/members/:user_id/roles/:role_id",
            delete(role_handlers::remove_role),
        )
        // Kick/Ban endpoints
        .route(
            "/servers/:server_id/kick/:user_id",
            post(moderation_handlers::kick_member),
        )
        .route(
            "/servers/:server_id/bans",
            get(moderation_handlers::list_bans),
        )
        .route(
            "/servers/:server_id/bans/:user_id",
            post(moderation_handlers::ban_member),
        )
        .route(
            "/servers/:server_id/bans/:user_id",
            delete(moderation_handlers::unban_member),
        )
        // Voice moderation: move a member between voice channels, or
        // (channel_id: null) disconnect them from voice. Writes no rows — they
        // keep their membership and can rejoin immediately.
        .route(
            "/servers/:server_id/voice-move/:user_id",
            post(moderation_handlers::move_member_voice),
        )
        // Timeout endpoints
        .route(
            "/servers/:server_id/timeout/:user_id",
            post(moderation_handlers::timeout_member),
        )
        .route(
            "/servers/:server_id/timeout/:user_id",
            delete(moderation_handlers::remove_timeout),
        )
        .route(
            "/servers/:server_id/custom-sounds/:user_id",
            axum::routing::put(moderation_handlers::set_member_custom_sounds),
        )
        // Audit log endpoint
        .route(
            "/servers/:server_id/audit-log",
            get(moderation_handlers::list_audit_log),
        )
        // Report system endpoints
        .route(
            "/servers/:server_id/reports",
            post(moderation_handlers::create_report),
        )
        .route(
            "/servers/:server_id/reports",
            get(moderation_handlers::list_reports),
        )
        .route(
            "/servers/:server_id/reports/:report_id",
            patch(moderation_handlers::resolve_report),
        )
        // Category endpoints
        .route(
            "/servers/:server_id/categories",
            get(category_handlers::list_categories),
        )
        .route(
            "/servers/:server_id/categories",
            post(category_handlers::create_category),
        )
        .route(
            "/servers/:server_id/categories/:category_id",
            delete(category_handlers::delete_category),
        )
        // Channel endpoints
        // Channel endpoints
        .route(
            "/channels/:channel_id",
            patch(channel_handlers::update_channel),
        )
        .route(
            "/channels/:channel_id",
            delete(channel_handlers::delete_channel),
        )
        .route(
            "/channels/:channel_id/feed",
            get(channel_handlers::get_channel_feed),
        )
        // Channel permission overwrites (MANAGE_CHANNELS only)
        .route(
            "/channels/:channel_id/overwrites",
            get(channel_handlers::list_overwrites),
        )
        .route(
            "/channels/:channel_id/overwrites/:role_id",
            axum::routing::put(channel_handlers::put_overwrite),
        )
        .route(
            "/channels/:channel_id/overwrites/:role_id",
            delete(channel_handlers::delete_overwrite),
        )
        // E2EE channel key distribution
        .route(
            "/channels/:channel_id/keys",
            post(key_handlers::publish_channel_keys),
        )
        .route(
            "/channels/:channel_id/keys",
            get(key_handlers::get_channel_keys),
        )
        .route(
            "/channels/:channel_id/member-keys",
            get(key_handlers::get_member_keys),
        )
        // Tier-2 SFU: LiveKit join tokens (VIEW-gated + admission control)
        .route("/channels/:channel_id/sfu-token", get(sfu::get_sfu_token))
        // Task endpoints
        .route(
            "/channels/:channel_id/tasks",
            post(task_handlers::create_task),
        )
        .route(
            "/channels/:channel_id/tasks",
            get(task_handlers::list_tasks),
        )
        .route("/tasks/:task_id", patch(task_handlers::update_task))
        .route("/tasks/:task_id", delete(task_handlers::delete_task))
        .route("/tasks/:task_id/move", post(task_handlers::move_task))
        .route("/tasks/:task_id/reorder", post(task_handlers::reorder_task))
        // Tasks-view tab order + favourites (per-user UI state)
        .route("/task-tab-prefs", get(task_handlers::list_tab_prefs))
        .route(
            "/task-tab-prefs",
            axum::routing::put(task_handlers::put_tab_prefs),
        )
        // Due-time reminders (ids + times only; content stays E2EE)
        .route(
            "/task-reminders",
            get(task_handlers::list_task_reminders),
        )
        // Personal task lists (Google Keep style)
        .route("/task-lists", get(task_handlers::list_task_lists))
        .route("/task-lists", post(task_handlers::create_task_list))
        // Static path — registered before the :list_id routes so "self" is never
        // parsed as a list id.
        .route("/task-lists/self", get(task_handlers::get_self_checklist))
        .route(
            "/task-lists/:list_id",
            patch(task_handlers::rename_task_list),
        )
        .route(
            "/task-lists/:list_id",
            delete(task_handlers::delete_task_list),
        )
        .route(
            "/task-lists/:list_id/tasks",
            get(task_handlers::list_list_tasks),
        )
        .route(
            "/task-lists/:list_id/tasks",
            post(task_handlers::create_list_task),
        )
        // Clips consent protocol (clip_handlers.rs, docs/CLIPS.md). The static
        // /clips/pending and /clips/usage are kept ahead of /clips/:clip_id
        // for the reader; matchit gives static segments priority over :param
        // whatever the registration order, so this is convention, not load-
        // bearing (verified against axum 0.7 — the older comment's "MUST
        // precede" overstated it).
        .route("/channels/:channel_id/clips", post(clip_handlers::propose_clip))
        .route("/clips/pending", get(clip_handlers::list_pending_clips))
        .route("/clips/usage", get(upload_handlers::clip_usage))
        .route("/clips/:clip_id", get(clip_handlers::get_clip).delete(clip_handlers::cancel_clip))
        .route("/clips/:clip_id/vote", post(clip_handlers::vote_clip))
        .route(
            "/channels/:channel_id/messages",
            get(message_handlers::get_messages),
        )
        .route(
            "/channels/:channel_id/messages",
            post(message_handlers::send_message),
        )
        .route(
            "/channels/:channel_id/messages/:message_id",
            patch(message_handlers::edit_message),
        )
        .route(
            "/channels/:channel_id/messages/:message_id",
            delete(message_handlers::delete_message),
        )
        // Collection feed
        .route(
            "/channels/:channel_id/messages/:message_id/edits",
            get(message_handlers::get_message_edits),
        )
        // Pinning endpoints
        .route(
            "/channels/:channel_id/pins",
            get(message_handlers::list_pinned_messages),
        )
        .route(
            "/channels/:channel_id/messages/:message_id/pin",
            post(message_handlers::pin_message),
        )
        .route(
            "/channels/:channel_id/messages/:message_id/pin",
            delete(message_handlers::unpin_message),
        )
        // Task endpoint
        .route(
            "/channels/:channel_id/messages/:message_id/toggle-task",
            post(message_handlers::toggle_task_completion),
        )
        // DM endpoints
        .route("/dms", get(dm_handlers::list_conversations))
        .route("/dms", post(dm_handlers::start_conversation))
        .route(
            "/dms/:conversation_id/messages",
            get(dm_handlers::get_messages),
        )
        .route(
            "/dms/:conversation_id/messages",
            post(dm_handlers::send_message),
        )
        // Friend endpoints
        .route("/friends", get(friend_handlers::list_friends))
        .route(
            "/friends/request",
            post(friend_handlers::send_friend_request),
        )
        .route(
            "/friends/requests/incoming",
            get(friend_handlers::list_incoming_requests),
        )
        .route(
            "/friends/requests/outgoing",
            get(friend_handlers::list_outgoing_requests),
        )
        .route(
            "/friends/requests/:id/accept",
            post(friend_handlers::accept_request),
        )
        .route(
            "/friends/requests/:id/reject",
            post(friend_handlers::reject_request),
        )
        .route("/friends/:user_id", delete(friend_handlers::remove_friend))
        .route(
            "/friends/:user_id/status",
            get(friend_handlers::get_friendship_status),
        )
        // Account deletion (tombstone; username re-typed, password proven
        // client-side via the seed unwrap, same as change-password)
        .route("/account", delete(handlers::delete_account))
        // Blocked users endpoints
        .route("/blocked", get(moderation_handlers::list_blocked_users))
        .route(
            "/users/:user_id/block",
            post(moderation_handlers::block_user),
        )
        .route(
            "/users/:user_id/block",
            delete(moderation_handlers::unblock_user),
        )
        // File upload endpoints. The handler enforces a 10 MB file cap, but axum's
        // default body limit is 2 MB and rejects bigger requests before the handler
        // runs — raise it (12 MB leaves headroom for multipart framing).
        .route(
            "/upload",
            post(upload_handlers::upload_file)
                .layer(axum::extract::DefaultBodyLimit::max(28 * 1024 * 1024)),
        )
        // Reaction endpoints
        .route(
            "/messages/:message_id/reactions",
            post(reaction_handlers::add_reaction),
        )
        .route(
            "/messages/:message_id/reactions",
            get(reaction_handlers::get_reactions),
        )
        .route(
            "/messages/:message_id/reactions/:emoji",
            delete(reaction_handlers::remove_reaction),
        )
        // Custom emoji endpoints
        .route(
            "/servers/:server_id/emojis",
            get(reaction_handlers::list_emojis),
        )
        .route(
            "/servers/:server_id/emojis",
            post(reaction_handlers::create_emoji),
        )
        .route(
            "/servers/:server_id/emojis/:emoji_id",
            delete(reaction_handlers::delete_emoji),
        )
        // Profile endpoints
        .route("/profile", get(handlers::get_profile))
        .route("/profile", patch(handlers::update_profile))
        // Email verification (requires auth)
        .route(
            "/auth/send-verification",
            post(email_handlers::send_verification_email),
        )
        // E2EE public key endpoints
        .route("/users/search", get(handlers::search_users)) // Must come before :user_id route
        .route(
            "/users/:user_id/public-key",
            get(handlers::get_user_public_key),
        )
        .route("/keys/public", patch(handlers::update_public_key))
        // Reclaim your own upload quota. Authenticated + uploader-scoped.
        .route("/files/:file_id", delete(upload_handlers::delete_file))
        // File downloads. AUTHENTICATED since 2026-07-28: this used to sit on
        // the public router "for embedding in messages", which meant anyone on
        // the internet holding a UUID could fetch any avatar, sound clip,
        // emoji or attachment with no account at all. Clients now fetch with
        // the Authorization header and hand the bytes to <img>/Audio via an
        // object URL (frontend/src/api/authedMedia.ts) — a plain <img src>
        // cannot send a header, which is why it was public in the first place.
        .route("/files/:file_id", get(upload_handlers::get_file))
        // E2EE recoverable key custody (v3): login unwrap + migrate/rewrap
        .route("/keys/wrap", get(recovery_handlers::get_wrap_material))
        .route(
            "/keys/migrate-v3",
            post(recovery_handlers::set_wrap_material),
        )
        .route("/keys/rewrap", post(recovery_handlers::set_wrap_material))
        .route("/keys/rewrap-pw", post(recovery_handlers::rewrap_password))
        .route(
            "/keys/change-password",
            post(recovery_handlers::change_password),
        )
        // Per-device identity ("My Devices"). The server is a registrar, not an
        // authority: it stores client-signed enrolment records it cannot mint,
        // and every client re-verifies them against the account signing key it
        // derives from its own seed.
        .route("/devices", post(device_handlers::enrol_device))
        .route("/devices", get(device_handlers::list_devices))
        .route("/devices/:device_id", patch(device_handlers::update_device))
        .route(
            "/devices/:device_id",
            delete(device_handlers::revoke_device),
        )
        // Host-signed controller allowlist. The signature comes from the HOST
        // DEVICE's key, so password compromise alone cannot authorise a
        // controller against a machine the attacker is not at.
        .route(
            "/devices/:device_id/grants",
            post(device_handlers::create_grant),
        )
        .route(
            "/devices/:device_id/grants",
            get(device_handlers::list_grants),
        )
        .route(
            "/devices/:device_id/grants/:controller_id",
            delete(device_handlers::delete_grant),
        )
        // Cross-user device shares: standing access for a FRIEND, mutual
        // consent (owner invites, grantee accepts), host-device-signed grant,
        // instantly revocable by either side. The peer-device route is the
        // ONLY cross-account device lookup in the system and must stay that
        // narrow — one named device, under one accepted share, never a list.
        .route(
            "/devices/:device_id/shares",
            post(device_handlers::create_share),
        )
        .route(
            "/devices/:device_id/shares",
            get(device_handlers::list_device_shares),
        )
        .route(
            "/shares/incoming",
            get(device_handlers::list_incoming_shares),
        )
        .route(
            "/shares/:invite_id/respond",
            post(device_handlers::respond_share),
        )
        .route("/shares/:invite_id/sign", post(device_handlers::sign_share))
        .route("/shares/:invite_id", delete(device_handlers::delete_share))
        .route(
            "/shares/:invite_id/device/:device_id",
            get(device_handlers::share_peer_device),
        )
        // The account's PUBLISHED Ed25519 signing key — what lets a FRIEND's
        // client verify this account's device enrolment records. TOFU-pinned
        // by peers, same trust posture as users.public_key.
        .route("/keys/signing", patch(device_handlers::set_signing_key))
        .route(
            "/users/:user_id/signing-key",
            get(device_handlers::get_signing_key),
        )
        // Logout: bump token_version to revoke every outstanding JWT (M1).
        .route("/auth/logout", post(handlers::logout))
        .route("/auth/logout-session", post(handlers::logout_session))
        // Unread count endpoints
        .route(
            "/channels/:channel_id/read",
            post(server_handlers::mark_channel_read),
        )
        .route(
            "/servers/:server_id/unread",
            get(server_handlers::get_unread_counts),
        )
        .route("/unread", get(server_handlers::get_all_unread_counts))
        .route(
            "/servers/:server_id/read",
            post(server_handlers::mark_server_read),
        )
        // Server nickname endpoint
        .route(
            "/servers/:server_id/nickname",
            post(server_handlers::set_nickname),
        )
        // Voice users endpoint (for initial state on app load)
        .route(
            "/servers/:server_id/voice-users",
            get(server_handlers::get_voice_users),
        )
        // Push notification endpoints
        .route("/device/register", post(push_handlers::register_device))
        .route(
            "/device/unregister",
            delete(push_handlers::unregister_device),
        )
        .route("/device/list", get(push_handlers::list_devices))
        .route("/device/:id", delete(push_handlers::remove_device))
        .route(
            "/notifications/preferences",
            get(push_handlers::get_notification_preferences),
        )
        .route(
            "/notifications/preferences",
            patch(push_handlers::update_notification_preferences),
        )
        .route(
            "/notifications/test",
            post(push_handlers::send_test_notification),
        )
        .layer(axum_middleware::from_fn_with_state(
            app_state.clone(),
            auth::jwt_auth_middleware,
        ));

    // Public routes (no auth required for invite preview and discovery)
    let public_api_routes = Router::new()
        .route("/invites/:code", get(invite_handlers::get_invite_info))
        .route("/discover", get(server_handlers::list_public_servers))
        .route("/config", get(public_config::get_public_config))
        .with_state(app_state.clone());

    // Create rate limit layers and spawn a periodic GC that prunes each limiter's
    // keyed store — idle-IP buckets are otherwise never evicted for the process
    // lifetime. retain_recent() only drops keys already back to full quota, so no
    // client is ever wrongly throttled; a 60s cadence is negligible CPU.
    let auth_rate_limit = middleware::rate_limit::create_auth_rate_limit_layer();
    let api_rate_limit = middleware::rate_limit::create_api_rate_limit_layer();
    for lim in [
        auth_rate_limit.config.limiter().clone(),
        api_rate_limit.config.limiter().clone(),
    ] {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                lim.retain_recent();
            }
        });
    }

    // Sweep abandoned peer-to-peer transfers. An offer nobody answers, or a
    // transfer whose sender vanished, would otherwise hold a registry entry for
    // the process lifetime — and since transfers are capped per user, enough of
    // them would stop a user from sending anything at all.
    {
        let state_for_transfers = app_state.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                ws::reap_stale_transfers(&state_for_transfers);
                ws::reap_stale_device_sessions(&state_for_transfers);
                clip_handlers::reap_stale_clips(&state_for_transfers);
            }
        });
    }

    // Sample real SFU node egress from LiveKit's Prometheus endpoint — feeds
    // the measured branch of SFU admission (no-op when the SFU tier or the
    // metrics endpoint isn't deployed; admission then stays worst-case only).
    sfu::spawn_egress_sampler(app_state.clone());

    // Hourly clip-part sweep (upload_handlers::sweep_clip_parts): orphaned
    // parts of proposals that never posted, plus optional CLIP_RETENTION_DAYS.
    // First tick after 5 minutes so a boot does not race a clip mid-upload.
    // CLIP_SWEEP_INTERVAL_SECS overrides the hour (the live e2e runs it at 5 s;
    // the first tick then comes after one interval instead of 5 minutes).
    {
        let state_for_clips = app_state.clone();
        let every = std::env::var("CLIP_SWEEP_INTERVAL_SECS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|s| *s > 0).unwrap_or(3600);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(every.min(300))).await;
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(every));
            loop {
                tick.tick().await;
                upload_handlers::sweep_clip_parts(&state_for_clips).await;
            }
        });
    }

    // Periodically sweep abandoned login_attempts rows. The per-username prune in
    // login_step_1 only fires when that username is re-attempted, so rows for
    // never-retried usernames would otherwise linger for the process lifetime.
    {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                tick.tick().await;
                let _ = sqlx::query(
                    "DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '10 minutes'",
                )
                .execute(&pool)
                .await;
            }
        });
    }

    // Moderation-table retention (src/retention.rs): resolved reports and
    // audit rows older than their window are pruned; pending reports never.
    // 0 in either env var keeps that table forever.
    {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
            loop {
                tick.tick().await;
                if let Some(days) = retention::retention_days("REPORTS_RETENTION_DAYS", retention::REPORTS_RETENTION_DAYS_DEFAULT) {
                    let _ = sqlx::query(
                        "DELETE FROM reports WHERE status <> 'pending' AND resolved_at IS NOT NULL AND resolved_at < NOW() - make_interval(days => $1::int)",
                    )
                    .bind(days as i32)
                    .execute(&pool)
                    .await;
                }
                if let Some(days) = retention::retention_days("AUDIT_RETENTION_DAYS", retention::AUDIT_RETENTION_DAYS_DEFAULT) {
                    let _ = sqlx::query(
                        "DELETE FROM audit_log WHERE created_at < NOW() - make_interval(days => $1::int)",
                    )
                    .bind(days as i32)
                    .execute(&pool)
                    .await;
                }
                // Uploads of deleted accounts whose grace period has passed:
                // the file first, then the row, so a crash between the two
                // leaves a row the next pass retries rather than an orphan file.
                let due: Vec<(String, String)> = sqlx::query_as(
                    "SELECT id::text, stored_name FROM uploaded_files WHERE purge_after IS NOT NULL AND purge_after < NOW() ORDER BY purge_after LIMIT 200",
                )
                .fetch_all(&pool)
                .await
                .unwrap_or_default();
                let mut purged = 0usize;
                for (id, stored_name) in due {
                    match tokio::fs::remove_file(format!("uploads/{}", stored_name)).await {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => {
                            tracing::warn!("purge: could not remove {stored_name}: {e}");
                            continue;
                        }
                    }
                    match sqlx::query("DELETE FROM uploaded_files WHERE id = $1::uuid").bind(&id).execute(&pool).await {
                        Ok(_) => purged += 1,
                        Err(e) => tracing::warn!("purge: could not delete row {id}: {e:?}"),
                    }
                }
                if purged > 0 {
                    tracing::info!("purge: removed {purged} upload(s) of deleted accounts past their grace period");
                }
            }
        });
    }

    let auth_routes = Router::new()
        // REST Auth endpoints (no auth required)
        .route("/auth/register", post(handlers::register))
        .route("/auth/login/step1", post(handlers::login_step_1))
        .route("/auth/login/step2", post(handlers::login_step_2))
        // Migration password reset (legacy: resets identity, loses history)
        .route(
            "/auth/reset-password-migration",
            post(handlers::reset_password),
        )
        // E2EE recovery reset (v3): keeps identity + history, proof-gated
        .route(
            "/auth/recovery/challenge",
            post(recovery_handlers::recovery_challenge),
        )
        .route(
            "/auth/recovery/reset",
            post(recovery_handlers::recovery_reset),
        )
        // Email endpoints (public - no auth for reset/verify)
        .route(
            "/auth/forgot-password",
            post(email_handlers::forgot_password),
        )
        .route("/auth/reset-password", post(email_handlers::reset_password))
        .route("/auth/verify-email", get(email_handlers::verify_email))
        .route(
            "/auth/validate-reset-token",
            get(email_handlers::validate_reset_token),
        )
        .layer(auth_rate_limit);

    let app = Router::new()
        // Health check
        .route("/", get(|| async { "Puca Backend Online" }))
        // Auth routes (rate limited)
        .merge(auth_routes)
        // WebSocket endpoint (auth via query param)
        .route("/ws", get(ws::ws_handler))
        // ICE configuration for WebRTC (no auth needed)
        .route("/ice-config", get(server_handlers::get_ice_config))
        .route("/source", get(source_offer::get_source))
        // UNAUTHENTICATED BY NECESSITY: a machine at its own sign-in screen has
        // no credential yet — obtaining one is the point. Both steps are bounded
        // (single-use nonce, capped pending map) and neither reveals whether a
        // device id exists.
        .route("/devices/token/challenge", post(device_token::device_challenge))
        .route("/devices/token", post(device_token::device_token))
        // LiveKit webhook feed (authenticates itself via signed JWT + body hash)
        .route("/livekit/webhook", post(sfu::livekit_webhook))
        // Protected routes (require JWT in Authorization header)
        .merge(protected_routes)
        // Public API routes (no auth required)
        .merge(public_api_routes)
        // Auto-updater endpoint (no auth required)
        .merge(update_routes::update_routes())
        // Static file serving for live update bundles
        .nest_service("/releases", ServeDir::new("releases"))
        // General API rate limiting (auth endpoints have their own stricter limit)
        .layer(api_rate_limit)
        .layer(cors)
        // COOP/COEP headers for SharedArrayBuffer support (AudioWorklet)
        .layer(axum_middleware::from_fn(add_security_headers))
        .with_state(app_state);

    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse::<u16>()
        .unwrap_or(3000);
    // Bind host is configurable: default 127.0.0.1 (safe behind a reverse proxy on
    // the same host); set BIND_ADDR=0.0.0.0 for containers / direct exposure.
    let host = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));

    tracing::info!(
        "environment: {}",
        if is_production {
            "production"
        } else {
            "development"
        }
    );
    tracing::info!(
        "listening on http://{} (local bind — expected behind a TLS-terminating reverse proxy)",
        addr
    );
    tracing::info!("WebSocket path: /ws, authenticating with the Sec-WebSocket-Protocol header `bearer, YOUR_JWT` (?token= is still accepted for pre-0.9.0 installs, but lands in access logs) — reachable locally as ws://{addr}/ws, or wss://<public-host>/ws through the reverse proxy in production");
    tracing::info!("💡 Production deployments MUST sit behind a reverse proxy (nginx/Caddy) terminating TLS — this process itself never speaks TLS/WSS");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    // Provide peer address as ConnectInfo so the rate limiter's IP key extractor
    // has a fallback when no X-Forwarded-For header is present (e.g. local dev).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    // Nagle off: remote-control input rides this socket as many small frames,
    // and batching them behind an unacked segment costs up to a delayed-ACK
    // (~40ms) each. In production the hop is loopback-to-Caddy so this is ~0,
    // but a direct-bind deployment should not inherit the penalty.
    .tcp_nodelay(true)
    .await?;

    Ok(())
}

/// Middleware to add COOP/COEP security headers for SharedArrayBuffer support
async fn add_security_headers(
    request: axum::extract::Request,
    next: axum_middleware::Next,
) -> Response<Body> {
    let mut response = next.run(request).await;

    // Add Cross-Origin-Opener-Policy header
    response.headers_mut().insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        header::HeaderValue::from_static("same-origin"),
    );

    // Add Cross-Origin-Embedder-Policy header
    response.headers_mut().insert(
        header::HeaderName::from_static("cross-origin-embedder-policy"),
        header::HeaderValue::from_static("require-corp"),
    );

    // Defense-in-depth response hardening for every API response. The web app
    // is served from a separate origin, so a strict CSP belongs on that host,
    // not here — but these headers still matter: `nosniff` stops a browser from
    // MIME-sniffing an API/file response into something executable (the
    // /files inline-serve path also sets its own, this is the blanket backstop);
    // DENY framing prevents clickjacking of any HTML an endpoint might return;
    // a strict Referrer-Policy keeps auth-bearing URLs out of the Referer
    // header; and a locked-down Permissions-Policy denies powerful features by
    // default. `insert` (not append) so a value set nearer the handler wins.
    let hardening: [(&str, &str); 4] = [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "strict-origin-when-cross-origin"),
        (
            "permissions-policy",
            "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
        ),
    ];
    for (name, value) in hardening {
        response.headers_mut().insert(
            header::HeaderName::from_static(name),
            header::HeaderValue::from_static(value),
        );
    }

    response
}
