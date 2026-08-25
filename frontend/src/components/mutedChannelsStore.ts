// Per-device muted-CHANNEL preferences (localStorage), sibling of
// mutedServersStore. Muting a channel suppresses its notification sound on THIS
// device (a message ping is gated on BOTH the server AND the channel not being
// muted). Independent of server mute — you can mute one noisy channel without
// muting the whole server.

const MUTED_CHANNELS_KEY = 'sovereign_muted_channels';

export function getMutedChannels(): Record<string, boolean> {
    try {
        const stored = localStorage.getItem(MUTED_CHANNELS_KEY);
        const parsed = stored ? JSON.parse(stored) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function isChannelMuted(channelId: number | string): boolean {
    return getMutedChannels()[String(channelId)] === true;
}

export function toggleChannelMute(channelId: number | string): boolean {
    const key = String(channelId);
    const muted = getMutedChannels();
    const next = !muted[key];
    if (next) {
        muted[key] = true;
    } else {
        delete muted[key];
    }
    try { localStorage.setItem(MUTED_CHANNELS_KEY, JSON.stringify(muted)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('channelMuteChanged', { detail: { channelId: key, muted: next } }));
    return next;
}

// --- Hide Muted Channels (per-server, per-device) -------------------------
// The server context menu's toggle: collapse muted channels out of the
// channel list entirely. The ACTIVE channel is always shown even if muted,
// so toggling this can never make the channel you're reading vanish.

const HIDE_MUTED_KEY = 'sovereign_hide_muted_channels';

function getHideMutedMap(): Record<string, boolean> {
    try {
        const stored = localStorage.getItem(HIDE_MUTED_KEY);
        const parsed = stored ? JSON.parse(stored) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function isHideMutedChannels(serverId: string): boolean {
    return getHideMutedMap()[serverId] === true;
}

export function toggleHideMutedChannels(serverId: string): boolean {
    const map = getHideMutedMap();
    const next = !map[serverId];
    if (next) map[serverId] = true;
    else delete map[serverId];
    try { localStorage.setItem(HIDE_MUTED_KEY, JSON.stringify(map)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('hideMutedChanged', { detail: { serverId, hidden: next } }));
    return next;
}
