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

/**
 * Whether a key press must not reach a phone at all. A phone types
 * characters and knows a few named keys (Enter, Backspace, Escape as Back);
 * everything else it would get wrong:
 * - a character key held with Ctrl, Alt or the Meta key that is not how
 *   that character is typed (phoneKeyText said no): a phone has no
 *   shortcuts, and it typed the key under it (Ctrl+A typed an "a");
 * - a dead key or a desktop IME's keys ('Dead', 'Process', 'Unidentified'):
 *   the accent, or the composed text, never reaches the phone, and the key's
 *   own letter would (US-International ' then e typed "'é").
 */
export function phoneDropsKey(
    e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'> & {
        getModifierState?(key: 'AltGraph'): boolean;
    },
    mac: boolean,
): boolean {
    if (e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return true;
    return [...e.key].length === 1 && phoneKeyText(e, mac) === null;
}

/** A Mac's keyboard (Option types characters), from what the browser says. */
export function macKeyboard(): boolean {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return /mac/i.test(platform);
}
