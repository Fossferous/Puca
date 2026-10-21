/**
 * The lite stand-in for devices/connectLog (kept OUT of api/devices/, which the
 * rc-exclusion guard refuses wholesale): vite.shared.ts aliases it in for
 * VITE_ENABLE_RC=false builds. A lite build has no remote control, so there
 * are no connection attempts to log; diagnosticsReport.ts, the one kept
 * module that imports the log, also gates its section behind __RC_ENABLED__.
 * Same exported shape — a real module, never an empty one (an empty module
 * makes the bindings undefined and breaks the importer at load).
 * connectLogLite.test.ts pins the shape.
 */
export function logRcConnect(_event: string): void {}

export function recentRcConnectLines(): string[] {
    return [];
}
