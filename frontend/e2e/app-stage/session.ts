/**
 * The session module for the REAL APP built with a stand-in host
 * (vite.appstage.config.ts): everything the stage drives comes from the
 * device-stage harness's stand-in (../device-stage/fakeSession.ts); every
 * other export is the real module's, so the rest of the app (the Devices
 * page, the file browser, the host side) builds and runs as it ships. A named
 * export shadows the star export.
 *
 * The stand-in reports its session from the first subscription; here nothing
 * is reported until the driver calls `window.__appStage.start()`, so the app
 * signs in and opens a channel with no stage over it, as it does for real.
 */
import type { DeviceControlSession } from '../../src/api/devices/session';
import * as fake from '../device-stage/fakeSession';

export * from '../../src/api/devices/session';
export {
    ALL_DISPLAYS, subscribeCaret, setCaretTracking, setCursorOwned,
    sendInput, sendViewSize, requestMonitor, requestKeyframe, requestWindowList, chooseWindow,
    dismissWindowNotice, latencyProbeUsable, sendLatencyProbe, noteFramePresented, subscribeLatency,
    deviceStatsSample, endSession, sendClipboard, sendStreamQuality, setPrivacyMode, sendPowerAction,
    deviceDiagnosticsWindow, requestFileAccess, connectToDevice,
} from '../device-stage/fakeSession';

let live = false;
export function subscribeSessions(l: (s: DeviceControlSession[]) => void): () => void {
    if (!live) l([]);
    return fake.subscribeSessions(s => { if (live) l(s); });
}
export function activeSessions(): DeviceControlSession[] { return live ? fake.activeSessions() : []; }

(window as unknown as Record<string, unknown>).__appStage = {
    /** The session comes up, as a connect that the PC accepted does. `peerName`
     *  is the PC's name as the session layer reports it (null: none known). */
    start(peerName: string | null = null): void {
        const stage = (window as unknown as { __stage: { state: { peerName: string | null }; start(): void } }).__stage;
        stage.state.peerName = peerName;
        live = true;
        stage.start();
    },
};
