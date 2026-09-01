/**
 * Peer-to-peer file transfer — negotiation and lifecycle.
 *
 * Ties three things together: the WS control plane (offer/accept/signal), a
 * dedicated RTCPeerConnection carrying ONE data channel, and the byte engine in
 * `fileTransfer.ts`. See docs/P2P_FILE_TRANSFER_PLAN.md.
 *
 * The peer connection is deliberately its own, not the call's: a transfer must
 * work between two people who are not in a call together (the whole point is
 * DMs), it must not disturb media negotiation, and closing it must never touch
 * a live call. Media signalling is gated on sharing a voice room; transfers
 * ride their own FileSignal messages, authorized by DM eligibility.
 */
import { wsClient, type ServerMessage } from './websocket';
import { loadSettings } from '../components/settingsStore';
import { fetchIceConfig, withRelayOnlyIfRequested } from './iceConfig';
import { lastSinkChoice, type PreparedSink } from './transferSinks';
import { capacitorSinkDiag } from './capacitorSink';
import {
    sendFile,
    sha256OfBlob,
    transferSendDiag,
    TransferReceiver,
    TransferError,
    type ByteSink,
    type TransferProgress,
} from './fileTransfer';
import {
    getActiveIdentity,
    canonicalJson,
    deriveFileOfferAuthKey,
    authenticateFileOffer,
    verifyFileOffer,
} from './e2ee';
import { resolvePinnedIdentityKey } from './keyVerification';
import { getToken, decodeJwtPayload } from './auth';

/** Signed-in user id from the JWT, or null. Used only to bind the offer MAC to
 *  its direction; the peer derives the same record from its own view. */
function myUserId(): number | null {
    const tok = getToken();
    if (!tok) return null;
    const p = decodeJwtPayload(tok);
    return typeof p?.sub === 'number' ? p.sub : null;
}

/**
 * The bytes both peers MAC to authenticate a transfer offer. Built identically
 * on each side (canonical, so field order can't matter) from the fields the
 * receiver would otherwise trust from the server verbatim. `from`/`to` are the
 * numeric user ids (sender→receiver), binding the offer to this direction and
 * pair on top of the pair-specific MAC key.
 */
function fileOfferRecord(fields: {
    id: string; from: number; to: number;
    name: string; size: number; mime: string; sha256: string;
}): string {
    return canonicalJson(fields);
}

export type TransferState =
    | 'preparing'    // sender only: reading + digesting the file; NO offer has
                     // been sent yet, so the server and the peer know nothing
    | 'offered'      // sent or received an offer; nobody has committed yet
    | 'connecting'   // accepted; negotiating the peer connection
    | 'transferring'
    | 'complete'
    | 'failed'
    | 'cancelled';

export interface TransferView {
    id: string;
    direction: 'send' | 'receive';
    peerId: number;
    peerName: string;
    name: string;
    size: number;
    mime: string;
    /** Digest of the whole file, from the offer. The desktop sink keys its
     *  partial file on this so a resume finds the right bytes. */
    sha256: string;
    state: TransferState;
    bytes: number;
    /** Set when state is 'failed' — safe to show to the user. */
    error?: string;
    /** True once we know the media path is a TURN relay (see §4 of the plan). */
    relayed?: boolean;
    /** Throughput ceiling in bytes/sec, or null for unlimited. Settable from
     *  EITHER end: the sender paces itself, the receiver asks the sender to. */
    rateLimit?: number | null;
    /** SENDER, state 'offered': the server is HOLDING the offer because the
     *  target has no live socket right now (a backgrounded phone looks
     *  exactly like offline). Server-worded, safe to show; cleared when the
     *  offer is actually delivered and accepted. */
    parkedReason?: string;
}

/**
 * Transfers above this size are refused over a TURN relay rather than run
 * through the host's home connection twice. Direct transfers are uncapped.
 */
export const RELAY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * How often the large-transfer refusal re-polls while ICE settles. Only paid
 * on transfers already over the relay cap whose first reading says relay — a
 * direct verdict is accepted immediately.
 */
const ICE_SETTLE_POLL_MS = 250;

/** Settle budget scaled to what is at stake. The relay pair completes first
 *  by construction (a TURN Allocate is deterministic; hole punching needs
 *  extra round trips — often more than 3 s with mDNS resolution or a VPN in
 *  the path), so the window must grow with the transfer: waiting 20 s before
 *  refusing a 1.2 GB send is free next to the send itself, while a
 *  barely-over-cap send still waits only ~3 s. */
function iceSettleBudgetMs(bytes: number): number {
    return Math.min(20_000, Math.max(3_000, Math.round(bytes / RELAY_MAX_BYTES) * 2_000));
}

/**
 * The relay ceiling actually in force, which the user can raise.
 *
 * The default exists because a RELAYED transfer is not peer-to-peer at all: it
 * goes up to your TURN server and back down, so an 800 MB file costs ~1.6 GB on
 * the host's home connection. That is worth defending by default and worth
 * being able to override knowingly — refusing outright just looks broken when
 * someone deliberately wants to send something large.
 *
 * A DIRECT transfer ignores this entirely and is uncapped.
 */
export function relayMaxBytes(): number {
    const mb = loadSettings().relayTransferMaxMB;
    if (typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0) return RELAY_MAX_BYTES;
    return Math.round(mb) * 1024 * 1024;
}

