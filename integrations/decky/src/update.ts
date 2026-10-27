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

/** The first look for an update once Púca is up, and the look after the Deck
 *  wakes: a little later, because a Deck often wakes before its Wi-Fi does. */
export const UPDATE_FIRST_CHECK_MS = 20 * 1000;
/** Then a look every six hours, on the wall clock. */
export const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Opening the panel, or waking the Deck, looks again once the download
 *  site's last answer is older than this. */
export const UPDATE_STALE_MS = 10 * 60 * 1000;
/** How often the controller reads the wall clock. */
export const UPDATE_TICK_MS = 60 * 1000;
/** Two readings further apart than this slept between them: on the timers'
 *  clock they were UPDATE_TICK_MS apart. The rest is room for a busy or
 *  throttled timer, which can be a minute late without any sleep. */
export const UPDATE_SLEPT_GAP_MS = 3 * 60 * 1000;
/** However often the panel opens, looks are at least this far apart. */
export const UPDATE_MIN_GAP_MS = 60 * 1000;

/**
 * When to look for an update, on the wall clock (Date.now()).
 *
 * A timer's clock stops while the Deck sleeps: a six-hour timer set before
 * three days asleep goes off three days and six hours after it was set, and
 * until then the panel offers what the last look saw. On the owner's Deck
 * (October 2026) that was 0.3.0, days after 0.4.0 was out. So the controller
 * reads the wall clock every UPDATE_TICK_MS and asks this: a jump between two
 * readings is a sleep, and six hours are six hours of the day.
 */
export class UpdateClock {
    private triedAt: number | null = null;
    private answeredAt: number | null = null;
    private tickAt: number | null = null;

    /** A look starts. */
    tried(now: number): void {
        this.triedAt = now;
    }

    /** The download site answered it: with an offer, or with none. */
    answered(now: number): void {
        this.answeredAt = now;
    }

    /** The Quick Access panel opened: look now? Yes when the site's last
     *  answer is more than UPDATE_STALE_MS old, or there is none yet. */
    panelOpened(now: number): boolean {
        return this.stale(now) && (this.triedAt === null || now - this.triedAt >= UPDATE_MIN_GAP_MS || now < this.triedAt);
    }

    /**
     * A reading of the wall clock, every UPDATE_TICK_MS on the timers' clock.
     * 'woke': the Deck slept since the last reading, and the last answer is
     * stale: look in a little while. 'due': six hours since the last look.
     * Null: nothing to do. Before the first look nothing is due: that one is
     * Púca's start's (UPDATE_FIRST_CHECK_MS after it is up).
     */
    tick(now: number): 'woke' | 'due' | null {
        const last = this.tickAt;
        this.tickAt = now;
        if (this.triedAt === null) return null;
        // A clock set back counts as a jump too: nothing measured from before it holds.
        const slept = last !== null && (now - last > UPDATE_SLEPT_GAP_MS || now < last);
        if (slept && this.stale(now)) return 'woke';
        return now - this.triedAt >= UPDATE_EVERY_MS || now < this.triedAt ? 'due' : null;
    }

    private stale(now: number): boolean {
        return this.answeredAt === null || now - this.answeredAt > UPDATE_STALE_MS || now < this.answeredAt;
    }
}
