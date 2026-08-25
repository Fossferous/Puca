// Per-device muted-server preferences, persisted in localStorage (same
// pattern as userVolumeStore). Muting a server suppresses its notification
// surfaces on THIS device — the channel unread badges, message blips and
// desktop toasts; any future notification wiring must gate on the same store.
//
// Three levels per server (the context menu's "Notification Settings"):
//   'all'      — everything pings (the default; absent from storage)
//   'mentions' — only @mentions ping. Because messages are E2EE, a mention is
//                only detectable in the channel you have OPEN — generic blips
//                and toasts are suppressed, the mention sound still plays.
//   'nothing'  — fully muted (stored as `true`, the legacy binary-mute value,
//                so blobs written before levels existed keep meaning "muted")

const MUTED_SERVERS_KEY = 'sovereign_muted_servers';

export type ServerNotifyLevel = 'all' | 'mentions' | 'nothing';

export function getMutedServers(): Record<string, boolean | string> {
    try {
        const stored = localStorage.getItem(MUTED_SERVERS_KEY);
        const parsed = stored ? JSON.parse(stored) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function getServerNotifyLevel(serverId: string): ServerNotifyLevel {
    const v = getMutedServers()[serverId];
    if (v === true) return 'nothing';
    if (v === 'mentions') return 'mentions';
    return 'all';
}

export function setServerNotifyLevel(serverId: string, level: ServerNotifyLevel): void {
    const map = getMutedServers();
    if (level === 'all') delete map[serverId];
    else if (level === 'nothing') map[serverId] = true; // legacy-compatible
    else map[serverId] = 'mentions';
    try { localStorage.setItem(MUTED_SERVERS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('serverMuteChanged', {
        detail: { serverId, muted: level === 'nothing', level },
    }));
}

/** Fully muted ('nothing'). Existing badge/sound consumers key off this. */
export function isServerMuted(serverId: string): boolean {
    return getServerNotifyLevel(serverId) === 'nothing';
}

/** Anything short of "all messages" — suppresses the GENERIC blip and toast
 *  ('mentions' keeps the mention sound, which self-gates elsewhere). */
export function isServerQuiet(serverId: string): boolean {
    return getServerNotifyLevel(serverId) !== 'all';
}

export function toggleServerMute(serverId: string): boolean {
    const next = getServerNotifyLevel(serverId) !== 'nothing';
    setServerNotifyLevel(serverId, next ? 'nothing' : 'all');
    return next;
}
