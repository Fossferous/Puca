/**
 * Device enrolment and per-connection attestation.
 *
 * WHY THIS IS NOT IN api/devices/. Attestation is how a WebSocket connection
 * proves WHICH device it is, and it is what gives this device the id that push
 * registration hands to the Android native-delivery service. Both are needed in
 * a build with remote control excluded, so neither can live in the My Devices
 * registry — importing that for an id pulled the entire remote-control surface
 * into the bundle.
 *
 * What stayed behind in api/devices/index.ts is the part that is genuinely
 * about MANAGING devices: listing them, renaming, revoking, and the cross-user
 * share notifications.
 */
import { apiClient } from '../client';
import { getToken, decodeJwtPayload } from '../auth';
import { getActiveIdentity } from '../e2ee';
import { isMobile, isTauri } from '../platform';
import { wsClient } from '../websocket';
import { thisDeviceId, setThisDeviceId, clearThisDeviceId } from '../thisDevice';
import { ensureDeviceKey, signWithDeviceKey } from './deviceKey';
import { attestationMessage, buildAuthRecord, signAuthRecord, type DevicePlatform } from './identity';

/** Shape of a device row as the server returns it. */
export interface DeviceRow {
    id: string;
    device_pub: string;
    sign_pub: string;
    name: string;
    platform: DevicePlatform;
    auth_record: string;
    auth_sig: string;
    host_enabled: boolean;
    host_policy: string | null;
    host_sig: string | null;
    lan_info: string | null;
    created_at: string;
    last_seen_at: string | null;
    online: boolean;
}

/** Work to run after a successful enrolment. Optional features register here
 *  instead of being imported by the enrolment path. */
type EnrolledHook = () => void;
const enrolledHooks = new Set<EnrolledHook>();
export function onDeviceEnrolled(fn: EnrolledHook): () => void {
    enrolledHooks.add(fn);
    return () => { enrolledHooks.delete(fn); };
}

function currentPlatform(): DevicePlatform {
    if (isTauri()) {
        const ua = navigator.userAgent;
        if (/Windows/i.test(ua)) return 'windows';
        if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
        return 'linux';
    }
    if (isMobile()) return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android';
    return 'web';
}

/** A reasonable default name; the user can rename it afterwards. */
function defaultDeviceName(): string {
    const platform = currentPlatform();
    const label: Record<DevicePlatform, string> = {
        windows: 'Windows PC',
        linux: 'Linux PC',
        macos: 'Mac',
        android: 'Android phone',
        ios: 'iPhone',
        web: 'Web browser',
    };
    return label[platform];
}

/** Signed-in user id straight from the JWT — same approach as dms.ts. No
 *  verification needed here: it only selects which account's records we build,
 *  and every one of them is signature-checked afterwards. */
export function currentUserId(): number | null {
    const t = getToken();
    if (!t) return null;
    const p = decodeJwtPayload(t);
    return typeof p?.sub === 'number' ? p.sub : null;
}

/** Has the server told us THIS device was signed out?
 *
 *  Drives the only way back: a button the user presses. Automatic recovery is
 *  what made revocation meaningless in the first place — the client discarded
 *  its identity on the 403 and re-enrolled seconds later as a new device. A
 *  deliberate press is fine and an automatic retry is not, which is the whole
 *  distinction. */
let thisDeviceRevoked = false;

/** True when this machine has been signed out and has not been re-added. */
/** Forget this device's id and its revoked flag, so the next enrolment is
 *  genuinely a NEW device. Used by the deliberate 'add this machine back'
 *  button — never automatically; see the note on thisDeviceRevoked. */
/** Record that the server has signed THIS device out. Set by an explicit
 *  revoke of the machine you are sitting at, as well as by a refused
 *  enrolment — the banner has to appear in both cases. */
export function markThisDeviceRevoked(): void {
    thisDeviceRevoked = true;
}

export function resetEnrolmentState(): void {
    clearThisDeviceId();
    thisDeviceRevoked = false;
}

export function isThisDeviceRevoked(): boolean {
    return thisDeviceRevoked;
}

/**
 * Enrol this device (idempotent — same keys produce the same id, and the server
 * treats a repeat as a refresh).
 *
 * Requires an unlocked identity: without the seed there is no account signing
 * key, so no enrolment record can be signed. Returns null in that case rather
 * than throwing, because it runs opportunistically at startup and a user who
 * has not completed E2EE setup is a normal state, not an error.
 */
