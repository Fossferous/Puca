/**
 * "Allow remote control with the lid closed" — the switch on the PC itself.
 *
 * A laptop with its lid shut and no monitor plugged in has no screen switched
 * on, so there is nothing to capture and remote control cannot show anything.
 * Turning this on installs a small virtual screen driver, which Púca's
 * remote-access service switches on ONLY while a remote session needs it and
 * the PC has no real screen on, and off again afterwards
 * (`crates/puca-service/src/virtual_screen.rs`). The phone needs no setting:
 * it is told what is happening (`session.ts`, `screen-state`).
 *
 * WHAT TURNING IT ON DOES, so the card can say it before it happens:
 *   - one Windows administrator prompt (the helper that installs it), then
 *   - Windows' OWN "install this device software?" prompt naming the
 *     publisher, SignPath Foundation, which signs the open-source Virtual
 *     Display Driver. That prompt is kept on purpose: skipping it would mean
 *     trusting that publisher for every program it signs, machine-wide;
 *   - a device, "Virtual Display Driver", which stays DISABLED in Device
 *     Manager except during a remote session.
 * Turning it off removes the device, the driver and its settings.
 *
 * Remote control only, so absent from Lite: this module is only imported by
 * the Devices view, and its Tauri commands are compiled only with the
 * `remote-control` feature.
 */
import { isTauri } from '../platform';

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

export interface VirtualScreenState {
    /** The driver and its device are installed: the option is on. */
    installed: boolean;
    /** This PC can have it: x64, with the remote-access service installed. */
    available: boolean;
    /** Why it cannot be offered, when it cannot. */
    problem?: string | null;
}

/** Read from the machine every time (`virtual_screen_state`), never a stored
 *  flag: the device can be removed in Device Manager behind the app's back. */
export async function virtualScreenState(): Promise<VirtualScreenState> {
    if (!isTauri()) return { installed: false, available: false, problem: null };
    try {
        return await invokeTauri<VirtualScreenState>('virtual_screen_state');
    } catch (e) {
        return {
            installed: false,
            available: false,
            problem: e instanceof Error ? e.message : String(e),
        };
    }
}

/** Install it. Resolves to `null` on success, else the reason, worded for a
 *  person (a declined Windows prompt says so, rather than "error 3"). */
export async function enableVirtualScreen(): Promise<string | null> {
    if (!isTauri()) return 'This can only be turned on from the desktop app on that PC.';
    try {
        await invokeTauri<void>('virtual_screen_install');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** Remove it. Resolves to `null` on success, else the reason. */
export async function disableVirtualScreen(): Promise<string | null> {
    if (!isTauri()) return 'This can only be turned off from the desktop app on that PC.';
    try {
        await invokeTauri<void>('virtual_screen_remove');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}
