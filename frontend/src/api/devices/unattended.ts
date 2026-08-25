/**
 * Unattended-access passphrase — CONTROLLER side.
 *
 * The counterpart to `crates/puca-ua` (the host). The host stores only a
 * salt and an Ed25519 public key and only ever verifies; here is where the
 * passphrase actually lives, gets stretched with Argon2id, and signs the host's
 * challenge. The passphrase never leaves this side, and the server is never in
 * the loop — the host checks the signature locally.
 *
 * WHY THE HOST CANNOT DO THIS ITSELF. If the host derived the key from the
 * passphrase, the passphrase (or its stretched seed) would have to reach the
 * host, defeating the point — an attacker who seizes an armed machine would find
 * it. So derivation is here, on the controller, and only a PUBLIC key and a
 * per-connect signature ever cross to the host.
 *
 * THE FRAMING IS A CONTRACT. `challengeMessage` must reproduce
 * `puca-ua`'s `signed_message` byte-for-byte, or every verification fails.
 * A shared KAT (`unattended.kat.json`) is asserted by BOTH this module's vitest
 * and `puca-ua`'s cargo test, so the two cannot drift silently — the same
 * discipline the media-frame AEAD uses.
 */
import { argon2id } from '@noble/hashes/argon2.js';
import { ed25519 } from '@noble/curves/ed25519';

/** Domain-separation tag. MUST equal `puca_ua::DOMAIN`. */
const DOMAIN = 'sovereign-unattended-v1';

/**
 * Argon2id parameters for the unattended passphrase. Memory-hard on purpose:
 * this is the gate on SYSTEM-level access, so the cost of an offline guess (were
 * the public key ever exposed) must be high. Matches the account-wrap params
 * (OWASP 2026 minimum, ~0.4 s in-process) — fine for a per-connect op.
 *
 * FIXED, never server-supplied and never carried in the record: the `-v1` domain
 * pins them. If they ever change, bump the domain to `-v2`, because the same
 * passphrase under different params yields a different key and would silently
 * stop matching an existing host record.
 */
const ARGON2_M = 19_456; // KiB (19 MiB)
const ARGON2_T = 2;
const ARGON2_P = 1;

const SALT_LEN = 16;

export interface UaRecord {
    /** Format version — mirrors `UaRecord::VERSION` on the host. */
    version: number;
    /** 16-byte Argon2id salt. */
    salt: number[];
    /** 32-byte Ed25519 public key. */
    verifying_key: number[];
}

/** Stretch the passphrase to a 32-byte Ed25519 seed. Exported so the session
 *  layer can derive once, sign with the seed, and remember the seed — never
 *  the passphrase. */
export function deriveUaSeed(passphrase: string, salt: Uint8Array): Uint8Array {
    return argon2id(new TextEncoder().encode(passphrase), salt, {
        m: ARGON2_M,
        t: ARGON2_T,
        p: ARGON2_P,
        dkLen: 32,
    });
}

/**
 * The exact bytes the host verifies. Reproduces `puca_ua::signed_message`:
 *
 *   DOMAIN || len(context) as u32 LE || context (utf8) || nonce (32)
 *
 * Context is length-prefixed so no context value can be mistaken for the nonce
 * or forge a different framing; the u32 is LITTLE-endian to match Rust's
 * `to_le_bytes`.
 */
export function challengeMessage(context: string, nonce: Uint8Array): Uint8Array {
    if (nonce.length !== 32) {
        throw new Error(`nonce must be 32 bytes, got ${nonce.length}`);
    }
    const domain = new TextEncoder().encode(DOMAIN);
    const ctx = new TextEncoder().encode(context);
    const out = new Uint8Array(domain.length + 4 + ctx.length + 32);
    let o = 0;
    out.set(domain, o);
    o += domain.length;
    // len(context) as u32 little-endian.
    out[o] = ctx.length & 0xff;
    out[o + 1] = (ctx.length >>> 8) & 0xff;
    out[o + 2] = (ctx.length >>> 16) & 0xff;
    out[o + 3] = (ctx.length >>> 24) & 0xff;
    o += 4;
    out.set(ctx, o);
    o += ctx.length;
    out.set(nonce, o);
    return out;
}

/**
 * Arm a NEW passphrase: pick a random salt, derive, and return the record the
 * host must persist. The passphrase and seed are dropped when this returns; the
 * record carries only public material.
 */
export function buildUaRecord(passphrase: string): UaRecord {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const seed = deriveUaSeed(passphrase, salt);
    const verifying_key = ed25519.getPublicKey(seed);
    return {
        version: 1,
        salt: Array.from(salt),
        verifying_key: Array.from(verifying_key),
    };
}

/**
 * Answer a host challenge: derive the keypair from the passphrase and the
 * host-supplied salt, and sign the framed message. Returns the 64-byte Ed25519
 * signature.
 *
 * The `salt` comes from the host's stored record (the host sends it with the
 * challenge), so a controller need not remember it — only the passphrase.
 */
export function signUaChallenge(
    passphrase: string,
    salt: Uint8Array,
    context: string,
    nonce: Uint8Array,
): Uint8Array {
    const seed = deriveUaSeed(passphrase, salt);
    return ed25519.sign(challengeMessage(context, nonce), seed);
}

/**
 * Does `passphrase` reproduce the public key in `record`? A LOCAL check for the
 * arming UI ("confirm your passphrase") — it does not involve the host and is
 * not an authentication. Constant-time is unnecessary: it compares two public
 * keys, neither secret.
 */
