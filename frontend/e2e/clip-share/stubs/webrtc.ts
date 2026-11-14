// Stand-in for api/webrtc, for the clip modules only: what replayBuffer asks
// of the call stack, with the REAL rtc/media.ts MediaManager behind it, so a
// screen share starts exactly the way the app starts one
// (getScreenShareStream) and announces its capture the way the app does
// (onShareCapture). No microphone (the ring mixes system audio only here).
import { MediaManager } from '../../../src/api/rtc/media';

export const media = new MediaManager();
export const webrtcManager = {
    media,
    getLocalStreamSync: (): MediaStream | null => null,
    onMicTrackSwapped: (_cb: () => void): (() => void) => () => { },
};
