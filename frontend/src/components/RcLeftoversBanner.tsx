/**
 * Tells a Lite user that remote-control machinery from a previous FULL install
 * is still on this machine, and offers to remove it.
 *
 * WHY IT EXISTS. Removing remote control from the ARTIFACT does not remove it
 * from the HOST. The full build can register `SovereignRemote`, a LocalSystem
 * Windows service for unattended and sign-in-screen access, in
 * %ProgramFiles%\Sovereign\service — outside the app's own install directory,
 * so no uninstaller touches it. Switching to Lite therefore leaves a
 * SYSTEM-privileged remote-access service running on exactly the machine whose
 * owner chose the build that has none, along with this machine's enrolment
 * secrets and its unattended-arming record, which the service re-arms from on
 * every start.
 *
 * The banner is deliberately not dismissible-forever. It reflects live state:
 * it disappears the moment the thing it warns about is gone, and it comes back
 * on the next launch if it is not. A "don't show again" on a security notice
 * is a way to make the problem invisible rather than absent.
 */
import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '../api/platform';
import { WarningIcon, ShieldCheckIcon, TrashIcon } from './Icons';
import './RcLeftoversBanner.css';

interface Leftovers {
    service_installed: boolean;
    service_running: boolean;
    install_dir_present: boolean;
    secrets_present: boolean;
    install_dir: string;
}

/** Anything at all left behind? */
function anyLeftovers(s: Leftovers | null): boolean {
    return !!s && (s.service_installed || s.install_dir_present || s.secrets_present);
}

/**
 * What is actually still here, in the user's terms. Ordered by how much it
 * matters: a RUNNING service is a live capability; a registered-but-stopped one
 * starts at the next boot; files alone are inert until something re-provisions
 * from them.
 */
function describe(s: Leftovers): string {
    if (s.service_running) {
        return 'A remote-access service from a previous full install is RUNNING on this machine, '
            + 'with system-level privileges.';
    }
    if (s.service_installed) {
        return 'A remote-access service from a previous full install is still registered on this '
            + 'machine and will start again at the next boot.';
    }
    return 'Files from a previous full install’s remote-access component are still on this '
        + 'machine, including this machine’s remote-access keys.';
}

export function RcLeftoversBanner() {
    const [state, setState] = useState<Leftovers | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set once removal has been launched, so the copy can say what to expect. */
    const [launched, setLaunched] = useState(false);

    const refresh = useCallback(async () => {
        if (!isTauri()) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            setState(await invoke<Leftovers>('rc_leftovers_status'));
        } catch {
            // An older shell without the command, or a non-desktop build:
            // nothing to report and nothing this banner can do about it.
            setState(null);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('rc_leftovers_remove');
            setLaunched(true);
            // The command returns as soon as the ELEVATED process is launched —
            // never that removal finished. Re-poll rather than assume; the
            // banner clears itself when the state actually changes.
            setTimeout(() => { void refresh(); }, 1500);
            setTimeout(() => { void refresh(); }, 5000);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    if (!anyLeftovers(state) || !state) return null;

    return (
        <div className="rcleft-banner" role="status">
            <span className="rcleft-icon"><WarningIcon /></span>
            <div className="rcleft-text">
                <strong>Remote access is still installed on this device</strong>
                <span>{describe(state)}</span>
                <span className="rcleft-path">{state.install_dir}</span>
                {launched && !error && (
                    <span className="rcleft-note">
                        Removal was started. If you approved the prompt this notice will clear on its own.
                    </span>
                )}
                {error && <span className="rcleft-error">{error}</span>}
            </div>
            <div className="rcleft-actions">
                <button className="rcleft-remove-btn" onClick={remove} disabled={busy}>
                    <TrashIcon /> {busy ? 'Removing…' : 'Remove it'}
                </button>
                <button className="rcleft-recheck-btn" onClick={() => void refresh()} disabled={busy}>
                    <ShieldCheckIcon /> Re-check
                </button>
            </div>
        </div>
    );
}
