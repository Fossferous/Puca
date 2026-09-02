#![allow(dead_code)]

use bitflags::bitflags;

bitflags! {
    /// Role-based permission flags using bitwise operations (the familiar chat-app model)
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct Permissions: u64 {
        // General permissions
        const VIEW_CHANNEL       = 1 << 0;
        const SEND_MESSAGES      = 1 << 1;
        const READ_MESSAGE_HISTORY = 1 << 2;
        const MANAGE_MESSAGES    = 1 << 3;
        const ATTACH_FILES       = 1 << 4;
        const EMBED_LINKS        = 1 << 5;
        const ADD_REACTIONS      = 1 << 6;
        const USE_EXTERNAL_EMOJIS = 1 << 7;

        // Voice permissions
        const CONNECT            = 1 << 8;
        const SPEAK              = 1 << 9;
        const VIDEO              = 1 << 10;
        const STREAM             = 1 << 11;  // Screen share / game stream
        const MUTE_MEMBERS       = 1 << 12;
        const DEAFEN_MEMBERS     = 1 << 13;
        const MOVE_MEMBERS       = 1 << 14;
        const USE_VOICE_ACTIVITY = 1 << 15;
        const PRIORITY_SPEAKER   = 1 << 16;

        // Admin permissions
        const MANAGE_CHANNELS    = 1 << 17;
        const MANAGE_ROLES       = 1 << 18;
        const MANAGE_SERVER      = 1 << 19;
        const KICK_MEMBERS       = 1 << 20;
        const BAN_MEMBERS        = 1 << 21;
        const ADMINISTRATOR      = 1 << 22;

        // Checklist task permissions
        const CREATE_TASKS       = 1 << 23;
        const COMPLETE_TASKS     = 1 << 24;
        const MANAGE_TASKS       = 1 << 25;

        // Clips (replay buffer, docs/CLIPS.md). Gated additionally by
        // servers.clips_enabled, which defaults FALSE, so this bit alone
        // grants nothing. Overwritable per channel like every non-admin bit.
        const CREATE_CLIPS       = 1 << 26;

        // Minting an invite code for the server. SERVER-scoped, not channel-
        // scoped (see OVERWRITABLE below): an invite is to the server, so a
        // per-channel overwrite for it would mean nothing.
        //
        // In DEFAULT_MEMBER because that is today's behaviour — `create_invite`
        // checked membership alone — and migration 055 ORs the bit onto every
        // existing @everyone role so nobody loses invite creation at deploy
        // time. What it buys is the ability to TAKE it away: before this,
        // the lowest-privilege member of a private server, including one with
        // VIEW_CHANNEL denied on every channel, could mint an unlimited
        // non-expiring code for it and there was no setting that said no.
        const CREATE_INVITE      = 1 << 27;

        // Default member permissions
        const DEFAULT_MEMBER = Self::VIEW_CHANNEL.bits()
                             | Self::SEND_MESSAGES.bits()
                             | Self::READ_MESSAGE_HISTORY.bits()
                             | Self::ATTACH_FILES.bits()
                             | Self::ADD_REACTIONS.bits()
                             | Self::CONNECT.bits()
                             | Self::SPEAK.bits()
                             | Self::VIDEO.bits()
                             | Self::USE_VOICE_ACTIVITY.bits()
                             | Self::CREATE_TASKS.bits()
                             | Self::COMPLETE_TASKS.bits()
                             | Self::CREATE_CLIPS.bits()
                             | Self::CREATE_INVITE.bits();
    }
}

impl Permissions {
    /// Check if this permission set has the ADMINISTRATOR flag (bypasses all checks)
    pub fn is_admin(&self) -> bool {
        self.contains(Permissions::ADMINISTRATOR)
    }

    /// Check if user has a specific permission (or is admin)
    pub fn has(&self, perm: Permissions) -> bool {
        self.is_admin() || self.contains(perm)
    }

    /// Convert to u64 for database storage
    pub fn to_bits_value(&self) -> u64 {
        self.bits()
    }

    /// Create from u64 (database value)
    pub fn from_bits_value(bits: u64) -> Self {
        Permissions::from_bits_truncate(bits)
    }
}

/// Represents a role that can be assigned to users
#[derive(Debug, Clone)]
pub struct Role {
    pub id: i64,
    pub name: String,
    pub color: u32,
    pub permissions: Permissions,
    pub position: i32,
}

/// Channel permission override (allow/deny for role or user)
#[derive(Debug, Clone)]
pub struct PermissionOverride {
    pub channel_id: i64,
    pub role_id: Option<i64>,
    pub user_id: Option<i64>,
    pub allow: Permissions,
    pub deny: Permissions,
}

/// Compute effective permissions for a user in a channel
/// Following the standard layered permission calculation used by most chat platforms:
/// 1. Base = Everyone role permissions
/// 2. Apply role permissions (union of all roles)
/// 3. Apply role-specific channel overrides
/// 4. Apply user-specific channel overrides
pub fn compute_channel_permissions(
    base_permissions: Permissions,
    role_overrides: &[PermissionOverride],
    user_override: Option<&PermissionOverride>,
) -> Permissions {
    // If admin, bypass all checks
    if base_permissions.is_admin() {
        return Permissions::all();
    }

    let mut perms = base_permissions;

    // Apply role overrides (sorted by role position ideally)
    for override_ in role_overrides {
        perms.remove(override_.deny);
        perms.insert(override_.allow);
    }

    // Apply user-specific override last (highest priority)
    if let Some(user_ov) = user_override {
        perms.remove(user_ov.deny);
        perms.insert(user_ov.allow);
    }

    perms
}

