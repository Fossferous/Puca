/**
 * "That computer runs an older Púca", said on the stage — and only when the
 * other computer has shown it.
 *
 * WHY. 0.9.847 moved the pointer to this end: the other computer's agent hands
 * its pointer over, says what SHAPE it has (pointer_shape.rs), and answers a
 * latency probe (latency.rs). An agent from before that hands the pointer over
 * and then says nothing, so the stage gives it back after SHAPE_WAIT_MS and the
 * pointer is drawn into the video there, a whole round trip behind the hand —
 * and frozen over a screen that presents nothing (the 2026-10-26 laptop
 * report: "mouse cursor doesnt move after reconnect … still slow"). Nothing on
 * the stage said why, and the fix was on the OTHER computer.
 *
 * NO VERSION IS NAMED, because none is known here. The device list carries
 * none (devices rows: keys, name, platform, sealed LAN details), the sealed
 * LAN blob holds a MAC, addresses and a role, and the session's hello is
 * `{hello: 1}` plus which key sealed it. So the line says "older" from what
 * the other end did, and never a number it would have to invent.
 *
 * THE EVIDENCE:
 *  - `noShapes`: it took the pointer (its ack), its picture was arriving, the
 *    channel the shape rides was open, and no shape came within SHAPE_WAIT_MS
 *    (DeviceStage). Both stages: the phone's trackpad takes the pointer too.
 *    A current agent says its shape within one 30 ms look of that.
 *  - Against it, `shapeReported` (only a current agent sends one) and
 *    `probeAnswered` (the probe came in the same release as the shape, so an
 *    agent that answers one is not older, whatever else is slow).
 * An unanswered probe is NOT evidence (review 2026-10-26): a current agent's
 * answer can be late or dropped (a busy stream loop, a channel full of a file
 * transfer), and an older agent refuses the probe only in its own log, never
 * on the wire, so this end can only ever see silence, and silence is a
 * timeout, not a refusal.
 */

export interface OlderHostEvidence {
    /** It took the pointer and sent no shape in time, while it could have. */
    noShapes: boolean;
    /** It has reported a pointer shape this session. */
    shapeReported: boolean;
    /** It has answered a latency probe this session. */
    probeAnswered: boolean;
}

/** Does the other computer run a Púca from before the pointer moved here? */
export function hostIsOlder(e: OlderHostEvidence): boolean {
    if (e.shapeReported || e.probeAnswered) return false;
    return e.noShapes;
}

/** The stage's one line, or null when nothing says the other end is older.
 *  Names the computer as the person called it, as the stage's other
 *  banners do. */
export function olderHostMessage(peerName: string | null | undefined, e: OlderHostEvidence): string | null {
    if (!hostIsOlder(e)) return null;
    const name = (peerName ?? '').trim();
    return name
        ? `${name} runs an older Púca: the pointer is drawn there and can lag. Update Púca on ${name}.`
        : 'That computer runs an older Púca: the pointer is drawn there and can lag. Update Púca on that computer.';
}
