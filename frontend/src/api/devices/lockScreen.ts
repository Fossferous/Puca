/**
 * Lock-screen access — the opt-in.
 *
 * OFF UNLESS SOMEBODY TURNS IT ON. Installing Puca registers no service,
 * creates nothing under Program Files, and raises no elevation prompt. This
 * module is the only route to any of that, and it exists behind a switch the
 * owner has to find and flip. A LocalSystem service arriving with a routine app
 * update is precisely what people are right to be suspicious of, and shipping
 * one that way would be indefensible however useful it is.
 *
 * WHAT TURNING IT ON ACTUALLY DOES, so the UI can say it plainly:
 *   - copies two binaries into %ProgramFiles%\Puca\service with a
 *     protected, administrator-only ACL;
 *   - registers a Windows service, `SovereignRemote`, running as LocalSystem
 *     and starting at boot;
 *   - that service runs an agent ONLY while the machine is locked or nobody is
 *     signed in, and stops it again on unlock.
 *
 * Turning it off removes all three. "Off" has to be a state, not a claim.
 */
import { isTauri } from '../platform';
import { apiClient } from '../client';
import { API_BASE_URL } from '../config';
import { getToken, decodeJwtPayload } from '../auth';
import { getActiveIdentity, deriveAccountSigningKey } from '../e2ee';
import { buildAuthRecord, signAuthRecord } from './identity';
import { buildUaRecord } from './unattended';

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

export interface LockScreenState {
    /** The service is registered on this machine. */
    installed: boolean;
    /** Registered AND currently running. */
    running: boolean;
    /** This build ships the components at all. */
    available: boolean;
    /** Why it cannot be offered, when it cannot. */
    problem?: string | null;
}

/** Only the desktop app can install a Windows service. */
export function lockScreenSupported(): boolean {
    return isTauri();
}

/**
 * Read the REAL state from Windows, never a stored boolean.
 *
 * The service can be removed with `sc delete`, by another admin, or by an
 * uninstall this app never saw. A remembered flag would then show a toggle that
 * is on while nothing is installed — which is the same class of bug as a
 * settings screen that reports what it wrote rather than what is true.
 */
export async function lockScreenState(): Promise<LockScreenState> {
    if (!isTauri()) {
        return { installed: false, running: false, available: false, problem: null };
    }
    try {
        return await invokeTauri<LockScreenState>('service_state');
    } catch (e) {
        return {
            installed: false,
            running: false,
            available: false,
            problem: e instanceof Error ? e.message : 'Could not read the service state.',
        };
    }
}

/**
 * Turn it on. Raises exactly one Windows elevation prompt.
 *
 * Returns an error message rather than throwing, because every failure here is
 * something the user should read: declining the prompt, a missing component, a
 * refused install path. A silent revert would leave them staring at a switch
 * that snapped back for no stated reason.
 */
