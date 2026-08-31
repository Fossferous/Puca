/**
 * Cross-user device shares — standing access for a FRIEND.
 *
 * The lifecycle is mutual consent with a cryptographic spine:
 *
 *   1. The owner invites a friend (per host device, with capabilities).
 *   2. The grantee must ACCEPT — their account is taking on reach into
 *      someone else's machine, and a grant nobody agreed to hold never goes
 *      live.
 *   3. The HOST DEVICE signs the grant with its own key (the key that never
 *      leaves that machine and is not derivable from any password), either
 *      inline when the invite is created on the host itself, or via
 *      auto-signing when the acceptance reaches it.
 *   4. Either side can revoke at any time; the server ends live sessions
 *      under the share immediately.
 *
 * Identity across accounts rests on users.account_sign_pub — each account's
 * PUBLISHED Ed25519 signing key, TOFU-pinned by peers (keyVerification.ts)
 * with exactly the trust posture of the X25519 DM identity key: the server
 * could substitute it on first contact; any later substitution is loud and
 * fails closed.
 */
import { apiClient } from '../client';
import { canonicalJson, deriveAccountSigningKey, getActiveIdentity } from '../e2ee';
import { pinServedSigningKey } from '../keyVerification';
import { signWithDeviceKey } from '../deviceIdentity/deviceKey';
import { verifyAuthRecordWithKey } from './identityRc';
import { thisDeviceId } from '../thisDevice';

export type ShareCapability = 'control' | 'view_only' | 'files';

/** Owner's view of a share on one of their devices. */
export interface DeviceShare {
    id: number;
    host_device: string;
    owner_user: number;
    grantee_user: number;
    grantee_username: string | null;
    capabilities: ShareCapability[];
    status: 'pending' | 'accepted' | 'rejected' | 'revoked';
    signed: boolean;
    grant_record: string | null;
    grant_sig: string | null;
    created_at: string;
    responded_at: string | null;
}

/** Grantee's view of a share offered to them. */
export interface IncomingShare {
    id: number;
    host_device: string;
    host_device_name: string;
    host_platform: string;
    owner_user: number;
    owner_username: string;
    capabilities: ShareCapability[];
    status: 'pending' | 'accepted';
    /** accepted AND host-signed: connectable right now. */
    ready: boolean;
    online: boolean;
    created_at: string;
}

/** The one cross-account device lookup: a single named device under a share. */
export interface SharePeerDevice {
    id: string;
    device_pub: string;
    sign_pub: string;
    name: string;
    platform: string;
    auth_record: string;
    auth_sig: string;
    host_enabled: boolean | null;
    host_policy: string | null;
    host_sig: string | null;
    online: boolean;
}

export const DEVICE_SHARE_TYPE = 'sovereign-device-share-v1';

export interface DeviceShareRecord {
    typ: typeof DEVICE_SHARE_TYPE;
    v: 1;
    /** Host device id — the machine whose key signs this. */
    host: string;
    /** The owner's user id. */
    owner: number;
    /** The GRANTEE's user id — account-scoped: any of their devices may
     *  connect, so enrolling a new phone never needs a re-grant. */
    grantee: number;
    /** Sorted, so two builders of the same grant produce the same bytes. */
    caps: ShareCapability[];
    ts: number;
}

/** Build the canonical record the HOST DEVICE signs. */
export function buildShareRecord(input: {
    hostDevice: string;
    ownerUser: number;
    granteeUser: number;
    capabilities: ShareCapability[];
    timestamp?: number;
}): { record: DeviceShareRecord; canonical: string } {
    const record: DeviceShareRecord = {
        typ: DEVICE_SHARE_TYPE,
        v: 1,
        host: input.hostDevice,
        owner: input.ownerUser,
        grantee: input.granteeUser,
        caps: [...input.capabilities].sort(),
        ts: input.timestamp ?? Math.floor(Date.now() / 1000),
    };
    return { record, canonical: canonicalJson(record) };
}