#[cfg(test)]
mod tests {
    use super::*;

    // Moderation hierarchy (can_moderate's pure core). Positive controls for the
    // audit finding: a bare KICK_MEMBERS / BAN_MEMBERS / timeout holder could act
    // on the owner and on administrators. mod=(owner?, admin?, pos).
    #[test]
    fn moderation_owner_is_untouchable_by_anyone() {
        // target is the owner: refused even for an admin and even for another
        // "owner"-flagged actor (there is only one, but prove the ordering).
        assert!(!moderation_allowed(false, true, 100, /*target_owner*/ true, 0));
        assert!(!moderation_allowed(true, true, 100, true, 0));
    }

    #[test]
    fn moderation_low_mod_cannot_reach_higher_or_equal_rank() {
        // A KICK holder at position 50 (not owner, not admin) vs an admin-ranked
        // target at 90 — this is the exact bug: 50 > 90 is false → refused.
        assert!(!moderation_allowed(false, false, 50, false, 90));
        // ...and cannot touch an equal-ranked peer (50 vs 50).
        assert!(!moderation_allowed(false, false, 50, false, 50));
        // ...and cannot touch itself (same rank).
        assert!(!moderation_allowed(false, false, 50, false, 50));
    }

    #[test]
    fn moderation_allows_acting_strictly_downward() {
        // The legitimate case must still work, or the fix would break moderation.
        assert!(moderation_allowed(false, false, 50, false, 0));
        assert!(moderation_allowed(false, false, 50, false, 49));
    }

    #[test]
    fn moderation_owner_and_admin_actors_bypass_position() {
        // Owner acts on anyone below (a high-ranked non-owner target).
        assert!(moderation_allowed(true, false, 0, false, 100));
        // Admin (exempt, matching the role-edit hierarchy) likewise.
        assert!(moderation_allowed(false, true, 10, false, 100));
    }

    #[test]
    fn test_default_member() {
        let perms = Permissions::DEFAULT_MEMBER;
        assert!(perms.has(Permissions::VIEW_CHANNEL));
        assert!(perms.has(Permissions::SEND_MESSAGES));
        assert!(!perms.has(Permissions::ADMINISTRATOR));
        assert!(!perms.has(Permissions::MANAGE_ROLES));
    }

    #[test]
    fn test_admin_bypass() {
        let admin = Permissions::ADMINISTRATOR;
        assert!(admin.has(Permissions::BAN_MEMBERS));
        assert!(admin.has(Permissions::MANAGE_SERVER));
    }

    #[test]
    fn test_bits_conversion() {
        let perms = Permissions::SEND_MESSAGES | Permissions::VIEW_CHANNEL;
        let bits = perms.to_bits_value();
        let restored = Permissions::from_bits_value(bits);
        assert_eq!(perms, restored);
    }

    #[test]
    fn test_default_member_gains_task_bits() {
        let perms = Permissions::DEFAULT_MEMBER;
        assert!(perms.has(Permissions::CREATE_TASKS));
        assert!(perms.has(Permissions::COMPLETE_TASKS));
        assert!(!perms.has(Permissions::MANAGE_TASKS));
    }

    // --- Overwrite layering (rows are (allow, deny, is_default)) ---

    #[test]
    fn test_layer_no_rows_keeps_base() {
        let base = Permissions::DEFAULT_MEMBER;
        assert_eq!(layer_overwrite_rows(1, base, &[]), base);
    }

    #[test]
    fn test_layer_everyone_deny_hides_channel() {
        let base = Permissions::DEFAULT_MEMBER;
        let rows = [(0, Permissions::VIEW_CHANNEL.bits() as i64, true)];
        let effective = layer_overwrite_rows(1, base, &rows);
        assert!(!effective.has(Permissions::VIEW_CHANNEL));
        assert!(effective.has(Permissions::SEND_MESSAGES));
    }

    #[test]
    fn test_layer_role_allow_beats_everyone_deny() {
        // @everyone denies VIEW; a role the user holds re-allows it. Role
        // overwrites apply after the @everyone overwrite, so allow wins.
        let base = Permissions::DEFAULT_MEMBER;
        let rows = [
            (0, Permissions::VIEW_CHANNEL.bits() as i64, true),
            (Permissions::VIEW_CHANNEL.bits() as i64, 0, false),
        ];
        let effective = layer_overwrite_rows(1, base, &rows);
        assert!(effective.has(Permissions::VIEW_CHANNEL));
    }

    #[test]
    fn test_layer_role_overwrites_union_allow_beats_deny() {
        // Two of the user's roles overwrite the same channel: one denies SEND,
        // another allows it. Non-default overwrites merge as a union with
        // deny-then-allow, so the allow wins regardless of row order.
        let base = Permissions::DEFAULT_MEMBER;
        let rows = [
            (0, Permissions::SEND_MESSAGES.bits() as i64, false),
            (Permissions::SEND_MESSAGES.bits() as i64, 0, false),
        ];
        let effective = layer_overwrite_rows(1, base, &rows);
        assert!(effective.has(Permissions::SEND_MESSAGES));

        let rows_reversed = [
            (Permissions::SEND_MESSAGES.bits() as i64, 0, false),
            (0, Permissions::SEND_MESSAGES.bits() as i64, false),
        ];
        let effective = layer_overwrite_rows(1, base, &rows_reversed);
        assert!(effective.has(Permissions::SEND_MESSAGES));
    }

