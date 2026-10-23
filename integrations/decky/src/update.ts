/**
 * Updates for the plugin itself, from the Púca server's download site.
 *
 * The plugin runs inside Steam's own interface, with far more reach than the
 * Púca page it hosts. An update is code that will run there, so it is
 * installed only when it is signed with the operator's release key, whose
 * public half ships inside the plugin (update-key.json, written by
 * scripts/sign-update.mjs). A server alone cannot make one: whoever takes a
 * server over can change the Púca web page it serves, but not this plugin.
 *
 * The signature covers this text and nothing else:
 *
 *     puca-decky-update/1 \n <version> \n <the zip's SHA-256, hex> \n
 *
 * The version inside it is what stops an old, genuinely signed release being
 * offered again as new. RSASSA-PKCS1-v1_5 with SHA-256, checked with
 * WebCrypto (Steam's Chromium has no Ed25519 there). The leading line keeps
 * the signature from meaning anything to any other use of the same key.
 */
export const UPDATE_DOMAIN = 'puca-decky-update/1';

/** What the download site's steam-deck/puca-decky.json offers. */
export interface UpdateOffer {
    version: string;
    file: string;
    sha256: string;
    /** Base64. */
    signature: string;
}

/** The public half of the release key, as update-key.json holds it. */
export interface UpdateKey {
    kty: 'RSA';
    n: string;
    e: string;
}

/** "0.2.0" as numbers; null for anything that is not a plain version. */
export function parseVersion(v: unknown): number[] | null {
    if (typeof v !== 'string' || !/^\d{1,6}(\.\d{1,6}){0,3}$/.test(v)) return null;
    return v.split('.').map(Number);
}

/** Is `a` newer than `b`? Missing parts count as 0 (0.2 is 0.2.0). False
 *  when either is not a version. */
export function isNewer(a: string, b: string): boolean {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return false;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) return d > 0;
    }
    return false;
}

/** The exact text the release key signs. */
export function updateMessage(version: string, sha256: string): string {
    return `${UPDATE_DOMAIN}\n${version}\n${sha256}\n`;
}

/** The offer, if it is well formed; null otherwise. */
export function readOffer(raw: unknown): UpdateOffer | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!parseVersion(o.version)) return null;
    const version = o.version as string;
    if (o.file !== `puca-decky-${version}.zip`) return null;
    if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return null;
    if (typeof o.signature !== 'string' || o.signature.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.signature)) return null;
    return { version, file: o.file, sha256: o.sha256, signature: o.signature };
}

/** The key, if it is an RSA public key of at least 2048 bits; null otherwise. */
export function readKey(raw: unknown): UpdateKey | null {
    if (!raw || typeof raw !== 'object') return null;
    const k = raw as Record<string, unknown>;
    if (k.kty !== 'RSA' || typeof k.n !== 'string' || typeof k.e !== 'string') return null;
    if (!/^[A-Za-z0-9_-]+$/.test(k.n) || !/^[A-Za-z0-9_-]+$/.test(k.e)) return null;
    // 2048 bits is 256 bytes, 342 base64url characters without padding.
    if (k.n.length < 342) return null;
    return { kty: 'RSA', n: k.n, e: k.e };
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> | null {
    try {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

/** Is the offer signed with this key? Never throws. */
export async function verifyOffer(offer: UpdateOffer, key: UpdateKey, subtle: SubtleCrypto = crypto.subtle): Promise<boolean> {
    const signature = fromBase64(offer.signature);
    if (!signature) return false;
    try {
        const k = await subtle.importKey(
            'jwk', { kty: 'RSA', n: key.n, e: key.e },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
        );
        return await subtle.verify(
            'RSASSA-PKCS1-v1_5', k, signature, new TextEncoder().encode(updateMessage(offer.version, offer.sha256)),
        );
    } catch {
        return false;
    }
}
