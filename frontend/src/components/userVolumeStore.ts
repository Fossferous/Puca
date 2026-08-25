// Per-user local audio volume/mute preferences, persisted in localStorage.
// Extracted from UserContextMenu so that component file only exports a component
// (keeps React Fast Refresh working).

const LOCAL_VOLUMES_KEY = 'sovereign_local_user_volumes';
const LOCAL_MUTES_KEY = 'sovereign_local_user_mutes';

// Get stored volumes from localStorage
export function getLocalUserVolumes(): Record<number, number> {
    try {
        const stored = localStorage.getItem(LOCAL_VOLUMES_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

// Get stored mutes from localStorage
export function getLocalUserMutes(): Record<number, boolean> {
    try {
        const stored = localStorage.getItem(LOCAL_MUTES_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

// Set volume for a user
export function setLocalUserVolume(userId: number, volume: number) {
    const volumes = getLocalUserVolumes();
    volumes[userId] = volume;
    localStorage.setItem(LOCAL_VOLUMES_KEY, JSON.stringify(volumes));
    // Dispatch event for other components to react
    window.dispatchEvent(new CustomEvent('userVolumeChanged', { detail: { userId, volume } }));
}

// Set mute for a user
export function setLocalUserMute(userId: number, muted: boolean) {
    const mutes = getLocalUserMutes();
    mutes[userId] = muted;
    localStorage.setItem(LOCAL_MUTES_KEY, JSON.stringify(mutes));
    window.dispatchEvent(new CustomEvent('userMuteChanged', { detail: { userId, muted } }));
}
