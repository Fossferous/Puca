/// <reference types="vite/client" />

/** Injected by vite.config.ts from tauri.conf.json — the one place the
 *  version lives. Lets web and mobile report a version without Tauri. */
declare const __APP_VERSION__: string;

/**
 * Whether this build contains remote control. Injected by vite.config.ts as a
 * raw boolean LITERAL, so `if (__RC_ENABLED__)` folds to `if (false)` in a lite
 * build and Rollup drops the branch — along with any dynamic import inside it —
 * rather than shipping code that never runs.
 */
declare const __RC_ENABLED__: boolean;
