/**
 * The spoiler as 0.9.856 shipped it: a bare span, with no role, no tab stop, no name, and
 * its words in the accessibility tree whether hidden or not. Kept as it was so that
 * e2e/spoiler-keyboard-real-browser.mjs can run its checks against it: each is a NEGATIVE
 * CONTROL that must FAIL here (the page is built with this in place of components/Spoiler.tsx).
 * Not imported by the app.
 */
import React, { useState } from 'react';
import { SpoilerCover } from '../../components/spoilerCover';

export function Spoiler({ children }: { children: React.ReactNode }) {
    const [revealed, setRevealed] = useState(false);
    return (
        <span
            className={`spoiler ${revealed ? 'revealed' : ''}`}
            onClick={(e) => {
                const control = (e.target as Element).closest('a, button, [role="button"]');
                if (revealed && control && e.currentTarget.contains(control)) return;
                setRevealed(!revealed);
            }}
        >
            <SpoilerCover.Provider value={!revealed}>{children}</SpoilerCover.Provider>
        </span>
    );
}
