/** Types for deploy/ops/make-web-clip-profile.mjs (imported by frontend/src/tests/webClipProfile.test.ts). */
export const ICON_SIZE: number;
export function pngSize(png: Buffer): { width: number; height: number };
export function uuidFor(name: string): string;
export function webClipProfile(o: { url: string; iconPng: Buffer; label?: string }): string;