    #[test]
    fn test_layer_admin_base_ignores_overwrites() {
        let base = Permissions::ADMINISTRATOR;
        let rows = [(0, Permissions::VIEW_CHANNEL.bits() as i64, true)];
        let effective = layer_overwrite_rows(1, base, &rows);
        assert!(effective.has(Permissions::VIEW_CHANNEL));
    }

    #[test]
    fn test_layer_overwrite_grants_task_bits() {
        // A member without MANAGE_TASKS can be granted it per-channel.
        let base = Permissions::DEFAULT_MEMBER;
        let rows = [(Permissions::MANAGE_TASKS.bits() as i64, 0, false)];
        let effective = layer_overwrite_rows(1, base, &rows);
        assert!(effective.has(Permissions::MANAGE_TASKS));
    }
}

/// Get a user's effective permissions in a server by combining all their role permissions.
/// Returns ADMINISTRATOR if user is the server owner.
pub async fn get_user_server_permissions(
    pool: &sqlx::PgPool,
    server_id: &str,
    user_id: i64,
) -> Permissions {
    // Check if user is server owner (owners have all permissions)
    // Cast user_id to i32 since owner_id is INTEGER in PostgreSQL
    let is_owner: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM servers WHERE id = $1 AND owner_id = $2")
            .bind(server_id)
            .bind(user_id as i32)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);

    if is_owner.is_some() {
        return Permissions::ADMINISTRATOR;
    }

    // A non-member gets NO permissions — not even the default @everyone role.
    // Without this gate the `OR sr.is_default = true` clause below hands every
    // authenticated user the @everyone bits (VIEW_CHANNEL, SEND_MESSAGES, …) for
    // ANY server, and a kicked/banned user keeps whatever roles were never
    // purged from member_roles. Membership (server_members) is the source of
    // truth; roles only layer on top of it.
    if !is_server_member(pool, server_id, user_id).await {
        return Permissions::empty();
    }

    // Get all role permissions for this user in this server.
    // `AND mr.server_id = sr.server_id` is load-bearing: without it a member_roles
    // row pairing THIS server with a role from ANOTHER server would match, letting
    // an attacker inherit a foreign server's role permissions here (cross-server
    // priv-esc, audit C2). member_roles is (server_id, user_id, role_id) — pin all
    // three to the evaluated server.
    let role_perms: Vec<(i64,)> = sqlx::query_as(
        r#"
        SELECT COALESCE(sr.permissions, 0) as permissions
        FROM server_roles sr
        LEFT JOIN member_roles mr ON sr.id = mr.role_id AND mr.server_id = sr.server_id
        WHERE sr.server_id = $1
        AND (mr.user_id = $2 OR sr.is_default = true)
        "#,
    )
    .bind(server_id)
    .bind(user_id as i32)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    // Combine all permissions with bitwise OR
    let mut combined = Permissions::empty();
    for (perm_bits,) in role_perms {
        combined |= Permissions::from_bits_truncate(perm_bits as u64);
    }

    combined
}

/// Check if user has a specific permission in a server
pub async fn user_has_permission(
    pool: &sqlx::PgPool,
    server_id: &str,
    user_id: i64,
    required: Permissions,
) -> bool {
    let perms = get_user_server_permissions(pool, server_id, user_id).await;
    perms.has(required)
}

/// `(is_owner, highest_role_position)` for `user_id` in `server_id`. Highest
/// position among roles the user actually holds (0 if none / not a member).
/// Server-scoped join mirrors the C2 permission-query fix so a cross-server
/// member_roles row can't inflate rank.
pub async fn member_rank(pool: &sqlx::PgPool, server_id: &str, user_id: i64) -> (bool, i32) {
    let is_owner: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM servers WHERE id = $1 AND owner_id = $2")
            .bind(server_id)
            .bind(user_id as i32)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
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
    (is_owner.is_some(), highest.map(|(p,)| p).unwrap_or(0))
}

/// Whether `actor` may take a moderation action (kick / ban / timeout) against
/// `target` in `server_id`, BY ROLE HIERARCHY only — the caller still checks the
/// permission bit (KICK_MEMBERS / BAN_MEMBERS) separately. Rules, matching the
/// role-editing hierarchy: the owner may act on anyone; NO ONE may act on the
/// owner; otherwise the actor must outrank the target (strictly higher top role
/// position). Equal rank (incl. acting on yourself, or two peers) is refused, so
/// a KICK_MEMBERS holder can no longer time out / kick / ban the owner, an
/// administrator, or an equal-ranked moderator.
pub async fn can_moderate(pool: &sqlx::PgPool, server_id: &str, actor: i64, target: i64) -> bool {
    let (target_owner, target_pos) = member_rank(pool, server_id, target).await;
    let (actor_owner, actor_pos) = member_rank(pool, server_id, actor).await;
    // Fetching admin status is only needed when neither ownership shortcut
    // decides it, but the extra query on a moderation action is negligible and
    // keeping it unconditional keeps the decision in one pure, tested function.
    let actor_admin = get_user_server_permissions(pool, server_id, actor)
        .await
        .is_admin();
    moderation_allowed(
        actor_owner,
        actor_admin,
        actor_pos,
        target_owner,
        target_pos,
    )
}

