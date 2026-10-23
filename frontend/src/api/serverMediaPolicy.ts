/**
 * "Require encryption for calls", pushed live (audit 2026-10, second review).
 *
 * The owner's setting (`servers.require_media_e2ee`) reaches a running call
 * through the cached server rows: Chat hands the voice channel's server row's
 * value to VoicePanel, whose effect calls `webrtcManager.setRequireMediaE2ee`,
 * and on an engine that cannot encrypt that rebuilds every peer under the
 * join-time guards. But the rows were only ever refetched by the owner's own
 * client, so every other member's call went on under the value their list had
 * when it was fetched. The server now pushes `MediaE2eeRequired` to every
 * member when the setting is saved, and this is what lands it in the rows.
 */

/** The owner saved "Require encryption for calls" for a server (server -> client). */
export interface MediaE2eeRequiredFrame {
    server_id: string;
    require_media_e2ee: boolean;
}

/** `MediaE2eeRequired`, checked; `null` for any other frame or a malformed one. */
export function parseMediaE2eeRequired(msg: { type: string; payload?: unknown }): MediaE2eeRequiredFrame | null {
    if (msg.type !== 'MediaE2eeRequired') return null;
    const p = msg.payload;
    if (!p || typeof p !== 'object') return null;
    const { server_id, require_media_e2ee } = p as Record<string, unknown>;
    if (typeof server_id !== 'string' || server_id === '' || typeof require_media_e2ee !== 'boolean') return null;
    return { server_id, require_media_e2ee };
}

/**
 * The cached server rows with one server's `require_media_e2ee` replaced. A
 * NEW array when it changes (react-query compares by identity); the same one
 * when the server is not listed or already says so.
 */
export function applyMediaE2eeRequired<T extends { id: string; require_media_e2ee?: boolean }>(
    rows: T[] | undefined,
    f: MediaE2eeRequiredFrame,
): T[] | undefined {
    if (!rows) return rows;
    const i = rows.findIndex(r => r.id === f.server_id);
    if (i === -1 || rows[i].require_media_e2ee === f.require_media_e2ee) return rows;
    const next = rows.slice();
    next[i] = { ...rows[i], require_media_e2ee: f.require_media_e2ee };
    return next;
}
