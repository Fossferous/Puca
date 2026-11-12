/**
 * Discord's own web app in a window of its own: the desktop app's rail entry
 * (src-tauri/src/discord_window.rs has the window; docs/USER_GUIDE.md, "Discord
 * in a window of its own", says what it is to the owner).
 *
 * Púca only OPENS that window. It opens https://discord.com/app in a separate
 * process with a WebView2 profile of its own; the owner signs in on Discord's
 * page and Púca never reads, stores, relays or automates anything there. This
 * module asks the shell to open it, and decides where the entry is offered.
 *
 * WHERE. The Windows desktop app only, full and Lite alike (Lite leaves out
 * remote control, and this is not remote control). Nowhere else, not even as a
 * link:
 *  - the web app is already a browser tab, and Discord refuses to be framed in
 *    one, so all it could offer is a link to discord.com, which every browser
 *    does better (a bookmark, a tab of its own) without Púca advertising
 *    another chat service to everyone who uses it;
 *  - on a phone, Discord's own app does this properly, with its own push
 *    notifications; a link to Discord's mobile web page would be the worse way.
 *  - the shell's window is Windows only (WebView2; the command refuses on any
 *    other OS), so a desktop build elsewhere does not show the entry either.
 */
import { isMobile, isTauri } from './platform';

/** Can this app open the Discord window at all? */
export function discordWindowAvailable(): boolean {
    if (!isTauri() || isMobile()) return false;
    return typeof navigator !== 'undefined' && /\bWindows\b/.test(navigator.userAgent);
}

/** Is the rail's Discord entry shown? Available here, and switched on in
 *  Settings > Advanced > Desktop App (off by default: Púca does not put another
 *  service in front of everyone who installs it). */
export function discordEntryShown(settings: { showDiscordEntry?: boolean }): boolean {
    return settings.showDiscordEntry === true && discordWindowAvailable();
}

/** Open the Discord window, or bring the open one forward. */
export async function openDiscordWindow(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('discord_window_open');
}
