/** Types for scripts/check-npm-advisories.mjs (imported by src/tests/npmAdvisoriesGate.test.ts). */

/** One package in `npm audit --json`'s `vulnerabilities` map — only the
 *  fields the gate reads. A `via` item is an advisory object, or the name of
 *  another vulnerable package (a string), which the gate skips. */
export interface NpmAuditEntry {
    severity: string;
    isDirect?: boolean;
    via?: Array<string | { url?: string }>;
}

/** The parsed `npm audit --json` output: a report, or an error from a
 *  registry that could not be reached. */
export interface NpmAuditReport {
    vulnerabilities?: Record<string, NpmAuditEntry>;
    error?: { code?: string; summary?: string };
}

/** The triage table: package -> the identifiers its row names. */
export function parseTriage(docText: string): Map<string, Set<string>>;

/** The decision: what blocks and what merely warns; `reported` is each
 *  high/critical package with the identifiers the audit named for it. */
export function triage(audit: NpmAuditReport | null | undefined, docText: string): {
    failures: string[];
    warnings: string[];
    reported: Map<string, string[]>;
};
