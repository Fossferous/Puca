use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{get_user_server_permissions, user_has_permission, Permissions};
use crate::state::AppState;

/// Validate a role color against `^#[0-9A-Fa-f]{6}$` (7 chars: `#` + 6 hex).
/// Rejecting anything else keeps arbitrary client strings out of the roles table
/// (C1: the old update path interpolated `color` straight into the UPDATE).
fn is_valid_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// The acting user's authority in a server, used for role-hierarchy checks
/// (H1/M11). Owners and ADMINISTRATOR holders are top authority; everyone else
/// is bounded by the permission bits they actually hold and their highest role
/// position.
struct RoleAuthority {
    is_owner: bool,
    perms: Permissions,
    /// Highest position among roles the user actually holds (0 if none).
    highest_position: i32,
}

impl RoleAuthority {
    /// Owner or ADMINISTRATOR — exempt from masking/hierarchy limits.
    fn is_privileged(&self) -> bool {
        self.is_owner || self.perms.is_admin()
    }

    /// Mask a requested permission bitmask down to the bits the actor actually
    /// holds (no-op when privileged) so a MANAGE_ROLES holder can't grant bits
    /// they lack (e.g. ADMINISTRATOR).
    fn mask_permissions(&self, requested: i64) -> i64 {
        if self.is_privileged() {
            requested
        } else {
            ((requested as u64) & self.perms.bits()) as i64
        }
    }
}

/// Resolve the acting user's role authority in `server_id`.
async fn get_role_authority(pool: &sqlx::PgPool, server_id: &str, user_id: i64) -> RoleAuthority {
    let is_owner: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM servers WHERE id = $1 AND owner_id = $2")
            .bind(server_id)
            .bind(user_id as i32)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);

    let perms = get_user_server_permissions(pool, server_id, user_id).await;

    // Highest position among roles the user actually holds. Server-scoped join
    // (mr.server_id = sr.server_id) mirrors the C2 permission-query fix.
    let highest: Option<(i32,)> = sqlx::query_as(
        "SELECT COALESCE(MAX(sr.position), 0) FROM server_roles sr \
         JOIN member_roles mr ON mr.role_id = sr.id AND mr.server_id = sr.server_id \
         WHERE sr.server_id = $1 AND mr.user_id = $2",
    )
    .bind(server_id)
    .bind(user_id as i32)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    RoleAuthority {
        is_owner: is_owner.is_some(),
        perms,
        highest_position: highest.map(|(p,)| p).unwrap_or(0),
    }
}

#[derive(Serialize)]
pub struct RoleResponse {
    pub id: i64,
    pub server_id: String,
    pub name: String,
    pub color: String,
    pub permissions: i64,
    pub position: i32,
    pub is_default: bool,
}

#[derive(Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub permissions: i64,
}

fn default_color() -> String {
    "#99AAB5".to_string()
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub permissions: Option<i64>,
    pub position: Option<i32>,
}

#[derive(Serialize)]
pub struct MemberWithRoles {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub server_nickname: Option<String>,
    pub is_online: bool,
    pub roles: Vec<RoleResponse>,
    pub top_role_color: String,
    pub is_owner: bool,
    pub avatar_file_id: Option<String>,
    /// Custom voice join/leave clips. Nulled SERVER-side when this server's
    /// moderators disabled the member's sounds — clients never learn a
    /// suppressed id, so the mute can't be bypassed by a modified client.
    pub join_sound_file_id: Option<String>,
    pub leave_sound_file_id: Option<String>,
    /// Whether this server disabled the member's custom sounds (drives the
    /// moderation menu label; the ids above are already nulled when true).
    pub custom_sounds_disabled: bool,
}

// --- Role Handlers ---

