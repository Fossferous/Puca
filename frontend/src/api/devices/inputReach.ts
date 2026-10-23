/**
 * "Your input is not landing", said in words.
 *
 * Windows silently drops injected input aimed at a window whose program runs
 * at a higher integrity level than the injector — an app run as administrator,
 * Task Manager on an administrator account, a game started by an elevated
 * launcher (UIPI). The host's agent can see it happening (input_reach.rs) and
 * names the program; this module is the one place that decides what a viewer
 * may be told and how it reads.
 *
 * The name crosses two trust boundaries — the agent's pipe on the host, then
 * the E2EE relay on the controller — so both ends pass it through
 * `blockedAppName`, which accepts a short file name and nothing else. A
 * malformed value reads as "not blocked": this only ever adds a banner, and a
 * garbled frame must not be able to paste one over a working session.
 */

/** The longest program name the banner will carry (the agent caps at 64). */
const MAX_APP_NAME = 64;

/** A program's file name as the agent reports it, or null for anything that
 *  is not one: empty, too long, a path, or holding control characters. */
export function blockedAppName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    if (!name || name.length > MAX_APP_NAME) return null;
    if (/[\\/]/.test(name)) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return null;
    return name;
}

/** Programs whose file name tells a person nothing, named for them. Lower-case
 *  keys; anything else is shown as its file name. */
const FRIENDLY: Record<string, string> = {
    'consent.exe': 'a Windows administrator prompt',
    'taskmgr.exe': 'Task Manager',
    'regedit.exe': 'Registry Editor',
    'mmc.exe': 'a Windows management console',
    'cmd.exe': 'an administrator Command Prompt',
    'powershell.exe': 'an administrator PowerShell',
    'pwsh.exe': 'an administrator PowerShell',
    'windowsterminal.exe': 'an administrator Terminal',
};

/** How the banner names the program. */
export function blockedAppLabel(app: string): string {
    return FRIENDLY[app.toLowerCase()] ?? app;
}

/** The banner's sentence: what is happening, and what to do about it. */
export function inputBlockedMessage(app: string, peerName: string | null): string {
    const pc = peerName?.trim() || 'that computer';
    const label = blockedAppLabel(app);
    const isPrompt = app.toLowerCase() === 'consent.exe';
    if (isPrompt) {
        return `${pc} is showing ${label}, and Windows does not let remote control `
            + 'answer it. Someone at that computer has to click it, or cancel it with Ctrl+Alt+Del.';
    }
    return `${label} on ${pc} is running as administrator, so Windows blocks remote control `
        + 'from clicking or typing in it. Close it, or start it again without administrator rights '
        + '(for a game: start Steam or its launcher normally, not as administrator).';
}
