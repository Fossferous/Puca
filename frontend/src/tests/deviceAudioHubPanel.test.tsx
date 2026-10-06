/**
 * The Audio Hub panel on a My Devices card: what it shows in each state, and
 * that Android's Bluetooth settings open ONLY after a successful "to phone".
 * The session layer is mocked — its gates are driven for real in
 * deviceSessionAuth.test.ts and deviceAudioHubController.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AudioHubOp, AudioHubOutcome, AudioHubStatus } from '../api/devices/audioHub';

type SessionLike = { id: string; role: string; phase: string; error: string | null };
let listener: ((s: SessionLike[]) => void) | null = null;
let sessions: SessionLike[] = [];
const connectToDevice = vi.fn(async (..._a: unknown[]) => 'sess-own');
const endSession = vi.fn((..._a: unknown[]) => {});
let existing: string | null = null;
/** What the PC answers, per op. */
let answers: Partial<Record<AudioHubOp, AudioHubOutcome>> = {};
let hold: Promise<void> | null = null;
const sendAudioHubRequest = vi.fn(async (_id: string, op: AudioHubOp): Promise<AudioHubOutcome> => {
    if (hold) await hold;
    return answers[op] ?? { kind: 'error', message: 'no answer scripted' };
});
vi.mock('../api/devices/session', () => ({
    connectToDevice: (...a: unknown[]) => connectToDevice(...a),
    endSession: (...a: unknown[]) => endSession(...a),
    sendAudioHubRequest: (id: string, op: AudioHubOp) => sendAudioHubRequest(id, op),
    audioHubSessionFor: () => existing,
    activeSessions: () => sessions,
    subscribeSessions: (l: (s: SessionLike[]) => void) => { listener = l; l(sessions); return () => { listener = null; }; },
}));
const openBluetoothSettings = vi.fn(async () => true);
vi.mock('../api/mobileApp', () => ({ openBluetoothSettings: () => openBluetoothSettings() }));
let android = true;
vi.mock('../api/platform', () => ({ isAndroidApp: () => android }));

import { DeviceAudioHubPanel } from '../components/DeviceAudioHubPanel';
import { AUDIO_HUB_REREAD_MS, AUDIO_HUB_IDLE_CLOSE_MS } from '../api/devices/audioHub';

const STATUS_FIXTURE: AudioHubStatus = {
    name: 'PC',
    airpods: { line: 'AirPods: L 64% · R 66%', onPc: true, handedToPhone: false },
    xm6: { line: 'XM6: connected', onPc: true, available: true },
    devices: 'Out: Speakers · Mic: AirPods',
};
const STATUS: AudioHubOutcome = {
    kind: 'status',
    status: {
        name: 'PC',
        airpods: { line: 'AirPods: L 64% · R 66%', onPc: true, handedToPhone: false },
        xm6: { line: 'XM6: connected', onPc: true, available: true },
        devices: 'Out: Speakers · Mic: AirPods',
    },
};

let root: Root;
let host: HTMLDivElement;

async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    }
}

/** Mount, and bring the panel's own session live the way session.ts would. */
async function mount(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(<DeviceAudioHubPanel hostDevice="pc-app" machineName="Desk PC" onClose={() => {}} />);
    });
    await flush();
    if (!existing) {
        sessions = [{ id: 'sess-own', role: 'controller', phase: 'active', error: null }];
        await act(async () => { listener?.(sessions); });
        await flush();
    }
}

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const text = () => host.textContent ?? '';

beforeEach(() => {
    sessions = [{ id: 'sess-own', role: 'controller', phase: 'connecting', error: null }];
    existing = null;
    answers = { status: STATUS };
    hold = null;
    android = true;
    connectToDevice.mockClear();
    endSession.mockClear();
    sendAudioHubRequest.mockClear();
    openBluetoothSettings.mockClear();
    openBluetoothSettings.mockResolvedValue(true);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
});

