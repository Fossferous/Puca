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
/** The ONE screen the person at that PC shared went dark (its lid shut,
 *  mostly) or went away, and the picture may not move to the screens they
 *  did not share. Sent by the HOST only, which alone knows what was shared:
 *  for a lid end its agent reports (`no-screen:lid`) on a session that shared
 *  one screen, and for a stream the agent moved off that screen anyway (an
 *  older agent does that at the start). Not the lid code: that one tells the
 *  phone to turn on "Allow remote control with the lid closed", which is
 *  usually on already when this happens, and would not help. */
export const NO_SCREEN_SHARED_OFF_REASON = 'no-screen:shared-off';
/** A PINNED stream (one screen shared, so `steer_on_lid` false) found its
 *  capture showing another screen than the one it was pinned to (Windows
 *  renumbered the screens, or the shared one went away) and ended without
 *  sending that picture: the agent's `stream_end`. Never restarted, like the
 *  lid's: the consent here is a screen INDEX, and a restart by index could
 *  land on a screen nobody shared. */
export const NO_SCREEN_CHANGED_REASON = 'no-screen:changed';

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
    [NO_SCREEN_SHARED_OFF_REASON]: 'that PC’s shared screen went dark. Is its lid closed? '
        + 'Only that screen was shared: connect again with the lid open, or share another screen.',
    [NO_SCREEN_CHANGED_REASON]: 'that PC’s shared screen changed or was turned off. Connect again to choose a screen.',
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
 *  sign-in-screen agent sends that) or the code with its sentence; null when
 *  it is not one of these. What the controller LOGS for such an end, where
 *  the sentence it shows names the PC (connectLog.ts: no device names). */
export function noScreenCode(reason: string): string | null {
    return codeOf(reason);
}

function codeOf(reason: string): string | null {
    for (const code of [
        NO_SCREEN_LID_REASON, NO_SCREEN_VIRTUAL_FAILED_REASON, NO_SCREEN_NO_FRAME_REASON, NO_SCREEN_SHARED_OFF_REASON,
        NO_SCREEN_CHANGED_REASON,
    ]) {
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
    if (code === NO_SCREEN_SHARED_OFF_REASON) {
        // Both ways out, because which one exists depends on the PC: a
        // laptop with nothing else plugged in has no other screen to share.
        return `${pc(pcName)}’s shared screen went dark — is its lid closed? `
            + 'Only that screen was shared, so the picture could not move to another. '
            + 'Connect again with the lid open, or share another screen.';
    }
    if (code === NO_SCREEN_CHANGED_REASON) {
        return `${pc(pcName)}’s shared screen changed or was turned off. Connect again to choose a screen.`;
    }
    return null;
}

/**
 * The code a HOST ends with when the screen went dark under a live stream:
 * the agent's own `code`, except that a lid end on a session whose person
 * shared ONE screen is `no-screen:shared-off`. Such a session never lets the
 * agent move the picture (session.ts sends `steer_on_lid` only for consent
 * that covers every screen), so its lid end means "the one screen they shared
 * is behind the lid", and the lid code's advice (turn on the lid option) is
 * not the fix. `coversEveryScreen` is session.ts consentCoversEveryScreen.
 */
export function noScreenCodeForShared(code: string, coversEveryScreen: boolean): string {
    return code === NO_SCREEN_LID_REASON && !coversEveryScreen ? NO_SCREEN_SHARED_OFF_REASON : code;
}

/** The waiting banner while the host switches its virtual screen on. */
export function virtualStartingMessage(pcName: string | null | undefined): string {
    return `${pc(pcName)}’s screen is off — starting a virtual screen…`;
}

/** The agent's `stream_end` for a stream that never produced a first frame
 *  (crates/puca-agent protocol.rs STREAM_END_NO_FRAME). */
export const AGENT_STREAM_END_NO_FRAME = 'no_frame';

/**
 * The code a HOST ends the session with when its agent's live stream ended
 * for want of a screen — read from the agent's status poll (`stream_end`) —
 * or null when the stream ended for any other reason (the host then restarts
 * it).
 *
 * `no_frame`: the display never produced a first frame. And, since the agent
 * follows a lid shut MID-SESSION (virtual_screen.rs), the session-start codes
 * themselves: the lid closed with nowhere to move the picture
 * (`no-screen:lid`), or the virtual screen it moved to never came
 * (`no-screen:virtual-failed`). Before this a host restarted those once, and
 * the restart's own screen check ended with the same code a round trip later,
 * after a brief "starting a virtual screen" the phone had no use for.
 * And `no-screen:changed`: a stream pinned to the one screen that was shared
 * found its capture showing another (NO_SCREEN_CHANGED_REASON), which a
 * restart by index could repeat with a screen nobody shared.
 * Matched literally, like every code here: anything else is not ours to name.
 */
export function noScreenCodeForStreamEnd(streamEnd: string | null | undefined): string | null {
    if (streamEnd === AGENT_STREAM_END_NO_FRAME) return NO_SCREEN_NO_FRAME_REASON;
    if (streamEnd === NO_SCREEN_LID_REASON) return NO_SCREEN_LID_REASON;
    if (streamEnd === NO_SCREEN_VIRTUAL_FAILED_REASON) return NO_SCREEN_VIRTUAL_FAILED_REASON;
    if (streamEnd === NO_SCREEN_CHANGED_REASON) return NO_SCREEN_CHANGED_REASON;
    return null;
}
