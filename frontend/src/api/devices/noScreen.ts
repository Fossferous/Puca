/**
 * "That PC has no screen switched on" — the codes, and what the phone says.
 *
 * A laptop with its lid shut has no active display, so remote control has
 * nothing to show. Until this existed the phone said only "could not connect
 * to the device", which sent the owner looking at the network for a problem
 * that was a lid (2026-10-21). The host now finds out BEFORE it answers
 * (`prepareHostScreen` in session.ts, the agent's `prepare_screen`) and ends
 * the session with one of these codes, or tells the phone a virtual screen is
 * starting.
 *
 * The codes travel as a DeviceEnd reason and are matched LITERALLY: the agent
 * spells them in `crates/puca-agent/src/virtual_screen.rs` (`NO_SCREEN_LID`,
 * `NO_SCREEN_VIRTUAL_FAILED`) for the sign-in-screen path, whose end reason
 * the service passes through unchanged, and a test on each side pins the same
 * strings. Codes rather than sentences because the sentence names the PC,
 * which only the phone knows how to call it.
 */

export const NO_SCREEN_LID_REASON = 'no-screen:lid';
export const NO_SCREEN_VIRTUAL_FAILED_REASON = 'no-screen:virtual-failed';
/** The stream ran but the display never produced a picture (the agent's
 *  `stream_end: no_frame`): a screen that is asleep and did not wake, or a
 *  dark panel the lid check could not see. Sent by the HOST from its status
 *  poll, because the phone's own connection used to time out first and say
 *  "could not connect to the device" (0.9.842 field report). */
export const NO_SCREEN_NO_FRAME_REASON = 'no-screen:no-frame';

/** The option's name, exactly as the PC's own settings card spells it. */
export const LID_CLOSED_OPTION = 'Allow remote control with the lid closed';

/** "Work Laptop" — or a stand-in when the name is unknown (a share, an old
 *  caller). Trimmed, and never empty. */
function pc(name: string | null | undefined): string {
    const n = (name ?? '').trim();
    return n || 'That PC';
}

/** The sentence an OLDER phone shows instead, which knows no codes and
 *  displays the end reason as it arrives. Without a name: the PC cannot be
 *  named from here. */
const FALLBACK: Record<string, string> = {
    [NO_SCREEN_LID_REASON]: 'that PC’s screen is off. Is its lid closed? '
        + `Turn on “${LID_CLOSED_OPTION}” on it.`,
    [NO_SCREEN_VIRTUAL_FAILED_REASON]: 'that PC’s screen is off, and its virtual screen did not start.',
    [NO_SCREEN_NO_FRAME_REASON]: 'that PC’s screen did not show anything. It may be asleep, or its lid closed.',
};

/**
 * The DeviceEnd reason the HOST sends: the code, then a sentence. A phone
 * that knows the code shows its own sentence naming the PC; one from before
 * this shows the whole string, which reads, rather than a bare code. Well
 * under both limits on the way: the server refuses a reason over 512 bytes
 * (ws.rs), and a phone shows at most 200 characters.
 */
export function noScreenEndReason(code: string): string {
    const fallback = FALLBACK[code];
    return fallback ? `${code} — ${fallback}` : code;
}

/** The code at the front of an end reason, in either form: the bare code (the
 *  sign-in-screen agent sends that) or the code with its sentence. */
function codeOf(reason: string): string | null {
    for (const code of [NO_SCREEN_LID_REASON, NO_SCREEN_VIRTUAL_FAILED_REASON, NO_SCREEN_NO_FRAME_REASON]) {
        if (reason === code || reason.startsWith(`${code} `)) return code;
    }
    return null;
}

/** What the phone shows when a session ended for want of a screen, or `null`
 *  when `reason` is not one of the codes (the caller shows it as it was). */
export function noScreenMessage(reason: string, pcName: string | null | undefined): string | null {
    const code = codeOf(reason);
    if (code === NO_SCREEN_LID_REASON) {
        return `${pc(pcName)}’s screen is off — is its lid closed? `
            + `Turn on “${LID_CLOSED_OPTION}” on that PC.`;
    }
    if (code === NO_SCREEN_VIRTUAL_FAILED_REASON) {
        return `${pc(pcName)}’s screen is off, and its virtual screen did not start. `
            + 'Open its lid, or try again.';
    }
    if (code === NO_SCREEN_NO_FRAME_REASON) {
        return `${pc(pcName)}’s screen did not show anything — it may be asleep, or its lid closed. `
            + 'Try again, or move its mouse.';
    }
    return null;
}

/** The waiting banner while the host switches its virtual screen on. */
export function virtualStartingMessage(pcName: string | null | undefined): string {
    return `${pc(pcName)}’s screen is off — starting a virtual screen…`;
}
