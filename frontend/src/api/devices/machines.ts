/**
 * One physical machine, however many device rows it enrolled.
 *
 * WHY THIS EXISTS. Turning on sign-in-screen access enrols a SECOND device row
 * for a PC that already has one. That is deliberate and stays: the LocalSystem
 * service mints its own keypair because it may not hold the app's, and must
 * never hold the account seed (`crates/puca-service/src/enrol.rs`), and a
 * device id is `sha256(device_pub‖sign_pub)` — two keypairs can never collide
 * onto one row. Two identities is the security design. Two CARDS was the bug.
 *
 * It was not merely untidy. The capabilities split so that neither row was
 * usable on its own:
 *
 *   - the app's row had the MAC, so it was the one that could be woken, but it
 *     is offline exactly when you need it (locked, or at the sign-in screen);
 *   - the service's row is reachable at the sign-in screen, but nothing ever
 *     wrote its `lan_info`, so it could never be woken — and its refusal said
 *     "open Puca on that device once", which publishes to the OTHER row.
 *
 * So the reachable half could not be woken and the wakeable half could not be
 * reached, and the user hit both ends of that.
 *
 * THE GROUPING KEY IS THE MAC, and it needs no new column, no migration and no
 * new server field. `lanInfo.ts` now publishes the same sealed blob to both
 * rows of the machine it is running on; two rows carrying the same MAC are
 * therefore one machine, by construction. The link stays inside a blob only
 * this account can decrypt, which is the same privacy stance the LAN details
 * already take — the server never learns which rows are one box.
 *
 * A row whose `lan_info` will not decrypt (no identity yet, a Mac or Linux
 * desktop where collection is unimplemented, a machine that has not run the
 * app since enrolling) is left standing alone. That is exactly today's
 * behaviour, so nothing regresses while the MAC is still missing.
 */
import { openLanInfo } from './wake';
import type { VerifiedDevice } from './index';

/** One machine: every row that is provably the same box. */
export interface Machine {
    /** Stable key for React. The primary row's id. */
    id: string;
    /**
     * The row to name the card after, and to connect to when everything is up.
     *
     * The APP row wins when there is a choice: it is the one whose name the
     * owner has actually seen and may have renamed, and the sign-in row's name
     * is a hard-coded literal nobody chose.
     */
    primary: VerifiedDevice;
    /** The sign-in-screen row, when this machine has one. */
    signInRow: VerifiedDevice | null;
    /** Every row, primary first. */
    rows: VerifiedDevice[];
    /** Reachable by ANY of its rows. */
    online: boolean;
    /**
     * The row a session should actually be opened against, or null when the
     * machine is off.
     *
     * PREFERS THE SIGN-IN ROW WHENEVER IT IS ONLINE, and that is not a
     * preference for the poorer session — it is the only one that can see the
     * screen at that moment. The service runs its agent ONLY while the console
     * is locked or signed out and drops it the instant somebody signs in, so
     * "the sign-in row is online" is precisely "the console is locked". The
     * desktop app is an ordinary user-session process and cannot capture the
     * lock screen at all, so connecting there lands on a session with no
     * picture.
     *
     * This used to prefer the app row, and the failure was exactly that: with
     * a PC locked and the app still running, Connect went to the app row,
     * showed nothing, and only reached the sign-in screen after the user had
     * watched it fail. When the console IS unlocked the service is gone, so
     * this naturally resolves to the app row with no extra condition.
     */
    onlineRow: VerifiedDevice | null;
    /** True when the only way in right now is the sign-in screen. */
    atSignInScreen: boolean;
    /** The MAC every row of this machine shares, when known. */
    mac: string | null;
}

/**
 * The name `enrolLockScreenAccess` gives the service row.
 *
 * Used ONLY as a fallback for rows enrolled before the sealed `role` field
 * existed. It is not the primary signal precisely because it is renameable from
 * the Devices UI, and a card that silently un-merged because someone renamed a
 * device would be a mystery to debug. Kept in sync with
 * `frontend/src/api/devices/lockScreen.ts`.
 */
export const SIGN_IN_ROW_NAME = 'This PC (sign-in screen)';

/** Is this row the sign-in-screen half? `role` when we have it, name otherwise. */
function isSignInRow(d: VerifiedDevice, role: LanRole): boolean {
    if (role) return role === 'signin';
    return d.name === SIGN_IN_ROW_NAME;
}

