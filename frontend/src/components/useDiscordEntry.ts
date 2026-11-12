import { useCallback, useEffect, useState } from 'react';
import { discordEntryShown, openDiscordWindow } from '../api/discordWindow';
import { loadSettings } from './settingsStore';

/**
 * The rail's Discord entry (api/discordWindow.ts): what to hand ServerList as
 * `onOpenDiscord`, or `undefined` for no entry. Follows Settings > Advanced >
 * "Show Discord in the server rail" live, with no reload. `onError` gets a
 * sentence for the person when the window could not be opened.
 */
export function useDiscordEntry(onError: (text: string) => void): (() => void) | undefined {
    const [shown, setShown] = useState(() => discordEntryShown(loadSettings()));
    useEffect(() => {
        const sync = () => setShown(discordEntryShown(loadSettings()));
        window.addEventListener('settingsChanged', sync);
        return () => window.removeEventListener('settingsChanged', sync);
    }, []);
    const open = useCallback(() => {
        openDiscordWindow().catch((err: unknown) => {
            // The shell's refusals are written for people (discord_window.rs).
            onError(typeof err === 'string' && err ? err : 'Could not open the Discord window.');
        });
    }, [onError]);
    return shown ? open : undefined;
}
