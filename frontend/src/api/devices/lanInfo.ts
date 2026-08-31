/**
 * Records THIS machine's LAN details so another of your devices can wake it.
 *
 * This is the half that was missing for the whole life of the wake feature:
 * `wake.ts` could plan and relay a wake, `wol.rs` could send the packet, and
 * the backend had a column to hold the details — but nothing ever gathered a
 * MAC, so `devices.lan_info` was permanently NULL and `planWake` could only
 * ever answer "no waker". Everything here exists to fill that column.
 *
 * PRIVACY. The blob is sealed client-side (`sealLanInfo`, HKDF off the account
 * seed) before it is sent. The server stores an opaque string: it never learns
 * which MAC or internal IP belongs to which device, which matters because a
 * map of a user's home network is exactly the kind of thing a self-hosted
 * product should not be accumulating. Every device that needs to READ it
 * already holds the seed.
 */
import { isTauri } from '../platform';
import { updateDeviceLanInfo } from './index';
import { thisDeviceId } from '../thisDevice';
import { unattendedAccessState } from './lockScreen';
import { sealLanInfo, type LanInfo } from './wake';

/** What the native collector returns. Superset of `LanInfo` — the extra fields
 *  are recorded so the UI can explain itself ("last seen on Wi-Fi"). */
interface CollectedLan extends LanInfo {
    v?: number;
    prefix?: number;
    wired?: boolean;
    iface?: string;
}

/**
 * Ask the native side which card would still be listening after this machine
 * powers off. Null off Tauri: a browser or a phone has no way to enumerate
 * adapters, and neither can be woken anyway.
 */
export async function collectLanInfo(): Promise<CollectedLan | null> {
    if (!isTauri()) return null;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke<CollectedLan | null>('lan_info');
        return info?.mac ? info : null;
    } catch {
        // Old shell without the command, or an adapter enumeration that failed.
        // Neither is worth surfacing: the consequence is simply that this
        // device cannot be woken, which the Devices UI already explains.
        return null;
    }
}

/** The last blob we successfully stored, so an unchanged network is silent. */
let publishedFingerprint: string | null = null;
let installed = false;
let inFlight = false;
/** Something changed while a publish was in flight; run once more after it. */
let republishWanted = false;

/** Everything that decides whether a stored blob is still correct. Compared as
 *  a string rather than deep-equality because it is only ever used for "has
 *  this changed", and the sealed ciphertext itself cannot be compared (it is
 *  nondeterministic — a fresh nonce every time, so equal inputs seal to
 *  different bytes and would re-PATCH forever). */
/** Includes the DEVICE ID, not just the hardware.
 *
 *  Keying on the NIC alone made the guard mean "this network has been
 *  published by someone", when what it must mean is "this network has been
 *  published FOR THIS DEVICE ROW". Two real paths otherwise leave a row's
 *  `lan_info` NULL forever, on the same unchanged hardware: re-enrolling this
 *  machine (Devices → reset identity mints a NEW device id), and signing in as
 *  a different account (a different row again). Both are un-wakeable until the
 *  app restarts, and `planWake` then advises opening Puca on that
 *  machine — which is exactly what just happened and changed nothing. */
function fingerprint(deviceId: string, companionId: string | null, info: CollectedLan): string {
    return [
        deviceId,
        // INCLUDES THE COMPANION TOO, so enrolling sign-in-screen access is not
        // silently swallowed by a guard that already matched. Without this the
        // new row would wait for a network change to get its MAC — and on a
        // machine that never moves, that is for ever.
        companionId ?? '',
        info.mac,
        info.ip ?? '',
        info.subnet ?? '',
        info.broadcast ?? '',
        String(info.wired ?? ''),
    ].join('|');
}

/**
 * The OTHER device row that is this same physical machine, if there is one.
 *
 * ONE PC, TWO ROWS. Sign-in-screen access is a LocalSystem service with its own
 * keypair — it cannot share the app's, and it must never hold the account seed
 * — so it enrols as a second device. That is a security requirement, not an
 * accident, and it stays.
 *
 * What was an accident is that only the app's row ever got LAN details, because
 * this module published to `thisDeviceId()` and nothing else. The consequence
 * was precise and bad: the row you can actually REACH while the screen is
 * locked was the one that could never be WOKEN, and its refusal told you to
 * "open Puca on that device once", which publishes to the other row and
 * can never help. The two halves of one machine each lacked what the other had.
 *
 * Same machine, same adapter, same MAC — so the same sealed blob is correct for
 * both, and two rows carrying one MAC are self-evidently one machine, which is
 * what lets the UI show a single card without inventing a new server field.
 */
