/**
 * Parse a server datetime string into epoch MILLISECONDS, treating naive
 * strings as UTC.
 *
 * Why this exists: the backend's Postgres columns are naive TIMESTAMP filled
 * with UTC. Historically they were serialized as "YYYY-MM-DD HH:MM:SS.ffffff"
 * (no zone marker), which `new Date(...)` interprets in the LOCAL zone — so
 * every history-loaded message rendered one hour early during BST while the
 * live WS path (Unix seconds) was correct. The server now emits
 * "YYYY-MM-DDTHH:MM:SS.ffffffZ", but this parser must keep handling:
 *  - the new Z-suffixed form (and any future explicit-offset form),
 *  - old naive strings (pre-fix rows echoed verbatim, e.g. invite expiries
 *    stored as TEXT, or a client talking to an older self-hosted server),
 *  - Postgres timestamptz text ("... +00" — a bare-hours offset ECMAScript
 *    does not accept; normalized to "+00:00").
 */
export function parseServerTimestamp(s: string | null | undefined): number {
    if (!s) return NaN;
    const t = s.trim().replace(' ', 'T');
    // Bare-hours offset ("+00" / "-05") → ECMA-valid "+00:00" form. Anchored
    // on a preceding TIME component: a plain date like "2026-07-27" also ends
    // in [+-]\d{2} ("-27") and must fall through to the naive branch instead
    // of becoming Invalid Date.
    if (/\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}$/.test(t)) return new Date(`${t}:00`).getTime();
    // Explicit zone designator → trust it.
    if (/([zZ]|[+-]\d{2}:\d{2})$/.test(t)) return new Date(t).getTime();
    // Naive → it is UTC wall time.
    return new Date(`${t}Z`).getTime();
}

/** Same, in whole SECONDS (the unit most message state carries). */
export function parseServerTimestampSecs(s: string | null | undefined): number {
    return parseServerTimestamp(s) / 1000;
}
