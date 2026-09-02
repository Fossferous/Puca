/**
 * Tap a key CHORD onto the remote machine: modifiers down (in order), the key
 * down+up, modifiers up (reverse order). Ordinary chords — Alt+Tab, Alt+F4 —
 * inject fine through SendInput on the host.
 *
 * Ctrl+Alt+Del deliberately does NOT go this way: Windows ignores injected
 * keys for the Secure Attention Sequence by design, and the old six-keystroke
 * version reported success while doing nothing. That one is a `{t:'sas'}`
 * frame the host routes to the Púca system service.
 */
import { sendInput } from './session';

export function sendChord(sessionId: string, modifiers: string[], key: string): boolean {
    // All-or-nothing: sendInput's guards are synchronous and identical for
    // every frame, so if the first one is refused none will go — and if it is
    // queued the rest follow in the same tick. Returning that lets the menu
    // say "not connected" instead of closing as if the chord had gone.
    let queued = true;
    for (const m of modifiers) queued = sendInput(sessionId, { t: 'key', code: m, down: true }) && queued;
    queued = sendInput(sessionId, { t: 'key', code: key, down: true }) && queued;
    queued = sendInput(sessionId, { t: 'key', code: key, down: false }) && queued;
    for (const m of [...modifiers].reverse()) queued = sendInput(sessionId, { t: 'key', code: m, down: false }) && queued;
    return queued;
}
