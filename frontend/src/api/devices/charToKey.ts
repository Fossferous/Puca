/**
 * A single typed character expressed as the PHYSICAL key that produces it —
 * for the keyboard overlay's modifier latch.
 *
 * WHY THIS EXISTS. Characters from the soft keyboard travel as `{t:'text'}`
 * frames, which the Windows host injects with KEYEVENTF_UNICODE — and a held
 * modifier provably cannot change what a unicode injection produces
 * (crates/puca-input/src/lib.rs states this at its ControlInput doc). So
 * "latch Ctrl, type a" can only become Ctrl+A if the `a` is re-routed as a
 * `{t:'key', code:'KeyA'}` frame while the modifier is down. This map is that
 * re-route's dictionary.
 *
 * US-LAYOUT POSITIONS, the same assumption the physical-keyboard forwarding
 * path already makes: the host maps `code` → virtual key positionally
 * (`Semicolon` → VK_OEM_1), so punctuation combos on a non-US host layout may
 * land on a different glyph. Letters and digits — the overwhelming case for a
 * chord — map to VK_A..Z / VK_0..9 and are what accelerators are defined in.
 *
 * Every code this returns MUST pass `isInjectableKey` (pointerMapping.ts) and
 * be mapped by `code_to_vk` in crates/puca-input — a code that fails either
 * is dropped silently at the far end. Pinned by charToKey.test.ts.
 */

/** Unshifted US punctuation: the glyph on the key itself. */
const BASE: Record<string, string> = {
    ' ': 'Space',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
};

/** Shifted US punctuation: the glyph above it. */
const SHIFTED: Record<string, string> = {
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
    '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
    '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight',
    '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '~': 'Backquote',
    '<': 'Comma', '>': 'Period', '?': 'Slash',
};

/**
 * The key for one character, or null when it has no US-keyboard position
 * (an emoji, CJK, an accented letter) — the caller falls back to the text
 * path then. `shift` says the character needs Shift held around the tap.
 */
export function charToKey(ch: string): { code: string; shift: boolean } | null {
    if (ch.length !== 1) return null;
    if (ch >= 'a' && ch <= 'z') return { code: 'Key' + ch.toUpperCase(), shift: false };
    if (ch >= 'A' && ch <= 'Z') return { code: 'Key' + ch, shift: true };
    if (ch >= '0' && ch <= '9') return { code: 'Digit' + ch, shift: false };
    const base = BASE[ch];
    if (base) return { code: base, shift: false };
    const shifted = SHIFTED[ch];
    if (shifted) return { code: shifted, shift: true };
    return null;
}

/** Every character this module can re-route — for the allowlist cross-check
 *  in charToKey.test.ts, not for callers. */
export const MAPPABLE_CHARS: readonly string[] = [
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ...Object.keys(BASE),
    ...Object.keys(SHIFTED),
];
