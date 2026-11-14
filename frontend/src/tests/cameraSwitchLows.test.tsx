/**
 * The lows the camera switch's review rounds left (the camera-rear hand-over),
 * each pinned where it was decided:
 *
 *  - the camera list followed the browser's devicechange (watchCameraList): a
 *    webcam plugged in mid-call brought no Flip and no camera arrow;
 *  - full screen and back kept the keyboard's focus (useFocusAcrossTakeover):
 *    it was left on the page's body, both ways, and on turning the camera off;
 *  - the camera menu's cameras and Flip are disabled while a switch is under
 *    way (cameraMenuItems): a press on them did nothing at all;
 *  - a Settings save re-opened a listen-only member's microphone
 *    (settingsReacquireMic) whenever Input Volume was not 100%;
 *  - on an SFU call, a switch that could not reach the call was only logged:
 *    the camera stayed "on" with nothing sent (VoicePanel.applyCameraSwitch).
 *
 * VoicePanel cannot be mounted under vitest: its wiring is read from source.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { localCameraState, setLocalCameraState, watchCameraList, type CameraInfo } from '../api/rtc/cameraChoice';
import { useFocusAcrossTakeover } from '../components/useFocusAcrossTakeover';
import { cameraMenuItems } from '../components/cameraMenuItems';
import { settingsReacquireMic } from '../components/settingsMicReacquire';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'VoicePanel.tsx'), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

afterEach(() => {
    vi.unstubAllGlobals();
    setLocalCameraState({ deviceId: null, trackId: null, facing: null, cameras: [] });
});

describe('the camera list follows the browser (devicechange)', () => {
    const cam = (deviceId: string, label: string) => ({ kind: 'videoinput', deviceId, label, getCapabilities: () => ({}) });
    function devices(initial: ReturnType<typeof cam>[]) {
        const target = new EventTarget();
        let list = initial;
        const pending: Array<() => void> = [];
        let hold = false;
        const md = Object.assign(target, {
            enumerateDevices: vi.fn(() => {
                const snapshot = list;
                if (!hold) return Promise.resolve(snapshot);
                return new Promise(r => pending.push(() => r(snapshot)));
            }),
        });
        vi.stubGlobal('navigator', { mediaDevices: md });
        return {
            set(next: ReturnType<typeof cam>[]) { list = next; },
            change() { target.dispatchEvent(new Event('devicechange')); },
            holdLooks(on: boolean) { hold = on; },
            answer(i: number) { pending[i](); },
        };
    }
    const ids = () => localCameraState().cameras.map((c: CameraInfo) => c.deviceId);

    it('THE BUG: a webcam plugged in mid-call is in the list (so Flip and the camera arrow come), and one unplugged goes', async () => {
        const d = devices([cam('front', 'Front Camera')]);
        setLocalCameraState({ cameras: [{ deviceId: 'front', label: 'Front Camera', facing: 'user' }] });
        const stop = watchCameraList();
        d.set([cam('front', 'Front Camera'), cam('usb', 'USB Webcam')]);
        d.change();
        await flush();
        expect(ids()).toEqual(['front', 'usb']);
        d.set([cam('front', 'Front Camera')]);
        d.change();
        await flush();
        expect(ids()).toEqual(['front']);
        stop();
        d.set([cam('front', 'Front Camera'), cam('usb', 'USB Webcam')]);
        d.change();
        await flush();
        expect(ids(), 'still watched after it was stopped (the camera turned off)').toEqual(['front']);
    });

    it('the newest look wins: a list that answers after a later one is dropped', async () => {
        const d = devices([cam('a', 'A')]);
        const stop = watchCameraList();
        d.holdLooks(true);
        d.set([cam('a', 'A')]);
        d.change(); // look 0: the old list
        d.set([cam('a', 'A'), cam('b', 'B')]);
        d.change(); // look 1: the new list
        d.answer(1);
        await flush();
        d.answer(0);
        await flush();
        expect(ids()).toEqual(['a', 'b']);
        stop();
    });
});

describe('full screen and back keep the keyboard\'s focus', () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;
    afterEach(async () => {
        if (root) await act(async () => root!.unmount());
        container?.remove();
        root = null;
        container = null;
    });

    /** A self-view whose menu button opens full screen, as the panel's does:
     *  the button is not drawn while full screen is, nor full screen's Exit
     *  once it closes. */
    const control = { open: (_on: boolean) => {} };
    function Panel() {
        const [full, setFull] = useState(false);
        useEffect(() => { control.open = setFull; }, []);
        useFocusAcrossTakeover(full, () => document.querySelector<HTMLButtonElement>('#exit'), () => document.querySelector<HTMLButtonElement>('#self'));
        return (
            <div>
                <input id="elsewhere" />
                {/* Keyed apart, as the panel's are separate trees: React would
                    otherwise keep the one <button> and only change its id. */}
                {full
                    ? <button key="exit" id="exit" onClick={() => setFull(false)}>Exit Fullscreen</button>
                    : <button key="self" id="self" onClick={() => setFull(true)}>Your camera</button>}
            </div>
        );
    }
    async function mount() {
        container = document.body.appendChild(document.createElement('div'));
        root = createRoot(container);
        await act(async () => root!.render(<Panel />));
        return control;
    }

    it('THE BUG: into full screen the focus goes to its Exit, and back out to the self-view, never to the page\'s body', async () => {
        await mount();
        const self = document.getElementById('self') as HTMLButtonElement;
        self.focus();
        await act(async () => self.click());
        expect(document.activeElement?.id, 'left on nothing as the self-view went').toBe('exit');
        await act(async () => (document.getElementById('exit') as HTMLButtonElement).click());
        expect(document.activeElement?.id).toBe('self');
    });

    it('CONTROL: a focus put somewhere else on purpose is left there', async () => {
        const control = await mount();
        (document.getElementById('elsewhere') as HTMLInputElement).focus();
        await act(async () => control.open(true));
        expect(document.activeElement?.id).toBe('elsewhere');
        await act(async () => control.open(false));
        expect(document.activeElement?.id).toBe('elsewhere');
    });

    it('VoicePanel: full screen\'s Exit, then the self-view\'s button (the camera button once it is off), and the camera turned off', () => {
        expect(VP).toMatch(/useFocusAcrossTakeover\(isCameraOn && isFullscreen,\s*\(\) => fullscreenExitRef\.current,\s*\(\) => selfViewMenuRef\.current \?\? cameraButtonRef\.current\)/);
        expect(VP).toMatch(/useFocusAcrossTakeover\(isCameraOn, \(\) => null, \(\) => cameraButtonRef\.current\)/);
        expect(VP).toMatch(/ref=\{fullscreenExitRef\}\s*className="fullscreen-btn exit-btn"/);
        expect(VP).toMatch(/ref=\{selfViewMenuRef\}[\s\S]{0,200}data-testid="camera-self-view-menu"/);
        expect(VP).toMatch(/ref=\{cameraButtonRef\}\s*className=\{`voice-btn vp-camera/);
    });
});

describe('the camera menu while a switch is under way', () => {
    const camera = {
        cameras: [
            { deviceId: 'front', label: 'Front Camera', facing: 'user' as const },
            { deviceId: 'back', label: 'Back Camera', facing: 'environment' as const },
        ],
        deviceId: 'front',
        facing: 'user' as const,
    };
    const menu = (switching: boolean) => cameraMenuItems({
        camera, switching, fullscreen: false,
        choose: () => {}, flip: () => {}, fullScreen: () => {}, turnOff: () => {},
    });

    it('THE BUG: its cameras and Flip are disabled (a press on them did nothing at all), Turn off camera is not', () => {
        const items = menu(true);
        const by = (id: string) => items.find(i => i.id === id)!;
        expect(by('camera-front').disabled).toBe(true);
        expect(by('camera-back').disabled).toBe(true);
        expect(by('camera-flip').disabled).toBe(true);
        expect(by('camera-off').disabled, 'Turn off also answers a switch that hangs').toBeFalsy();
        expect(by('camera-fullscreen').disabled).toBeFalsy();
    });

    it('CONTROL: with no switch under way every row is pressable, and a camera press chooses it', () => {
        const chosen: string[] = [];
        const items = cameraMenuItems({ camera, switching: false, fullscreen: false, choose: (id) => chosen.push(id), flip: () => {}, fullScreen: () => {}, turnOff: () => {} });
        expect(items.filter(i => i.disabled)).toEqual([]);
        items.find(i => i.id === 'camera-back')!.onClick!();
        items.find(i => i.id === 'camera-front')!.onClick!(); // the one on: nothing
        expect(chosen).toEqual(['back']);
    });

    it('VoicePanel draws it with the switch under way', () => {
        expect(VP).toMatch(/cameraMenuItems\(\{\s*camera: ownCamera,\s*switching: cameraSwitching,/);
        expect(VP).toMatch(/items=\{cameraMenuRows\(\)\}/);
    });
});

describe('a Settings save mid-call and a listen-only member\'s microphone', () => {
    const base = { inVoice: true, listenOnly: false, deviceChanged: false, constraintsChanged: false, dfTuningChanged: false, gainNeedsGraph: false };

    it('THE BUG: listen-only, Input Volume not 100% (no gain stage: no microphone), any save: the microphone is NOT opened', () => {
        expect(settingsReacquireMic({ ...base, listenOnly: true, gainNeedsGraph: true })).toBe(false);
        expect(settingsReacquireMic({ ...base, listenOnly: true, constraintsChanged: true })).toBe(false);
        expect(settingsReacquireMic({ ...base, listenOnly: true, dfTuningChanged: true })).toBe(false);
    });

    it('listen-only, a microphone picked in Settings: tried (the one way out of listen-only from here)', () => {
        expect(settingsReacquireMic({ ...base, listenOnly: true, deviceChanged: true, constraintsChanged: true })).toBe(true);
    });

    it('CONTROL: with a microphone, each reason still re-opens it; out of a call nothing does', () => {
        expect(settingsReacquireMic({ ...base, gainNeedsGraph: true })).toBe(true);
        expect(settingsReacquireMic({ ...base, constraintsChanged: true })).toBe(true);
        expect(settingsReacquireMic({ ...base, dfTuningChanged: true })).toBe(true);
        expect(settingsReacquireMic(base)).toBe(false);
        expect(settingsReacquireMic({ ...base, inVoice: false, constraintsChanged: true })).toBe(false);
    });

    it('VoicePanel asks it, with the media layer\'s listen-only and whether the input device changed', () => {
        expect(VP).toMatch(/if \(!settingsReacquireMic\(\{\s*inVoice: isInVoiceRef\.current,\s*listenOnly: webrtcManager\.isListenOnly\(\),\s*deviceChanged, constraintsChanged, dfTuningChanged, gainNeedsGraph,\s*\}\)\) return;/);
        expect(VP).toMatch(/const deviceChanged = s\.inputDeviceId !== inputDevice;/);
    });
});

describe('an SFU switch that could not reach the call', () => {
    it('turns the camera off and says so (it was only logged: "on", with nothing sent)', () => {
        const at = VP.indexOf('await sfuManager.replaceCameraTrack(live);');
        expect(at).toBeGreaterThan(0);
        const handler = VP.slice(at, VP.indexOf('if (live) showOwnCamera(currentUserId, live);', at));
        expect(handler).toMatch(/catch \(err\) \{[\s\S]*setError\(CAMERA_NOT_SENT_NOTICE\);[\s\S]*await setCameraEnabled\(false\)[\s\S]*return;\s*\}/);
    });
});
