/**
 * Which API bases the UPDATE checks may try, in order.
 *
 * The API base is baked at build time from frontend/.env.production — which is
 * gitignored. A build made without it falls back to localhost:3000, and on
 * 2026-08-03 that shipped: every updated client's login broke AND, because the
 * update checks used the same broken base, no client could ever see the fixed
 * release — desktop and mobile were stranded until a manual reinstall.
 *
 * The optional fallback below exists ONLY for the update paths, where it is
 * safe: the desktop installer is minisign-verified against the pubkey baked
 * into the app, and the mobile OTA is RSA-verified against the key in the APK,
 * so the worst a wrong host could do is offer an update that fails
 * verification. It is deliberately NOT used for general API traffic — a
 * mis-built client must fail loudly there, not silently talk to the wrong
 * server.
 *
 * IT IS CONFIGURED, NOT HARDCODED. This used to be a literal production
 * domain, with a note saying "if this is ever open-sourced this constant must
 * become configurable". That happened. Baking one deployment's domain into a
 * public repo would point every fork's update checks at somebody else's
 * server; leaving a placeholder domain in would be worse, because it looks
 * configured while silently resolving nowhere. So it comes from
 * VITE_UPDATE_FALLBACK_API, and when unset there is simply no fallback —
 * the configured base is tried and that is all.
 *
 * Read at CALL time rather than captured at import time, so a build-time
 * value and a test stub behave the same way.
 */

/** The update-check fallback base, or '' when none is configured. */
export function updateFallbackBase(): string {
    return import.meta.env.VITE_UPDATE_FALLBACK_API || '';
}

/** Candidate bases for update checks: the configured one first, then the
 *  optional fallback — deduped, so a correct build tries exactly one. */
export function updateCheckBases(configuredBase: string): string[] {
    const bases = [configuredBase];
    const fallback = updateFallbackBase();
    if (fallback && !bases.includes(fallback)) bases.push(fallback);
    return bases;
}