/**
 * Master switch for peer-to-peer transfers, OFF until the path has actually
 * moved a file between two machines.
 *
 * The control plane, engine, disk sink and UI are all implemented and
 * unit-tested, but no byte has ever crossed a real data channel between two
 * peers. Shipping the surface in a release that also carries a pile of
 * unrelated voice and upload fixes would mean an untested subsystem is the
 * first thing to blame if anything looks odd. The server-side handlers ship
 * regardless — they are inert unless a client sends FileOffer — so flipping
 * this to true is a client-only change once the loopback harness passes.
 */
export function p2pTransfersEnabled(): boolean {
    return loadSettings().experimentalP2PTransfers === true;
}

type Listener = (transfers: TransferView[]) => void;

interface Transfer extends TransferView {
    pc?: RTCPeerConnection;
    channel?: RTCDataChannel;
    file?: Blob;                  // sender side
    sink?: ByteSink;              // receiver side
    receiver?: TransferReceiver;
    abort: { aborted: boolean };
    /** Where the bytes are going, for the "Saved to ..." line. */
    destination?: () => string;
    /** Kept so completion can consult the sink's at-rest digest. */
    prepared?: PreparedSink;
    /** True when this attempt appended to an earlier partial file. */
    resumed?: boolean;
    /** Serializes chunk handling — see channel.onmessage. */
    writeChain?: Promise<void>;
    /** ICE candidates that arrived before the remote description was set. */
    pendingCandidates: RTCIceCandidateInit[];
    /** Sender side: resolves when the receiver reports the file complete. */
    ackResolve?: () => void;
}

/**
 * How long the sender waits for the receiver's "got it" before closing anyway.
 * Only a backstop: the receiver sends it as soon as the digest verifies, so
 * this expires only if the peer went away, in which case closing is right.
 */
const ACK_TIMEOUT_MS = 30_000;
/** Control frame the receiver sends back. A string, so it can never be
 *  confused with a chunk (chunks are always ArrayBuffers). */
const DONE_MARKER = 'sovereign-transfer-complete';
/** Receiver -> sender: "please send no faster than this". Prefix + bytes/sec,
 *  or the empty string for unlimited. A string, like DONE_MARKER, so it can
 *  never collide with a chunk. */
const RATE_PREFIX = 'sovereign-transfer-rate:';
/**
 * Gap between closing the data channel and dropping the peer connection.
 * Long enough for the SCTP stream reset to reach the peer, so it sees a clean
 * close rather than an abort. Short enough not to leak a connection.
 */
const CLOSE_GRACE_MS = 1500;

/**
 * Turn a data-channel error event into something diagnosable.
 *
 * `channel.onerror` receives an RTCErrorEvent carrying `errorDetail` (e.g.
 * "sctp-failure", "dtls-failure"), an `sctpCauseCode` and a message. The old
 * handler ignored all of it and reported the bare string "the data channel
 * failed", which told a user nothing and told us nothing either — the first
 * real two-machine failure could not be diagnosed from the report at all.
 */
function describeChannelError(ev: Event): string {
    const err = (ev as RTCErrorEvent).error;
    if (!err) return 'the data channel failed';
    const bits = [err.errorDetail, err.message].filter(Boolean);
    if (err.sctpCauseCode != null) bits.push(`sctp cause ${err.sctpCauseCode}`);
    console.error('[p2p] data channel error:', err.errorDetail, err.sctpCauseCode, err.message);
    return bits.length ? `the data channel failed (${bits.join(': ')})` : 'the data channel failed';
}

/** Random, URL-safe, and within the server's 8..64 [A-Za-z0-9-] rule. */
function newTransferId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

class FileTransferManager {
    private transfers = new Map<string, Transfer>();
    private listeners = new Set<Listener>();
    /** Supplies somewhere to put received bytes; set by the platform layer. */
    private sinkFactory: ((t: TransferView) => Promise<PreparedSink | null>) | null = null;
    private wired = false;

    /** Called once at startup by the platform layer (desktop file, browser
     *  download, …). Returning null from the factory declines the transfer. */
    setSinkFactory(factory: (t: TransferView) => Promise<PreparedSink | null>): void {
        this.sinkFactory = factory;
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        fn(this.list());
        return () => this.listeners.delete(fn);
    }

    list(): TransferView[] {
        return [...this.transfers.values()].map(t => ({
            id: t.id, direction: t.direction, peerId: t.peerId, peerName: t.peerName,
            name: t.name, size: t.size, mime: t.mime, sha256: t.sha256,
            state: t.state, bytes: t.bytes, error: t.error, relayed: t.relayed,
            rateLimit: t.rateLimit, parkedReason: t.parkedReason,
        }));
    }

    private emit(): void {
        const snapshot = this.list();
        for (const fn of this.listeners) fn(snapshot);
    }

