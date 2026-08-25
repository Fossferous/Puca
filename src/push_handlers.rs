use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::state::AppState;

// ============================================================================
// Request/Response Types
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct RegisterDeviceRequest {
    pub token: String,
    pub platform: String,
    pub device_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisterDeviceResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceToken {
    pub id: i32,
    pub platform: String,
    pub device_name: Option<String>,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Serialize)]
pub struct ListDevicesResponse {
    pub devices: Vec<DeviceToken>,
}

#[derive(Debug, Deserialize)]
pub struct NotificationPreferencesRequest {
    pub push_enabled: Option<bool>,
    pub push_messages: Option<bool>,
    pub push_mentions: Option<bool>,
    pub push_dms: Option<bool>,
    pub push_friend_requests: Option<bool>,
    pub quiet_hours_start: Option<String>,
    pub quiet_hours_end: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NotificationPreferencesResponse {
    pub push_enabled: bool,
    pub push_messages: bool,
    pub push_mentions: bool,
    pub push_dms: bool,
    pub push_friend_requests: bool,
    pub quiet_hours_start: Option<String>,
    pub quiet_hours_end: Option<String>,
}

// ============================================================================
// Device Token Handlers
// ============================================================================

/// Register a device token for push notifications
/// POST /device/register
pub async fn register_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<RegisterDeviceRequest>,
) -> Result<Json<RegisterDeviceResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    // Validate platform. Matches migration 038, which widened the schema's
    // CHECK constraint to these four — this handler was still rejecting two of
    // them, so the values 038 added were unreachable.
    //
    // Accepting a platform is NOT a claim that anything sends to it: only
    // 'android' has a transport. See the note on send_test_notification.
    const PLATFORMS: [&str; 4] = ["ios", "android", "web", "unifiedpush"];
    if !PLATFORMS.contains(&payload.platform.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Platform must be one of: {}", PLATFORMS.join(", ")),
        ));
    }

    // Validate token is not empty
    if payload.token.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Token cannot be empty".to_string()));
    }

    // Upsert device token (insert or update last_used_at if exists)
    let result = sqlx::query(
        r#"
        INSERT INTO device_tokens (user_id, token, platform, device_name, last_used_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id, token) DO UPDATE SET
            last_used_at = NOW(),
            device_name = COALESCE(EXCLUDED.device_name, device_tokens.device_name)
        "#,
    )
    .bind(user_id)
    .bind(&payload.token)
    .bind(&payload.platform)
    .bind(&payload.device_name)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // An FCM token identifies a device INSTALL, and only one account is
            // signed in per install. Without this, signing into account B
            // leaves account A's row pointing at the same phone — and A keeps
            // receiving pushes, on someone else's device, indefinitely.
            //
            // The UNIQUE(user_id, token) key cannot express that; it permits
            // exactly the duplicate being deleted here. No migration needed.
            let _ = sqlx::query("DELETE FROM device_tokens WHERE token = $1 AND user_id <> $2")
                .bind(&payload.token)
                .bind(user_id)
                .execute(&state.pool)
                .await;
            Ok(Json(RegisterDeviceResponse {
                success: true,
                message: "Device registered successfully".to_string(),
            }))
        }
        Err(e) => {
            tracing::error!("Error registering device: {:?}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to register device".to_string(),
            ))
        }
    }
}

/// Unregister a device token
/// DELETE /device/unregister
pub async fn unregister_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<RegisterDeviceRequest>,
) -> Result<Json<RegisterDeviceResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let result = sqlx::query("DELETE FROM device_tokens WHERE user_id = $1 AND token = $2")
        .bind(user_id)
        .bind(&payload.token)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => Ok(Json(RegisterDeviceResponse {
            success: true,
            message: "Device unregistered successfully".to_string(),
        })),
        Err(e) => {
            eprintln!("Error unregistering device: {:?}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to unregister device".to_string(),
            ))
        }
    }
}