/// Pure moderation-hierarchy decision (DB-free, unit-tested — see the tests).
/// `can_moderate` fetches the ranks and delegates here.
///
/// - The owner is untouchable, even by an administrator (`target_owner`).
/// - The owner may act on anyone else (`actor_owner`).
/// - An administrator is exempt from the position check, matching the role-edit
///   hierarchy (`RoleAuthority::is_privileged`) — but never over the owner.
/// - Everyone else may act only on a member ranked STRICTLY below them, so a
///   bare KICK_MEMBERS / BAN_MEMBERS holder can never reach the owner, an
///   administrator (higher position), or an equal-ranked peer.
fn moderation_allowed(
    actor_owner: bool,
    actor_admin: bool,
    actor_pos: i32,
    target_owner: bool,
    target_pos: i32,
) -> bool {
    if target_owner {
        return false;
    }
    if actor_owner || actor_admin {
        return true;
    }
    actor_pos > target_pos
}

/// Result of resolving a channel and checking the caller's access to it.
pub enum ChannelAccess {
    /// User may access the channel; carries the owning server id.
    Allowed(String),
    /// Channel does not exist (or has no owning server).
    NotFound,
    /// Channel exists but the user is not a member of its server.
    Forbidden,
}

/// Resolve a channel's owning server and verify the caller is a member of it.
///
/// This is the baseline authorization gate for channel message operations
/// (read, send, search, pin). Without it, any authenticated user could act on
/// any channel simply by guessing its numeric id.
pub async fn check_channel_membership(
    pool: &sqlx::PgPool,
    channel_id: i64,
    user_id: i64,
) -> ChannelAccess {
    // Fail closed on DB errors, but LOUDLY: a silent unwrap_or(None) here turns
    // a transient pool/decode failure into "not a member", which cuts a
    // legitimate client off from its channels with nothing in the logs.
    // Width matched to this SQL text's other users (channels.id is INT4;
    // channel_handlers binds i32 — see the 22P03 note in device_token.rs).
    let server_id: Option<(Option<String>,)> =
        match sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
            .bind(channel_id as i32)
            .fetch_optional(pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!(
                    "check_channel_membership: channel lookup failed for channel {}: {}",
                    channel_id,
                    e
                );
                return ChannelAccess::NotFound;
            }
        };

    let server_id = match server_id {
        Some((Some(sid),)) => sid,
        _ => return ChannelAccess::NotFound,
    };

    if is_server_member(pool, &server_id, user_id).await {
        ChannelAccess::Allowed(server_id)
    } else {
        ChannelAccess::Forbidden
    }
}

/// Result of resolving a channel and the caller's effective permissions in it.
pub enum ChannelPermAccess {
    /// Channel does not exist (or has no owning server).
    NotFound,
    /// Channel exists but the caller is not a member of its server.
    NotMember,
    /// Caller is a member of the owning server; carries the server id and the
    /// caller's effective channel permissions. An ADMINISTRATOR bit means the
    /// caller is treated as having everything (Permissions::has bypasses).
    Allowed {
        server_id: String,
        perms: Permissions,
    },
}

impl Permissions {
    /// Bits a channel overwrite is allowed to set. Server-governance bits
    /// (ADMINISTRATOR, MANAGE_CHANNELS/ROLES/SERVER, KICK/BAN) must never be
    /// grantable through a per-channel allow mask — a MANAGE_CHANNELS holder
    /// could otherwise mint ADMINISTRATOR for a role via PUT /overwrites.
    /// Keeping MANAGE_CHANNELS out also means the overwrite endpoints' gate
    /// (server-level MANAGE_CHANNELS) always matches the channel-effective bit.
    pub const OVERWRITABLE: Self = Self::from_bits_truncate(
        Self::all().bits()
            & !(Self::ADMINISTRATOR.bits()
                | Self::MANAGE_CHANNELS.bits()
                | Self::MANAGE_ROLES.bits()
                | Self::MANAGE_SERVER.bits()
                | Self::KICK_MEMBERS.bits()
                | Self::BAN_MEMBERS.bits()
                // Server-scoped, like the admin bits above: create_invite
                // resolves SERVER permissions, so a channel overwrite for it
                // would be a control that silently does nothing.
                | Self::CREATE_INVITE.bits()),
    );
}

/// Layer a channel's overwrite rows onto base server permissions using the
/// compute_channel_permissions algorithm: the @everyone (is_default) overwrite
/// applies first (deny then allow), then the UNION of the caller's other role
/// overwrites (deny then allow). Rows are (allow, deny, is_default).
///
/// Overwrite masks are clamped to OVERWRITABLE (defense in depth alongside the
/// PUT-endpoint validation), and a base MANAGE_CHANNELS always retains
/// VIEW_CHANNEL so channel managers cannot lock themselves (or other managers)
/// out of a channel they can still administer.
fn layer_overwrite_rows(
    channel_id: i64,
    base: Permissions,
    rows: &[(i64, i64, bool)],
) -> Permissions {
    if rows.is_empty() && !base.is_admin() {
        return base;
    }
    let empty_override = |role_id: Option<i64>| PermissionOverride {
        channel_id,
        role_id,
        user_id: None,
        allow: Permissions::empty(),
        deny: Permissions::empty(),
    };
    let mut everyone = empty_override(None);
    let mut merged_roles = empty_override(None);
    for &(allow, deny, is_default) in rows {
        let target = if is_default {
            &mut everyone
        } else {
            &mut merged_roles
        };
        target.allow |= Permissions::from_bits_truncate(allow as u64) & Permissions::OVERWRITABLE;
        target.deny |= Permissions::from_bits_truncate(deny as u64) & Permissions::OVERWRITABLE;
    }
    let mut perms = compute_channel_permissions(base, &[everyone, merged_roles], None);
    if base.contains(Permissions::MANAGE_CHANNELS) {
        perms.insert(Permissions::VIEW_CHANNEL);
    }
    perms
}

