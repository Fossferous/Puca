import { useState } from 'react';
import { askConfirm } from '../api/appDialogs';
import { clearDiscordData } from '../api/discordWindow';

/**
 * Settings > Advanced > Desktop App, the Discord rows (api/discordWindow.ts,
 * docs/DISCORD.md): the switch that shows the rail's Discord entry, with a plain
 * account of what Púca can and cannot see, and the way out, "Sign out of
 * Discord and clear its data on this PC". Turning the switch off offers the way
 * out too. Rendered by SettingsModal only where the window exists.
 */
export function DiscordWindowSettings({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
    const [clearing, setClearing] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    const clear = async () => {
        setClearing(true);
        setStatus('Closing the Discord window and clearing its data…');
        try {
            const result = await clearDiscordData();
            setStatus(result === 'cleared'
                ? 'Discord is signed out on this PC and its data here is gone. Your Discord account is unchanged.'
                : 'Discord had nothing stored on this PC.');
        } catch (err) {
            setStatus(typeof err === 'string' && err ? err : "Púca could not clear Discord's data. Try again.");
        } finally {
            setClearing(false);
        }
    };

    const CLEAR_QUESTION =
        'Sign out of Discord and clear its data on this PC?\n\n'
        + 'This closes the Discord window and deletes what Discord keeps in it on this PC: '
        + 'your sign-in, cookies, cache and settings. Files you downloaded stay where you saved them. '
        + 'Your Discord account itself is not touched, and you can sign in again later. '
        + 'To end this sign-in at Discord as well, use Log Out in Discord first.';

    return (
        <>
            <div className="settings-option">
                <div className="option-info">
                    <label htmlFor="settings-show-discord">Show Discord in the server rail</label>
                    <span className="option-hint">
                        Adds a Discord button that opens Discord's own website in a window of its own.
                        Púca's code never runs in that window, and Púca cannot read the page, your
                        messages or your Discord sign-in. Your Púca server never sees any of it: the
                        window talks to Discord directly. Your Discord sign-in is kept in a separate
                        store on this PC. Links to other sites open in your browser. Off by default.
                    </span>
                </div>
                <input
                    id="settings-show-discord"
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                        const next = e.target.checked;
                        onChange(next);
                        if (!next) {
                            // The way out, offered at the moment someone turns it off.
                            void (async () => {
                                if (await askConfirm(CLEAR_QUESTION)) await clear();
                            })();
                        }
                    }}
                />
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label>Sign out of Discord and clear its data on this PC</label>
                    <span className="option-hint">
                        Closes the Discord window and deletes what Discord keeps in it on this PC (your
                        sign-in, cookies, cache and settings). Files you downloaded stay where you saved
                        them, and your Discord account is not touched. Use Log Out in Discord first to
                        end the sign-in at Discord as well.
                    </span>
                    {status && (
                        <span className="option-hint discord-clear-status" role="status">{status}</span>
                    )}
                </div>
                <button
                    type="button"
                    className="secondary-btn"
                    disabled={clearing}
                    onClick={async () => {
                        if (await askConfirm(CLEAR_QUESTION)) await clear();
                    }}
                >
                    Sign out and clear
                </button>
            </div>
        </>
    );
}
