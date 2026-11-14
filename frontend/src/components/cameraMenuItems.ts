/**
 * The camera menu (the self-view's tap, the arrow beside the camera button,
 * full screen's Cameras): every camera by name, the one on ticked, then Flip,
 * Full screen and Turn off camera.
 *
 * While a switch is under way (a phone opens one camera at a time, so the
 * panel takes one switch at a time) the cameras and Flip are shown DISABLED.
 * They used to look pressable and a press did nothing at all: the panel drops
 * a switch asked for while another runs (VoicePanel.applyCameraSwitch). The
 * menu is drawn again when the switch is done. Turn off camera is never held
 * back: it also answers a switch that hangs.
 */
import type { ContextMenuItem } from './ContextMenu';
import { cameraDisplayName, canFlip, flipLabel, type CameraInfo, type Facing } from '../api/rtc/cameraChoice';

export function cameraMenuItems(o: {
    camera: { cameras: CameraInfo[]; deviceId: string | null; facing: Facing };
    /** A switch is under way (Flip shows itself busy meanwhile). */
    switching: boolean;
    fullscreen: boolean;
    choose: (deviceId: string) => void;
    flip: () => void;
    fullScreen: () => void;
    turnOff: () => void;
}): ContextMenuItem[] {
    const cams = o.camera.cameras;
    const items: ContextMenuItem[] = cams.map(c => ({
        id: `camera-${c.deviceId}`,
        label: cameraDisplayName(c, cams),
        checked: c.deviceId === o.camera.deviceId,
        testId: 'camera-option',
        value: c.deviceId,
        disabled: o.switching,
        onClick: () => { if (c.deviceId !== o.camera.deviceId) o.choose(c.deviceId); },
    }));
    if (cams.length > 0) items.push({ id: 'camera-sep', label: '', separator: true });
    if (canFlip(o.camera)) {
        items.push({ id: 'camera-flip', label: flipLabel(o.camera), icon: 'flip-camera', testId: 'camera-menu-flip', disabled: o.switching, onClick: o.flip });
    }
    if (!o.fullscreen) {
        items.push({ id: 'camera-fullscreen', label: 'Full screen', icon: 'fullscreen', onClick: o.fullScreen });
    }
    items.push({ id: 'camera-off', label: 'Turn off camera', icon: 'camera-off', danger: true, onClick: o.turnOff });
    return items;
}
