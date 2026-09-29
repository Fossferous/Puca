/** Types for scripts/check-api-url.mjs (imported by src/tests/checkApiUrl.test.ts). */

/** The value of `key` in dotenv `text`, surrounding quotes removed; undefined when absent. */
export function readDotenvValue(text: string, key: string): string | undefined;

/** null = acceptable; otherwise the reason the value is not. */
export function verdict(value: string | null | undefined, opts?: { allowLocal?: boolean }): string | null;
