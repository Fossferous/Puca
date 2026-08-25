// Per-user LOCAL avatar preferences (persisted in localStorage, this device
// only — the other user is never told). Same shape as userVolumeStore: plain
// getters over localStorage + a CustomEvent so mounted avatars react live.

const HIDDEN_AVATARS_KEY = 'sovereign_hidden_avatars';

export function getHiddenAvatars(): Record<number, boolean> {
    try {
        const stored = localStorage.getItem(HIDDEN_AVATARS_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

export function isAvatarHidden(userId: number): boolean {
    return getHiddenAvatars()[userId] === true;
}

export function setAvatarHidden(userId: number, hidden: boolean) {
    const map = getHiddenAvatars();
    if (hidden) map[userId] = true;
    else delete map[userId];
    localStorage.setItem(HIDDEN_AVATARS_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent('avatarPrefsChanged', { detail: { userId, hidden } }));
}