export async function enrolThisDevice(userId: number, name?: string): Promise<DeviceRow | null> {
    const identity = getActiveIdentity();
    if (!identity) return null;

    const keys = await ensureDeviceKey();
    const { canonical, deviceId } = buildAuthRecord({
        devicePub: keys.device_pub,
        signPub: keys.sign_pub,
        name: name ?? defaultDeviceName(),
        platform: currentPlatform(),
        userId,
    });
    let row: DeviceRow;
    try {
        row = await apiClient.post<DeviceRow>('/devices', {
            device_pub: keys.device_pub,
            sign_pub: keys.sign_pub,
            name: name ?? defaultDeviceName(),
            platform: currentPlatform(),
            auth_record: canonical,
            auth_sig: signAuthRecord(identity, canonical),
        });
    } catch (e) {
        // This device was signed out from elsewhere. KEEP its identity.
        //
        // The first version of this handler called forgetDeviceKey() here, which
        // was exactly backwards. The device id is derived from the keypair, so
        // discarding it mints a NEW id — and the attestation handler re-runs
        // enrolThisDevice on every DeviceChallenge, which the server sends on
        // every WebSocket connect. The machine therefore came back about a
        // second later as a brand-new device with full access, under a default
        // name, with nothing to approve it. The remediation WAS the bypass:
        // without it the keypair survives, the same id is derived, and the same
        // 403 is returned forever, which is what "revoked" has to mean.
        //
        // It also quietly handed the server a primitive it should never have:
        // answer any POST /devices with "device_revoked" and every client
        // destroys its OS-protected device private key. This module's own header
        // says the server is a registrar, not an authority.
        //
        // Cost of getting this right: a device revoked by mistake cannot re-add
        // itself: it must be cleared deliberately (device_key_forget) from that
        // machine. That is the correct direction for the failure to point.
        if (String((e as Error)?.message ?? '').includes('device_revoked')) {
            clearThisDeviceId();
            thisDeviceRevoked = true;
            console.warn(
                '[devices] this device was signed out and will stay signed out; '
                + 're-add it deliberately from this machine if that was a mistake',
            );
            return null;
        }
        throw e;
    }
    setThisDeviceId(deviceId);
    thisDeviceRevoked = false;
    // Anything that should follow a successful enrolment (publishing the
    // account signing key for device shares, say) registers a hook rather
    // than being called from here, so optional features do not become part
    // of the enrolment path in every build.
    for (const fn of enrolledHooks) {
        try { fn(); } catch (e) { console.warn('[devices] post-enrol hook failed:', e); }
    }
    return row;
}


/**
 * Answer the server's per-connection device challenge.
 *
 * Must be armed before the first socket opens, including on a reconnect: a
 * challenge that arrives with no listener is simply lost, and the connection
 * would stay unattested for its whole life.
 */
export function installDeviceAttestation(): void {
    wsClient.on('DeviceChallenge', (msg: { payload?: { nonce?: string } }) => {
        void (async () => {
            try {
                const nonce = msg?.payload?.nonce;
                const userId = currentUserId();
                if (!nonce || userId == null) return;
                // Enrolment is what makes the id known; without it the server
                // has nothing to look up.
                if (!thisDeviceId()) await enrolThisDevice(userId);
                const deviceId = thisDeviceId();
                // Explicit rather than relying on enrolment having set it: a
                // null id here would attest as "device null", which the server
                // answers by silently ignoring — a failure mode that looks
                // exactly like the feature not being wired up at all.
                if (!deviceId) return;

                const sig = await signWithDeviceKey(attestationMessage(nonce, userId));
                wsClient.send({ type: 'DeviceAttest', payload: { device_id: deviceId, sig } });
                // Anything that must reach the server AS this device can go
                // out from here on: the socket delivers in order, so the
                // server processes the DeviceAttest above before whatever a
                // listener sends next. session.ts reattaches held device
                // sessions on this — sent from `wsConnected` it raced the
                // attestation and the server refused every claim.
                window.dispatchEvent(new CustomEvent('deviceAttested'));
            } catch (e) {
                console.warn('[devices] attestation skipped:', e);
            }
        })();
    });
}
