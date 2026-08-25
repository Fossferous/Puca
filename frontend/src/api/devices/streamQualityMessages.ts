/**
 * User-facing text for stream-quality failures, keyed by the `code` carried on
 * the `stream-quality-failed` event (session.ts dispatches it from both the
 * 5s apply timeout and the host's `stream-quality-error` signal).
 *
 * Lives outside StreamStage.tsx on purpose: exporting a plain function from a
 * component file breaks React fast-refresh, and the test that pins these
 * mappings shouldn't have to import a component tree to check four strings.
 */
export function getStreamQualityErrorMessage(code?: string): string {
    if (code === 'query_failed') return 'Failed to query stream quality';
    if (code === 'unsupported_bitrate') return 'Requested bitrate is not supported';
    if (code === 'apply_timeout') return 'Quality update timed out';
    return 'Failed to update stream quality';
}