export async function enableLockScreenAccess(): Promise<string | null> {
    if (!isTauri()) return 'This can only be turned on from the desktop app.';
    try {
        await invokeTauri<void>('service_enable');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** Turn it off: stop the service, delete it, remove its files. */
export async function disableLockScreenAccess(): Promise<string | null> {
    if (!isTauri()) return 'This can only be turned off from the desktop app.';
    try {
        await invokeTauri<void>('service_disable');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/**
 * The two switches, read from the machine rather than remembered.
 *
 * ENROLLED means this computer can be reached at its sign-in screen at all.
 * ARMED means a session there may be authorised by proving a passphrase. Both
 * are required before anything happens, and they are separate so that disarming
 * can shut the door without tearing down the connection you would need to
 * re-arm it.
 */
export interface UnattendedAccessState {
    serviceInstalled: boolean;
    enrolled: boolean;
    armed: boolean;
    /**
     * The device row this machine is enrolled as at its sign-in screen, or null.
     *
     * ONE PC IS TWO DEVICE ROWS — the app's and this service's, each with its
     * own keypair because neither process may hold the other's. Nothing linked
     * them, so the list showed the same machine twice and, worse, only the
     * app's row ever had a MAC recorded: the row you can actually reach while
     * the screen is locked could never be woken. `lanInfo.ts` uses this id to
     * publish the same sealed LAN details to both rows, which fixes the wake
     * and makes the two rows recognisable as one machine (same MAC).
     */
    deviceId: string | null;
    /**
     * Fingerprint of the INSTALLED service+agent pair, reported by the running
     * service itself. Null from an old service that predates the field — which
     * is itself the strongest possible "this service needs updating".
     */
    binsHash: string | null;
    error?: string | null;
}

export async function unattendedAccessState(): Promise<UnattendedAccessState> {
    if (!isTauri()) {
        return {
            serviceInstalled: false, enrolled: false, armed: false,
            deviceId: null, binsHash: null,
        };
    }
    try {
        const s = await invokeTauri<{
            service_installed: boolean;
            enrolled: boolean;
            armed: boolean;
            device_id?: string | null;
            bins_hash?: string | null;
            error?: string | null;
        }>('lock_screen_state');
        return {
            serviceInstalled: s.service_installed,
            enrolled: s.enrolled,
            armed: s.armed,
            deviceId: s.device_id ?? null,
            binsHash: s.bins_hash ?? null,
            error: s.error ?? null,
        };
    } catch (e) {
        return {
            serviceInstalled: false,
            enrolled: false,
            armed: false,
            deviceId: null,
            binsHash: null,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * Does the running service predate the app that is asking?
 *
 * A PURE decision so it can be tested: `reported` is what the running service
 * says it is (null from a service too old to say — which IS out of date), and
 * `bundled` is what this app ships (null in a dev build with no sidecar, where
 * no update can be offered anyway).
 *
 * WHY THIS MATTERS ENOUGH TO EXIST: the app auto-updates and the service does
 * not — nothing but enrolment day ever touched it. The skew is invisible: the
 * pipe still answers, just without whatever fields the newer app relies on.
 * That is exactly how 0.8.82's one-card-per-PC merge silently never engaged —
 * the service never sent `device_id`, so the sign-in row never got its MAC.
 */
export function serviceNeedsUpdate(
    reported: string | null,
    bundled: string | null,
): boolean {
    if (!bundled) return false;
    return reported !== bundled;
}

/**
 * Should the app-root "update the service" banner show? The card's decision
 * plus the one thing the card's placement already implied: there has to BE a
 * service. `installed` from the SCM (`service_state`), `reported` from the
 * running service over the control pipe, `bundled` from this build's
 * sidecars. Pure; the banner (`ServiceUpdateBanner.tsx`) is the only caller.
 */
export function serviceUpdateBannerDue(
    installed: boolean,
    reported: string | null,
    bundled: string | null,
): boolean {
    return installed && serviceNeedsUpdate(reported, bundled);
}

export interface BundledFingerprint {
    hash: string | null;
    /**
     * Set only when the pair SHOULD have been readable and was not — never
     * for the ordinary "this build has no sidecars" case, which is `hash:
     * null, error: null`. The distinction matters: collapsing both into a
     * bare `null` is exactly how the previous version of this went missing
     * with nothing anywhere saying why — on a real install, `bundled` being
     * silently null makes `serviceNeedsUpdate` return false and the "Update
     * the service" card never appears, indistinguishable from "already
     * current". This field is what turns that into something reportable.
     */
    error: string | null;
}

/** The fingerprint of the service+agent pair bundled with THIS app build. */
export async function bundledServiceFingerprint(): Promise<BundledFingerprint> {
    if (!isTauri()) return { hash: null, error: null };
    try {
        const hash = await invokeTauri<string | null>('service_bundled_fingerprint');
        return { hash, error: null };
    } catch (e) {
        return { hash: null, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Replace the installed service binaries with this build's. One elevation
 * prompt; the registration, enrolment and passphrase all survive.
 */
export async function updateLockScreenService(): Promise<string | null> {
    if (!isTauri()) return 'This can only be done from the desktop app.';
    try {
        await invokeTauri<void>('service_update');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/**
 * Enrol this machine so its sign-in screen can be reached.
 *
 * THREE STEPS, AND THE ORDER IS THE POINT. The service generates its own device
 * keypair and hands back only the public halves; this signs a record describing
 * them with the ACCOUNT key and enrols it with the server; only then is the
 * service told where to connect and which account key to verify others against.
 *
 * The account signing key never reaches the service. It is derived from the
 * account seed, and a LocalSystem process holding an internet socket must not be
 * able to enrol devices into the account — it gets the PUBLIC half, which is
 * enough to verify a peer and useless for enrolling anything.
 *
 * Returns an error message rather than throwing, matching the other toggles in
 * this file, because every failure here is something the user needs to read.
 */
export async function enrolLockScreenAccess(name?: string): Promise<string | null> {
    if (!isTauri()) return 'This can only be turned on from the desktop app.';

    const identity = getActiveIdentity();
    if (!identity) {
        return 'Unlock Puca on this computer first — enrolling has to sign with your account key.';
    }
    const token = getToken();
    if (!token) return 'Sign in first: this computer needs a copy of the session to connect.';

    // CAPTURE THE PREDECESSOR'S ROW ID BEFORE IT IS UNKNOWABLE. `begin_enrol`
    // overwrites the stored keys, and the device id is derived from the keys —
    // so the old row's id exists nowhere after that call. Every re-enrolment
    // used to orphan the previous row this way: permanently offline (its
    // private key is destroyed), never grouped, never cleaned up. Three of
    // them accumulated on one machine before anyone understood why.
    let priorDeviceId: string | null = null;
    try {
        const prior = await unattendedAccessState();
        priorDeviceId = prior.enrolled ? prior.deviceId : null;
    } catch {
        // Unknowable is survivable: worst case is the old behaviour, one
        // orphan row the user can revoke by hand.
    }

    // The account id comes from the TOKEN, not from the identity: `Identity`
    // carries keys, not an account number, and the server derives the same id
    // from the same token when it validates the enrolment.
    let userId: number;
    try {
        const sub = decodeJwtPayload(token)?.sub;
        if (typeof sub !== 'number') throw new Error('no sub');
        userId = sub;
    } catch {
        return 'Could not tell which account this is. Sign in again and retry.';
    }

    try {
        // 1. The service makes its own keys. The private halves never leave it.
        const keys = await invokeTauri<{
            device_id: string;
            device_pub: string;
            sign_pub: string;
        }>('lock_screen_begin_enrol');

        // 2. Sign a record describing them, and enrol it.
        const deviceName = name?.trim() || 'This PC (sign-in screen)';
        const { canonical, deviceId } = buildAuthRecord({
            devicePub: keys.device_pub,
            signPub: keys.sign_pub,
            name: deviceName,
            platform: 'windows',
            userId,
        });

        // The server derives the id independently and ignores what we claim, so
        // a mismatch means the service handed back keys that do not hash to the
        // id it reported. Catch it now rather than shipping a device row that
        // can never attest.
        if (deviceId !== keys.device_id) {
            return 'This computer reported keys that do not match its own device id. Try again.';
        }

        await apiClient.post('/devices', {
            device_pub: keys.device_pub,
            sign_pub: keys.sign_pub,
            name: deviceName,
            platform: 'windows',
            auth_record: canonical,
            auth_sig: signAuthRecord(identity, canonical),
        });

        // 3. Tell the service where to connect, and whose signature to trust.
        await invokeTauri<void>('lock_screen_finish_enrol', {
            apiBase: API_BASE_URL,
            userId,
            token,
            accountSignPub: deriveAccountSigningKey(identity).publicKeyEncoded,
        });

        // 4. Retire the predecessor row — ONLY now, with the new enrolment
        // fully landed. Revoking first would leave the machine unreachable if
        // any later step failed. Best-effort: its key is already destroyed,
        // so the worst a failure here costs is one stale card.
        if (priorDeviceId && priorDeviceId !== keys.device_id) {
            try {
                const { revokeDevice } = await import('./index');
                await revokeDevice(priorDeviceId);
            } catch {
                // The old row stays visible until revoked by hand. Not worth
                // failing an enrolment that succeeded.
            }
        }

        // 5. Give the fresh row its LAN details NOW. The steady-state publish
        // fires on the next socket attestation — days away on a desktop that
        // stays up — and until then this row would be un-wakeable and
        // un-grouped, which is precisely the field failure this fixes.
        try {
            const { publishNow } = await import('./lanInfo');
            await publishNow();
        } catch {
            // The attestation-day publish remains as the retry path.
        }
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** Forget everything: keys, token, connection details and the passphrase —
 *  and retire the server row, which "forget" used to leave behind as a
 *  permanently-offline card (the keys that could attest for it are gone). */
export async function unenrolLockScreenAccess(): Promise<string | null> {
    if (!isTauri()) return 'This can only be turned off from the desktop app.';

    // Captured BEFORE the service forgets: afterwards nothing knows the id.
    let priorDeviceId: string | null = null;
    try {
        const prior = await unattendedAccessState();
        priorDeviceId = prior.enrolled ? prior.deviceId : null;
    } catch {
        // Unknowable is survivable — one stale card, removable by hand.
    }

    try {
        await invokeTauri<void>('lock_screen_unenrol');
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }

    if (priorDeviceId) {
        try {
            const { revokeDevice } = await import('./index');
            await revokeDevice(priorDeviceId);
        } catch {
            // The machine-side forget succeeded, which is the half that
            // matters for security; the leftover card is cosmetic.
        }
    }
    return null;
}

/**
 * Set the passphrase that authorises a session at the sign-in screen.
 *
 * Derived HERE; only the salt and the public verifying key are stored on the
 * machine. The passphrase itself exists inside this call and nowhere else — not
 * returned, not logged, not kept.
 *
 * THIS IS THE ONLY THING PROTECTING A MACHINE THAT IS SITTING AT ITS LOGIN
 * SCREEN, and there is no server-side rate limit behind it and no recovery, so
 * the minimum length is enforced here rather than only in the UI.
 */
export async function armLockScreenAccess(passphrase: string): Promise<string | null> {
    if (!isTauri()) return 'This can only be set from the desktop app.';
    if (passphrase.length < 8) {
        return 'Use at least 8 characters — this is the only thing protecting the sign-in screen.';
    }
    try {
        const record = buildUaRecord(passphrase);
        await invokeTauri<void>('lock_screen_arm', { record: JSON.stringify(record) });
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** Shut the door. Removing the record IS the revocation — the agent re-reads
 *  it on every connection, so this takes effect on the next session and not at
 *  the next reboot. */
export async function disarmLockScreenAccess(): Promise<string | null> {
    if (!isTauri()) return 'This can only be changed from the desktop app.';
    try {
        await invokeTauri<void>('lock_screen_disarm');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