type LanRole = 'app' | 'signin' | null;

/**
 * Fold rows into machines.
 *
 * Pure, and exported for that reason: the merge is the part most likely to be
 * wrong, and it must be testable without mounting a component or standing up an
 * identity. `openLanInfo` is async (it decrypts), so this is too.
 *
 * Order is preserved: machines come out in the order their primary row came in,
 * so the list does not reshuffle when a machine's second row appears.
 */
export async function groupIntoMachines(devices: VerifiedDevice[]): Promise<Machine[]> {
    // Decrypt once per row. Doing it inside the grouping loop would decrypt the
    // same blob repeatedly for no benefit.
    const macs = new Map<string, string | null>();
    const roles = new Map<string, LanRole>();
    for (const d of devices) {
        let mac: string | null = null;
        let role: LanRole = null;
        try {
            const lan = await openLanInfo(d.lan_info);
            mac = lan?.mac ? lan.mac.toUpperCase() : null;
            role = lan?.role === 'app' || lan?.role === 'signin' ? lan.role : null;
        } catch {
            // Undecryptable is the same as unknown: the row stands alone.
            mac = null;
        }
        macs.set(d.id, mac);
        roles.set(d.id, role);
    }
    const signIn = (d: VerifiedDevice) => isSignInRow(d, roles.get(d.id) ?? null);

    const byMac = new Map<string, VerifiedDevice[]>();
    const ordered: Array<{ key: string; mac: string | null }> = [];

    for (const d of devices) {
        const mac = macs.get(d.id) ?? null;
        // A row with no MAC is its own machine, keyed on its id so it can never
        // collide with another. Grouping every unknown together would merge
        // every phone on the account into one card.
        const key = mac ?? `id:${d.id}`;
        const existing = byMac.get(key);
        if (existing) {
            existing.push(d);
        } else {
            byMac.set(key, [d]);
            ordered.push({ key, mac });
        }
    }

    return ordered.map(({ key, mac }) => {
        const rows = byMac.get(key)!;
        // The app row is the primary; if every row looks like a sign-in row
        // (a machine whose app row has not been seen yet) the first one is.
        const primary = rows.find(r => !signIn(r)) ?? rows[0];
        const signInRow = rows.find(signIn) ?? null;
        const others = rows.filter(r => r.id !== primary.id);

        // THE SIGN-IN ROW WINS WHEN IT IS UP — see `onlineRow` on the type for
        // why: its being online IS the machine being locked, and the app row
        // cannot see a lock screen. Falls through to the app row the moment
        // the console is unlocked, because the service stops itself then.
        const onlineRow =
            (signInRow?.online ? signInRow : null)
            ?? (primary.online ? primary : null)
            ?? others.find(r => r.online)
            ?? null;

        return {
            id: primary.id,
            primary,
            signInRow,
            rows: [primary, ...others],
            online: rows.some(r => r.online),
            onlineRow,
            atSignInScreen: onlineRow !== null && signInRow !== null && onlineRow.id === signInRow.id,
            mac,
        };
    });
}

/**
 * One machine per row, no merging — SYNCHRONOUS.
 *
 * The real fold decrypts every `lan_info` and is therefore async, and the
 * Devices view rendered NOTHING while it ran: `devices` was a loaded array
 * (so neither "Loading…" nor the empty state showed) but `machines` was still
 * `[]` — an empty grid with no spinner, on every entry to the view and after
 * every 15 s poll that changed the list. This gives the view something honest
 * to paint immediately: exactly the pre-merge picture, which the fold then
 * replaces a moment later. It must stay a faithful subset of the fold's
 * shape so a card does not flicker between two layouts.
 */
export function ungrouped(devices: VerifiedDevice[]): Machine[] {
    return devices.map(d => ({
        id: d.id,
        primary: d,
        signInRow: null,
        rows: [d],
        online: d.online,
        onlineRow: d.online ? d : null,
        atSignInScreen: false,
        mac: null,
    }));
}

/** The machine a given row belongs to, or null. */
export function machineOf(machines: Machine[], deviceId: string): Machine | null {
    return machines.find(m => m.rows.some(r => r.id === deviceId)) ?? null;
}
