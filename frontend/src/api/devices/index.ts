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
import { thisDeviceId } from '../thisDevice';
import {
    currentUserId,
    enrolThisDevice,
    isThisDeviceRevoked,
    onDeviceEnrolled,
    resetEnrolmentState,
    markThisDeviceRevoked,
    type DeviceRow,
} from '../deviceIdentity/attest';
import { getActiveIdentity, deriveAccountSigningKey } from '../e2ee';
import { wsClient } from '../websocket';
import { verifyAuthRecord } from './identityRc';


/** A device row plus whether its enrolment signature actually verified. */
export interface VerifiedDevice extends DeviceRow {
    /** False means the server returned something no device of yours signed. */
    verified: boolean;
    /** True for the device this code is running on. */
    isThisDevice: boolean;
}







/**
 * Discard this device's identity and enrol again as a NEW device.
 *
 * For the user who revoked the machine they are sitting at. It cannot be
 * automatic — see thisDeviceRevoked — so it is exported for a button and called
 * from nowhere else.
 */
export async function resetThisDeviceIdentity(userId: number): Promise<DeviceRow | null> {
    const { forgetDeviceKey } = await import('./deviceKeyRc');
    const { clearPeerKeyCache } = await import('./peerKeys');
    await forgetDeviceKey();
    clearPeerKeyCache();
    resetEnrolmentState();
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

/** This device's id, if it has enrolled in this session.
 *  Re-exported for existing RC callers; the cache itself is a leaf module
 *  (api/thisDevice.ts) so the preserved push path can read the id without
 *  importing this registry. */
// thisDeviceId is NOT re-exported: callers import it from api/thisDevice
// directly, so needing this device's id never drags in this registry.

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
        isThisDevice: d.id === thisDeviceId(),
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
    if (deviceId === thisDeviceId()) markThisDeviceRevoked();
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
/**
 * Host-side notifications for CROSS-USER device shares.
 *
 * Was part of installDeviceAttestation until attestation moved to
 * api/deviceIdentity/attest.ts (push needs it in every build). What is left
 * here is share-specific and belongs to remote control.
 */
export function installShareNotifications(): void {
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
        if (!p?.host_device || p.host_device === thisDeviceId()) return;
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

}

// Re-exported for the My Devices UI, which has always imported these from
// this barrel. They live in api/deviceIdentity/attest.ts because device
// ENROLMENT and attestation must also work in a build without remote
// control (push registration needs this device's id).
export { currentUserId, enrolThisDevice, isThisDeviceRevoked };
export type { DeviceRow };

// Publishing the account signing PUBLIC key is what lets a FRIEND holding a
// device share verify that this account's devices are really its own (see
// shares.ts). It follows enrolment, but only in a build that HAS shares —
// hence a hook rather than a call inside enrolThisDevice.
onDeviceEnrolled(() => {
    void import('./shares')
        .then(({ publishSigningKey }) => publishSigningKey())
        .catch(() => { /* best-effort */ });
});
