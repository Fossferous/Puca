/**
 * The device card's POWER OFF: shut a PC down from the device list, forcibly
 * (docs/REMOTE_CONTROL.md, *Power off from the device list*).
 *
 * WHAT IT IS ON THE WIRE. Nothing new to the server: the card opens the same
 * sealed device session Files and Audio Hub open, but sends NO offer (no
 * capture, nothing to browse, and the sign-in-screen agent — the way into a
 * locked PC — ends a files-only offer outright) and sends the `power` action
 * FORCE_POWER_OFF_ACTION the moment it is connected. Both hosts hold it until
 * the unattended passphrase is proved. The host is the gate: an unproved
 * controller, a share without control, and a session somebody AT the PC had
 * to let in (it is not armed for unattended access) are refused there
 * whatever this side does. On the host the action is `InitiateShutdownW` with
 * the forcing flags (the Tauri shell's and the sign-in-screen agent's
 * power.rs): every app is closed without being asked to save.
 *
 * A Control or Files session already open to that PC carries it instead of a
 * new one, because a host takes one session at a time and the server would
 * refuse the second as "already handling a session".
 *
 * WHAT THE CARD SAYS. The session layer records how it went (PowerOffProgress)
 * in codes and the host's own words; this file turns that into a sentence
 * naming the PC, which only this side knows the name of. Every way it can fail
 * has its sentence — offline, an older Púca on the PC, not allowed, nobody let
 * the connection in, the passphrase, Windows refusing — so the button never
 * fails silently.
 */
import {
    connectToDevice,
    powerOffSessionFor,
    requestForcePowerOff,
    subscribeSessions,
    SHUTDOWN_REASON,
    POWER_OFF_TOO_OLD_REASON,
    POWER_OFF_NOT_ALLOWED_REASON,
    POWER_OFF_ATTENDED_REASON,
    POWER_OFF_UNLOCKED_REASON,
    type DeviceControlSession,
    type PowerOffProgress,
} from './session';

/** What the card shows when it is over. `going`: Windows took it. `unknown`:
 *  the connection went between asking and any answer. `refused`: it is not
 *  powering off, and the text says why. */
export interface PowerOffOutcome {
    kind: 'going' | 'unknown' | 'refused';
    text: string;
}

export interface PowerOffTarget {
    /** The device row to connect to (the machine's online row, fetched now). */
    hostDevice: string;
    /** What the person calls the PC. Every sentence names it. */
    name: string;
    /** The row is the PC's SIGN-IN-SCREEN row (it is locked or signed out):
     *  what answers there is its lock-screen service, which updates apart
     *  from the app (someone there clicks Update the service). */
    signIn?: boolean;
    /** Set for a friend's PC under an accepted share. */
    share?: {
        inviteId: number;
        ownerUser: number;
        ownerUsername: string;
        capabilities: string[];
    };
}

/** May a card offer Power off at all? A share needs control — the line the
 *  stage's Lock and Shut down draw — and only a Windows PC can do it (a Linux
 *  host refuses every power action; a phone has none). */
export function powerOffOffered(platform: string | null | undefined, capabilities?: readonly string[]): boolean {
    if (platform !== 'windows') return false;
    return !capabilities || capabilities.includes('control');
}

const trimmed = (name: string): string => name.trim() || 'That PC';

/** The question asked before anything is sent (askConfirm's message). */
export function powerOffQuestion(name: string): string {
    const n = trimmed(name);
    return `Power off ${n} now?\n\n`
        + `Windows on ${n} shuts down straight away and closes every app without asking `
        + `it to save, so any unsaved work on ${n} will be lost.\n\n`
        + `To start it again you need Wake & connect, or somebody at ${n}.`;
}

/** The line on the card while it runs. */
export function powerOffProgressText(name: string, p: PowerOffProgress | null): string {
    const n = trimmed(name);
    switch (p?.state) {
        case 'sent': return `Asking ${n} to power off…`;
        case 'accepted': return `${n} is powering off…`;
        default: return `Connecting to ${n}…`;
    }
}

/**
 * The sentence for a power-off that is over. `p` is the session's record;
 * `sessionError` its error, for a session that ended without one (it never
 * started, say).
 */
export function powerOffOutcome(
    name: string,
    p: PowerOffProgress | null,
    sessionError?: string | null,
    signIn = false,
): PowerOffOutcome {
    const n = trimmed(name);
    if (p?.state === 'done') return { kind: 'going', text: `${n} is powering off.` };
    if (p?.state === 'unknown') {
        return {
            kind: 'unknown',
            text: `The connection to ${n} ended just after it was asked to power off, so whether `
                + `it is going is not known yet. Its card shows it offline once it has.`,
        };
    }
    const reason = (p?.reason ?? sessionError ?? '').trim();
    return { kind: 'refused', text: refusalText(n, reason, signIn) };
}