/// Resolve a channel's owning server and the caller's EFFECTIVE permissions in
/// it: server owner -> ADMINISTRATOR; non-member -> NotMember; otherwise the OR
/// of the member's role permissions (roles held + @everyone) layered with this
/// channel's permission overwrites (see layer_overwrite_rows).
///
/// FAIL CLOSED: any DB error is logged and treated as no permission — a member
/// resolves to empty perms (every gate then denies), never to a default-allow.
pub async fn get_user_channel_permissions(
    pool: &sqlx::PgPool,
    channel_id: i64,
    user_id: i64,
) -> ChannelPermAccess {
    // Channel -> owning server + owner status in one round-trip.
    let row: Option<(Option<String>, bool)> = match sqlx::query_as(
        "SELECT c.server_id, COALESCE(s.owner_id = $2, false) \
         FROM channels c LEFT JOIN servers s ON c.server_id = s.id \
         WHERE c.id = $1",
    )
    .bind(channel_id)
    .bind(user_id as i32)
    .fetch_optional(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(
                "get_user_channel_permissions: channel lookup failed for channel {}: {}",
                channel_id,
                e
            );
            return ChannelPermAccess::NotFound;
        }
    };

    let (server_id, is_owner) = match row {
        Some((Some(sid), owner)) => (sid, owner),
        _ => return ChannelPermAccess::NotFound,
    };

    if is_owner {
        return ChannelPermAccess::Allowed {
            server_id,
            perms: Permissions::ADMINISTRATOR,
        };
    }

    if !is_server_member(pool, &server_id, user_id).await {
        return ChannelPermAccess::NotMember;
    }

    // Base = OR of the member's roles + the @everyone (is_default) role.
    // `AND mr.server_id = sr.server_id` prevents a cross-server member_roles row
    // from binding a foreign role's permissions to this channel's server (C2).
    let role_perms: Vec<(i64,)> = match sqlx::query_as(
        r#"
        SELECT COALESCE(sr.permissions, 0) as permissions
        FROM server_roles sr
        LEFT JOIN member_roles mr ON sr.id = mr.role_id AND mr.user_id = $2 AND mr.server_id = sr.server_id
        WHERE sr.server_id = $1
        AND (mr.user_id IS NOT NULL OR sr.is_default = true)
        "#,
    )
    .bind(&server_id)
    .bind(user_id as i32)
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(
                "get_user_channel_permissions: role fetch failed for server {} user {}: {}",
                server_id, user_id, e
            );
            return ChannelPermAccess::Allowed { server_id, perms: Permissions::empty() };
        }
    };
    let mut base = Permissions::empty();
    for (bits,) in role_perms {
        base |= Permissions::from_bits_truncate(bits as u64);
    }

    // ADMINISTRATOR skips overwrites entirely.
    if base.is_admin() {
        return ChannelPermAccess::Allowed {
            server_id,
            perms: base,
        };
    }

    // Overwrites for THIS channel restricted to the caller's roles + @everyone.
    let rows: Vec<(i64, i64, bool)> =
        match sqlx::query_as(
            r#"
        SELECT o.allow, o.deny, sr.is_default
        FROM channel_permission_overwrites o
        JOIN server_roles sr ON o.role_id = sr.id
        WHERE o.channel_id = $1
        AND (sr.is_default = true OR EXISTS (
            SELECT 1 FROM member_roles mr WHERE mr.role_id = o.role_id AND mr.user_id = $2
            AND mr.server_id = sr.server_id))
        "#,
        )
        .bind(channel_id)
        .bind(user_id as i32)
        .fetch_all(pool)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(
                "get_user_channel_permissions: overwrite fetch failed for channel {} user {}: {}",
                channel_id, user_id, e
            );
                return ChannelPermAccess::Allowed {
                    server_id,
                    perms: Permissions::empty(),
                };
            }
        };

    ChannelPermAccess::Allowed {
        server_id,
        perms: layer_overwrite_rows(channel_id, base, &rows),
    }
}