/**
 * Does this grant authorise `granteeUser` against `hostDevice` with EXACTLY
 * `capabilities`, right now? Checked by the HOST before accepting a
 * cross-user session, with the same strictness as grantAuthorises: every
 * field of the record must match the context it is being used in, or a
 * genuine signature over a DIFFERENT share could be replayed onto this one —
 * including a stale signature over NARROWER capabilities being presented
 * alongside a widened invite row.
 *
 * `verifySig` is injected because verification uses the host's own key,
 * which may live natively — the caller supplies the check.
 */
export async function shareAuthorises(
    grant: { grant_record: string; grant_sig: string },
    ctx: {
        hostDevice: string;
        ownerUser: number;
        granteeUser: number;
        capabilities: string[];
    },
    verifySig: (record: string, sig: string) => Promise<boolean> | boolean,
): Promise<boolean> {
    let rec: DeviceShareRecord;
    try {
        rec = JSON.parse(grant.grant_record) as DeviceShareRecord;
    } catch {
        return false;
    }
    if (rec.typ !== DEVICE_SHARE_TYPE || rec.v !== 1) return false;
    if (rec.host !== ctx.hostDevice) return false;
    if (rec.owner !== ctx.ownerUser) return false;
    if (rec.grantee !== ctx.granteeUser) return false;
    const want = [...ctx.capabilities].sort();
    if (!Array.isArray(rec.caps) || rec.caps.length !== want.length) return false;
    if (!rec.caps.every((c, i) => c === want[i])) return false;
    // The stored bytes must already be canonical, or this blob would verify
    // here and re-serialise differently elsewhere.
    if (canonicalJson(rec) !== grant.grant_record) return false;
    return verifySig(grant.grant_record, grant.grant_sig);
}

// --- REST --------------------------------------------------------------------

export async function createShare(
    hostDevice: string,
    granteeUser: number,
    capabilities: ShareCapability[],
    grant?: { record: string; sig: string },
): Promise<DeviceShare> {
    return apiClient.post<DeviceShare>(`/devices/${encodeURIComponent(hostDevice)}/shares`, {
        grantee_user: granteeUser,
        capabilities,
        grant_record: grant?.record ?? null,
        grant_sig: grant?.sig ?? null,
    });
}

export async function listDeviceShares(hostDevice: string): Promise<DeviceShare[]> {
    const rows = await apiClient.get<DeviceShare[]>(`/devices/${encodeURIComponent(hostDevice)}/shares`);
    return Array.isArray(rows) ? rows : [];
}

export async function listIncomingShares(): Promise<IncomingShare[]> {
    // Coerce at the boundary. The caller renders `incoming?.filter(...)`, so a
    // response that is not an array — an error envelope, a paginated wrapper, a
    // server that simply lies — threw "incoming?.filter is not a function" out
    // of DevicesView's render and took the entire Devices tab down with it.
    // The server is untrusted by this product's own threat model, so it must not
    // be able to break a view by changing a response shape.
    const rows = await apiClient.get<IncomingShare[]>('/shares/incoming');
    return Array.isArray(rows) ? rows : [];
}

export async function respondShare(inviteId: number, accept: boolean): Promise<DeviceShare> {
    return apiClient.post<DeviceShare>(`/shares/${inviteId}/respond`, { accept });
}

export async function deleteShare(inviteId: number): Promise<{ revoked: boolean }> {
    return apiClient.delete<{ revoked: boolean }>(`/shares/${inviteId}`);
}

export async function sharePeerDevice(inviteId: number, deviceId: string): Promise<SharePeerDevice> {
    return apiClient.get<SharePeerDevice>(
        `/shares/${inviteId}/device/${encodeURIComponent(deviceId)}`,
    );
}

// --- Account signing key: publish + pinned fetch ------------------------------

/**
 * Publish this account's Ed25519 signing public key so friends can verify
 * device enrolment records. Best-effort and idempotent — called after
 * enrolment, where the identity is known to be unlocked.
 */
