/**
 * Wake-on-LAN.
 *
 * The shape of this feature is dictated by the protocol, not by us: a magic
 * packet is a LAN broadcast, and a machine that is off has no connection to
 * receive an instruction. So waking a device ALWAYS requires a second device
 * that is already awake on the same subnet. There is no way around it, and the
 * UI must say so rather than offering a button that silently does nothing.
 *
 * Privacy: the LAN details (MAC, local IP, subnet, broadcast address) are
 * CLIENT-ENCRYPTED before they are stored. The server has no business holding a
 * map of the user's MAC addresses and internal network layout, and it costs
 * nothing to avoid — every device that needs to read this already holds the
 * account seed.
 */
import { getActiveIdentity, openDeviceLan, sealDeviceLan } from '../e2ee';
import { wsClient } from '../websocket';
import type { VerifiedDevice } from './index';

export interface LanInfo {
    /** Schema version of the sealed blob (1). Absent on nothing yet — the
     *  collector has always written it — but optional so an older or newer
     *  shape is tolerated rather than throwing. */
    v?: number;
    /** `AA:BB:CC:DD:EE:FF` */
    mac: string;
    /** e.g. `192.168.0.42` */
    ip?: string;
    /** e.g. `192.168.0` — the /24 prefix, used only to compare devices.
     *  MUST stay the same shape `subnetOf()` produces; the native collector
     *  emits three octets for exactly this reason. */
    subnet?: string;
    /** e.g. `192.168.0.255` */
    broadcast?: string;
    /** On-link prefix length, e.g. 24. Recorded but not currently compared. */
    prefix?: number;
    /** Ethernet rather than Wi-Fi. A magic packet almost never wakes a machine
     *  over Wi-Fi, so the UI warns the user before they wait for a timeout. */
    wired?: boolean;
    /** Adapter friendly name, for display and diagnosis only. */
    iface?: string;
    /**
     * Which half of the machine this row is.
     *
     * A PC with sign-in-screen access enrolled is TWO rows sharing one MAC (see
     * `machines.ts`). Something has to say which is which, and the row's NAME
     * cannot: it is renameable from the Devices UI, and a card that silently
     * un-merged because someone renamed a device would be a mystery to debug.
     * The app writes this when it publishes, so it is authoritative and survives
     * a rename. Absent on rows written before this shipped, where the name
     * literal is the only fallback available.
     */
    role?: 'app' | 'signin';
}

/**
 * Can this device physically send a magic packet?
 *
 * A POSITIVE test, deliberately. It used to be `platform !== 'web'`, which is
 * wrong in the one way that matters: an Android phone passed it, got chosen as
 * the waker, and then did nothing at all — `installWakeResponder` bails on
 * `!isTauri()`, and there is no UDP/broadcast capability anywhere in the
 * Android app. The result was a button that reported success and never woke
 * anything.
 *
 * Sending only needs a raw UDP socket, which every desktop shell has (`wol.rs`
 * is plain `std::net`), so all three desktop platforms qualify — including the
 * ones whose LAN details cannot yet be COLLECTED. Being able to wake something
 * else and being wakeable yourself are separate capabilities.
 */
export function canSendWakePackets(platform: string): boolean {
    return platform === 'windows' || platform === 'macos' || platform === 'linux';
}

export async function sealLanInfo(info: LanInfo): Promise<string | null> {
    const identity = getActiveIdentity();
    if (!identity) return null;
    return sealDeviceLan(identity, JSON.stringify(info));
}

