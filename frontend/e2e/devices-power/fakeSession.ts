/**
 * The device-session layer, played: each stand-in PC answers a power-off the
 * way the real hosts do (session.ts and both Rust power.rs files; the real
 * layer's states are pinned against those hosts in
 * src/tests/devicePowerOffController.test.ts). This side records every
 * connect in `window.__power.calls` so the walk can assert what was — and
 * was not — sent.
 *
 * The constants and types are the real module's (re-exported), so the card
 * reads the same codes it reads in the app.
 */
export * from '../../src/api/devices/session';
import {
    SHUTDOWN_REASON,
    POWER_OFF_TOO_OLD_REASON,
    POWER_OFF_NOT_ALLOWED_REASON,
    POWER_OFF_ATTENDED_REASON,
    type DeviceControlSession,
    type PowerOffProgress,
} from '../../src/api/devices/session';

type Snap = DeviceControlSession;
type Step = [ms: number, change: { phase?: Snap['phase']; powerOff?: PowerOffProgress; error?: string | null }];

const waiting: PowerOffProgress = { state: 'waiting', reason: null };
const sent: PowerOffProgress = { state: 'sent', reason: null };
const accepted: PowerOffProgress = { state: 'accepted', reason: null };

/** How each PC answers, by device id. */
const SCRIPTS: Record<string, Step[]> = {
    // A current attended host: ack, Windows takes it, the session ends with
    // the shutdown reason.
    'pc-going': [
        [200, { phase: 'active', powerOff: waiting }],
        [500, { powerOff: sent }],
        [900, { powerOff: accepted }],
        [1500, { phase: 'ended', powerOff: { state: 'done', reason: SHUTDOWN_REASON } }],
    ],
    'their-box': [
        [200, { phase: 'active', powerOff: waiting }],
        [500, { powerOff: sent }],
        [900, { powerOff: accepted }],
        [1500, { phase: 'ended', powerOff: { state: 'done', reason: SHUTDOWN_REASON } }],
    ],
    // A Púca from before the action: silence, then the controller's deadline.
    'pc-old': [
        [200, { phase: 'active', powerOff: waiting }],
        [500, { powerOff: sent }],
        [1600, { phase: 'ended', powerOff: { state: 'failed', reason: POWER_OFF_TOO_OLD_REASON } }],
    ],
    // Windows refuses after the ack (the shell's own words).
    'pc-refused': [
        [200, { phase: 'active', powerOff: waiting }],
        [500, { powerOff: sent }],
        [800, { powerOff: accepted }],
        [1100, { phase: 'ended', powerOff: { state: 'failed', reason: 'Windows refused: the account Púca runs as there may not shut it down' } }],
    ],
    // An unarmed PC whose consent prompt nobody answered.
    'pc-declined': [
        [900, { phase: 'ended', powerOff: { state: 'failed', reason: 'the person at that device declined' } }],
    ],
    // An unarmed PC where somebody DID let the connection in: the host
    // refuses a forced power-off on a session a person admitted.
    'pc-attended': [
        [200, { phase: 'active', powerOff: sent }],
        [700, { phase: 'ended', powerOff: { state: 'failed', reason: POWER_OFF_ATTENDED_REASON } }],
    ],
    // The PC refuses a share without control, out loud.
    'attic': [
        [200, { phase: 'active', powerOff: waiting }],
        [500, { powerOff: sent }],
        [900, { phase: 'ended', powerOff: { state: 'failed', reason: POWER_OFF_NOT_ALLOWED_REASON } }],
    ],
};

const sessions = new Map<string, Snap>();
const listeners = new Set<(all: Snap[]) => void>();
const calls: Array<{ host: string; opts: unknown }> = [];
(window as unknown as { __power: unknown }).__power = { calls };
let n = 0;

function emit(): void {
    const all = [...sessions.values()].map(s => ({ ...s, powerOff: s.powerOff ? { ...s.powerOff } : null }));
    for (const l of listeners) l(all);
}

export function subscribeSessions(l: (all: Snap[]) => void): () => void {
    listeners.add(l);
    l([...sessions.values()]);
    return () => { listeners.delete(l); };
}
export function activeSessions(): Snap[] { return [...sessions.values()]; }
export function endSession(id: string): void {
    const s = sessions.get(id);
    if (!s) return;
    s.phase = 'ended';
    emit();
    sessions.delete(id);
}
export function audioHubSessionFor(): string | null { return null; }
export function powerOffSessionFor(): string | null { return null; }
export function requestForcePowerOff(): boolean { return false; }

export async function connectToDevice(
    hostDevice: string,
    opts?: { powerOff?: boolean; peerName?: string; filesOnly?: boolean; share?: unknown },
): Promise<string> {
    calls.push({ host: hostDevice, opts: opts ?? null });
    const id = `ps${++n}`;
    const s = {
        id, role: 'controller', peerDevice: hostDevice, phase: 'connecting', error: null,
        filesOnly: !!(opts?.filesOnly || opts?.powerOff), audioHub: false,
        powerOff: opts?.powerOff ? waiting : null, powerOffOnly: !!opts?.powerOff,
        peerName: opts?.peerName ?? null,
    } as unknown as Snap;
    sessions.set(id, s);
    emit();
    const script = SCRIPTS[hostDevice] ?? [[300, { phase: 'ended', powerOff: { state: 'failed', reason: "that device isn't online" } }]];
    for (const [ms, change] of script) {
        setTimeout(() => {
            const cur = sessions.get(id);
            if (!cur) return;
            Object.assign(cur, change);
            emit();
            if (cur.phase === 'ended') sessions.delete(id);
        }, ms);
    }
    return id;
}