export function passphraseMatches(passphrase: string, record: UaRecord): boolean {
    const salt = Uint8Array.from(record.salt);
    const seed = deriveUaSeed(passphrase, salt);
    const pub = ed25519.getPublicKey(seed);
    const want = Uint8Array.from(record.verifying_key);
    if (pub.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < pub.length; i++) diff |= pub[i] ^ want[i];
    return diff === 0;
}

/** Sign a challenge with an ALREADY-derived seed — the remembered-seed path,
 *  and the second half of every prompted path (derive once, sign, remember).
 *  Byte-identical to `signUaChallenge(pass, salt, ...)` for the seed that
 *  passphrase and salt derive; a test pins that equivalence. */
export function signUaChallengeSeed(
    seed: Uint8Array,
    context: string,
    nonce: Uint8Array,
): Uint8Array {
    return ed25519.sign(challengeMessage(context, nonce), seed);
}

// ---------------------------------------------------------------------------
// Remembering a proved passphrase on THIS device.
//
// Typing the unattended passphrase on a phone for every reconnect is friction
// that pushes people toward weak passphrases, so a seed that a host has
// actually ACCEPTED is kept for a while and re-used silently. What is stored
// is the Argon2id-stretched Ed25519 SEED, never the passphrase. Be honest
// about what that buys: the seed IS the signing key for that host — anyone
// who reads this store holds the unattended capability for that machine until
// it is re-armed. The two things it does NOT expose are the passphrase itself
// (deriving it back means beating Argon2id) and, with it, whatever OTHER
// accounts reuse that password. The stored capability is bounded host-side by
// re-arming: a new passphrase means a new salt and verifying key, and every
// remembered seed everywhere misses from that moment.
//
// Because of that exposure, the session layer only WRITES this store inside
// the native shells (Tauri / Capacitor), where storage belongs to the app —
// never in a shared browser, where a later user of the same profile could
// lift it. Signing out clears it either way (see auth.ts logout).
//
// The entry is keyed by host device id and pinned to the host's SALT: re-arm
// the host with a new passphrase and the salt changes, so the stale seed
// misses instead of signing garbage. Expiry is sliding — each session the
// host accepts renews it — and a seed the host REJECTS is forgotten by the
// session layer (see teardown), so one typo cannot wedge the cache. The
// expiry is client-side housekeeping, not a security bound; the security
// bounds are the native-shell gate, the logout clear, and re-arming.
// ---------------------------------------------------------------------------

/** How long a remembered seed lives without a successful use: 30 days. */
export const UA_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;

const REMEMBER_KEY = 'sovereign-ua-remember';

interface RememberedSeed {
    /** base64 of the host record's salt — the cache key's second half. */
    salt: string;
    /** base64 of the 32-byte derived seed. */
    seed: string;
    /** Epoch ms after which the entry is dead. */
    expires: number;
}

function loadRemembered(): Record<string, RememberedSeed> {
    try {
        const raw = localStorage.getItem(REMEMBER_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, RememberedSeed>)
            : {};
    } catch {
        return {};
    }
}

function storeRemembered(map: Record<string, RememberedSeed>): void {
    try {
        if (Object.keys(map).length === 0) localStorage.removeItem(REMEMBER_KEY);
        else localStorage.setItem(REMEMBER_KEY, JSON.stringify(map));
    } catch {
        // Storage unavailable (private mode); remembering is best-effort.
    }
}

function b64(bytes: Uint8Array): string {
    let s = '';
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
}

/** Remember a derived seed for `deviceId` under the host's current salt. */
export function rememberUaSeed(
    deviceId: string,
    saltB64: string,
    seed: Uint8Array,
    now: number = Date.now(),
): void {
    const map = loadRemembered();
    map[deviceId] = { salt: saltB64, seed: b64(seed), expires: now + UA_REMEMBER_MS };
    storeRemembered(map);
}

/**
 * The remembered seed for `deviceId`, or null. A salt mismatch (the host was
 * re-armed) and an expired entry both miss AND drop the dead entry, so the
 * store cannot accumulate seeds nothing will ever read.
 */
export function rememberedUaSeed(
    deviceId: string,
    saltB64: string,
    now: number = Date.now(),
): Uint8Array | null {
    const map = loadRemembered();
    const entry = map[deviceId];
    if (!entry) return null;
    if (entry.salt !== saltB64 || now >= entry.expires || typeof entry.seed !== 'string') {
        delete map[deviceId];
        storeRemembered(map);
        return null;
    }
    try {
        const seed = Uint8Array.from(atob(entry.seed), c => c.charCodeAt(0));
        if (seed.length !== 32) throw new Error('bad seed length');
        return seed;
    } catch {
        delete map[deviceId];
        storeRemembered(map);
        return null;
    }
}

/** Slide the expiry after the host accepted a signature made from this seed. */
export function confirmUaSeed(deviceId: string, now: number = Date.now()): void {
    const map = loadRemembered();
    const entry = map[deviceId];
    if (!entry) return;
    entry.expires = now + UA_REMEMBER_MS;
    storeRemembered(map);
}

/** Drop the seed — the host rejected it, or the user is done with the device. */
export function forgetUaSeed(deviceId: string): void {
    const map = loadRemembered();
    if (!(deviceId in map)) return;
    delete map[deviceId];
    storeRemembered(map);
}

/** Drop every remembered seed. Sign-out hygiene: these grant SYSTEM-level
 *  unattended control of the user's machines, which must not outlive the
 *  account session that earned them on this browser profile. */
export function clearRememberedUaSeeds(): void {
    try {
        localStorage.removeItem(REMEMBER_KEY);
    } catch {
        // Storage unavailable; there is nothing stored to clear either.
    }
}