    /** Byte-counter emits, COALESCED to 10 Hz (trailing edge, so the last
     *  tick always lands). Progress arrives once per 16 KiB chunk — 256/s at
     *  4 MB/s — and every emit() rebuilds the whole list and re-renders every
     *  subscribed card; the throughput audit measured that fan-out as a real
     *  component of the per-chunk cost on BOTH main threads, and the design
     *  doc had specified ~1/s all along. The speed gauge is unaffected: it
     *  discards samples closer than 250 ms anyway. State CHANGES still use
     *  emit() directly — a click must never wait 100 ms to be acknowledged. */
    private emitTimer: ReturnType<typeof setTimeout> | null = null;
    private emitProgress(): void {
        if (this.emitTimer !== null) return;
        this.emitTimer = setTimeout(() => {
            this.emitTimer = null;
            this.emit();
        }, 100);
    }

    /**
     * Cap this transfer's throughput. `null` removes the cap.
     *
     * Only the SENDER can pace — it owns the send loop. So on a send this sets
     * the limit directly; on a receive it asks the sender over the data
     * channel, because the receiver is the one whose connection is being
     * filled and is therefore the one who wants to say "not so fast".
     */
    setRateLimit(id: string, bytesPerSecond: number | null): void {
        const t = this.transfers.get(id);
        if (!t) return;
        t.rateLimit = bytesPerSecond;
        if (t.direction === 'receive' && t.channel?.readyState === 'open') {
            try {
                t.channel.send(RATE_PREFIX + (bytesPerSecond ?? ''));
            } catch { /* peer gone; the cap is moot */ }
        }
        this.emit();
    }

    /** Idempotent: safe to call on every mount. */
    wire(): void {
        if (this.wired) return;
        this.wired = true;
        wsClient.on('FileOffered', m => this.onOffered(m));
        wsClient.on('FileAccepted', m => void this.onAccepted(m));
        wsClient.on('FileRejected', m => this.onEnded(m, 'failed', 'declined'));
        wsClient.on('FileCancelled', m => this.onEnded(m, 'cancelled'));
        wsClient.on('FileSignal', m => void this.onSignal(m));
        // NOT a cancellation: the server is holding the offer for a target
        // whose socket is down (backgrounded phone). The transfer stays live
        // in 'offered'; the card just says what is really happening. An
        // accept can still follow when they reconnect.
        wsClient.on('FileParked', (m: { payload?: { transfer_id?: string; reason?: string } }) => {
            const t = m.payload?.transfer_id ? this.transfers.get(m.payload.transfer_id) : undefined;
            if (!t || t.direction !== 'send' || t.state !== 'offered') return;
            t.parkedReason = m.payload?.reason || 'their app is not connected right now — the offer is waiting for them';
            this.emit();
        });
        // Diagnostics accessor, mirroring __pucaVoiceDiag(): run
        // __pucaTransferDiag() in DevTools DURING a transfer, on the end
        // whose speed is in question. sendDiag's bufferedSamples are the
        // sender-vs-receiver discriminator (pinned near highWater = the
        // receiver is the slow side); the sink numbers split encode from
        // bridge on the phone.
        if (typeof window !== 'undefined') {
            (window as unknown as Record<string, unknown>).__pucaTransferDiag = () => ({
                sink: lastSinkChoice,
                send: transferSendDiag(),
                capacitorSink: capacitorSinkDiag(),
                transfers: this.list(),
            });
        }
    }

    // --- Sending ---------------------------------------------------------

    /**
     * Offer a file. The digest is computed by streaming the file, so offering a
     * 4 GB file costs one sequential read rather than 4 GB of memory — but it
     * IS a full read, and the server refuses an offer without a real digest,
     * so the offer cannot reach the peer until the read finishes. The card
     * spends that window in 'preparing' with the byte counter tracking the
     * hash pass; it used to sit in 'offered' claiming to wait on the peer,
     * which blamed the receiver for time spent entirely on this machine.
     */
    async offerFile(peerId: number, peerName: string, file: File): Promise<string> {
        const id = newTransferId();
        const t: Transfer = {
            id, direction: 'send', peerId, peerName,
            name: file.name, size: file.size, mime: file.type || 'application/octet-stream',
            state: 'preparing', bytes: 0, sha256: '', file,
            abort: { aborted: false }, pendingCandidates: [],
        };
        this.transfers.set(id, t);
        this.emit();

        try {
            t.sha256 = await sha256OfBlob(
                file,
                read => { t.bytes = read; this.emitProgress(); },
                t.abort,
            );
        } catch (err) {
            if ((err as TransferError).code === 'cancelled') return id; // cancel() already reported
            // NOT this.fail(): that frees the server-side slot, and no slot
            // exists yet — the server learning a transfer id from FileComplete
            // answers "Unknown transfer", which alerts and wipes optimistic DM
            // bubbles (see dismiss). Nothing to tear down either: no pc, no
            // channel, no sink.
            t.state = 'failed';
            t.error = (err as Error).message;
            this.emit();
            return id;
        }
        if (t.abort.aborted) return id;      // cancelled while hashing

        // The counter now belongs to the transfer itself; hand it back before
        // anyone reads it as "bytes already sent".
        t.bytes = 0;

        // Authenticate the offer to the peer's PINNED identity key so a
        // malicious server can't substitute the hash (and MITM the "P2P"
        // transfer while the receiver's own hash check still passes against the
        // hash the MITM supplied). Fail CLOSED: if we can't resolve our own
        // identity or the peer's pinned key, we do not send an unauthenticated
        // offer — the receiver requires the MAC, so an unauthenticated one is
        // useless anyway.
        const identity = getActiveIdentity();
        const myId = myUserId();
        const peerPub = identity ? await resolvePinnedIdentityKey(peerId) : null;
        const authKey = identity && peerPub ? deriveFileOfferAuthKey(identity, peerPub) : null;
        if (!authKey || myId == null) {
            t.state = 'failed';
            t.error = "can't send securely — this person's encryption key is unavailable or unverified";
            this.emit();
            return id;
        }
        const auth = authenticateFileOffer(
            authKey,
            fileOfferRecord({ id, from: myId, to: peerId, name: t.name, size: t.size, mime: t.mime, sha256: t.sha256 }),
        );

        t.state = 'offered';
        wsClient.send({
            type: 'FileOffer',
            payload: {
                target_user: peerId, transfer_id: id,
                name: t.name, size: t.size, mime: t.mime, sha256: t.sha256,
                auth,
            },
        });
        this.emit();
        return id;
    }