/// Effective per-channel permissions for `user_id` across many channels of ONE
/// server, fetching all relevant overwrites in a single query (no N+1). Every
/// requested channel id gets an entry. Callers must have verified the channels
/// belong to `server_id`. FAIL CLOSED: DB errors bubble up as Err so callers
/// refuse the request rather than defaulting open.
pub async fn get_user_channels_permissions(
    pool: &sqlx::PgPool,
    server_id: &str,
    user_id: i64,
    channel_ids: &[i64],
) -> Result<std::collections::HashMap<i64, Permissions>, sqlx::Error> {
    let mut map = std::collections::HashMap::with_capacity(channel_ids.len());
    if channel_ids.is_empty() {
        return Ok(map);
    }

    // Owner -> ADMINISTRATOR; non-member -> empty; else OR of role permissions.
    // (get_user_server_permissions already fails closed to empty on DB errors.)
    let base = get_user_server_permissions(pool, server_id, user_id).await;

    if base.is_admin() {
        for &cid in channel_ids {
            map.insert(cid, base);
        }
        return Ok(map);
    }

    // ONE query for every overwrite relevant to this user across the channels.
    let rows: Vec<(i64, i64, i64, bool)> = sqlx::query_as(
        r#"
        SELECT o.channel_id, o.allow, o.deny, sr.is_default
        FROM channel_permission_overwrites o
        JOIN server_roles sr ON o.role_id = sr.id
        WHERE o.channel_id = ANY($1)
        AND sr.server_id = $2
        AND (sr.is_default = true OR EXISTS (
            SELECT 1 FROM member_roles mr WHERE mr.role_id = o.role_id AND mr.user_id = $3
            AND mr.server_id = sr.server_id))
        "#,
    )
    .bind(channel_ids)
    .bind(server_id)
    .bind(user_id as i32)
    .fetch_all(pool)
    .await?;

    let mut by_channel: std::collections::HashMap<i64, Vec<(i64, i64, bool)>> =
        std::collections::HashMap::new();
    for (cid, allow, deny, is_default) in rows {
        by_channel
            .entry(cid)
            .or_default()
            .push((allow, deny, is_default));
    }

    for &cid in channel_ids {
        let perms = match by_channel.get(&cid) {
            Some(rows) => layer_overwrite_rows(cid, base, rows),
            None => base,
        };
        map.insert(cid, perms);
    }
    Ok(map)
}

/// User ids of every server member who can VIEW `channel_id` — the owner, plus
/// members whose layered channel permissions retain VIEW_CHANNEL. Used to keep
/// E2EE key distribution aligned with channel visibility: epoch keys must not
/// be wrapped for (or served to) members a VIEW deny has hidden the channel
/// from. FAIL CLOSED: DB errors bubble as Err so callers refuse the request.
pub async fn get_channel_viewer_ids(
    pool: &sqlx::PgPool,
    channel_id: i64,
    server_id: &str,
) -> Result<std::collections::HashSet<i64>, sqlx::Error> {
    let owner: Option<(i32,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(server_id)
        .fetch_optional(pool)
        .await?;

    // Every member with the OR of their held-role bits (0 when roleless).
    // `AND sr.server_id = sm.server_id` is the C2 cross-server pin the other
    // two resolvers carry: without it a member_roles row pointing at ANOTHER
    // server's role would fold that foreign role's bits into this server's
    // base — and could grant VIEW here that no role of THIS server grants.
    let member_bases: Vec<(i32, i64)> = sqlx::query_as(
        r#"
        SELECT sm.user_id, COALESCE(BIT_OR(sr.permissions), 0)
        FROM server_members sm
        LEFT JOIN member_roles mr ON mr.user_id = sm.user_id AND mr.server_id = sm.server_id
        LEFT JOIN server_roles sr ON sr.id = mr.role_id AND sr.server_id = sm.server_id
        WHERE sm.server_id = $1
        GROUP BY sm.user_id
        "#,
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;

    let default_bits: i64 = sqlx::query_as::<_, (i64,)>(
        "SELECT COALESCE(BIT_OR(permissions), 0) FROM server_roles \
         WHERE server_id = $1 AND is_default = true",
    )
    .bind(server_id)
    .fetch_one(pool)
    .await?
    .0;

    // This channel's overwrites + which members hold each overwritten role.
    let ov_rows: Vec<(i64, i64, i64, bool)> = sqlx::query_as(
        r#"
        SELECT o.role_id, o.allow, o.deny, sr.is_default
        FROM channel_permission_overwrites o
        JOIN server_roles sr ON o.role_id = sr.id
        WHERE o.channel_id = $1 AND sr.server_id = $2
        "#,
    )
    .bind(channel_id)
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    let role_ids: Vec<i64> = ov_rows.iter().filter(|r| !r.3).map(|r| r.0).collect();
    let mut role_members: std::collections::HashMap<i64, std::collections::HashSet<i64>> =
        std::collections::HashMap::new();
    if !role_ids.is_empty() {
        let rows: Vec<(i64, i32)> = sqlx::query_as(
            "SELECT role_id, user_id FROM member_roles WHERE server_id = $1 AND role_id = ANY($2)",
        )
        .bind(server_id)
        .bind(&role_ids)
        .fetch_all(pool)
        .await?;
        for (rid, uid) in rows {
            role_members.entry(rid).or_default().insert(uid as i64);
        }
    }

    let mut viewers = std::collections::HashSet::with_capacity(member_bases.len());
    if let Some((owner_id,)) = owner {
        viewers.insert(owner_id as i64);
    }
    for (uid, role_bits) in member_bases {
        let uid = uid as i64;
        let base = Permissions::from_bits_truncate((role_bits | default_bits) as u64);
        let rows: Vec<(i64, i64, bool)> = ov_rows
            .iter()
            .filter(|(rid, _, _, is_default)| {
                *is_default || role_members.get(rid).map_or(false, |m| m.contains(&uid))
            })
            .map(|&(_, allow, deny, is_default)| (allow, deny, is_default))
            .collect();
        if layer_overwrite_rows(channel_id, base, &rows).has(Permissions::VIEW_CHANNEL) {
            viewers.insert(uid);
        }
    }
    Ok(viewers)
}

/// Membership probe shared by the channel- and message-scoped checks.
/// DB errors are logged and mapped to `false` — fail closed, but LOUDLY: a
/// silent `unwrap_or(None)` here turned transient pool/decode failures into
/// "not a member" with nothing in the logs.
async fn is_server_member(pool: &sqlx::PgPool, server_id: &str, user_id: i64) -> bool {
    match sqlx::query_as::<_, (i32,)>(
        "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(server_id)
    .bind(user_id as i32)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.is_some(),
        Err(e) => {
            tracing::error!(
                "is_server_member: membership lookup failed for server {} user {}: {}",
                server_id,
                user_id,
                e
            );
            false
        }
    }
}

/// Resolve a message's owning server (via its channel) and verify the caller is
/// a member of it. Used to gate message-scoped actions such as reactions.
///
/// DM messages are also allowed when the caller participates in the
/// conversation; those return `Allowed` with an empty server id (DMs have no
/// owning server — callers only use the id for server-scoped extras like
/// custom emojis).
pub async fn check_message_membership(
    pool: &sqlx::PgPool,
    message_id: &str,
    user_id: i64,
) -> ChannelAccess {
    let server_id: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT c.server_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = $1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    let server_id = match server_id {
        Some((Some(sid),)) => sid,
        _ => {
            // Not a channel message — is it a DM message the caller can see?
            let dm_participant: Option<(i32,)> = sqlx::query_as(
                "SELECT 1 FROM dm_messages m JOIN dm_conversations c ON m.conversation_id = c.id \
                 WHERE m.id = $1 AND (c.user1_id = $2 OR c.user2_id = $2)",
            )
            .bind(message_id)
            .bind(user_id as i32)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            return if dm_participant.is_some() {
                ChannelAccess::Allowed(String::new())
            } else {
                ChannelAccess::NotFound
            };
        }
    };

    if is_server_member(pool, &server_id, user_id).await {
        ChannelAccess::Allowed(server_id)
    } else {
        ChannelAccess::Forbidden
    }
}

/// Like [`check_message_membership`], but channel messages additionally require
/// VIEW_CHANNEL on the message's channel: a member who is VIEW-denied gets
/// `NotFound` (hide the channel's existence, matching the HTTP matrix). DM
/// messages keep the participant-only check.
pub async fn check_message_view(
    pool: &sqlx::PgPool,
    message_id: &str,
    user_id: i64,
) -> ChannelAccess {
    let channel: Option<(i32,)> =
        match sqlx::query_as("SELECT channel_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!(
                    "check_message_view: message lookup failed for message {}: {}",
                    message_id,
                    e
                );
                return ChannelAccess::NotFound;
            }
        };

    let channel_id = match channel {
        Some((cid,)) => cid as i64,
        None => {
            // Not a channel message — is it a DM message the caller can see?
            let dm_participant: Option<(i32,)> = sqlx::query_as(
                "SELECT 1 FROM dm_messages m JOIN dm_conversations c ON m.conversation_id = c.id \
                 WHERE m.id = $1 AND (c.user1_id = $2 OR c.user2_id = $2)",
            )
            .bind(message_id)
            .bind(user_id as i32)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            return if dm_participant.is_some() {
                ChannelAccess::Allowed(String::new())
            } else {
                ChannelAccess::NotFound
            };
        }
    };

    match get_user_channel_permissions(pool, channel_id, user_id).await {
        ChannelPermAccess::Allowed { server_id, perms } => {
            if perms.has(Permissions::VIEW_CHANNEL) {
                ChannelAccess::Allowed(server_id)
            } else {
                ChannelAccess::NotFound
            }
        }
        ChannelPermAccess::NotFound => ChannelAccess::NotFound,
        ChannelPermAccess::NotMember => ChannelAccess::Forbidden,
    }
}

