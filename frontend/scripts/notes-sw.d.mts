/** Types for scripts/notes-sw.mjs (imported by vite.notes.config.ts). */
import type { Plugin } from 'vite';
export function renderNotesServiceWorker(buildId: string, precache: string[]): string;
export function notesServiceWorkerPlugin(opts: { outDir: string; enabled: boolean }): Plugin;
