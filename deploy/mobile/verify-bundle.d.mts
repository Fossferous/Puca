/** Types for deploy/mobile/verify-bundle.mjs (imported by frontend/src/tests/otaBundleSigning.test.ts). */
/** The CapacitorUpdater publicKey in a capacitor.config.ts, or null when it has none. */
export function publicKeyFromConfig(text: string): string | null;
/** Throws with the reason when the bundle does not verify; returns the decrypted length. */
export function verifyBundle(enc: Buffer, sessionKey: string, checksum: string, pem: string): number;
