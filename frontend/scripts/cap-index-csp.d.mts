/** Types for scripts/cap-index-csp.mjs (imported by src/tests/capIndexCsp.test.ts). */
export const WEB_DIST: string;
export const ANDROID_INDEX: string;
/** Throws when `apiUrl` is missing or is not an absolute http(s) URL. */
export function buildPolicy(opts?: { apiUrl?: string; fallbackApiUrl?: string }): string;
export function metaTag(policy: string): string;
export function injectCsp(html: string, policy: string): string;
export function applyToFile(
    target: string,
    policy: string,
    opts?: { webDist?: string; dryRun?: boolean },
): { changed: boolean; policy: string };
