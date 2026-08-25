/**
 * Device enrolment, listing and revocation, plus the WebSocket attestation
 * that makes a connection addressable as a specific device.
 *
 * The server is a registrar, not an authority: every row it returns is
 * re-verified here against the account signing key this client derives from its
 * OWN seed (see identity.ts). A device the server invented fails that check and
 * is reported rather than displayed.
 */
import { apiClient } from '../client';
import { getToken, decodeJwtPayload } from '../auth';
import { getActiveIdentity, deriveAccountSigningKey } from '../e2ee';
import { isMobile, isTauri } from '../platform';
import { wsClient } from '../websocket';
import { ensureDeviceKey, signWithDeviceKey } from './deviceKey';
import {
    attestationMessage,
    buildAuthRecord,
    signAuthRecord,
    verifyAuthRecord,
    type DevicePlatform,
} from './identity';

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

/** A device row plus whether its enrolment signature actually verified. */
export interface VerifiedDevice extends DeviceRow {
    /** False means the server returned something no device of yours signed. */
    verified: boolean;
    /** True for the device this code is running on. */
    isThisDevice: boolean;
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

let cachedDeviceId: string | null = null;

/** Has the server told us THIS device was signed out?
 *
 *  Drives the only way back: a button the user presses. Automatic recovery is
 *  what made revocation meaningless in the first place — the client discarded
 *  its identity on the 403 and re-enrolled seconds later as a new device. A
 *  deliberate press is fine and an automatic retry is not, which is the whole
 *  distinction. */
let thisDeviceRevoked = false;

/** True when this machine has been signed out and has not been re-added. */
export function isThisDeviceRevoked(): boolean {
    return thisDeviceRevoked;
}

/**
 * Discard this device's identity and enrol again as a NEW device.
 *
 * For the user who revoked the machine they are sitting at. It cannot be
 * automatic — see thisDeviceRevoked — so it is exported for a button and called
 * from nowhere else.
 */
export async function resetThisDeviceIdentity(userId: number): Promise<DeviceRow | null> {
    const { forgetDeviceKey } = await import('./deviceKey');
    const { clearPeerKeyCache } = await import('./peerKeys');
    await forgetDeviceKey();
    clearPeerKeyCache();
    cachedDeviceId = null;
    thisDeviceRevoked = false;
    const row = await enrolThisDevice(userId);

    // Enrolling is not the same as being REACHABLE. Attestation binds a device
    // id to this WebSocket connection and happens only in response to a
    // DeviceChallenge, which the server sends once per connect. Without a
    // reconnect the socket stays bound to the OLD, now-revoked id: the row
    // appears in the list and the banner clears, so the UI reports success while
    // every other device still sees this one as offline and cannot reach it.
    // Reconnecting asks for a fresh challenge, which attests the new id.
    if (row) wsClient.forceReconnect();
    return row;
}

/** This device's id, if it has enrolled in this session. */
export function thisDeviceId(): string | null {
    return cachedDeviceId;
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
            cachedDeviceId = null;
            thisDeviceRevoked = true;
            console.warn(
                '[devices] this device was signed out and will stay signed out; '
                + 're-add it deliberately from this machine if that was a mistake',
            );
            return null;
        }
        throw e;
    }
    cachedDeviceId = deviceId;
    thisDeviceRevoked = false;
    // Publish the account signing PUBLIC key alongside enrolment — it is what
    // lets a FRIEND holding a device share verify that this account's devices
    // are really its own (see shares.ts). Best-effort and fire-and-forget:
    // enrolment must not fail because publication did.
    void import('./shares')
        .then(({ publishSigningKey }) => publishSigningKey())
        .catch(() => { /* best-effort */ });
    return row;
}

/**
 * Every enrolled device, each marked with whether its record actually verified.
 *
 * Unverified rows are RETURNED, not silently dropped: a device that fails
 * verification is exactly the thing a user needs to be told about, and hiding
 * it would turn a server misbehaving into an invisible one.
 */
