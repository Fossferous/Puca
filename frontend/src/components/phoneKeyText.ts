/**
 * What a key press types on a PHONE being controlled (StreamStage), or null
 * to send it as a key. A phone types characters, not keys, so the character
 * this keyboard's layout makes of the key goes as text; held with Ctrl, Alt
 * or the Meta key it is a shortcut and goes as a key.
 *
 * Except where that modifier is how the character is typed:
 * - AltGr, which Windows reports as Ctrl AND Alt: '@' on a German keyboard is
 *   AltGr+Q, and went as KeyQ, which typed a 'q'. The browser says AltGr
 *   apart from Ctrl+Alt through getModifierState('AltGraph').
 * - Option on a Mac, which is Alt to the browser and types the layout's
 *   third characters ('@' is Option+L on a German Mac).
 */
export function phoneKeyText(
    e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'> & {
        getModifierState?(key: 'AltGraph'): boolean;
    },
    mac: boolean,
): string | null {
    // One character (a named key such as 'Enter' or 'Dead' is not text).
    if ([...e.key].length !== 1) return null;
    if (e.metaKey) return null;
    if (!e.ctrlKey && !e.altKey) return e.key;
    if (e.getModifierState?.('AltGraph') === true) return e.key;
    if (mac && e.altKey && !e.ctrlKey) return e.key;
    return null;
}

/** A Mac's keyboard (Option types characters), from what the browser says. */
export function macKeyboard(): boolean {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return /mac/i.test(platform);
}
