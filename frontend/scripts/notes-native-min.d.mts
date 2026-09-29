/** Types for scripts/notes-native-min.mjs (imported by src/tests/notesNativeMin.test.ts). */

/** notes-app/native-min.json, relative to the frontend directory. */
export const NATIVE_MIN_FILE: string;

/** a > b, both MAJOR.MINOR.PATCH. */
export function versionGt(a: string, b: string): boolean;

export function isVersion(v: unknown): v is string;

/** The APK's native surface: every list sorted, permissions de-duplicated. */
export interface NativeSurface {
    packages: string[];
    plugins: string[];
    permissions: string[];
}

/** File TEXT the surface is read from (so tests can feed it anything). */
export interface NativeSurfaceSources {
    /** notes-app/package.json, parsed. */
    notesPkg: { dependencies?: Record<string, string> } | null | undefined;
    /** Every .java file under app/src/main/java. */
    javaSources: { name: string; text: string }[];
    /** notes-app/android/app/src/main/AndroidManifest.xml. */
    manifestXml: string | null | undefined;
}

export function nativeSurface(sources: NativeSurfaceSources): NativeSurface;

/** notes-app/native-min.json, parsed. It is JSON off disk and the checker is
 *  the thing that validates it, so nothing here is trusted to be well formed. */
export interface NativeMinRecord {
    min?: unknown;
    surface?: { packages?: unknown; plugins?: unknown; permissions?: unknown };
}

/** The real tree's record and surface. */
export function readNativeMin(frontendDir: string): { record: NativeMinRecord; surface: NativeSurface };

export function checkNativeMin(
    record: NativeMinRecord | null | undefined,
    surface: NativeSurface,
): { ok: string[]; failures: string[] };