/** Why it is not powering off, in a sentence. Exported for the tests. */
export function refusalText(n: string, reason: string, signIn = false): string {
    if (reason === POWER_OFF_TOO_OLD_REASON || /not one this agent knows/i.test(reason)) {
        // Locked: the lock-screen service answered, and it updates apart from
        // the app — Windows asks permission, so someone there has to click.
        if (signIn) {
            return `${n} is locked, and its lock-screen service runs a Púca too old to power it off. `
                + `On ${n}, update Púca and click Update the service (Devices, This device), or open it `
                + `with Control and use More, then Shut down.`;
        }
        return `${n} runs a Púca too old to be powered off from here. Update Púca on ${n} `
            + `(Power off also needs it set up for unattended access), or open it with Control and `
            + `use More, then Shut down.`;
    }
    if (reason === POWER_OFF_NOT_ALLOWED_REASON) {
        return `Your access to ${n} does not include control, so you cannot power it off. `
            + `Only its owner can give you that.`;
    }
    if (reason === POWER_OFF_ATTENDED_REASON) {
        return `${n} was not powered off: it is not set up for unattended access, so the person there `
            + `agreed only to a connection, not to losing their unsaved work. Use Control, then More, then `
            + `Shut down (its apps can ask to save), or set up unattended access on ${n}.`;
    }
    // The connect deadline: an unarmed PC waits for somebody there to let
    // the connection in, longer than this side waits for an answer — and
    // would refuse a forced power-off even if they did.
    if (/^no answer from that device/i.test(reason)) {
        return `${n} did not answer, so it was not powered off. If it is not set up for unattended `
            + `access, that is why: it waits for somebody there to let the connection in, and Power off `
            + `works only on a PC set up for unattended access.`;
    }
    if (reason === POWER_OFF_UNLOCKED_REASON) {
        return `Somebody signed in at ${n} just now, so it was not powered off. Press Power off again `
            + `if you still want it off: anything they have open would be lost.`;
    }
    if (/isn'?t online|not online|not reachable/i.test(reason)) {
        return `${n} is offline, so it cannot be powered off from here (it may already be off).`;
    }
    if (/already handling a session/i.test(reason)) {
        return `${n} is in another remote session right now, so it was not powered off. `
            + `End that session, then try again.`;
    }
    if (/declined/i.test(reason)) {
        return `${n} asked the person there to let the connection in, and nobody did, so it was `
            + `not powered off. Power off works only on a PC set up for unattended access: set it up `
            + `on ${n}.`;
    }
    if (/passphrase not (entered|provided)/i.test(reason)) {
        return `${n} was not powered off: its unattended-access passphrase was not entered.`;
    }
    if (/passphrase rejected|unattended access was refused/i.test(reason)) {
        return `${n} was not powered off: it did not accept the unattended-access passphrase.`;
    }
    if (reason === SHUTDOWN_REASON) return `${n} is powering off.`;
    const why = reason.replace(/[.\s]+$/, '');
    return why
        ? `${n} was not powered off: ${why}.`
        : `${n} was not powered off, and gave no reason.`;
}

/**
 * Run it: ride a live session to that PC or open one, then follow it to an
 * outcome. Always resolves, with the sentence for the card. `onProgress` gets
 * the line to show meanwhile.
 */
export async function powerOffDevice(
    t: PowerOffTarget,
    onProgress?: (text: string) => void,
): Promise<PowerOffOutcome> {
    // Every snapshot of every session, kept by id: a session that fails on
    // the spot (no server connection) is emitted ended and deleted inside
    // connectToDevice, before its id is known here.
    const last = new Map<string, DeviceControlSession>();
    let target: string | null = null;
    let settle: ((o: PowerOffOutcome) => void) | null = null;
    const result = new Promise<PowerOffOutcome>(resolve => { settle = resolve; });
    let lastProgress = '';

    const check = (): void => {
        if (!target || !settle) return;
        const s = last.get(target);
        if (!s) return;
        const p = s.powerOff;
        const over = s.phase === 'ended'
            || p?.state === 'done' || p?.state === 'unknown' || p?.state === 'failed';
        if (over) {
            const done = settle;
            settle = null;
            done(powerOffOutcome(t.name, p, s.error, t.signIn === true));
            return;
        }
        const line = powerOffProgressText(t.name, p);
        if (line !== lastProgress) {
            lastProgress = line;
            onProgress?.(line);
        }
    };

    const unsubscribe = subscribeSessions(all => {
        for (const s of all) last.set(s.id, s);
        check();
    });
    try {
        onProgress?.(powerOffProgressText(t.name, null));
        lastProgress = powerOffProgressText(t.name, null);
        const live = powerOffSessionFor(t.hostDevice);
        if (live && requestForcePowerOff(live)) {
            target = live;
        } else {
            target = await connectToDevice(t.hostDevice, {
                powerOff: true,
                peerName: t.name,
                ...(t.share ? { share: t.share } : {}),
            });
        }
        check();
        if (target && !last.has(target)) {
            // Never seen at all: nothing to follow.
            const done = settle as ((o: PowerOffOutcome) => void) | null;
            settle = null;
            done?.({ kind: 'refused', text: `${trimmed(t.name)} could not be reached.` });
        }
        return await result;
    } catch (e) {
        return { kind: 'refused', text: refusalText(trimmed(t.name), e instanceof Error ? e.message : String(e)) };
    } finally {
        unsubscribe();
    }
}