/// List all roles for a server
pub async fn list_roles(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    tracing::info!(
        "[list_roles] Checking membership for server_id={}, user_id={}",
        server_id,
        claims.sub
    );

    // Verify user is a member - cast i64 to i32 since database uses INTEGER
    let is_member_result = sqlx::query_as::<_, (i32,)>(
        "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await;

    let is_member = match is_member_result {
        Ok(m) => {
            tracing::info!("[list_roles] Membership query result: {:?}", m);
            m
        }
        Err(e) => {
            tracing::error!("[list_roles] Membership query error: {:?}", e);
            None
        }
    };

    if is_member.is_none() {
        tracing::warn!(
            "[list_roles] User {} is not a member of server {}",
            claims.sub,
            server_id
        );
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    let roles: Vec<(i64, String, String, String, i64, i32, bool)> = sqlx::query_as(
        "SELECT id, server_id, name, color, permissions, position, is_default FROM server_roles WHERE server_id = $1 ORDER BY position DESC"
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<RoleResponse> = roles
        .into_iter()
        .map(
            |(id, server_id, name, color, permissions, position, is_default)| RoleResponse {
                id,
                server_id,
                name,
                color,
                permissions,
                position,
                is_default,
            },
        )
        .collect();

    Json(response).into_response()
}

/// Create a new role
pub async fn create_role(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateRoleRequest>,
) -> impl IntoResponse {
    // Check user has MANAGE_ROLES permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_ROLES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_ROLES permission").into_response();
    }

    // Reject non-hex colors (defense in depth; the value is bound, not
    // interpolated, but a garbage color still has no business in the table).
    if !is_valid_hex_color(&payload.color) {
        return (StatusCode::BAD_REQUEST, "Invalid color (expected #RRGGBB)").into_response();
    }

    // Hierarchy guard (H1/M11): a MANAGE_ROLES holder must not be able to mint a
    // role carrying bits they don't hold (e.g. ADMINISTRATOR) and grant it to
    // themselves. Owners/ADMINISTRATOR are exempt.
    let authority = get_role_authority(&state.pool, &server_id, claims.sub).await;
    let permissions = authority.mask_permissions(payload.permissions);

    // Get max position to place new role above @everyone
    let max_pos: (i32,) = sqlx::query_as(
        "SELECT COALESCE(MAX(position), 0) FROM server_roles WHERE server_id = $1 AND is_default = false"
    )
    .bind(&server_id)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));

    // Non-privileged creators can't place a role at or above their own highest
    // role (they'd then be unable to manage it anyway, and it must stay beneath
    // them in the hierarchy). Owners/admins get the normal top slot.
    let new_position = if authority.is_privileged() {
        max_pos.0 + 1
    } else {
        (max_pos.0 + 1).min(authority.highest_position - 1).max(1)
    };

    let result: Result<(i64,), _> = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id"
    )
    .bind(&server_id)
    .bind(&payload.name)
    .bind(&payload.color)
    .bind(permissions)
    .bind(new_position)
    .fetch_one(&state.pool)
    .await;

    match result {
        Ok((id,)) => Json(RoleResponse {
            id,
            server_id,
            name: payload.name,
            color: payload.color,
            permissions,
            position: new_position,
            is_default: false,
        })
        .into_response(),
        Err(e) => {
            // Log the raw DB error; return a generic message so column and
            // constraint names aren't handed to the client.
            tracing::error!("create_role failed: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create role").into_response()
        }
    }
}

