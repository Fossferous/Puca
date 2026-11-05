/**
 * A `||spoiler||` in a message: hidden until pressed, pressed again to hide.
 *
 * It is a real control. Until 0.9.857 it was a bare span, which a keyboard could
 * not reach and a screen reader read out loud: the words are only painted out
 * (Chat.css, color: transparent), they were never out of the page. So:
 *
 *  - role="button" and tabIndex 0, named "Spoiler" and nothing more (the name never
 *    carries the hidden words), with aria-expanded for the state. Revealed, the name
 *    is its content, "Spoiler: " first (visually hidden), so the words are read once and
 *    a spoiler that holds only a picture or a file still has a name.
 *  - Hidden, the words are `inert` and aria-hidden: out of the accessibility tree,
 *    out of the tab order (a player or a link in it cannot be focused), and never a
 *    target of a pointer, which lands on the spoiler and reveals it.
 *  - Enter and Space press it, as on a button. Not a key a voice hotkey is bound to:
 *    api/hotkeys.ts swallows a hold on Space or Enter (swallowsHoldKey) so it presses
 *    nothing focused, by preventing the default of every keydown, and a control of
 *    its own has to ask `defaultPrevented`. So a push-to-talk on Space never reveals
 *    one, and a spoiler never gets in the way of a hotkey.
 *  - A key pressed on something INSIDE a revealed spoiler (a link, Download) is that
 *    one's own, and is not heard here.
 *
 * The press on the mouse and the screen reader's own activation (a click) are one
 * handler. A press on a link, a channel or a Download inside a revealed spoiler is
 * for that one, and would otherwise hide what it just pressed.
 */
import React, { useState } from 'react';
import { SpoilerCover } from './spoilerCover';

export function Spoiler({ children }: { children: React.ReactNode }) {
    const [revealed, setRevealed] = useState(false);
    return (
        <span
            className={`spoiler ${revealed ? 'revealed' : ''}`}
            role="button"
            tabIndex={0}
            aria-expanded={revealed}
            aria-label={revealed ? undefined : 'Spoiler'}
            onClick={(e) => {
                // Revealed, a press on a link, a channel or a Download is for that one, and would
                // otherwise hide what it just pressed. Hidden, they take no press (Chat.css). The
                // spoiler itself is a role="button" too, and a press on it is the one that counts.
                const control = (e.target as Element).closest('a, button, [role="button"]');
                if (revealed && control && control !== e.currentTarget && e.currentTarget.contains(control)) return;
                setRevealed(!revealed);
            }}
            onKeyDown={(e) => {
                // Only a key pressed on the spoiler itself: a link inside takes its own Enter.
                if (e.target !== e.currentTarget) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                // A hotkey bound to the key already took it (api/hotkeys.ts): it presses nothing.
                if (e.defaultPrevented) return;
                // Space would scroll the chat, and a held key would flicker it open and shut.
                e.preventDefault();
                if (e.repeat) return;
                setRevealed(!revealed);
            }}
        >
            {revealed && <span className="sr-only">Spoiler: </span>}
            <span className="spoiler-body" aria-hidden={revealed ? undefined : true} inert={!revealed}>
                <SpoilerCover.Provider value={!revealed}>{children}</SpoilerCover.Provider>
            </span>
        </span>
    );
}
