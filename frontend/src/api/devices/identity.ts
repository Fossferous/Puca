/**
 * Device identity records — the client half of the enrolment trust chain.
 *
 * WHY THIS EXISTS: every device of an account currently holds the SAME X25519
 * private key, so a handshake between two of your own devices degenerates into
 * self-DH — it looks like it works while authenticating nothing. Per-device
 * keys fix that, but only if the binding "device D belongs to user U" is
 * something the SERVER CANNOT MINT. That is what an auth record is.
 *
 * The chain has two levels, and they are deliberately rooted differently:
 *   - the ACCOUNT signing key certifies ENROLMENT (here), and
 *   - the HOST DEVICE's own key certifies each GRANT (see grants.ts).
 *
 * The split is the point. An attacker who has only the password can derive the
 * account key and enrol a device, but cannot sign a grant for any host, because
 * that key never leaves the host machine and is not derivable from the password.
 *
 * The server never sees a signing private key and never supplies the public one
 * — verifiers derive it from their own seed. A record the server invented fails
 * verification on every real device.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
    canonicalJson,
    deriveAccountSigningKey,
    signWithAccountKey,
    verifyWithAccountKey,
    type AccountSigningKey,
    type Identity,
} from '../e2ee';

/** Must match DEVICE_ID_LABEL in src/device_handlers.rs. */
const DEVICE_ID_LABEL = 'sovereign-device-v1';
/** Must match DEVICE_ID_LEN in src/device_handlers.rs. */
const DEVICE_ID_LEN = 21;

export const DEVICE_AUTH_TYPE = 'sovereign-device-auth-v1';

export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'android' | 'ios' | 'web';

export interface DeviceAuthRecord {
    /** Record type — pins the meaning of a signature so one cannot be replayed
     *  into a different record shape that happens to share fields. */
    typ: typeof DEVICE_AUTH_TYPE;
    v: 1;
    did: string;
    dpub: string;
    spub: string;
    name: string;
    plat: DevicePlatform;
    uid: number;
    ts: number;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding — matches Rust's URL_SAFE_NO_PAD. */
function toBase64Url(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        out += B64URL[b0 >> 2];
        out += B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
        if (b1 === undefined) break;
        out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
        if (b2 === undefined) break;
        out += B64URL[b2 & 63];
    }
    return out;
}

/**
 * `id = base64url(sha256(LABEL || device_pub || sign_pub))[0..21]`
 *
 * DERIVED, never chosen, so a client cannot squat another device's id — and the
 * server recomputes this and rejects a mismatch without trusting anyone.
 * Mirrors `derive_device_id` in src/device_handlers.rs byte-for-byte; if you
 * change one, the other must change with it or enrolment 400s.
 */
export function deriveDeviceId(devicePub: string, signPub: string): string {
    const enc = new TextEncoder();
    const label = enc.encode(DEVICE_ID_LABEL);
    const dp = enc.encode(devicePub);
    const sp = enc.encode(signPub);
    const buf = new Uint8Array(label.length + dp.length + sp.length);
    buf.set(label, 0);
    buf.set(dp, label.length);
    buf.set(sp, label.length + dp.length);
    return toBase64Url(sha256(buf)).slice(0, DEVICE_ID_LEN);
}

/** Build the canonical record that the account key signs. */
export function buildAuthRecord(input: {
    devicePub: string;
    signPub: string;
    name: string;
    platform: DevicePlatform;
    userId: number;
    /** Injected so callers can pin it in tests; defaults to now. */
    timestamp?: number;
}): { record: DeviceAuthRecord; canonical: string; deviceId: string } {
    const deviceId = deriveDeviceId(input.devicePub, input.signPub);
    const record: DeviceAuthRecord = {
        typ: DEVICE_AUTH_TYPE,
        v: 1,
        did: deviceId,
        dpub: input.devicePub,
        spub: input.signPub,
        name: input.name,
        plat: input.platform,
        uid: input.userId,
        ts: input.timestamp ?? Math.floor(Date.now() / 1000),
    };
    return { record, canonical: canonicalJson(record), deviceId };
}

export function signAuthRecord(identity: Identity, canonical: string): string {
    return signWithAccountKey(deriveAccountSigningKey(identity), canonical);
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
 * The transcript a device signs to prove which device a connection is.
 * Mirrors `device_attest_message` in src/ws.rs — the '|' separators keep the
 * concatenation unambiguous.
 */
export function attestationMessage(nonce: string, userId: number): string {
    return `sovereign-device-attest-v1|${nonce}|${userId}`;
}