export async function openLanInfo(blob: string | null): Promise<LanInfo | null> {
    if (!blob) return null;
    const identity = getActiveIdentity();
    if (!identity) return null;
    const plain = await openDeviceLan(identity, blob);
    if (!plain) return null;
    try {
        const parsed = JSON.parse(plain) as LanInfo;
        // A blob that decrypts but has no MAC is unusable; treat it as absent
        // rather than returning a half-object callers must re-check.
        return typeof parsed?.mac === 'string' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Are these the same adapter, and therefore the same physical machine?
 *
 * Case-insensitive: the native collector emits uppercase, but nothing forces a
 * blob written by another path to, and a case difference here would silently
 * re-admit the very candidate this comparison exists to exclude.
 */
export function sameMac(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** The /24 prefix of an IPv4 address, or null if it is not one. */
export function subnetOf(ip: string | undefined): string | null {
    if (!ip) return null;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
    if (!m) return null;
    const octets = m.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) return null;
    return octets.slice(0, 3).join('.');
}

export interface WakePlan {
    /** The device that will broadcast, or null when nothing can. */
    waker: VerifiedDevice | null;
    /** The target's MAC, once decrypted. */
    mac: string | null;
    broadcast?: string;
    /** Plain-language explanation when `waker` is null. Shown verbatim: a
     *  disabled button with no reason is a support ticket. */
    reason?: string;
}

/**
 * Decide which device can wake `target`, entirely client-side.
 *
 * Eligibility is "online, and on the same subnet as the target was last seen
 * on". Both halves matter: an offline device cannot send anything, and a device
 * on a different network broadcasts into the wrong LAN.
 */
export async function planWake(
    target: VerifiedDevice,
    all: VerifiedDevice[],
    thisDevice: string | null,
): Promise<WakePlan> {
    const targetLan = await openLanInfo(target.lan_info);
    if (!targetLan?.mac) {
        return {
            waker: null, mac: null,
            reason: `Puca has not recorded ${target.name}'s network details yet. ` +
                'Open Puca on that device once while it is on your home network.',
        };
    }
    const targetSubnet = targetLan.subnet ?? subnetOf(targetLan.ip);

    // Ranked, not filtered. A candidate whose own subnet is UNKNOWN is still
    // worth trying: LAN collection is Windows-only, so a Mac or Linux desktop
    // sitting on the same switch has no recorded subnet and a strict filter
    // would exclude the only machine able to help. A candidate whose subnet is
    // known and DIFFERENT is excluded outright — broadcasting into the wrong
    // LAN cannot work.
    const sameSubnet: VerifiedDevice[] = [];
    const unknownSubnet: VerifiedDevice[] = [];
    let sawIneligiblePlatform = false;
    let wrongSubnet = 0;

    for (const d of all) {
        if (d.id === target.id || !d.online || !d.verified) continue;
        if (!canSendWakePackets(d.platform)) {
            sawIneligiblePlatform = true;
            continue;
        }
        const lan = await openLanInfo(d.lan_info);

        // EXCLUDE THE WHOLE MACHINE, NOT JUST THE ROW. A PC with sign-in-screen
        // access enrolled is TWO device rows sharing one MAC, and only the id
        // was compared — so the dead machine's own second row was a legal
        // waker. The server's guard is an id compare too (ws.rs: "a device
        // cannot wake the network on its own behalf"), so it does not catch it
        // either, and the 75s idle reaper keeps a just-powered-off row looking
        // online long enough to be picked. The relay then "succeeds" into an
        // orphaned channel: no packet, no error, and a three-minute wait that
        // ends by blaming the BIOS.
        if (lan?.mac && sameMac(lan.mac, targetLan.mac)) continue;

        const subnet = lan?.subnet ?? subnetOf(lan?.ip);
        if (!subnet) {
            unknownSubnet.push(d);
            continue;
        }
        if (targetSubnet && subnet !== targetSubnet) {
            wrongSubnet += 1;
            continue;
        }
        sameSubnet.push(d);
    }

    const candidates = [...sameSubnet, ...unknownSubnet];
    if (candidates.length === 0) {
        // Name the ACTUAL obstacle — three different situations that used to
        // collapse into one misleading sentence. Telling someone to "leave a
        // computer on" when their computer IS on, just on another network,
        // sends them to fix the wrong thing.
        let reason: string;
        if (wrongSubnet > 0) {
            reason = `${target.name} can only be woken by a computer on the same network as it. ` +
                (wrongSubnet === 1
                    ? 'The one you have switched on is on a different network.'
                    : 'The ones you have switched on are all on different networks.');
        } else if (sawIneligiblePlatform) {
            reason = 'A wake signal has to be broadcast on your home network, which only ' +
                'the desktop app can do — a phone or a browser tab cannot. Leave one ' +
                `of your computers switched on, on the same network as ${target.name}.`;
        } else {
            reason = 'Nothing can send the wake signal: it has to come from another ' +
                'of your devices that is switched on and on the same network as ' +
                `${target.name}.`;
        }
        return { waker: null, mac: targetLan.mac, reason };
    }

    // Prefer a device OTHER than this one, but only WITHIN the best rank —
    // never across it. Reaching past a device known to be on the target's
    // subnet to pick one whose subnet is merely unknown trades a certainty for
    // a guess, which is the opposite of what the ranking is for. (This device
    // is a perfectly good waker; `requestWake` sends locally in that case
    // rather than asking the server to relay to us, which it refuses.)
    const best = sameSubnet.length > 0 ? sameSubnet : unknownSubnet;
    const preferred = best.find(d => d.id !== thisDevice) ?? best[0];
    return { waker: preferred, mac: targetLan.mac, broadcast: targetLan.broadcast };
}

/** What `requestWake` actually did, so the caller can tell a failure from a wait.
 *
 *  'sent'    — this machine put the packet on the wire; nothing more is coming.
 *  'relayed' — asked the server to ask another device; a `DeviceWakeResult`
 *              frame will follow and may still refuse.
 *  'failed'  — the local send did not happen at all. Previously indistinguishable
 *              from success, so the card waited out its full three minutes. */
export type WakeRequestOutcome =
    | { kind: 'sent' }
    | { kind: 'relayed' }
    | { kind: 'failed'; reason: string };

/**
 * Ask the chosen waker to broadcast.
 *
 * Note what this does NOT tell you: whether the machine woke. Nothing can — the
 * only proof is the target reconnecting, so callers should wait for it to come
 * online rather than treating a resolved promise as success. What it now DOES
 * tell you is whether the request got as far as the wire at all.
 */
export async function requestWake(
    plan: WakePlan,
    thisDevice: string | null,
): Promise<WakeRequestOutcome> {
    if (!plan.waker || !plan.mac) return { kind: 'failed', reason: 'Nothing could send the wake signal.' };

    // THIS machine is the chosen waker: send it ourselves rather than asking
    // the server to ask us.
    //
    // Not an optimisation — the relay REFUSES this case. The server compares
    // the asking device against `waker_device` and rejects a match, and it
    // cannot do better: the target's MAC is sealed, so from the server's side
    // "wake the machine I am sitting at" and "broadcast for a different
    // machine" are the same frame. Routing through it produced the worst
    // possible outcome — no packet, no error the user ever saw, and a
    // three-minute wait ending in advice to go and check their BIOS.
    //
    // Waking a second machine from the one you are sitting at is the ordinary
    // case (a laptop waking the desktop next to it), so this is the common
    // path, not an edge case.
    if (plan.waker.id === thisDevice) {
        const sent = await sendWakePacket(plan.mac, plan.broadcast ?? null);
        return sent
            ? { kind: 'sent' }
            : {
                kind: 'failed',
                reason:
                    'This computer could not put the wake signal on the network. ' +
                    'Check that it is on your home network on a wired connection.',
            };
    }

    // CHECKED, not fire-and-forget. `wsClient.send` drops the frame silently
    // when the socket is not open — routine on a phone that was just brought
    // back from the background — and this used to report 'relayed' anyway.
    // The card then waited its full three minutes on a request that never
    // left the device, AND the result queue gained an entry no reply would
    // ever match, shifting every LATER wake's verdict onto the wrong card.
    const written = wsClient.send({
        type: 'DeviceWake',
        payload: {
            waker_device: plan.waker.id,
            mac: plan.mac,
            broadcast: plan.broadcast ?? null,
        },
    });
    if (!written) {
        return {
            kind: 'failed',
            reason: 'Not connected right now — check your connection and press Wake again.',
        };
    }
    return { kind: 'relayed' };
}

/** Put a magic packet on the wire from THIS machine. Desktop only — a browser
 *  or a phone has no raw UDP socket, which is what `canSendWakePackets`
 *  encodes and what the responder re-checks here.
 *
 *  RETURNS WHETHER IT HAPPENED. It used to return void and swallow every
 *  failure into a `console.warn`, so a bad MAC, a bind failure or a refused
 *  send all left the caller believing a packet had gone out — and the card then
 *  waited the full three minutes before advising a BIOS change for a packet
 *  that never existed. */
async function sendWakePacket(mac: string, broadcast: string | null): Promise<boolean> {
    try {
        const { isTauri } = await import('../platform');
        if (!isTauri()) return false;
        const { invoke } = await import('@tauri-apps/api/core');
        const sent = await invoke<number>('wol_send', { mac, broadcast });
        // Deliberately not surfaced as success: this counts datagrams the OS
        // accepted, which it essentially always does. Only the target coming
        // back proves anything. Zero, though, means nothing left the machine.
        console.info(`[devices] wake packet sent (${sent} datagrams)`);
        return typeof sent === 'number' ? sent > 0 : true;
    } catch (e) {
        console.warn('[devices] could not send the wake packet:', e);
        return false;
    }
}

/**
 * Per-MAC cooldown for the responder.
 *
 * This exists for the USER's benefit, not as a security control, and the
 * distinction matters: the key is a MAC chosen by whoever sent the frame, so
 * anything hostile simply varies it. What it does buy is that a duplicated or
 * retried relay does not put the same packet on the wire twice in a second —
 * and a wake that has not worked in five seconds will not work by being
 * repeated faster. The actual bound on this path is the server's per-connection
 * wake bucket.
 *
 * Per-MAC rather than global so waking several machines in a row still works.
 */
const RESPONDER_COOLDOWN_MS = 5_000;
/** Bounded: the key is caller-supplied, so an unbounded map is a slow leak.
 *  Far more than anyone's device count; oldest entries are evicted first. */
const MAX_TRACKED_MACS = 64;
const lastSentAt = new Map<string, number>();

function coolingDown(mac: string): boolean {
    const now = Date.now();
    const previous = lastSentAt.get(mac);
    if (previous !== undefined && now - previous < RESPONDER_COOLDOWN_MS) return true;
    // Re-insert to move this key to the end of the Map's insertion order, so
    // the eviction below drops the least recently used.
    lastSentAt.delete(mac);
    lastSentAt.set(mac, now);
    while (lastSentAt.size > MAX_TRACKED_MACS) {
        const oldest = lastSentAt.keys().next();
        if (oldest.done) break;
        lastSentAt.delete(oldest.value);
    }
    return false;
}

/** Handle a request for THIS device to broadcast. Desktop only. */
export function installWakeResponder(): void {
    wsClient.on('DeviceWakeRequested', (msg: { payload?: { mac?: string; broadcast?: string } }) => {
        void (async () => {
            const mac = msg?.payload?.mac;
            if (!mac) return;
            if (coolingDown(mac)) return;
            await sendWakePacket(mac, msg?.payload?.broadcast ?? null);
        })();
    });
}
