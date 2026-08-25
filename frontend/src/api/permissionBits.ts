// Permission bit flags — frontend single source of truth, matching the
// backend bitflags in src/permissions.rs exactly. Two views over the same
// bits:
//
// - PERM: the subset gating code checks against a channel's `my_permissions`
//   (the resolved effective bits the backend returns per channel).
// - PERMISSIONS: the full flag map the role editors render as checkboxes.

export const PERM = {
    VIEW_CHANNEL: 1 << 0,
    SEND_MESSAGES: 1 << 1,
    READ_MESSAGE_HISTORY: 1 << 2,
    MANAGE_MESSAGES: 1 << 3,
    ATTACH_FILES: 1 << 4,
    ADD_REACTIONS: 1 << 6,
    MOVE_MEMBERS: 1 << 14,
    MANAGE_CHANNELS: 1 << 17,
    MANAGE_ROLES: 1 << 18,
    ADMINISTRATOR: 1 << 22,
    CREATE_TASKS: 1 << 23,
    COMPLETE_TASKS: 1 << 24,
    MANAGE_TASKS: 1 << 25,
    // Clips (replay buffer). Gated additionally by servers.clips_enabled, so
    // this bit alone grants nothing. Backend: permissions.rs CREATE_CLIPS.
    CREATE_CLIPS: 1 << 26,
} as const;

/**
 * Check an effective-permission bitset for a flag.
 *
 * `bits` being null/undefined means the backend didn't send `my_permissions`
 * (pre-migration server) — return true so older servers keep today's
 * everything-allowed behavior instead of locking the UI. ADMINISTRATOR
 * implies every permission.
 */
export function hasPerm(bits: number | null | undefined, flag: number): boolean {
    if (bits === null || bits === undefined) return true;
    return (bits & PERM.ADMINISTRATOR) !== 0 || (bits & flag) !== 0;
}

// Full flag map (matching backend permissions.rs) for the role editors.
export const PERMISSIONS = {
    // General
    VIEW_CHANNEL: 1 << 0,
    SEND_MESSAGES: 1 << 1,
    READ_MESSAGE_HISTORY: 1 << 2,
    MANAGE_MESSAGES: 1 << 3,
    ATTACH_FILES: 1 << 4,
    EMBED_LINKS: 1 << 5,
    ADD_REACTIONS: 1 << 6,
    USE_EXTERNAL_EMOJIS: 1 << 7,
    // Voice
    CONNECT: 1 << 8,
    SPEAK: 1 << 9,
    VIDEO: 1 << 10,
    STREAM: 1 << 11,
    MUTE_MEMBERS: 1 << 12,
    DEAFEN_MEMBERS: 1 << 13,
    MOVE_MEMBERS: 1 << 14,
    USE_VOICE_ACTIVITY: 1 << 15,
    PRIORITY_SPEAKER: 1 << 16,
    // Admin
    MANAGE_CHANNELS: 1 << 17,
    MANAGE_ROLES: 1 << 18,
    MANAGE_SERVER: 1 << 19,
    KICK_MEMBERS: 1 << 20,
    BAN_MEMBERS: 1 << 21,
    ADMINISTRATOR: 1 << 22,
    // Tasks
    CREATE_TASKS: 1 << 23,
    COMPLETE_TASKS: 1 << 24,
    MANAGE_TASKS: 1 << 25,
    // Clips
    CREATE_CLIPS: 1 << 26,
} as const;
