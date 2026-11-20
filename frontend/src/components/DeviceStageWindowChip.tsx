/**
 * What says, on the stage, that ONE WINDOW is shown on its own, and offers
 * the way back: the window's icon and title, and Whole screen beside them
 * (the desktop bar's chip, the phone's strip above its bottom bar). The
 * picker itself is DeviceStageWindowPicker.tsx.
 */
import { chooseWindow, type DeviceControlSession } from '../api/devices/session';
import { windowId } from '../api/devices/windowPick';
import { PopOutIcon } from './Icons';

/** The shown window's icon (from the last list, when it has one) and title. */
export function ShownWindowLabel({ session }: { session: DeviceControlSession }) {
    const w = session.activeWindow;
    if (!w) return null;
    const id = windowId(w);
    const listed = session.windowList?.windows.find(x => windowId(x) === id);
    const src = listed?.icon ? session.windowList?.icons[listed.icon] : undefined;
    return (
        <>
            <span className="dswp-icon" aria-hidden="true">
                {src ? <img src={src} alt="" width={18} height={18} draggable={false} /> : <PopOutIcon />}
            </span>
            <span className="dswp-chip-title" title={`${w.title} (${w.app})`}>{w.title}</span>
        </>
    );
}

/** The desktop bar's chip. */
export function DesktopWindowChip({ session }: { session: DeviceControlSession }) {
    if (!session.activeWindow) return null;
    return (
        <span className="dswp-chip" data-testid="window-chip">
            <ShownWindowLabel session={session} />
            <button
                type="button"
                className="device-stage-btn"
                title="Show the whole screen again"
                onClick={() => chooseWindow(session.id, null)}
            >
                Whole screen
            </button>
        </span>
    );
}
