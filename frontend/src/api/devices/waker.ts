/**
 * Pair an always-on LAN waker.
 *
 * WHY THIS HAS TO LIVE ON THE DESKTOP. A device is only a legitimate wake
 * candidate if its enrolment record verifies — `planWake` filters out
 * unverified devices, and verification is against the ACCOUNT signing key,
 * which is derived from the E2EE seed. The waker never holds that seed and must
 * never hold it: it runs unattended on a box the owner rarely looks at, and a
 * seed there would turn a compromised container into a compromised account. So
 * the waker mints its own keypair, and this signs the record vouching for it.
 *
 * WHAT THE WAKER GETS, AND WHAT IT DOES NOT. It gets its own public keys back
 * as a signed record (public anyway), and a copy of the session token. It does
 * not get the seed, any channel key, or any ability to read a message. Its whole
 * capability is: hold a socket, and put a magic packet on one LAN.
 *
 * The token is a plain user token — `Claims` has no device field, so a token
 * minted here is usable there, and device identity is a property of the
 * CONNECTION established by attestation. This is not a new trick: the mobile app
 * already copies the same session token into a separate native process.
 */
import { apiClient } from '../client';
import { getToken } from '../auth';
import { getActiveIdentity } from '../e2ee';
import { buildAuthRecord, signAuthRecord } from '../deviceIdentity/identity';
import type { DeviceRow } from './index';

/** The three public values `puca-waker init` prints. */
export interface WakerKeys {
    device_id: string;
    device_pub: string;
    sign_pub: string;
}

/**
 * The two things the waker cannot work out for itself.
 *
 * Deliberately NOT a whole config file. `puca-waker init` already prints a
 * complete template with the right `api_base`, `bind_ip` and `broadcast` for
 * the machine it ran on — that machine knows its own address and this one does
 * not. An earlier version of this generated the whole file here and guessed
 * those three, which is how a product feature ends up with one particular
 * home's LAN baked into it.
 */
export interface WakerBootstrap {
    /** Goes into the `user_id` field of the template `init` printed. */
    userId: number;
    /** Confirms the id the server actually assigned. */
    deviceId: string;
    /** Contents of /var/lib/puca-waker/token */
    token: string;
}

/**
 * Parse the block `puca-waker init` prints.
 *
 * Tolerant of whitespace and of the operator pasting the surrounding lines,
 * because the alternative is an error message about a regular expression to
 * someone who just copied a terminal.
 */
export function parseWakerKeys(text: string): WakerKeys | null {
    const grab = (label: string): string | null => {
        const m = text.match(new RegExp(`${label}\\s+(\\S+)`));
        return m ? m[1] : null;
    };
    const device_id = grab('device_id');
    const device_pub = grab('device_pub');
    const sign_pub = grab('sign_pub');
    if (!device_id || !device_pub || !sign_pub) return null;
    // Shape-check rather than trust: a truncated paste otherwise enrols a
    // device whose id the server derives differently, and the failure surfaces
    // much later as "the waker never comes online".
    if (device_id.length !== 21) return null;
    if (!device_pub.startsWith('x25519:') || !sign_pub.startsWith('ed25519:')) return null;
    return { device_id, device_pub, sign_pub };
}

/**
 * Enrol the waker and produce the two files it needs.
 *
 * Throws with a readable reason rather than returning null: this runs from a
 * button the owner deliberately pressed, so silence would be the wrong answer.
 */
export async function pairWaker(
    userId: number,
    keys: WakerKeys,
    opts: { name?: string },
): Promise<WakerBootstrap> {
    const identity = getActiveIdentity();
    if (!identity) {
        throw new Error('Unlock Puca on this computer first — pairing has to sign with your account key.');
    }
    const token = getToken();
    if (!token) throw new Error('Sign in first: the waker needs a copy of this session to connect.');

    const name = opts.name?.trim() || 'Home Waker';
    const { canonical, deviceId } = buildAuthRecord({
        devicePub: keys.device_pub,
        signPub: keys.sign_pub,
        name,
        platform: 'linux',
        userId,
    });

    // THE SERVER DERIVES THE ID INDEPENDENTLY and ignores anything we claim, so
    // a mismatch here means the pasted keys are not the ones the waker holds —
    // catch it now, while the person is looking at the screen, rather than
    // shipping a config whose device_id will never attest.
    if (deviceId !== keys.device_id) {
        throw new Error(
            `Those keys do not match that device id (expected ${deviceId}). Re-copy the whole block from the waker.`,
        );
    }

    const row = await apiClient.post<DeviceRow>('/devices', {
        device_pub: keys.device_pub,
        sign_pub: keys.sign_pub,
        name,
        platform: 'linux',
        auth_record: canonical,
        auth_sig: signAuthRecord(identity, canonical),
    });

    return { userId, deviceId: row.id, token };
}