    /** Recipient accepted: build the connection and start pushing bytes. */
    private async onAccepted(msg: ServerMessage): Promise<void> {
        const p = msg.payload as { transfer_id: string; resume_from: number };
        const t = this.transfers.get(p.transfer_id);
        if (!t || t.direction !== 'send' || !t.file) return;
        // Single-shot. A replayed FileAccept used to build a fresh
        // RTCPeerConnection and data channel each time, orphaning the previous
        // pair (ICE gathering, sockets, TURN allocations) and re-reading the
        // file from disk. The server refuses a second accept too; this is the
        // half that protects a client talking to a modified server.
        if (t.state !== 'offered') return;

        t.state = 'connecting';
        // The accept proves the offer reached them — the parked note is done.
        t.parkedReason = undefined;
        this.emit();

        const pc = await this.newConnection(t);
        // The SENDER creates the channel; the receiver picks it up via
        // ondatachannel. Only one side may create it or both would race.
        const channel = pc.createDataChannel('file', { ordered: true });
        channel.binaryType = 'arraybuffer';
        t.channel = channel;

        channel.onopen = () => {
            console.info(`[p2p ${t.id.slice(0, 8)}] send channel open`);
            void this.startSending(t, p.resume_from ?? 0);
        };
        channel.onclose = () => console.info(
            `[p2p ${t.id.slice(0, 8)}] send channel closed at ${t.bytes}/${t.size} state=${t.state}`);
        channel.onerror = ev => this.fail(t, describeChannelError(ev));
        // The receiver's completion ack. Chunks only ever travel one way, so a
        // string arriving here can only be that.
        channel.onmessage = ev => {
            if (typeof ev.data !== 'string') return;
            if (ev.data === DONE_MARKER) { t.ackResolve?.(); return; }
            if (ev.data.startsWith(RATE_PREFIX)) {
                // The receiver is the one whose connection is being filled, so
                // it gets to ask. Only the SENDER can actually pace, hence the
                // round trip.
                const raw = ev.data.slice(RATE_PREFIX.length);
                t.rateLimit = raw ? Number(raw) : null;
                if (!Number.isFinite(t.rateLimit as number)) t.rateLimit = null;
                this.emit();
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal(t, { kind: 'offer', sdp: offer.sdp });
    }

    private async startSending(t: Transfer, resumeFrom: number): Promise<void> {
        if (!t.channel || !t.file) return;
        // Refuse to push a large transfer through the TURN relay — that is the
        // host's home connection carrying every byte in and back out. Size
        // gates first so small transfers never pay the settle wait.
        //
        // REMAINING bytes, not the file's total: a resume (the desktop sink
        // keeps .part files keyed by digest) may owe only a sliver of a huge
        // file, and judging THAT by the total both refuses a cheap finish and
        // lies about the cost in the message — a 1.2 GB resend with 60 MB
        // left was refused as "this 1229 MB file".
        const remaining = Math.max(0, t.size - (resumeFrom || 0));
        const relayCap = relayMaxBytes();
        if (remaining > relayCap) {
            const relayed = await this.settledRelayCheck(t, iceSettleBudgetMs(remaining));
            // The settle poll can await tens of seconds now; the transfer can
            // be cancelled (either end) or fail in that window. Acting on the
            // stale answer would double-cancel or pump chunks into a torn-down
            // channel.
            if (t.abort.aborted || t.state === 'cancelled' || t.state === 'failed') return;
            if (relayed) {
                const mb = Math.round(remaining / (1024 * 1024));
                const capMb = Math.round(relayCap / (1024 * 1024));
                // coturn caps a relay allocation at ~1.25 MB/s — say what
                // overriding actually costs instead of a bare "raise it".
                const mins = Math.max(1, Math.round(mb / (1.25 * 60)));
                this.cancel(t.id,
                    `No direct connection, so the ${mb} MB still to send would go through `
                    + `the TURN relay — over the ${capMb} MB relay limit. Relayed, it would `
                    + `take roughly ${mins} min and carry every byte through the server. `
                    + `Raise the limit in Settings → Experimental, or try again on a `
                    + `network that allows a direct link.`);
                return;
            }
        } else {
            // Small transfers skip the refusal entirely, but the "· relayed"
            // indicator should still be honest — best-effort, off the send path.
            void this.isRelayed(t).then(() => this.emit()).catch(() => { /* indicator only */ });
        }
        t.state = 'transferring';
        this.emit();
        try {
            await sendFile(t.channel, t.file, {
                resumeFrom,
                signal: t.abort,
                // Read per chunk, so dragging the limiter takes effect at once.
                rateLimit: () => t.rateLimit ?? null,
                onProgress: (pr: TransferProgress) => { t.bytes = pr.bytes; this.emitProgress(); },
            });
            // DO NOT tear down yet. `sendFile` resolves when the last chunk has
            // been HANDED to the data channel, not when it has been delivered —
            // the tail can still be sitting in `bufferedAmount`. The `finally`
            // below calls pc.close(), which drops the DTLS/SCTP transport
            // immediately and discards anything in flight, so the receiver saw
            // the association abort and reported "the data channel failed" on a
            // transfer whose bytes had all been sent.
            //
            // This never appeared in the loopback harness because both peers
            // live in one process there: the buffer had always drained by this
            // point. Real latency is what exposes it.
            await this.awaitDelivery(t);
            t.state = 'complete';
            this.releaseOnServer(t.id);
            this.emit();
        } catch (err) {
            if ((err as TransferError).code === 'cancelled') return; // already reported
            this.fail(t, (err as Error).message);
        } finally {
            this.teardown(t, false);
        }
    }

    /**
     * Wait until the bytes are genuinely across before closing the connection.
     *
     * Two stages, because neither alone is enough:
     *  1. `bufferedAmount` reaching 0 means the local queue is empty — but SCTP
     *     may still have unacknowledged data on the wire.
     *  2. The receiver's ack means it assembled the whole file AND the digest
     *     verified, which is the only thing that actually proves delivery.
     *
     * Bounded, so a peer that vanishes mid-transfer cannot wedge the sender:
     * on timeout we close anyway, which is the same behaviour as before.
     */
    private async awaitDelivery(t: Transfer): Promise<void> {
        const channel = t.channel;
        if (!channel) return;

        const acked = new Promise<void>(resolve => { t.ackResolve = resolve; });
        const deadline = new Promise<void>(resolve => setTimeout(resolve, ACK_TIMEOUT_MS));

        // Drain the local queue first. `bufferedamountlow` fires as it empties;
        // poll as a fallback for the case where it is already below threshold.
        if (channel.bufferedAmount > 0) {
            channel.bufferedAmountLowThreshold = 0;
            await Promise.race([
                new Promise<void>(resolve => {
                    const done = () => {
                        if (channel.bufferedAmount === 0) resolve();
                    };
                    channel.onbufferedamountlow = done;
                    const poll = setInterval(() => {
                        if (channel.bufferedAmount === 0 || channel.readyState !== 'open') {
                            clearInterval(poll);
                            resolve();
                        }
                    }, 100);
                }),
                deadline,
            ]);
        }
        await Promise.race([acked, deadline]);
        t.ackResolve = undefined;
    }

    // --- Receiving -------------------------------------------------------

    private async onOffered(msg: ServerMessage): Promise<void> {
        const p = msg.payload as {
            from_user: number; from_username: string; transfer_id: string;
            name: string; size: number; mime: string; sha256: string;
            auth?: string;
        };

        // Authenticate the offer against the SENDER's pinned identity key before
        // it is ever shown or accepted. Without this the server relaying the
        // offer could substitute the hash (and MITM the DTLS) and the receiver's
        // own hash check would still pass — against the hash the MITM chose.
        // Fail CLOSED: a missing MAC, an unavailable/unverified sender key, or a
        // MAC that doesn't verify all mean we cannot trust the offer, so we
        // surface a failed transfer rather than a tamperable one. This is safe
        // to require unconditionally: P2P transfers are experimental and no byte
        // has ever crossed a real channel, so there are no unauthenticated
        // senders to be compatible with.
        const identity = getActiveIdentity();
        const myId = myUserId();
        const senderPub = identity ? await resolvePinnedIdentityKey(p.from_user) : null;
        const authKey = identity && senderPub ? deriveFileOfferAuthKey(identity, senderPub) : null;
        const record = fileOfferRecord({
            id: p.transfer_id, from: p.from_user, to: myId ?? -1,
            name: p.name, size: p.size, mime: p.mime, sha256: p.sha256,
        });
        const authed = !!authKey && myId != null && !!p.auth && verifyFileOffer(authKey, record, p.auth);
        if (!authed) {
            // Tell the sender we refused (so it stops waiting) — inline rather
            // than via reject(), which DELETES the transfer, because we also
            // want to leave a visible 'failed' entry so the user knows a
            // transfer was attempted and why it was not accepted.
            wsClient.send({ type: 'FileReject', payload: { transfer_id: p.transfer_id, reason: 'offer authentication failed' } });
            this.transfers.set(p.transfer_id, {
                id: p.transfer_id, direction: 'receive',
                peerId: p.from_user, peerName: p.from_username,
                name: p.name, size: p.size, mime: p.mime, sha256: p.sha256,
                state: 'failed', bytes: 0,
                error: `refused: could not verify this transfer really came from ${p.from_username}`,
                abort: { aborted: false }, pendingCandidates: [],
            });
            this.emit();
            return;
        }

        this.transfers.set(p.transfer_id, {
            id: p.transfer_id, direction: 'receive',
            peerId: p.from_user, peerName: p.from_username,
            name: p.name, size: p.size, mime: p.mime, sha256: p.sha256,
            state: 'offered', bytes: 0,
            abort: { aborted: false }, pendingCandidates: [],
        });
        this.emit();
    }

    /** User accepted an incoming offer. */
    async accept(id: string): Promise<void> {
        const t = this.transfers.get(id);
        if (!t || t.direction !== 'receive') return;
        if (!this.sinkFactory) {
            this.reject(id, 'this device cannot receive files');
            return;
        }

        let prepared: PreparedSink | null;
        try {
            prepared = await this.sinkFactory(t);
        } catch (err) {
            // The platform cannot receive this at all (mobile, or a browser
            // without enough room). Tell the sender why rather than stalling.
            this.reject(id, (err as Error).message);
            this.fail(t, (err as Error).message);
            return;
        }
        if (!prepared) {                // user cancelled the save dialog
            this.reject(id, 'declined');
            return;
        }

        t.sink = prepared.sink;
        t.prepared = prepared;
        t.destination = prepared.describeDestination;
        // Resume where a previous attempt stopped. The offset is chunk-aligned
        // by the engine, so a partial chunk is re-sent rather than spliced.
        //
        // A resume is only allowed when the finished file can be verified at
        // rest: this process never saw the earlier bytes, so its running hash
        // covers only part of the file. Without that check a resumed transfer
        // would complete with NO integrity guarantee at all, which is worse
        // than starting again — so a sink that cannot verify starts from zero.
        const resumeFrom = prepared.verifiedDigest ? prepared.resumeFrom : 0;
        t.bytes = resumeFrom;
        t.resumed = resumeFrom > 0;
        t.receiver = new TransferReceiver(prepared.sink, {
            expectedSha256: t.sha256,
            total: t.size,
            resumeFrom,
            onProgress: pr => { t.bytes = pr.bytes; this.emitProgress(); },
        });
        t.state = 'connecting';
        this.emit();
        // Build OUR connection before telling the sender to build theirs: a
        // cold/slow ICE-config fetch here used to lose the race with the
        // sender's offer, and onSignal drops descriptions that arrive before
        // t.pc exists — wedging the transfer in 'connecting' forever.
        await this.newConnection(t);
        wsClient.send({ type: 'FileAccept', payload: { transfer_id: id, resume_from: resumeFrom } });
    }

    reject(id: string, reason = 'declined'): void {
        wsClient.send({ type: 'FileReject', payload: { transfer_id: id, reason } });
        this.transfers.delete(id);
        this.emit();
    }

    cancel(id: string, reason = 'cancelled'): void {
        const t = this.transfers.get(id);
        if (!t) return;
        // Cancelled while still hashing: no offer was ever sent, so the server
        // holds no slot and the peer knows nothing — a FileCancel here would
        // come back as an "Unknown transfer" error (see dismiss). Purely local.
        const unannounced = t.state === 'preparing';
        t.abort.aborted = true;
        t.state = 'cancelled';
        t.error = reason;
        // Send WHY. Without it the peer was told a bare "cancelled" while its
        // own connection was being torn down, so it reported a data-channel
        // error and the actual, actionable cause never reached the person who
        // needed it.
        if (!unannounced) {
            wsClient.send({ type: 'FileCancel', payload: { transfer_id: id, reason } });
        }
        this.teardown(t, true);
        this.emit();
    }

    /**
     * Drop a FINISHED card from the list. Purely local view-state: by the time
     * a card is terminal the server-side registry slot is already gone
     * (FileComplete/FileCancel/FileReject each removed it), so this must send
     * no WS frame — a FileCancel here would come back as "Unknown transfer".
     * The live-state guard also means dismiss can never orphan an open
     * RTCPeerConnection, and must not re-run teardown: for a failed transfer
     * teardown already ran with keep=true to preserve the .part for resume.
     */
    dismiss(id: string): void {
        const t = this.transfers.get(id);
        if (!t) return;
        if (t.state === 'preparing' || t.state === 'offered' || t.state === 'connecting' || t.state === 'transferring') return;
        this.transfers.delete(id);
        this.emit();
    }

    /** Drop every finished card at once. Same rules as {@link dismiss}. */
    clearFinished(): void {
        let dropped = false;
        for (const [id, t] of this.transfers) {
            if (t.state === 'complete' || t.state === 'failed' || t.state === 'cancelled') {
                this.transfers.delete(id);
                dropped = true;
            }
        }
        if (dropped) this.emit();
    }

    // --- Negotiation -----------------------------------------------------

    private async newConnection(t: Transfer): Promise<RTCPeerConnection> {
        const config = await fetchIceConfig();
        // Same relay-only policy as voice: this path handed the peer the
        // user's IP even with "Hide my IP in calls" on.
        const pc = new RTCPeerConnection(withRelayOnlyIfRequested(config));
        t.pc = pc;

        pc.onicecandidate = e => {
            if (e.candidate) this.signal(t, { kind: 'ice', candidate: e.candidate.toJSON() });
        };
        pc.onconnectionstatechange = () => {
            console.info(`[p2p ${t.id.slice(0, 8)}] pc=${pc.connectionState} ice=${pc.iceConnectionState} ` +
                `dir=${t.direction} state=${t.state} bytes=${t.bytes}/${t.size}`);
            if (pc.connectionState === 'failed') this.fail(t, 'could not connect to the peer');
        };
        pc.oniceconnectionstatechange = () => {
            console.info(`[p2p ${t.id.slice(0, 8)}] ice=${pc.iceConnectionState}`);
        };
        // Receiver side: the sender created the channel, we adopt it.
        pc.ondatachannel = e => {
            const channel = e.channel;
            channel.binaryType = 'arraybuffer';
            t.channel = channel;
            t.state = 'transferring';
            console.info(`[p2p ${t.id.slice(0, 8)}] recv channel adopted, expecting ${t.size} bytes`);
            channel.onclose = () => console.info(
                `[p2p ${t.id.slice(0, 8)}] recv channel closed at ${t.bytes}/${t.size} state=${t.state}`);
            this.emit();
            // Chunks MUST be processed strictly in order. `onmessage` fires as
            // fast as the network delivers, while handling a chunk awaits a
            // disk write — so without this chain a second chunk would begin
            // while the first was still being written, read a stale
            // expectedIndex, and fail a perfectly good transfer as
            // 'bad-chunk'. Serialize on a promise chain.
            channel.onmessage = ev => {
                const frame = ev.data as ArrayBuffer;
                t.writeChain = (t.writeChain ?? Promise.resolve())
                    .then(() => this.onChunk(t, frame))
                    // onChunk already reports failures; swallow here so one bad
                    // chunk cannot leave the chain permanently rejected.
                    .catch(() => { /* reported in onChunk */ });
            };
            channel.onerror = ev => this.fail(t, describeChannelError(ev));
        };
        return pc;
    }

    private async onChunk(t: Transfer, frame: ArrayBuffer): Promise<void> {
        if (!t.receiver) return;
        try {
            await t.receiver.accept(frame);
            if (t.receiver.offset >= t.size) {
                // For a fresh transfer this verifies the running hash. For a
                // RESUMED one it cannot (see accept), so the sink hashes the
                // finished file at rest and we check that instead.
                await t.receiver.finish();
                if (t.resumed) {
                    const atRest = t.prepared?.verifiedDigest?.() ?? null;
                    if (atRest !== t.sha256) {
                        throw new TransferError(
                            'the resumed file does not match the hash the sender offered',
                            'hash-mismatch',
                        );
                    }
                }
                t.state = 'complete';
                this.releaseOnServer(t.id);
                this.emit();
                // Tell the sender we have every byte and the digest verified,
                // so it stops waiting and closes in an orderly way. Do NOT tear
                // down here: closing now would drop this ack before it left,
                // and the sender would sit until its timeout. Let the sender
                // close first and follow it down, with a backstop in case it
                // never does.
                try { t.channel?.send(DONE_MARKER); } catch { /* peer already gone */ }
                const ch = t.channel;
                if (ch) {
                    ch.onclose = () => this.teardown(t, false);
                    setTimeout(() => this.teardown(t, false), ACK_TIMEOUT_MS);
                } else {
                    this.teardown(t, false);
                }
            }
        } catch (err) {
            // A hash mismatch or a chunk out of order means what landed is not
            // the file that was offered. Report it rather than presenting a
            // corrupt file as complete.
            this.fail(t, (err as Error).message);
            this.teardown(t, true);
        }
    }

    private async onSignal(msg: ServerMessage): Promise<void> {
        const p = msg.payload as { transfer_id: string; payload: string };
        const t = this.transfers.get(p.transfer_id);
        if (!t) return;
        let body: { kind: string; sdp?: string; candidate?: RTCIceCandidateInit };
        try {
            body = JSON.parse(p.payload);
        } catch {
            return;                             // malformed: ignore, not fatal
        }
        const pc = t.pc;
        if (!pc) return;

        if (body.kind === 'offer' && body.sdp) {
            await pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
            await this.flushCandidates(t);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.signal(t, { kind: 'answer', sdp: answer.sdp });
        } else if (body.kind === 'answer' && body.sdp) {
            await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
            await this.flushCandidates(t);
        } else if (body.kind === 'ice' && body.candidate) {
            // Candidates can arrive before the description they belong to;
            // adding one then throws, so hold them until there is a remote.
            if (pc.remoteDescription) {
                await pc.addIceCandidate(body.candidate).catch(() => { /* stale */ });
            } else {
                t.pendingCandidates.push(body.candidate);
            }
        }
    }

    private async flushCandidates(t: Transfer): Promise<void> {
        const pc = t.pc;
        if (!pc) return;
        const queued = t.pendingCandidates.splice(0);
        for (const c of queued) {
            await pc.addIceCandidate(c).catch(() => { /* stale candidate */ });
        }
    }

    private signal(t: Transfer, body: unknown): void {
        wsClient.send({
            type: 'FileSignal',
            payload: { transfer_id: t.id, payload: JSON.stringify(body) },
        });
    }

    /**
     * Is the chosen path a TURN relay? See plan §4.
     *
     * Judges the SELECTED candidate pair only. Once TURN is configured the
     * relay allocation essentially always completes a connectivity check, so
     * "any succeeded pair touches a relay" was true even when ICE had
     * nominated a direct pair — refusing perfectly direct large transfers.
     * Fails OPEN (treat as direct) when no selected pair can be identified;
     * fails CLOSED only on positive evidence the live path is a relay.
     */
    private async isRelayed(t: Transfer): Promise<boolean> {
        if (!t.pc) return false;
        try {
            const stats = await t.pc.getStats();
            // Chrome/Safari: the transport stat names the live pair.
            let selected: Record<string, unknown> | undefined;
            stats.forEach(report => {
                if (report.type === 'transport' && report.selectedCandidatePairId) {
                    selected = stats.get(report.selectedCandidatePairId);
                }
            });
            // Firefox (no transport stat): the nominated/selected succeeded pair.
            if (!selected) {
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded'
                        && (report.nominated === true || report.selected === true)) {
                        selected = report;
                    }
                });
            }
            if (!selected) return false; // can't identify the path: don't block
            const local = stats.get(selected.localCandidateId as string);
            const remote = stats.get(selected.remoteCandidateId as string);
            const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
            t.relayed = relayed;
            return relayed;
        } catch {
            return false;   // unknown: treat as direct rather than blocking a transfer
        }
    }

    /**
     * Relay check for the large-transfer refusal, with time for ICE to settle.
     *
     * The data channel opens on whatever pair is current, and the relay pair
     * often completes first (a TURN allocation is deterministic; hole punching
     * needs extra round trips) — so a one-shot check at `onopen` sees relay
     * even when a direct pair is nominated moments later. Re-check briefly
     * before refusing; accept the first direct reading immediately.
     */
    private async settledRelayCheck(t: Transfer, budgetMs: number): Promise<boolean> {
        const start = Date.now();
        const deadline = start + budgetMs;
        for (;;) {
            const relayed = await this.isRelayed(t);
            if (!relayed) return false;
            if (t.abort.aborted) return relayed;
            // 'completed' means checking finished — but Chrome reaches it
            // FASTEST precisely when the peer's mDNS candidates never resolved
            // into pairs at all (VPN, multicast-filtered Wi-Fi), which is the
            // case that most needs the polling. Trust it only after ICE has
            // had a real moment to try the direct pairs.
            if (t.pc?.iceConnectionState === 'completed' && Date.now() - start >= 1_500) return relayed;
            if (Date.now() >= deadline) return relayed;
            await new Promise(r => setTimeout(r, ICE_SETTLE_POLL_MS));
        }
    }

    private fail(t: Transfer, error: string): void {
        if (t.state === 'complete' || t.state === 'cancelled') return;
        t.state = 'failed';
        t.error = error;
        // Tear down, or a connection failure leaves the desktop sink's file
        // handle open and its .part on disk for the life of the app. `true`
        // keeps the partial so a later attempt can resume from it.
        this.teardown(t, true);
        this.releaseOnServer(t.id);
        this.emit();
    }

    /** Free the server-side registry slot; it counts against the sender cap. */
    private releaseOnServer(id: string): void {
        wsClient.send({ type: 'FileComplete', payload: { transfer_id: id } });
    }

    private onEnded(msg: ServerMessage, state: TransferState, error?: string): void {
        const p = msg.payload as { transfer_id: string; reason?: string };
        const t = this.transfers.get(p.transfer_id);
        if (!t) return;
        // A late cancel must not downgrade a transfer that already completed.
        if (t.state === 'complete') return;
        t.abort.aborted = true;
        t.state = state;
        t.error = error ?? p.reason;
        this.teardown(t, true);
        this.emit();
        // Drop it after a moment so the card can show WHY it ended, without an
        // offer/cancel loop growing this map (and the card list) without bound.
        setTimeout(() => {
            const cur = this.transfers.get(p.transfer_id);
            if (cur && cur.state !== 'transferring') {
                this.transfers.delete(p.transfer_id);
                this.emit();
            }
        }, 15000);
    }

    /** Close the connection; `discard` also drops a partial file. */
    private teardown(t: Transfer, discard: boolean): void {
        // Close the CHANNEL, then let the SCTP stream reset actually happen
        // before dropping the transport. `channel.close()` is graceful, but
        // `pc.close()` on the next line aborts the association outright — the
        // peer then sees "sctp-failure 12 User-Initiated Abort" instead of a
        // clean close, and any receiver not yet finished draining its write
        // chain reports a perfectly good transfer as failed.
        const channel = t.channel;
        const pc = t.pc;
        try { channel?.close(); } catch { /* already closed */ }
        if (pc) {
            setTimeout(() => {
                try { pc.close(); } catch { /* already closed */ }
            }, CLOSE_GRACE_MS);
        }
        t.channel = undefined;
        t.pc = undefined;
        if (discard && t.prepared) {
            // NOT sink.close(): on desktop that promotes the partial file to
            // its real name, which would present a truncated file as complete.
            // Keep the partial only when a resume could still use it — i.e. the
            // transfer failed rather than being deliberately abandoned.
            const keep = t.state === 'failed';
            void t.prepared.abort?.(keep).catch(() => { /* best effort */ });
            // Frames already queued on the writeChain when the cancel landed
            // keep running after this returns — dropping the receiver makes
            // every one of them a no-op (onChunk bails without it), so a
            // cancelled transfer can never finish() behind our back and
            // promote a partial file the abort above just discarded.
            t.receiver = undefined;
        }
    }
}

export const fileTransferManager = new FileTransferManager();