/// Like [`check_message_view`], but also hands back the caller's effective
/// channel permissions so a handler can check a further bit without resolving
/// them a second time. `None` perms means the message is a DM (no roles apply
/// there — DM access is participant-only), NOT "no permissions".
pub async fn check_message_view_perms(
    pool: &sqlx::PgPool,
    message_id: &str,
    user_id: i64,
) -> (ChannelAccess, Option<Permissions>) {
    let channel: Option<(i32,)> =
        match sqlx::query_as("SELECT channel_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!(
                    "check_message_view_perms: message lookup failed for message {}: {}",
                    message_id,
                    e
                );
                return (ChannelAccess::NotFound, None);
            }
        };

    let channel_id = match channel {
        Some((cid,)) => cid as i64,
        None => {
            let dm_participant: Option<(i32,)> = sqlx::query_as(
                "SELECT 1 FROM dm_messages m JOIN dm_conversations c ON m.conversation_id = c.id \
                 WHERE m.id = $1 AND (c.user1_id = $2 OR c.user2_id = $2)",
            )
            .bind(message_id)
            .bind(user_id as i32)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            return if dm_participant.is_some() {
                (ChannelAccess::Allowed(String::new()), None)
            } else {
                (ChannelAccess::NotFound, None)
            };
        }
    };

    match get_user_channel_permissions(pool, channel_id, user_id).await {
        ChannelPermAccess::Allowed { server_id, perms } => {
            if perms.has(Permissions::VIEW_CHANNEL) {
                (ChannelAccess::Allowed(server_id), Some(perms))
            } else {
                (ChannelAccess::NotFound, None)
            }
        }
        ChannelPermAccess::NotFound => (ChannelAccess::NotFound, None),
        ChannelPermAccess::NotMember => (ChannelAccess::Forbidden, None),
    }
}

#[cfg(test)]
mod create_clips_bit_tests {
    use super::Permissions;

