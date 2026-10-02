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
    /** The newest Notes APK whose native layer changed: the manifest's native.version. */
    latest?: unknown;
    /** latestFingerprint(latest, nativeLayerHash(layer)) when `latest` was recorded. */
    latestFingerprint?: unknown;
    surface?: { packages?: unknown; plugins?: unknown; permissions?: unknown };
}

/** One file of the APK's native layer: its path relative to frontend/ and its bytes. */
export interface NativeLayerFile {
    path: string;
    bytes: string | Uint8Array;
}

/** Whether a path (relative to frontend/) is part of the APK's native layer. */
export function isNativeLayerPath(path: string): boolean;

/** sha256 over every file's path and normalised bytes (no CRs, no release number). */
export function nativeLayerHash(files: NativeLayerFile[]): string;

/** What native-min.json records as latestFingerprint for a given latest. */
export function latestFingerprint(latest: string, layerHash: string): string;

/** The tree's native layer: listed by git (tracked, plus untracked files git
 *  does not ignore), read from the working tree. */
export function nativeLayerFiles(frontendDir: string): NativeLayerFile[];

/** Has this release shipped, i.e. does the repository hold its v<version> tag? */
export function releaseTagged(frontendDir: string, version: string): boolean;

/** The real tree's record, surface and native layer. */
export function readNativeMin(frontendDir: string): {
    record: NativeMinRecord;
    surface: NativeSurface;
    layerFiles: NativeLayerFile[];
    layerHash: string;
};

/** Raise `latest` and seal it to the layer, or say why not. A version equal
 *  to the current `latest` or to `appVersion` is accepted only while
 *  `isShipped` says that release has not shipped; without `isShipped` it is
 *  refused. */
export function recordLatest(
    record: NativeMinRecord,
    version: string,
    layerHash: string,
    appVersion: string,
    isShipped?: (version: string) => boolean,
):{ record?: NativeMinRecord & { latest: string; latestFingerprint: string }; error?: string };

export function checkNativeMin(
    record: NativeMinRecord | null | undefined,
    surface: NativeSurface,
    layerHash: string,
): { ok: string[]; failures: string[] };
