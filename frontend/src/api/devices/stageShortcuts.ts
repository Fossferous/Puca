/**
 * The remote-control stage's OWN keyboard shortcuts — the few chords that act
 * here and are never sent to the computer being controlled.
 *
 * Esc used to be one: it paused control. That made Escape the one key the
 * desktop could never send, and closing a dialog or a game's menu on the far
 * side needs it constantly. Esc now goes over like every other key, and the
 * stage's own actions sit on Ctrl+Alt chords — Home and End are the Remote
 * Desktop client's (release the keyboard; Ctrl+Alt+Del), so the hands that
 * know RDP already know them. Ctrl+Alt+Del itself can never be one: Windows
 * keeps that chord for its own secure screen on THIS computer.
 */

export type StageShortcut = 'pause' | 'sas' | 'fullscreen';

/** What a key press means to the stage itself, or null when it is for the
 *  remote machine. Exactly Ctrl+Alt (no Shift, no Windows key) plus one key. */
export function stageShortcut(e: {
    code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
}): StageShortcut | null {
    if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return null;
    switch (e.code) {
        case 'Home': return 'pause';
        case 'End': return 'sas';
        case 'Enter':
        case 'NumpadEnter': return 'fullscreen';
        default: return null;
    }
}

/** The shortcuts as the Keyboard menu lists them. */
export const STAGE_SHORTCUTS: ReadonlyArray<{ keys: string; what: string }> = [
    { keys: 'Ctrl+Alt+Home', what: 'Pause or resume control' },
    { keys: 'Ctrl+Alt+End', what: 'Ctrl+Alt+Del on that computer' },
    { keys: 'Ctrl+Alt+Enter', what: 'Fullscreen' },
];
