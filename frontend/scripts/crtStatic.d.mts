export const CRT_STATIC: string;
export function rustflagsFor(platform: string, env?: Record<string, string | undefined>): string | undefined;
export function envWithCrtStatic(platform: string, env: Record<string, string | undefined>): Record<string, string | undefined>;
