/**
 * Resolving another device's static X25519 public key.
 *
 * This is a small file guarding a big property. The static half of a
 * device-control handshake is what proves WHICH MACHINE is at the other end —
 * so if the key used for it came from whatever the server said, the server
 * could substitute its own and sit in the middle of a session that controls
 * your computer.
 *
 * So keys come only from device records whose enrolment signature verified
 * against the account signing key this client derived from its own seed. An
 * unverified record resolves to null, and every caller fails closed on null.
 */
import { listDevices, currentUserId, type VerifiedDevice } from './index';

interface CacheEntry {
    devicePub: string;
    signPub: string;
    at: number;
}

const cache = new Map<string, CacheEntry>();
/** Short: a revoked or re-enrolled device must not stay usable for long. */
const TTL_MS = 60_000;

/**
 * Populate the cache from a device list the caller already fetched.
 *
 * Purely a LATENCY measure: the Devices view lists devices on mount and every
 * 15s, and without this the first Control click pays another full GET /devices
 * before key agreement can even start — one HTTPS round trip, on the critical
 * path, for data already in memory.
 *
 * It changes no trust decision. The `d.verified` filter is the same line as in
 * `deviceStaticPubFor`, and it is the one that stops a server-substituted key
 * being used: records come from listDevices, whose signatures were checked
 * against the account signing key this client derived from its own seed. An
 * unverified record is not cached here any more than it is there, so a caller
 * still resolves null and still fails closed.
 */
export function warmPeerKeys(devices: VerifiedDevice[]): void {
    const at = Date.now();
    for (const d of devices) {
        if (d.verified) cache.set(d.id, { devicePub: d.device_pub, signPub: d.sign_pub, at });
    }
}

/**
 * The peer's static device public key, or null when it cannot be trusted.
 *
 * Null on: unknown device, a record whose signature did not verify, or no
 * unlocked identity to verify against. Callers must treat null as "refuse the
 * session", never as "carry on without the static half".
 */
export async function deviceStaticPubFor(deviceId: string): Promise<string | null> {
    const hit = cache.get(deviceId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.devicePub;

    const userId = currentUserId();
    if (userId == null) return null;

    let devices;
    try {
        devices = await listDevices(userId);
    } catch {
        // A network failure must not fall back to an untrusted key.
        return null;
    }

    for (const d of devices) {
        // ONLY verified records populate the cache. This is the line that stops
        // a server-substituted key being used for key agreement.
        if (d.verified) cache.set(d.id, { devicePub: d.device_pub, signPub: d.sign_pub, at: Date.now() });
    }

    const found = devices.find(d => d.id === deviceId);
    if (!found) return null;
    if (!found.verified) {
        console.warn(`[devices] refusing to use an unverified key for ${deviceId}`);
        return null;
    }
    return found.device_pub;
}

/** The peer's Ed25519 signing key, same trust rules. */
export async function deviceSignPubFor(deviceId: string): Promise<string | null> {
    await deviceStaticPubFor(deviceId); // populates the cache
    return cache.get(deviceId)?.signPub ?? null;
}

/** Drop cached keys — call on logout, or after revoking a device. */
export function clearPeerKeyCache(): void {
    cache.clear();
}
