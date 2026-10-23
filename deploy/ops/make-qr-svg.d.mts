/** Types for deploy/ops/make-qr-svg.mjs (imported by frontend/src/tests/qrSvg.test.ts). */
export const MAX_BYTES: number;
export function rsRemainder(data: number[], ecLen: number): number[];
export function qrMatrix(text: string): { size: number; version: number; mask: number; modules: boolean[][] };
export function qrSvg(text: string, label?: string): string;