/// Update a role
pub async fn update_role(
    State(state): State<Arc<AppState>>,
    Path((server_id, role_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<UpdateRoleRequest>,
) -> impl IntoResponse {
    // Check user has MANAGE_ROLES permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_ROLES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_ROLES permission").into_response();
    }

    // Reject non-hex colors up front. Historically `color` was string-interpolated
    // straight into the UPDATE (C1 SQL injection); it is now bound, but validation
    // also keeps junk out of the column.
    if let Some(ref color) = payload.color {
        if !is_valid_hex_color(color) {
            return (StatusCode::BAD_REQUEST, "Invalid color (expected #RRGGBB)").into_response();
        }
    }

    // Load the target role (scoped to this server) to enforce hierarchy.
    let target: Option<(bool, i32)> = sqlx::query_as(
        "SELECT is_default, position FROM server_roles WHERE id = $1 AND server_id = $2",
    )
    .bind(role_id)
    .bind(&server_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let (target_is_default, target_position) = match target {
        Some(t) => t,
        None => return (StatusCode::NOT_FOUND, "Role not found").into_response(),
    };

    // Hierarchy guard (H1/M11): non-owner, non-admin editors are bounded.
    let authority = get_role_authority(&state.pool, &server_id, claims.sub).await;
    if !authority.is_privileged() {
        // @everyone is off-limits to non-owners (else a MANAGE_ROLES holder could
        // widen every member's baseline permissions).
        if target_is_default {
            return (
                StatusCode::FORBIDDEN,
                "Only the owner can edit the @everyone role",
            )
                .into_response();
        }
        // Can't edit a role at or above your own highest role (covers the Owner
        // role, position 100, for any non-owner).
        if target_position >= authority.highest_position {
            return (
                StatusCode::FORBIDDEN,
                "Cannot edit a role at or above your highest role",
            )
                .into_response();
        }
        // Can't raise a role to or above your own highest role.
        if let Some(new_pos) = payload.position {
            if new_pos >= authority.highest_position {
                return (
                    StatusCode::FORBIDDEN,
                    "Cannot move a role to or above your highest role",
                )
                    .into_response();
            }
        }
    }

    // Fully parameterized UPDATE — every field is bound via push_bind, never
    // interpolated (C1). Permissions are masked to the actor's own bits.
    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new("UPDATE server_roles SET ");
    let mut any = false;
    if let Some(ref name) = payload.name {
        if any {
            qb.push(", ");
        }
        qb.push("name = ").push_bind(name);
        any = true;
    }
    if let Some(ref color) = payload.color {
        if any {
            qb.push(", ");
        }
        qb.push("color = ").push_bind(color);
        any = true;
    }
    if let Some(perms) = payload.permissions {
        if any {
            qb.push(", ");
        }
        qb.push("permissions = ")
            .push_bind(authority.mask_permissions(perms));
        any = true;
    }
    if let Some(pos) = payload.position {
        if any {
            qb.push(", ");
        }
        qb.push("position = ").push_bind(pos);
        any = true;
    }

    if !any {
        return StatusCode::OK.into_response();
    }

    qb.push(" WHERE id = ")
        .push_bind(role_id)
        .push(" AND server_id = ")
        .push_bind(&server_id);
    let _ = qb.build().execute(&state.pool).await;

    // A permissions edit changes members' effective channel access — notify the
    // server and evict now-VIEW-denied users from its live rooms. Name/color/
    // position edits don't affect resolution, so skip the fan-out for those.
    if payload.permissions.is_some() {
        crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;
    }

    StatusCode::OK.into_response()
}

/// Delete a role
pub async fn delete_role(
    State(state): State<Arc<AppState>>,
    Path((server_id, role_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check user has MANAGE_ROLES permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_ROLES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_ROLES permission").into_response();
    }

    // Load the target role (scoped to this server) to enforce hierarchy.
    let target: Option<(bool, i32)> = sqlx::query_as(
        "SELECT is_default, position FROM server_roles WHERE id = $1 AND server_id = $2",
    )
    .bind(role_id)
    .bind(&server_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let (target_is_default, target_position) = match target {
        Some(t) => t,
        None => return (StatusCode::NOT_FOUND, "Role not found").into_response(),
    };

    // Don't allow deleting the default (@everyone) role.
    if target_is_default {
        return (StatusCode::BAD_REQUEST, "Cannot delete @everyone role").into_response();
    }

    // Hierarchy guard, mirroring update_role (H1/M11): without it a low-position
    // MANAGE_ROLES holder could DELETE a role at or above their own — including
    // the Owner role (position 100, backfilled by migration 042) and any
    // administrator role — stripping its holders of their permissions and, with
    // the Owner role gone, decapitating the server. A non-owner/non-admin may
    // only delete a role strictly below their highest.
    let authority = get_role_authority(&state.pool, &server_id, claims.sub).await;
    if !authority.is_privileged() && target_position >= authority.highest_position {
        return (
            StatusCode::FORBIDDEN,
            "Cannot delete a role at or above your highest role",
        )
            .into_response();
    }

    let _ = sqlx::query("DELETE FROM server_roles WHERE id = $1 AND server_id = $2")
        .bind(role_id)
        .bind(&server_id)
        .execute(&state.pool)
        .await;

    // Deleting a role strips its permissions (and cascades its channel
    // overwrites + assignments) — same fan-out as a permissions edit.
    crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;

    StatusCode::OK.into_response()
}

/// Assign a role to a user
pub async fn assign_role(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id, role_id)): Path<(String, i64, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Privilege-escalation guard: without this, ANY member could grant any role
    // (including ones carrying KICK/BAN/ADMINISTRATOR) to themselves.
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_ROLES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_ROLES permission").into_response();
    }

    // C2(a): the role MUST belong to THIS server. Without this check a member of
    // server B could insert member_roles(server=B, role=<A's admin role>) and, via
    // the permission query, inherit server A's admin bits (cross-server priv-esc).
    let target: Option<(i32, bool, i64)> = sqlx::query_as(
        "SELECT position, is_default, permissions FROM server_roles WHERE id = $1 AND server_id = $2"
    )
    .bind(role_id)
    .bind(&server_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let (target_position, _target_is_default, target_perms) = match target {
        Some(t) => t,
        None => return (StatusCode::NOT_FOUND, "Role not found on this server").into_response(),
    };

    // Hierarchy guard (H1/M11): a non-owner, non-admin actor may not assign a role
    // that sits at or above their own highest role, nor one carrying permission
    // bits they don't themselves hold (an ADMINISTRATOR role below their position
    // would otherwise be a clean self-escalation).
    let authority = get_role_authority(&state.pool, &server_id, claims.sub).await;
    if !authority.is_privileged() {
        if target_position >= authority.highest_position {
            return (
                StatusCode::FORBIDDEN,
                "Cannot assign a role at or above your highest role",
            )
                .into_response();
        }
        if (target_perms as u64) & !authority.perms.bits() != 0 {
            return (
                StatusCode::FORBIDDEN,
                "Cannot assign a role with permissions you don't have",
            )
                .into_response();
        }
    }

    let _ = sqlx::query(
        "INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING"
    )
    .bind(&server_id)
    .bind(user_id as i32)
    .bind(role_id)
    .execute(&state.pool)
    .await;

    // Role assignment changes the member's effective channel permissions.
    crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;

    StatusCode::OK.into_response()
}

/// Remove a role from a user
pub async fn remove_role(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id, role_id)): Path<(String, i64, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Same guard as assign_role: only MANAGE_ROLES holders may strip roles.
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_ROLES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_ROLES permission").into_response();
    }

    // Hierarchy guard, mirroring assign_role (H1/M11). GRANTING was gated but
    // REMOVING was not, so a plain MANAGE_ROLES holder could strip a role that
    // outranks their own — demoting co-administrators, or the Owner role. The
    // role lookup is scoped to this server for the same reason as C2(a).
    let target: Option<(i32,)> =
        sqlx::query_as("SELECT position FROM server_roles WHERE id = $1 AND server_id = $2")
            .bind(role_id)
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    let target_position = match target {
        Some((p,)) => p,
        None => return (StatusCode::NOT_FOUND, "Role not found on this server").into_response(),
    };
    let authority = get_role_authority(&state.pool, &server_id, claims.sub).await;
    if !authority.is_privileged() && target_position >= authority.highest_position {
        return (
            StatusCode::FORBIDDEN,
            "Cannot remove a role at or above your highest role",
        )
            .into_response();
    }

    let _ = sqlx::query(
        "DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3",
    )
    .bind(&server_id)
    .bind(user_id as i32)
    .bind(role_id)
    .execute(&state.pool)
    .await;

    // Stripping a role changes the member's effective channel permissions —
    // this may revoke VIEW somewhere, so the eviction pass matters here.
    crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;

    StatusCode::OK.into_response()
}

/// List members with their roles (for member list display)
pub async fn list_members_with_roles(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Verify member - user_id is INTEGER (i32)
    let is_member: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member").into_response();
    }

    // Get server owner - owner_id is INTEGER (i32)
    let owner_id: (i32,) = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or((0,));

    // Get all members with optional server nicknames - users.id is INTEGER (i32)
    let members: Vec<(i32, String, Option<String>, Option<String>, Option<String>, bool, Option<String>, Option<String>, bool)> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, u.avatar_file_id, sn.nickname, u.show_online_status,
                CASE WHEN sm.custom_sounds_disabled THEN NULL ELSE u.join_sound_file_id END,
                CASE WHEN sm.custom_sounds_disabled THEN NULL ELSE u.leave_sound_file_id END,
                sm.custom_sounds_disabled
         FROM users u
         JOIN server_members sm ON u.id = sm.user_id
         LEFT JOIN server_nicknames sn ON sn.user_id = u.id AND sn.server_id = sm.server_id
         WHERE sm.server_id = $1"
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut result: Vec<MemberWithRoles> = Vec::new();

    for (
        user_id,
        username,
        display_name,
        avatar_file_id,
        server_nickname,
        shows_online,
        join_sound_file_id,
        leave_sound_file_id,
        custom_sounds_disabled,
    ) in members
    {
        // Get user's roles
        let user_roles: Vec<(i64, String, String, String, i64, i32, bool)> = sqlx::query_as(
            "SELECT r.id, r.server_id, r.name, r.color, r.permissions, r.position, r.is_default
             FROM server_roles r
             JOIN member_roles mr ON r.id = mr.role_id AND r.server_id = mr.server_id
             WHERE mr.server_id = $1 AND mr.user_id = $2
             ORDER BY r.position DESC",
        )
        .bind(&server_id)
        .bind(user_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

        let roles: Vec<RoleResponse> = user_roles
            .into_iter()
            .map(
                |(id, server_id, name, color, permissions, position, is_default)| RoleResponse {
                    id,
                    server_id,
                    name,
                    color,
                    permissions,
                    position,
                    is_default,
                },
            )
            .collect();

        let top_color = roles
            .first()
            .map(|r| r.color.clone())
            .unwrap_or("#99AAB5".to_string());
        let is_owner = user_id == owner_id.0;

        result.push(MemberWithRoles {
            id: user_id as i64,
            username,
            display_name,
            server_nickname,
            // Hidden status reads as offline to everyone but the user themself.
            is_online: state.is_user_visibly_online(user_id as i64)
                && (shows_online || user_id as i64 == claims.sub),
            roles,
            top_role_color: top_color,
            is_owner,
            avatar_file_id,
            join_sound_file_id,
            leave_sound_file_id,
            custom_sounds_disabled,
        });
    }

    // Sort: owners first, then by top role position
    result.sort_by(|a, b| {
        if a.is_owner != b.is_owner {
            return b.is_owner.cmp(&a.is_owner);
        }
        let a_pos = a.roles.first().map(|r| r.position).unwrap_or(0);
        let b_pos = b.roles.first().map(|r| r.position).unwrap_or(0);
        b_pos.cmp(&a_pos)
    });

    Json(result).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_color_accepts_valid_rrggbb() {
        assert!(is_valid_hex_color("#99AAB5"));
        assert!(is_valid_hex_color("#000000"));
        assert!(is_valid_hex_color("#ffffff"));
        assert!(is_valid_hex_color("#F1c40F"));
    }

    #[test]
    fn hex_color_rejects_injection_and_garbage() {
        // The exact C1 exploit shape must be rejected.
        assert!(!is_valid_hex_color(
            "x', permissions=4194304 WHERE server_id=$2 OR $1=$1--"
        ));
        assert!(!is_valid_hex_color("#99AAB")); // too short
        assert!(!is_valid_hex_color("#99AAB55")); // too long
        assert!(!is_valid_hex_color("99AAB5")); // missing #
        assert!(!is_valid_hex_color("#gggggg")); // non-hex
        assert!(!is_valid_hex_color(""));
        assert!(!is_valid_hex_color("#12 45 6"));
    }

    fn authority(is_owner: bool, perms: Permissions, highest_position: i32) -> RoleAuthority {
        RoleAuthority {
            is_owner,
            perms,
            highest_position,
        }
    }

    #[test]
    fn mask_permissions_clamps_to_actor_bits() {
        // A MANAGE_ROLES holder without ADMINISTRATOR cannot mint ADMINISTRATOR.
        let actor = authority(
            false,
            Permissions::MANAGE_ROLES | Permissions::KICK_MEMBERS,
            5,
        );
        let requested = (Permissions::ADMINISTRATOR | Permissions::KICK_MEMBERS).bits() as i64;
        let masked = actor.mask_permissions(requested);
        let masked = Permissions::from_bits_truncate(masked as u64);
        assert!(
            !masked.contains(Permissions::ADMINISTRATOR),
            "ADMINISTRATOR must be masked out"
        );
        assert!(
            masked.contains(Permissions::KICK_MEMBERS),
            "a held bit is preserved"
        );
    }

    #[test]
    fn mask_permissions_owner_and_admin_are_exempt() {
        let requested = (Permissions::ADMINISTRATOR | Permissions::BAN_MEMBERS).bits() as i64;
        // Owner: no masking.
        let owner = authority(true, Permissions::empty(), 0);
        assert_eq!(owner.mask_permissions(requested), requested);
        // ADMINISTRATOR holder: no masking.
        let admin = authority(false, Permissions::ADMINISTRATOR, 10);
        assert_eq!(admin.mask_permissions(requested), requested);
    }

    #[test]
    fn is_privileged_tracks_owner_and_admin() {
        assert!(authority(true, Permissions::empty(), 0).is_privileged());
        assert!(authority(false, Permissions::ADMINISTRATOR, 0).is_privileged());
        assert!(!authority(false, Permissions::MANAGE_ROLES, 9).is_privileged());
    }
}