export async function publishSigningKey(): Promise<void> {
    const identity = getActiveIdentity();
    if (!identity) return;
    const key = deriveAccountSigningKey(identity);
    try {
        await apiClient.patch('/keys/signing', { account_sign_pub: key.publicKeyEncoded });
    } catch (e) {
        // Publication failing only delays cross-user shares; it must never
        // break enrolment or login.
        console.warn('[shares] could not publish signing key:', e);
    }
}

/**
 * A peer's account signing key, TOFU-pinned. Null means unpublished, or —
 * the case that matters — DIFFERENT from the pinned one, and every caller
 * must fail closed on null: an unverifiable peer gets no session.
 */
export async function pinnedSigningKeyFor(userId: number): Promise<string | null> {
    try {
        const { account_sign_pub } = await apiClient.get<{
            user_id: number;
            account_sign_pub: string | null;
        }>(`/users/${userId}/signing-key`);
        return pinServedSigningKey(userId, account_sign_pub);
    } catch {
        // A network failure must not fall back to an untrusted key.
        return null;
    }
}

/**
 * Fetch AND verify the one peer device a share names. Returns the verified
 * row, or null when anything along the chain fails — the caller must refuse
 * the session on null, never proceed with an unverified key.
 */
export async function verifiedSharePeerDevice(
    inviteId: number,
    deviceId: string,
    peerUser: number,
): Promise<SharePeerDevice | null> {
    const pinnedKey = await pinnedSigningKeyFor(peerUser);
    if (!pinnedKey) return null;
    let row: SharePeerDevice;
    try {
        row = await sharePeerDevice(inviteId, deviceId);
    } catch {
        return null;
    }
    if (!verifyAuthRecordWithKey(pinnedKey, row, peerUser)) {
        console.warn(`[shares] refusing unverifiable device ${deviceId} of user ${peerUser}`);
        return null;
    }
    return row;
}

// --- Host-side helpers ---------------------------------------------------------

/**
 * The accepted, signed share (if any) that lets `granteeUser` reach THIS
 * device. Used by the host's connect handler; reads the owner-only list
 * endpoint, so it only ever works on the device's own account.
 */
export async function shareForGrantee(
    hostDevice: string,
    granteeUser: number,
): Promise<DeviceShare | null> {
    let shares: DeviceShare[];
    try {
        shares = await listDeviceShares(hostDevice);
    } catch {
        return null;
    }
    return (
        shares.find(
            s => s.grantee_user === granteeUser && s.status === 'accepted' && s.signed,
        ) ?? null
    );
}

/**
 * Produce and upload the host-device signature for ONE accepted share.
 *
 * Deliberately NOT a bulk auto-signer, and deliberately NOT triggered by any
 * reconnect or push. Producing a grant is the act the whole trust model rests
 * on — "a password thief cannot grant access to a host they are not at" holds
 * ONLY because the host device's key signs, AND because signing takes a
 * deliberate human action AT the host. An automatic signer on every reconnect
 * would let anyone with a phished password stage a share and have the real
 * host silently complete it. So this is called from exactly one place: the
 * owner clicking "Confirm & activate" for a specific share, on the host,
 * having seen the grantee and capabilities it is about to sign.
 *
 * Must run ON the host device (`share.host_device === thisDeviceId()`); the
 * signature is only valid from that machine's key.
 */
export async function signShareGrant(share: DeviceShare, myUserId: number): Promise<void> {
    if (thisDeviceId() !== share.host_device) {
        throw new Error('a share can only be activated from the device being shared');
    }
    const { canonical } = buildShareRecord({
        hostDevice: share.host_device,
        ownerUser: myUserId,
        granteeUser: share.grantee_user,
        capabilities: share.capabilities,
    });
    const sig = await signWithDeviceKey(canonical);
    await apiClient.post(`/shares/${share.id}/sign`, {
        grant_record: canonical,
        grant_sig: sig,
    });
}
