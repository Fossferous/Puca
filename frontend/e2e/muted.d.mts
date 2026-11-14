/** Types for e2e/muted.mjs (imported by src/tests/e2eMuted.test.ts). */
export function silencePage(): void;
export function muteWebkit<T extends { newContext(...args: never[]): Promise<unknown>; newPage(...args: never[]): Promise<unknown> }>(browser: T): T;
