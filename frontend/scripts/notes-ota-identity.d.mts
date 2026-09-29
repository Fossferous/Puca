/** Types for scripts/notes-ota-identity.mjs (imported by src/tests/notesOtaIdentity.test.ts). */

export interface IdentityCheck {
    ok: string[];
    failures: string[];
}

/** The body of `CapacitorUpdater: { ... }` in a capacitor.config.ts text, or null. */
export function updaterBlock(cfgText: string): string | null;

/** The CapacitorUpdater publicKey in a capacitor.config.ts text, or null. */
export function updaterPublicKey(cfgText: string): string | null;

export function checkNotesOta(a: {
    /** notes-app/capacitor.config.ts text */
    notesCfg: string;
    /** capacitor.config.ts text */
    pucaCfg: string;
    /** notes-app/package.json, parsed */
    notesPkg: { dependencies?: Record<string, string> } | null | undefined;
    /** the @capgo/capacitor-updater version frontend/package-lock.json resolves */
    frontendUpdaterVersion: string | null | undefined;
}): IdentityCheck;

/** A tauri*.conf.json, comment keys stripped — only `build` is read. */
export interface TauriConfLike {
    build?: Record<string, unknown>;
}

export function checkDesktopDist(
    base: TauriConfLike | null | undefined,
    lite: TauriConfLike | null | undefined,
    win: TauriConfLike | null | undefined,
): IdentityCheck;
