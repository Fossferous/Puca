/**
 * This device's enrolled id — a leaf cache with ZERO imports.
 *
 * WHY IT IS NOT IN api/devices/index.ts, where it used to live. Push
 * registration needs the id (it hands it to the Android native-delivery
 * service so frames can be addressed to this device) and read it via a getter
 * exported from the My Devices registry. That single edge put the entire
 * registry — and, transitively, `../client`, `../auth`, `../e2ee`,
 * `../websocket` and the device keypair — onto the preserved push path, so a
 * build with remote control excluded still pulled all of it into the main
 * chunk.
 *
 * The id is written by device enrolment/attestation and read by anything that
 * needs to name this device. Nothing here knows what a device record IS, which
 * is exactly what keeps it a leaf.
 */

let cachedDeviceId: string | null = null;

/**
 * This device's id, or null before enrolment/attestation has completed.
 *
 * Callers must tolerate null rather than wait on it: attestation happens after
 * the socket opens, so early callers legitimately see nothing. Push
 * registration handles this by re-syncing on the `deviceAttested` event.
 */
export function thisDeviceId(): string | null {
    return cachedDeviceId;
}

/** Record the id enrolment resolved for this device. */
export function setThisDeviceId(id: string): void {
    cachedDeviceId = id;
}

/**
 * Forget it — on sign-out, or when the server says this device was revoked.
 * A stale id is worse than none: it names a device the server will refuse.
 */
export function clearThisDeviceId(): void {
    cachedDeviceId = null;
}
