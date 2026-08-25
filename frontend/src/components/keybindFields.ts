/**
 * Every rebindable field, with the label shown when one collides. Lives outside
 * SettingsModal.tsx (a component file may only export components — react-refresh)
 * so a test can assert a new binding joined this list: the conflict detector and
 * the Keybinds tab both read it.
 */
export const BIND_FIELDS = [
    ['pttBinding', 'Push to Talk'],
    ['ptmBinding', 'Push to Mute'],
    ['toggleMuteBinding', 'Toggle Mute'],
    ['toggleDeafenBinding', 'Toggle Deafen'],
    ['openSettingsBinding', 'Open Settings'],
    ['searchBinding', 'Search Messages'],
    ['remoteControlKillKey', 'Screen-control kill switch'],
    ['saveClipBinding', 'Save clip'],
] as const;

export type BindField = (typeof BIND_FIELDS)[number][0];

/** Rows of the Keybinds tab, in display order — one list, one place. */
export const KEYBIND_TAB_ROWS: readonly (readonly [BindField, string])[] = [
    ['toggleMuteBinding', 'Toggle Mute (in a call)'],
    ['toggleDeafenBinding', 'Toggle Deafen (in a call)'],
    ['openSettingsBinding', 'Open Settings'],
    ['searchBinding', 'Search Messages'],
    ['pttBinding', 'Push to Talk (hold)'],
    ['ptmBinding', 'Push to Mute (hold)'],
    ['remoteControlKillKey', 'Screen-control kill switch'],
    ['saveClipBinding', 'Save clip (buffer must be armed)'],
];