export async function listDevices(userId: number): Promise<VerifiedDevice[]> {
    const { devices } = await apiClient.get<{ devices: DeviceRow[] }>('/devices');
    const identity = getActiveIdentity();
    const accountKey = identity ? deriveAccountSigningKey(identity) : null;

    return devices.map(d => ({
        ...d,
        verified: accountKey ? verifyAuthRecord(accountKey, d, userId) : false,
        isThisDevice: d.id === cachedDeviceId,
    }));
}

export function renameDevice(deviceId: string, name: string): Promise<DeviceRow> {
    return apiClient.patch<DeviceRow>(`/devices/${encodeURIComponent(deviceId)}`, { name });
}

/** Store this machine's SEALED LAN details, so another device can wake it.
 *  The blob is opaque to the server (see api/devices/lanInfo.ts). */
export function updateDeviceLanInfo(deviceId: string, lanInfo: string): Promise<DeviceRow> {
    return apiClient.patch<DeviceRow>(
        `/devices/${encodeURIComponent(deviceId)}`,
        { lan_info: lanInfo },
    );
}

export async function revokeDevice(deviceId: string): Promise<{ revoked: boolean }> {
    const result = await apiClient.delete<{ revoked: boolean }>(`/devices/${encodeURIComponent(deviceId)}`);
    // Signing out the machine you are SITTING AT is the case the recovery banner
    // exists for, and it was the one that never reached it: the flag was only
    // set when a LATER enrolment was refused, which needs a reconnect — so the
    // banner appeared minutes later, or not at all. Record it here, where we
    // already know which device it was.
    if (deviceId === cachedDeviceId) thisDeviceRevoked = true;
    return result;
}

/**
 * Answer the server's device challenge.
 *
 * Registered once at startup. The JWT is account-scoped and identical on every
 * device, so it cannot say WHICH device a connection is; this proves possession
 * of the device signing key against a server-chosen, connection-scoped nonce.
 *
 * Every failure path is silent-and-harmless by design: an unattested connection
 * keeps working for chat and is simply not addressable by device. Throwing here
 * would break the socket for users who have no device key at all.
 */
export function installDeviceAttestation(): void {
    // --- Cross-user shares: this device's host-side notifications ------------
    //
    // NOTE: producing a share's grant SIGNATURE is deliberately NOT wired to
    // any reconnect or push here. Only the host device holds the key, but that
    // alone is not the guarantee — the guarantee is that signing takes a
    // deliberate human action AT the host (the "Confirm & activate" button in
    // the share modal, see signShareGrant). Auto-signing on every reconnect
    // would let anyone with a phished password stage a share and have the real
    // host silently complete it, which is exactly the "password thief who is
    // not at the machine" the design is meant to defeat.
    //
    // A friend's session going live on one of this account's OTHER devices —
    // the passive notice the owner gets wherever they are signed in. The host
    // device itself skips it (its own in-app banner covers the live session).
    wsClient.on('DeviceShareSessionStarted', (msg: { payload?: { host_device?: string; from_username?: string } }) => {
        const p = msg?.payload;
        if (!p?.host_device || p.host_device === cachedDeviceId) return;
        void (async () => {
            try {
                const { isPermissionGranted, sendNotification } =
                    await import('@tauri-apps/plugin-notification');
                if (await isPermissionGranted()) {
                    sendNotification({
                        title: `${p.from_username ?? 'A friend'} connected to your device`,
                        body: 'They are using access you granted. Manage sharing in the Devices view.',
                    });
                }
            } catch {
                // Not Tauri, or no notification permission — the Devices view
                // and the host-side banner still tell the story.
            }
        })();
    });

    wsClient.on('DeviceChallenge', (msg: { payload?: { nonce?: string } }) => {
        void (async () => {
            try {
                const nonce = msg?.payload?.nonce;
                const userId = currentUserId();
                if (!nonce || userId == null) return;
                // Enrolment is what makes the id known; without it the server
                // has nothing to look up.
                if (!cachedDeviceId) await enrolThisDevice(userId);
                const deviceId = cachedDeviceId;
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