async function companionDeviceId(): Promise<string | null> {
    if (!isTauri()) return null;
    try {
        const s = await unattendedAccessState();
        return s.enrolled ? s.deviceId : null;
    } catch {
        // No service, an old shell, or a pipe that refused. The machine simply
        // has no companion row, which is the ordinary case.
        return null;
    }
}

async function publish(): Promise<void> {
    // One at a time — two overlapping PATCHes of the same row race for no
    // benefit — but a request that arrives DURING one is remembered rather
    // than dropped. Dropping it lost the case that matters most: moving to a
    // different network re-attests, and if that landed while the previous
    // publish was still collecting, the old network's details were stored and
    // nothing corrected them until the next reconnect.
    if (inFlight) {
        republishWanted = true;
        return;
    }
    const deviceId = thisDeviceId();
    if (!deviceId) return;

    inFlight = true;
    try {
        const info = await collectLanInfo();
        if (!info) return;
        const companion = await companionDeviceId();
        const print = fingerprint(deviceId, companion, info);
        if (print === publishedFingerprint) return;

        // SEALED PER ROW, because each carries its own `role`. The MAC is the
        // same — it is one adapter — and that shared MAC is what lets the UI
        // recognise the two rows as one machine; `role` is what tells it which
        // is which without depending on a renameable name.
        const sealed = await sealLanInfo({ ...info, role: 'app' });
        // Sealing needs the account identity. Immediately after sign-in the
        // socket can attest before the identity is unlocked, and a null here
        // is that ordering — not an error. Leaving the fingerprint unset means
        // the next attestation simply tries again.
        if (!sealed) return;

        await updateDeviceLanInfo(deviceId, sealed);
        // The companion is published SECOND, and its failure must not undo the
        // first: this row is the one that matters most, and a service that was
        // unenrolled between the two calls must not cost us a good publish.
        if (companion && companion !== deviceId) {
            const sealedCompanion = await sealLanInfo({ ...info, role: 'signin' });
            if (!sealedCompanion) return;
            try {
                await updateDeviceLanInfo(companion, sealedCompanion);
            } catch {
                // Leaving the fingerprint unset is the whole retry mechanism:
                // the next attestation recomputes the same print, finds it does
                // not match, and tries both PATCHes again. Recording it here
                // would mark a half-done publish as finished.
                return;
            }
        }
        publishedFingerprint = print;
    } catch {
        // Offline, or an old server that rejects the field. Retried on the next
        // attestation; nothing here is worth interrupting the user for.
    } finally {
        inFlight = false;
        if (republishWanted) {
            republishWanted = false;
            void publish();
        }
    }
}

/**
 * Publish right now, without waiting for an attestation.
 *
 * EXISTS FOR ENROLMENT DAY. The steady-state trigger below fires on
 * `deviceAttested`, i.e. on socket (re)connects — which may be days away on a
 * desktop that stays up. A freshly-enrolled sign-in-screen row would sit with
 * `lan_info = NULL` that whole time: un-wakeable, un-grouped, and telling the
 * user to "open Puca on that device once" when Puca is already open.
 * `enrolLockScreenAccess` calls this the moment enrolment lands.
 */
export async function publishNow(): Promise<void> {
    await publish();
}

/**
 * Publish on every device attestation.
 *
 * `deviceAttested` is the correct hook for three reasons:
 *  - it is the moment `thisDeviceId()` becomes real (it is dispatched right
 *    after the DeviceAttest round-trip; `wsConnected` fires from `onopen`,
 *    before attestation, when the id is still null);
 *  - it fires again on EVERY reconnect, which is exactly the network-change
 *    trigger — moving to a different network drops the socket, and the server
 *    challenges again on the new one;
 *  - hooking enrolment instead would run once per page load and never again,
 *    because enrolment short-circuits on the cached id.
 */
export function installLanPublisher(): void {
    if (installed) return;
    installed = true;
    window.addEventListener('deviceAttested', () => { void publish(); });
}

/** Test seam: forget both the installation and the stored fingerprint. */
export function __resetLanPublisherForTests(): void {
    installed = false;
    publishedFingerprint = null;
    inFlight = false;
}