/// List all registered devices for the user
/// GET /device/list
pub async fn list_devices(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<ListDevicesResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let devices: Vec<(i32, String, Option<String>, String, String)> = sqlx::query_as(
        r#"
        SELECT 
            id, 
            platform, 
            device_name,
            TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            TO_CHAR(last_used_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_used_at
        FROM device_tokens 
        WHERE user_id = $1
        ORDER BY last_used_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        eprintln!("Error listing devices: {:?}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to list devices".to_string(),
        )
    })?;

    let devices = devices
        .into_iter()
        .map(
            |(id, platform, device_name, created_at, last_used_at)| DeviceToken {
                id,
                platform,
                device_name,
                created_at,
                last_used_at,
            },
        )
        .collect();

    Ok(Json(ListDevicesResponse { devices }))
}

/// Remove a specific device by ID
/// DELETE /device/:id
pub async fn remove_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(device_id): Path<i32>,
) -> Result<Json<RegisterDeviceResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let result = sqlx::query("DELETE FROM device_tokens WHERE id = $1 AND user_id = $2")
        .bind(device_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(r) => {
            if r.rows_affected() > 0 {
                Ok(Json(RegisterDeviceResponse {
                    success: true,
                    message: "Device removed successfully".to_string(),
                }))
            } else {
                Err((StatusCode::NOT_FOUND, "Device not found".to_string()))
            }
        }
        Err(e) => {
            eprintln!("Error removing device: {:?}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to remove device".to_string(),
            ))
        }
    }
}

// ============================================================================
// Notification Preferences Handlers
// ============================================================================

/// Get notification preferences
/// GET /notifications/preferences
pub async fn get_notification_preferences(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<NotificationPreferencesResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let prefs: Option<(bool, bool, bool, bool, bool, Option<String>, Option<String>)> =
        sqlx::query_as(
            r#"
        SELECT 
            push_enabled,
            push_messages,
            push_mentions,
            push_dms,
            push_friend_requests,
            TO_CHAR(quiet_hours_start, 'HH24:MI') as quiet_start,
            TO_CHAR(quiet_hours_end, 'HH24:MI') as quiet_end
        FROM notification_preferences 
        WHERE user_id = $1
        "#,
        )
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            eprintln!("Error getting notification preferences: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to get preferences".to_string(),
            )
        })?;

    // Return defaults if no preferences exist
    match prefs {
        Some((enabled, messages, mentions, dms, friends, quiet_start, quiet_end)) => {
            Ok(Json(NotificationPreferencesResponse {
                push_enabled: enabled,
                push_messages: messages,
                push_mentions: mentions,
                push_dms: dms,
                push_friend_requests: friends,
                quiet_hours_start: quiet_start,
                quiet_hours_end: quiet_end,
            }))
        }
        None => Ok(Json(NotificationPreferencesResponse {
            push_enabled: true,
            push_messages: true,
            push_mentions: true,
            push_dms: true,
            push_friend_requests: true,
            quiet_hours_start: None,
            quiet_hours_end: None,
        })),
    }
}

