/**
 * Host-signed grants — the half of the trust chain that survives password
 * compromise.
 *
 * The account key certifies "device D belongs to user U". A GRANT certifies
 * "controller C may drive host H", and it is signed by the HOST DEVICE's own
 * key: a key that never leaves that machine and is not derivable from the
 * password. So an attacker who phished the password can enrol a device of their
 * own, but cannot produce a grant for a host they are not physically at.
 *
 * The server stores grants and hands them back. It cannot forge one, and the
 * host re-verifies before accepting any session — so a grant the server
 * invented, or one it kept after the user withdrew it, does not work.
 */
import { apiClient } from '../client';
import { canonicalJson } from '../e2ee';
import { signWithDeviceKey } from '../deviceIdentity/deviceKey';

export const DEVICE_GRANT_TYPE = 'sovereign-device-grant-v1';

export interface DeviceGrantRecord {
    typ: typeof DEVICE_GRANT_TYPE;
    v: 1;
    /** Host device id — the one signing. */
    host: string;
    /** Controller device id being authorised. */
    ctl: string;
    /** Unix seconds, or null for "until withdrawn". */
    exp: number | null;
    ts: number;
}

export interface GrantRow {
    host_device: string;
    controller_device: string;
    grant_record: string;
    grant_sig: string;
    expires_at: string | null;
    created_at: string;
}

/** Build the canonical record a host signs to authorise a controller. */
export function buildGrantRecord(input: {
    hostDevice: string;
    controllerDevice: string;
    expiresAt?: number | null;
    timestamp?: number;
}): { record: DeviceGrantRecord; canonical: string } {
    const record: DeviceGrantRecord = {
        typ: DEVICE_GRANT_TYPE,
        v: 1,
        host: input.hostDevice,
        ctl: input.controllerDevice,
        exp: input.expiresAt ?? null,
        ts: input.timestamp ?? Math.floor(Date.now() / 1000),
    };
    return { record, canonical: canonicalJson(record) };
}

/**
 * Authorise a controller to drive THIS device.
 *
 * Must run ON the host: it signs with the local device key, which is the only
 * copy. Calling this from the controller would sign with the wrong key and the
 * host would reject its own grant.
 */
export async function grantControl(
    hostDevice: string,
    controllerDevice: string,
    expiresAt?: number | null,
): Promise<GrantRow> {
    const { canonical } = buildGrantRecord({ hostDevice, controllerDevice, expiresAt });
    return apiClient.post<GrantRow>(`/devices/${encodeURIComponent(hostDevice)}/grants`, {
        controller_device: controllerDevice,
        grant_record: canonical,
        grant_sig: await signWithDeviceKey(canonical),
        expires_at: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
    });
}

export async function listGrants(hostDevice: string): Promise<GrantRow[]> {
    const { grants } = await apiClient.get<{ grants: GrantRow[] }>(
        `/devices/${encodeURIComponent(hostDevice)}/grants`,
    );
    return grants;
}

export function withdrawGrant(hostDevice: string, controllerDevice: string): Promise<{ revoked: boolean }> {
    return apiClient.delete<{ revoked: boolean }>(
        `/devices/${encodeURIComponent(hostDevice)}/grants/${encodeURIComponent(controllerDevice)}`,
    );
}

/**
 * Does `grant` authorise `controllerDevice` against `hostDevice` right now?
 *
 * Checked by the HOST before accepting a session, against the host's own device
 * signing key. Deliberately strict about the record's contents matching the row
 * it arrived in: a genuine signature over a DIFFERENT grant could otherwise be
 * replayed onto this pairing.
 *
 * `verifySig` is injected because verification uses the host's own key, which
 * lives natively — the caller supplies the check rather than this module
 * reaching for a key it must not hold.
 */
export async function grantAuthorises(
    grant: { grant_record: string; grant_sig: string },
    hostDevice: string,
    controllerDevice: string,
    verifySig: (record: string, sig: string) => Promise<boolean>,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
    let rec: DeviceGrantRecord;
    try {
        rec = JSON.parse(grant.grant_record) as DeviceGrantRecord;
    } catch {
        return false;
    }
    if (rec.typ !== DEVICE_GRANT_TYPE || rec.v !== 1) return false;
    if (rec.host !== hostDevice || rec.ctl !== controllerDevice) return false;
    if (rec.exp !== null && rec.exp <= nowSeconds) return false;
    // The stored bytes must already be canonical, or this blob would verify
    // here and re-serialise differently elsewhere.
    if (canonicalJson(rec) !== grant.grant_record) return false;
    return verifySig(grant.grant_record, grant.grant_sig);
}