describe('the Audio Hub panel', () => {
    it('opens its own Audio Hub session and reads the status once it is live', async () => {
        await mount();
        expect(connectToDevice).toHaveBeenCalledWith('pc-app', { audioHub: true });
        expect(sendAudioHubRequest).toHaveBeenCalledWith('sess-own', 'status');
        expect(text()).toContain('AirPods: L 64% · R 66%');
        expect(text()).toContain('XM6: connected');
        for (const label of ['AirPods to phone', 'AirPods to PC', 'XM6 to phone', 'XM6 to PC']) {
            expect(button(label), label).not.toBeNull();
        }
    });

    it('shows no controls when Audio Hub is not running', async () => {
        answers = { status: { kind: 'not-running', message: "Audio Hub isn't running on that PC." } };
        await mount();
        expect(text()).toContain("Audio Hub isn't running on that PC.");
        expect(button('AirPods to phone')).toBeNull();
        expect(button('XM6 to PC')).toBeNull();
    });

    it('says to update an older PC instead of showing controls', async () => {
        answers = { status: { kind: 'unsupported', message: "That PC's Púca can't control Audio Hub yet — update Púca on it." } };
        await mount();
        expect(text()).toMatch(/update Púca/);
        expect(button('AirPods to phone')).toBeNull();
    });

    it('rides a session that is already open, and leaves it open on close', async () => {
        existing = 'sess-existing';
        await mount();
        expect(connectToDevice).not.toHaveBeenCalled();
        expect(sendAudioHubRequest).toHaveBeenCalledWith('sess-existing', 'status');
        await act(async () => { root.unmount(); });
        expect(endSession).not.toHaveBeenCalled();
        // afterEach unmounts again; give it something to unmount.
        root = createRoot(host);
    });

    it('ends the session it opened when it closes', async () => {
        await mount();
        await act(async () => { root.unmount(); });
        expect(endSession).toHaveBeenCalledWith('sess-own', 'closed Audio Hub');
        root = createRoot(host);
    });

    it('a successful "to phone" opens Bluetooth settings, after Audio Hub answered', async () => {
        answers.status = STATUS;
        answers['airpods-phone'] = { kind: 'action', ok: true, message: 'The PC let go of the AirPods.', error: null, httpStatus: 200 };
        await mount();
        let release!: () => void;
        hold = new Promise<void>(r => { release = r; });
        await act(async () => { button('AirPods to phone')!.click(); });
        await flush();
        expect(openBluetoothSettings, 'not before the answer').not.toHaveBeenCalled();
        expect(button('XM6 to PC')!.disabled, 'busy while the call runs').toBe(true);
        hold = null;
        await act(async () => { release(); });
        await flush();
        expect(openBluetoothSettings).toHaveBeenCalledTimes(1);
        expect(text()).toContain('The PC let go of the AirPods.');
        expect(host.querySelector('[role="status"].audio-hub-notice')).not.toBeNull();
    });

    it('a refused "to phone" shows Audio Hub\'s error and opens nothing', async () => {
        answers['xm6-phone'] = { kind: 'action', ok: false, message: null, error: 'FlooCast is not running on the PC', httpStatus: 503 };
        await mount();
        await act(async () => { button('XM6 to phone')!.click(); });
        await flush();
        expect(openBluetoothSettings).not.toHaveBeenCalled();
        expect(host.querySelector('[role="alert"]')?.textContent).toBe('FlooCast is not running on the PC');
    });

    it('a request that never got an answer opens nothing', async () => {
        answers['airpods-phone'] = { kind: 'error', message: 'That PC stopped answering before Audio Hub did.' };
        await mount();
        await act(async () => { button('AirPods to phone')!.click(); });
        await flush();
        expect(openBluetoothSettings).not.toHaveBeenCalled();
        expect(text()).toContain('That PC stopped answering');
    });

    it('"to PC" never opens Bluetooth settings', async () => {
        answers['airpods-pc'] = { kind: 'action', ok: true, message: 'The PC is taking the AirPods back.', error: null, httpStatus: 200 };
        await mount();
        await act(async () => { button('AirPods to PC')!.click(); });
        await flush();
        expect(openBluetoothSettings).not.toHaveBeenCalled();
        expect(text()).toContain('taking the AirPods back');
    });

    it('off Android, a "to phone" opens nothing', async () => {
        android = false;
        answers['xm6-phone'] = { kind: 'action', ok: true, message: 'The dongle let go of the XM6.', error: null, httpStatus: 200 };
        await mount();
        await act(async () => { button('XM6 to phone')!.click(); });
        await flush();
        expect(openBluetoothSettings).not.toHaveBeenCalled();
    });

    it('on an APK without the settings shortcut, says where to go instead', async () => {
        openBluetoothSettings.mockResolvedValue(false);
        answers['airpods-phone'] = { kind: 'action', ok: true, message: 'Let go.', error: null, httpStatus: 200 };
        await mount();
        await act(async () => { button('AirPods to phone')!.click(); });
        await flush();
        expect(text()).toContain('Open Bluetooth settings on this phone');
    });

    it('when Audio Hub stops mid-session the controls go', async () => {
        answers['airpods-pc'] = { kind: 'not-running', message: "Audio Hub isn't running on that PC." };
        await mount();
        await act(async () => { button('AirPods to PC')!.click(); });
        await flush();
        expect(button('AirPods to PC')).toBeNull();
        expect(text()).toContain("Audio Hub isn't running");
    });

    it('ends the session it opened after five idle minutes, and says so', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            host = document.createElement('div');
            document.body.appendChild(host);
            root = createRoot(host);
            await act(async () => {
                root.render(<DeviceAudioHubPanel hostDevice="pc-app" machineName="Desk PC" onClose={() => {}} />);
            });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            sessions = [{ id: 'sess-own', role: 'controller', phase: 'active', error: null }];
            await act(async () => { listener?.(sessions); await vi.advanceTimersByTimeAsync(10); });
            expect(button('AirPods to phone'), 'premise: the panel is live').not.toBeNull();
            await act(async () => { await vi.advanceTimersByTimeAsync(AUDIO_HUB_IDLE_CLOSE_MS - 1000); });
            expect(endSession).not.toHaveBeenCalled();
            await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
            expect(endSession).toHaveBeenCalledWith('sess-own', 'Audio Hub idle');
            expect(text()).toContain('Disconnected after 5 minutes');
            expect(button('AirPods to phone')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides the XM6 hand-overs when FlooCast is not running, and says so', async () => {
        answers.status = {
            kind: 'status',
            status: { ...STATUS_FIXTURE, xm6: { line: 'XM6', onPc: null, available: false } },
        };
        await mount();
        expect(button('XM6 to phone')).toBeNull();
        expect(button('XM6 to PC')).toBeNull();
        expect(text()).toContain("FlooCast isn't running on that PC");
        expect(button('AirPods to phone'), 'the AirPods are unaffected').not.toBeNull();
    });

    it('says where each headset is, and plays down the button for where it already is', async () => {
        await mount();
        const airpods = host.querySelectorAll('.audio-hub-headset')[0];
        expect(airpods.textContent).toContain('On the PC');
        expect(button('AirPods to PC')!.className).toContain('audio-hub-btn-here');
        expect(button('AirPods to phone')!.className).not.toContain('audio-hub-btn-here');
        // Still pressable: Audio Hub decides, Púca only hints.
        expect(button('AirPods to PC')!.disabled).toBe(false);
    });

    it('tells you to let go of the XM6 on the phone before taking it back', async () => {
        await mount();
        const xm6 = host.querySelectorAll('.audio-hub-headset')[1];
        expect(xm6.textContent).toMatch(/disconnect it on the phone first/i);
    });

    describe('after a hand-over (200 means QUEUED, not done)', () => {
        async function mountFake(): Promise<void> {
            host = document.createElement('div');
            document.body.appendChild(host);
            root = createRoot(host);
            await act(async () => {
                root.render(<DeviceAudioHubPanel hostDevice="pc-app" machineName="Desk PC" onClose={() => {}} />);
            });
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            sessions = [{ id: 'sess-own', role: 'controller', phase: 'active', error: null }];
            await act(async () => { listener?.(sessions); await vi.advanceTimersByTimeAsync(10); });
        }
        const statusReads = () => sendAudioHubRequest.mock.calls.filter(c => c[1] === 'status').length;

        it('re-reads a few times while the headset has not moved, then stops', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            try {
                answers['airpods-phone'] = { kind: 'action', ok: true, message: 'Let go.', error: null, httpStatus: 200 };
                await mountFake();
                expect(statusReads()).toBe(1);
                await act(async () => { button('AirPods to phone')!.click(); await vi.advanceTimersByTimeAsync(10); });
                // Audio Hub keeps saying "on the PC" (STATUS): every re-read is used...
                await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
                expect(statusReads()).toBe(1 + AUDIO_HUB_REREAD_MS.length);
                // ...and then nothing more: no background polling once settled.
                await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
                expect(statusReads()).toBe(1 + AUDIO_HUB_REREAD_MS.length);
            } finally {
                vi.useRealTimers();
            }
        });

        it('stops re-reading as soon as the headset is where it was sent', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            try {
                answers['airpods-phone'] = { kind: 'action', ok: true, message: 'Let go.', error: null, httpStatus: 200 };
                await mountFake();
                await act(async () => { button('AirPods to phone')!.click(); await vi.advanceTimersByTimeAsync(10); });
                if (STATUS.kind !== 'status') throw new Error('fixture');
                answers.status = { kind: 'status', status: { ...STATUS.status, airpods: { ...STATUS.status.airpods, onPc: false, handedToPhone: true } } };
                await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
                expect(statusReads()).toBe(2);
                expect(host.querySelectorAll('.audio-hub-headset')[0].textContent).toContain('Handed to the phone');
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it('a session that ends says why and drops the controls', async () => {
        await mount();
        sessions = [{ id: 'sess-own', role: 'controller', phase: 'ended', error: 'the person at that device declined' }];
        await act(async () => { listener?.(sessions); });
        expect(text()).toContain('the person at that device declined');
        expect(button('AirPods to phone')).toBeNull();
    });
});