/// Update notification preferences
/// PATCH /notifications/preferences
pub async fn update_notification_preferences(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<NotificationPreferencesRequest>,
) -> Result<Json<NotificationPreferencesResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    // Upsert preferences
    let result = sqlx::query(
        r#"
        INSERT INTO notification_preferences (user_id, push_enabled, push_messages, push_mentions, push_dms, push_friend_requests, quiet_hours_start, quiet_hours_end, updated_at)
        VALUES ($1, 
            COALESCE($2, TRUE), 
            COALESCE($3, TRUE), 
            COALESCE($4, TRUE), 
            COALESCE($5, TRUE), 
            COALESCE($6, TRUE),
            CASE WHEN $7 IS NOT NULL THEN $7::TIME ELSE NULL END,
            CASE WHEN $8 IS NOT NULL THEN $8::TIME ELSE NULL END,
            NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
            push_enabled = COALESCE($2, notification_preferences.push_enabled),
            push_messages = COALESCE($3, notification_preferences.push_messages),
            push_mentions = COALESCE($4, notification_preferences.push_mentions),
            push_dms = COALESCE($5, notification_preferences.push_dms),
            push_friend_requests = COALESCE($6, notification_preferences.push_friend_requests),
            quiet_hours_start = CASE WHEN $7 IS NOT NULL THEN $7::TIME ELSE notification_preferences.quiet_hours_start END,
            quiet_hours_end = CASE WHEN $8 IS NOT NULL THEN $8::TIME ELSE notification_preferences.quiet_hours_end END,
            updated_at = NOW()
        "#,
    )
    .bind(user_id)
    .bind(payload.push_enabled)
    .bind(payload.push_messages)
    .bind(payload.push_mentions)
    .bind(payload.push_dms)
    .bind(payload.push_friend_requests)
    .bind(&payload.quiet_hours_start)
    .bind(&payload.quiet_hours_end)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // Return updated preferences
            get_notification_preferences(State(state), Extension(claims)).await
        }
        Err(e) => {
            eprintln!("Error updating notification preferences: {:?}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update preferences".to_string(),
            ))
        }
    }
}

/// POST /notifications/test — 501, and the reason has a history worth keeping.
///
/// FIRST it counted rows in `device_tokens` and returned 200 with
/// `success: true` and "Push service integration pending" — nothing was ever
/// sent, and a handover doc duly claimed push was fully implemented. It was
/// rewritten to answer 501 honestly.
///
/// THEN a real FCM transport existed, briefly (2026-08-13, one release), and
/// this endpoint really sent. It was REMOVED ON PRINCIPLE the same day: every
/// push routed who-messaged-whom metadata (sender name, ids, timing) through
/// Google, and a self-hosted privacy product must not do that even opt-in.
///
/// Background delivery is now the Android client's NATIVE WebSocket to this
/// very server (a second authenticated session; see the Android
/// NativeDelivery class) — server-side there is nothing to send and nothing
/// to test, so this answers 501 again, on purpose. Do not "fix" it by
/// reintroducing a relay without reading that history.
pub async fn send_test_notification(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<RegisterDeviceResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    // Still counts devices first, so the error can distinguish "you have no
    // devices registered" from "this server does not send at all".
    let count: Option<(i64,)> =
        sqlx::query_as("SELECT COUNT(*) FROM device_tokens WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| {
                tracing::error!("notifications/test: device count failed: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to check devices".to_string(),
                )
            })?;

    if !state.wake.enabled() {
        return match count {
            Some((c,)) if c > 0 => Err((
                StatusCode::NOT_IMPLEMENTED,
                format!(
                    "Wake signals are not configured on this server. {c} device(s) are \
                     registered; Android still delivers over its own native connection while \
                     that socket survives, but nothing can wake a dozing phone. Set \
                     FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE to enable the doorbell \
                     (constant payload — no user data crosses Google)."
                ),
            )),
            _ => Err((
                StatusCode::NOT_IMPLEMENTED,
                "Wake signals are not configured on this server, and no devices are \
                 registered. Android delivers over its own native connection; no third \
                 party carries any data."
                    .to_string(),
            )),
        };
    }

    if count.map(|(c,)| c).unwrap_or(0) == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "No devices registered. Open the Android app while signed in to register one."
                .to_string(),
        ));
    }

    // A REAL wake: the same constant-payload signal a missed message sends.
    // The phone should reconnect its delivery socket within seconds — that
    // reconnect (server log: "connected [delivery]") is the test passing.
    match crate::wake::sender::wake_probe(&state, claims.sub).await {
        Ok(n) => Ok(Json(RegisterDeviceResponse {
            success: true,
            message: format!(
                "Wake signal sent to {n} device(s). The payload was the constant {{\"w\":\"1\"}} — \
                 nothing else crosses the relay, ever. If the phone is reachable its delivery \
                 socket reconnects within a few seconds."
            ),
        })),
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            format!("Wake transport rejected the signal: {e}"),
        )),
    }
}
