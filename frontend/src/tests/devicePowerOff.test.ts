/**
 * api/devices/powerOff.ts: who is offered Power off, the question asked
 * first, and the sentence for every way it can end — then the driver that
 * rides a live session or opens one and follows it to that sentence.
 *
 * The session layer is a stand-in here: what it records is pinned in
 * devicePowerOffController.test.ts against the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Snap = {
    id: string;
    role: 'controller';
    phase: 'connecting' | 'active' | 'ended';
    error: string | null;
    powerOff: { state: string; reason: string | null } | null;
};
let listener: ((all: Snap[]) => void) | null = null;
let snaps: Snap[] = [];
const emit = () => listener?.(snaps.map(s => ({ ...s })));
const connectToDevice = vi.fn<(host: string, opts: Record<string, unknown>) => Promise<string>>();
const powerOffSessionFor = vi.fn<(host: string) => string | null>(() => null);
const requestForcePowerOff = vi.fn<(id: string) => boolean>(() => false);

vi.mock('../api/devices/session', () => ({
    SHUTDOWN_REASON: 'the device is shutting down',
    POWER_OFF_TOO_OLD_REASON: 'power-off: that Púca is too old to know it',
    POWER_OFF_NOT_ALLOWED_REASON: 'power-off: this share does not include control',
    POWER_OFF_ATTENDED_REASON: 'power-off: someone there let this connection in',
    POWER_OFF_UNLOCKED_REASON: 'the console was unlocked',
    connectToDevice: (h: string, o: Record<string, unknown>) => connectToDevice(h, o),
    powerOffSessionFor: (h: string) => powerOffSessionFor(h),
    requestForcePowerOff: (id: string) => requestForcePowerOff(id),
    subscribeSessions: (l: (all: Snap[]) => void) => {
        listener = l;
        emit();
        return () => { listener = null; };
    },
}));

const {
    powerOffOffered, powerOffQuestion, powerOffOutcome, powerOffProgressText, refusalText, powerOffDevice,
} = await import('../api/devices/powerOff');

beforeEach(() => {
    listener = null;
    snaps = [];
    connectToDevice.mockReset();
    powerOffSessionFor.mockReset();
    powerOffSessionFor.mockReturnValue(null);
    requestForcePowerOff.mockReset();
    requestForcePowerOff.mockReturnValue(false);
});

describe('who is offered it', () => {
    it('a Windows PC, and on a share only with control', () => {
        expect(powerOffOffered('windows')).toBe(true);
        expect(powerOffOffered('windows', ['control'])).toBe(true);
        expect(powerOffOffered('windows', ['control', 'files'])).toBe(true);
        expect(powerOffOffered('windows', ['view_only'])).toBe(false);
        expect(powerOffOffered('windows', ['files'])).toBe(false);
        expect(powerOffOffered('windows', [])).toBe(false);
        // Every other host refuses power actions, so the button is not shown.
        for (const p of ['linux', 'android', 'ios', 'macos', '', null, undefined]) {
            expect(powerOffOffered(p), String(p)).toBe(false);
        }
    });
});

describe('the question', () => {
    it('names the PC and says plainly that unsaved work is lost', () => {
        const q = powerOffQuestion('Slim-Jim');
        expect(q.startsWith('Power off Slim-Jim now?')).toBe(true);
        expect(q).toMatch(/without asking it to save/);
        expect(q).toMatch(/unsaved work on Slim-Jim will be lost/);
        expect(q).toMatch(/Wake & connect/);
        // No PC name, still a sentence.
        expect(powerOffQuestion('   ').startsWith('Power off That PC now?')).toBe(true);
    });
});

describe('what the card says', () => {
    const N = 'Slim-Jim';
    it('the steps', () => {
        expect(powerOffProgressText(N, null)).toBe('Connecting to Slim-Jim…');
        expect(powerOffProgressText(N, { state: 'waiting', reason: null })).toBe('Connecting to Slim-Jim…');
        expect(powerOffProgressText(N, { state: 'sent', reason: null })).toBe('Asking Slim-Jim to power off…');
        expect(powerOffProgressText(N, { state: 'accepted', reason: null })).toBe('Slim-Jim is powering off…');
    });

    it('going, and not knowing', () => {
        expect(powerOffOutcome(N, { state: 'done', reason: 'the device is shutting down' }))
            .toEqual({ kind: 'going', text: 'Slim-Jim is powering off.' });
        const u = powerOffOutcome(N, { state: 'unknown', reason: 'the other device disconnected' });
        expect(u.kind).toBe('unknown');
        expect(u.text).toMatch(/not known yet/);
    });

    it('every refusal has its own sentence, naming the PC', () => {
        const cases: Array<[string, RegExp]> = [
            ['power-off: that Púca is too old to know it', /runs a Púca too old.*Update Púca on Slim-Jim/],
            ['that power action is not one this agent knows', /runs a Púca too old/],
            ['power-off: this share does not include control', /does not include control, so you cannot power it off/],
            ['power-off: someone there let this connection in', /not set up for unattended access, so the person there agreed only to a connection/],
            ['no answer from that device — check the connection and try again', /did not answer, so it was not powered off.*waits for somebody there.*works only on a PC set up for unattended access/],
            ['unattended access was refused', /did not accept the unattended-access passphrase/],
            ['the console was unlocked', /Somebody signed in at Slim-Jim just now, so it was not powered off/],
            ["that device isn't online", /Slim-Jim is offline/],
            ['that device is already handling a session', /in another remote session/],
            ['the person at that device declined', /nobody did.*works only on a PC set up for unattended access: set it up on Slim-Jim/],
            ['unattended passphrase not entered', /passphrase was not entered/],
            ['unattended passphrase not provided', /passphrase was not entered/],
            ['unattended passphrase rejected', /did not accept the unattended-access passphrase/],
            ['Windows refused: the account Púca runs as there may not shut it down',
                /^Slim-Jim was not powered off: Windows refused: the account Púca runs as there may not shut it down\.$/],
            ['power actions are only implemented on Windows', /not powered off: power actions are only implemented on Windows\.$/],
        ];
        for (const [reason, want] of cases) {
            const o = powerOffOutcome(N, { state: 'failed', reason });
            expect(o.kind, reason).toBe('refused');
            expect(o.text, reason).toMatch(want);
            expect(o.text, reason).toContain('Slim-Jim');
        }
        // Locked: the lock-screen service answered, and it updates apart.
        const locked = powerOffOutcome(N, { state: 'failed', reason: 'that power action is not one this agent knows' }, null, true);
        expect(locked.text).toMatch(/is locked, and its lock-screen service runs a Púca too old.*Update the service/);
        expect(powerOffOutcome(N, { state: 'failed', reason: 'power-off: that Púca is too old to know it' }).text,
            'not locked: the app is what to update').not.toMatch(/Update the service/);
        // No reason at all is still said, never blank.
        expect(refusalText(N, '')).toBe('Slim-Jim was not powered off, and gave no reason.');
        // A session that ended with no record reads its error.
        expect(powerOffOutcome(N, null, "that device isn't online").text).toMatch(/offline/);
    });
});

describe('the driver', () => {
    it('opens a power-off session when none is live, and resolves when it is going', async () => {
        connectToDevice.mockImplementation(async () => {
            snaps = [{ id: 's1', role: 'controller', phase: 'connecting', error: null, powerOff: { state: 'waiting', reason: null } }];
            emit();
            return 's1';
        });
        const lines: string[] = [];
        const p = powerOffDevice({ hostDevice: 'pc', name: 'Slim-Jim' }, t => lines.push(t));
        await vi.waitFor(() => expect(connectToDevice).toHaveBeenCalled());
        expect(connectToDevice.mock.calls[0]).toEqual(['pc', { powerOff: true, peerName: 'Slim-Jim' }]);
        snaps = [{ ...snaps[0], phase: 'active', powerOff: { state: 'sent', reason: null } }];
        emit();
        snaps = [{ ...snaps[0], powerOff: { state: 'accepted', reason: null } }];
        emit();
        snaps = [{ ...snaps[0], phase: 'ended', powerOff: { state: 'done', reason: 'the device is shutting down' } }];
        emit();
        expect(await p).toEqual({ kind: 'going', text: 'Slim-Jim is powering off.' });
        expect(lines).toEqual(['Connecting to Slim-Jim…', 'Asking Slim-Jim to power off…', 'Slim-Jim is powering off…']);
    });

    it('rides a live session to that PC instead of opening a second one', async () => {
        snaps = [{ id: 'live', role: 'controller', phase: 'active', error: null, powerOff: null }];
        powerOffSessionFor.mockReturnValue('live');
        requestForcePowerOff.mockImplementation(() => {
            snaps = [{ ...snaps[0], powerOff: { state: 'sent', reason: null } }];
            emit();
            return true;
        });
        const p = powerOffDevice({ hostDevice: 'pc', name: 'Slim-Jim' });
        await vi.waitFor(() => expect(requestForcePowerOff).toHaveBeenCalledWith('live'));
        // A refusal on a session that stays up is still an outcome.
        snaps = [{ ...snaps[0], powerOff: { state: 'failed', reason: 'Windows refused to power it off (error 1190)' } }];
        emit();
        expect(await p).toEqual({ kind: 'refused', text: 'Slim-Jim was not powered off: Windows refused to power it off (error 1190).' });
        expect(connectToDevice).not.toHaveBeenCalled();
    });

    it('a session that ended inside connectToDevice (no server connection) is still read', async () => {
        connectToDevice.mockImplementation(async () => {
            // Emitted ended, then deleted — before its id was known.
            snaps = [{ id: 's2', role: 'controller', phase: 'ended', error: null,
                powerOff: { state: 'failed', reason: 'not connected to the server — check your connection and try again' } }];
            emit();
            snaps = [];
            emit();
            return 's2';
        });
        const o = await powerOffDevice({ hostDevice: 'pc', name: 'Slim-Jim' });
        expect(o.kind).toBe('refused');
        expect(o.text).toMatch(/not connected to the server/);
    });

    it('a share rides along to the connect', async () => {
        const share = { inviteId: 3, ownerUser: 9, ownerUsername: 'friend', capabilities: ['control'] };
        connectToDevice.mockImplementation(async () => {
            snaps = [{ id: 's3', role: 'controller', phase: 'ended', error: null, powerOff: { state: 'done', reason: null } }];
            emit();
            return 's3';
        });
        await powerOffDevice({ hostDevice: 'their-pc', name: 'Box', share });
        expect(connectToDevice.mock.calls[0][1]).toEqual({ powerOff: true, peerName: 'Box', share });
    });

    it('a connect that throws is a refusal with its words', async () => {
        connectToDevice.mockRejectedValue(new Error('this device has not enrolled yet'));
        const o = await powerOffDevice({ hostDevice: 'pc', name: 'Slim-Jim' });
        expect(o).toEqual({ kind: 'refused', text: 'Slim-Jim was not powered off: this device has not enrolled yet.' });
    });
});
