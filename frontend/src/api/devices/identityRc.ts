/**
 * Remote-control-only signature verification.
 *
 * Split out of identity.ts so a lite build ships neither this nor its only
 * caller (devices/shares.ts, cross-user device sharing). The rest of the
 * device auth-record layer — which device ATTESTATION builds and signs, and
 * which push registration therefore depends on — lives in
 * api/deviceIdentity/identity.ts and ships in every build.
 */
import { canonicalJson, verifyWithAccountKey, type AccountSigningKey } from '../e2ee';
import { DEVICE_AUTH_TYPE, deriveDeviceId, type DeviceAuthRecord } from '../deviceIdentity/identity';

/**
 * As `verifyAuthRecord`, against an EXPLICIT `ed25519:`-prefixed public key
 * rather than this account's own derived one.
 *
 * This is the cross-user half: a device share lets a FRIEND's client verify
 * that a device really belongs to the friend, and the key it verifies against
 * is the friend's PUBLISHED account signing key (users.account_sign_pub) —
 * TOFU-pinned by the caller (keyVerification.ts), never taken from the server
 * unpinned. Every structural check is identical; only the key source differs.
 */
export function verifyAuthRecordWithKey(
    publicKeyEncoded: string,
    row: { id: string; device_pub: string; sign_pub: string; auth_record: string; auth_sig: string },
    expectedUserId: number,
): boolean {
    if (!verifyWithAccountKey(publicKeyEncoded, row.auth_record, row.auth_sig)) {
        return false;
    }
    let rec: DeviceAuthRecord;
    try {
        rec = JSON.parse(row.auth_record) as DeviceAuthRecord;
    } catch {
        return false;
    }
    if (rec.typ !== DEVICE_AUTH_TYPE || rec.v !== 1) return false;
    if (rec.uid !== expectedUserId) return false;
    if (rec.did !== row.id) return false;
    if (rec.dpub !== row.device_pub || rec.spub !== row.sign_pub) return false;
    // The id must be the honest hash of the keys the record itself carries.
    if (deriveDeviceId(rec.dpub, rec.spub) !== rec.did) return false;
    // Re-canonicalising must reproduce the exact signed bytes; if it does not,
    // the stored blob carries something outside the record we just validated.
    return canonicalJson(rec) === row.auth_record;
}

/**
 * Verify a device record the server handed back.
 *
 * Note what is checked beyond the signature: that the record's own `did`/`uid`
 * match what the surrounding row claims, and that `did` is the honest hash of
 * the keys inside the record. Without those a valid signature over a DIFFERENT
 * device's record could be replayed onto this row — the signature would pass
 * while the fields the UI displays and routes on were attacker-chosen.
 */
export function verifyAuthRecord(
    accountKey: AccountSigningKey,
    row: { id: string; device_pub: string; sign_pub: string; auth_record: string; auth_sig: string },
    expectedUserId: number,
): boolean {
    return verifyAuthRecordWithKey(accountKey.publicKeyEncoded, row, expectedUserId);
}