    #[test]
    fn create_clips_is_bit_26_in_default_member_and_overwritable() {
        assert_eq!(Permissions::CREATE_CLIPS.bits(), 1 << 26);
        assert!(Permissions::DEFAULT_MEMBER.contains(Permissions::CREATE_CLIPS));
        assert!(Permissions::OVERWRITABLE.contains(Permissions::CREATE_CLIPS));
    }

    /// The backfill migration hard-codes the decimal value of the bit. Read from
    /// the migration file's SQL (not this test file), so moving the bit without
    /// following through in SQL goes red.
    #[test]
    fn the_backfill_migration_grants_exactly_this_bit() {
        let sql = include_str!("../migrations/051_backfill_create_clips.sql");
        let stmt: String = sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
        assert!(stmt.contains(&format!("permissions | {}", Permissions::CREATE_CLIPS.bits())), "051 must OR in {}: {stmt}", Permissions::CREATE_CLIPS.bits());
        assert!(stmt.contains("WHERE is_default = true"), "051 must be scoped to @everyone: {stmt}");
    }
}

#[cfg(test)]
mod create_invite_bit_tests {
    use super::Permissions;

    /// The bit must be 27 and must not collide with CREATE_CLIPS (26) — the two
    /// were added a fortnight apart and a mis-typed shift would silently make
    /// "can create invites" mean "can create clips".
    #[test]
    fn create_invite_is_bit_27_and_collides_with_nothing() {
        assert_eq!(Permissions::CREATE_INVITE.bits(), 1 << 27);
        assert_eq!(Permissions::CREATE_CLIPS.bits(), 1 << 26);
        assert!(
            (Permissions::CREATE_INVITE & Permissions::CREATE_CLIPS).is_empty(),
            "CREATE_INVITE must not overlap CREATE_CLIPS"
        );
        // Every OTHER named flag is disjoint from it too.
        let others = Permissions::all() & !Permissions::CREATE_INVITE;
        assert!((others & Permissions::CREATE_INVITE).is_empty());
    }

    /// Behaviour-preserving by default: every member could invite before, so the
    /// bit ships in DEFAULT_MEMBER (and migration 055 backfills it onto every
    /// existing @everyone role). It is NOT overwritable per channel — invites
    /// are server-scoped and `create_invite` resolves SERVER permissions, so a
    /// channel overwrite for it would be a control that does nothing.
    #[test]
    fn create_invite_is_a_default_member_bit_and_is_not_channel_overwritable() {
        assert!(Permissions::DEFAULT_MEMBER.contains(Permissions::CREATE_INVITE));
        assert!(!Permissions::OVERWRITABLE.contains(Permissions::CREATE_INVITE));
        // The clips bit stays overwritable — this test must not be passing
        // because OVERWRITABLE is empty or the check is inverted.
        assert!(Permissions::OVERWRITABLE.contains(Permissions::CREATE_CLIPS));
    }

    /// The backfill hard-codes the bit's decimal value. Read the migration's own
    /// SQL (a DIFFERENT file from this test) so moving the bit without following
    /// through in SQL goes red — the same guard 051 carries.
    #[test]
    fn the_backfill_migration_grants_exactly_this_bit() {
        let sql = include_str!("../migrations/055_backfill_create_invite.sql");
        let stmt: String = sql
            .lines()
            .filter(|l| !l.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("
");
        assert!(
            stmt.contains(&format!("permissions | {}", Permissions::CREATE_INVITE.bits())),
            "055 must OR in {}: {stmt}",
            Permissions::CREATE_INVITE.bits()
        );
        assert!(
            stmt.contains("WHERE is_default = true"),
            "055 must be scoped to @everyone: {stmt}"
        );
    }
}

#[cfg(test)]
mod invite_expiry_clamp_tests {
    use crate::invite_handlers::{clamp_expiry_hours, MAX_EXPIRY_HOURS, MIN_EXPIRY_HOURS};

    /// `chrono::Duration::hours(i32::MAX as i64)` is roughly 245,000 years: the
    /// timestamp overflows the column on the way in. A negative value is worse
    /// in a quieter way — the invite is born expired while the response tells
    /// the creator it expires in the past.
    #[test]
    fn the_clamp_bounds_both_ends() {
        assert_eq!(clamp_expiry_hours(i32::MAX), MAX_EXPIRY_HOURS);
        assert_eq!(clamp_expiry_hours(i32::MIN), MIN_EXPIRY_HOURS);
        assert_eq!(clamp_expiry_hours(0), MIN_EXPIRY_HOURS);
        assert_eq!(clamp_expiry_hours(-1), MIN_EXPIRY_HOURS);
        assert_eq!(clamp_expiry_hours(MAX_EXPIRY_HOURS + 1), MAX_EXPIRY_HOURS);
        // ... and leaves every ordinary value alone.
        for h in [1, 24, 168, 720, MAX_EXPIRY_HOURS] {
            assert_eq!(clamp_expiry_hours(h), h, "{h} is in range");
        }
    }

    /// The clamped maximum must survive the arithmetic the handler then does.
    #[test]
    fn the_clamped_maximum_produces_a_real_timestamp() {
        let hours = clamp_expiry_hours(i32::MAX);
        let when = chrono::Utc::now()
            .checked_add_signed(chrono::Duration::hours(hours as i64))
            .expect("a clamped lifetime must not overflow");
        assert!(when > chrono::Utc::now());
        assert!(when < chrono::Utc::now() + chrono::Duration::days(366));
    }
}
