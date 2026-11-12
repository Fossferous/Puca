import { useSyncExternalStore } from 'react';

import { localCameraState, onLocalCameraState, type LocalCameraState } from '../api/rtc/cameraChoice';

/** The camera this device has on in the call (api/rtc/cameraChoice.ts): which
 *  one, the way it faces (whether the self-view is mirrored) and every camera
 *  there is to switch to. */
export function useLocalCamera(): LocalCameraState {
    return useSyncExternalStore(onLocalCameraState, localCameraState, localCameraState);
}
