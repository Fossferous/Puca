/**
 * Text -> the input frames that TYPE it on the remote machine.
 *
 * For what a keyboard cannot send position by position: a paste, a password
 * out of a manager, an emoji, a character only an IME or AltGr produces, text
 * in a layout the remote does not share. Characters go as `{t:'text'}`, which
 * the host injects as the characters themselves (KEYEVENTF_UNICODE on
 * Windows), so the remote's keyboard layout cannot change them.
 *
 * A text frame refuses control characters (puca-input `validate_text`: a
 * pasted newline must not submit a form behind the user's back), so a line
 * break here is an Enter KEY between lines and a tab a Tab key — sent because
 * the person asked for multi-line text, as visibly as typing it would be.
 * Other control characters are dropped, and counted, so the note can say so.
 */

/** What a text frame may not carry. The host refuses a frame holding ANY of
 *  these whole (`validate_text` asks Rust's `char::is_control`): the C0
 *  controls, DEL, and the C1 controls U+0080–U+009F — the ones mojibake is
 *  full of. Missing those cost a whole 200-character frame, silently, while
 *  the note said everything was typed. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** What one "Type" will do: the frames, the characters they type (an Enter or
 *  Tab tap counts as one) and those left out as untypable. */
export interface TypePlan {
    events: unknown[];
    typed: number;
    dropped: number;
}

/** Code points per text frame: under the host's 256-character limit, and the
 *  phone keyboard's chunk. */
export const TEXT_CHUNK = 200;

/** The most a single "Type" may send. Bigger belongs on the clipboard path,
 *  which exists (Send clipboard, then paste over there). */
export const MAX_TYPED_CHARS = 10_000;

/** Split by CODE POINTS, so a surrogate pair is never cut in half. */
export function textChunks(text: string, size = TEXT_CHUNK): string[] {
    const points = Array.from(text);
    if (points.length <= size) return text ? [text] : [];
    const out: string[] = [];
    for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(''));
    return out;
}

const tap = (code: string): unknown[] => [
    { t: 'key', code, down: true },
    { t: 'key', code, down: false },
];

/**
 * The frames that type `text`, in order, and what they amount to. Lines are
 * joined by an Enter tap, tabs become a Tab tap; CRLF and lone CR count as one
 * line break. No frames for empty text.
 */
export function typeTextPlan(text: string): TypePlan {
    const events: unknown[] = [];
    let typed = 0;
    let dropped = 0;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
        if (i > 0) { events.push(...tap('Enter')); typed++; }
        line.split('\t').forEach((cell, j) => {
            if (j > 0) { events.push(...tap('Tab')); typed++; }
            const clean = cell.replace(CONTROL, '');
            const kept = Array.from(clean).length;
            typed += kept;
            dropped += Array.from(cell).length - kept;
            for (const part of textChunks(clean)) events.push({ t: 'text', text: part });
        });
    });
    return { events, typed, dropped };
}

/** The frames alone (typeTextPlan). */
export function typeTextEvents(text: string): unknown[] {
    return typeTextPlan(text).events;
}
