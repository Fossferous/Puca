import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Negotiation logic for peer-to-peer transfers. The byte pump is covered in
 * fileTransfer.test.ts; what is exercised here is everything AROUND it that a
 * typecheck cannot see: candidate ordering, the relay policy, and whether a
 * refusal actually refuses.
 */

const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
const handlers = new Map<string, (m: { type: string; payload: unknown }) => void>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        send: (m: { type: string; payload: Record<string, unknown> }) => { sent.push(m); },
        on: (type: string, cb: (m: { type: string; payload: unknown }) => void) => { handlers.set(type, cb); },
        off: () => { /* not exercised */ },
    },
}));

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: async () => ({ iceServers: [], iceTransportPolicy: 'all' }),
}));

// Offers are now authenticated to the peer's pinned identity key (H-2). These
// tests exercise NEGOTIATION, not the MAC crypto (that lives in
// fileOfferAuth.test.ts), so give the sender an identity and a pinned peer key
// and let the MAC succeed. Real functions stay via importOriginal so anything
// else the module pulls from e2ee is untouched.
vi.mock('../api/e2ee', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api/e2ee')>();
    return {
        ...actual,
        getActiveIdentity: () => ({
            privateKey: new Uint8Array(32),
            publicKey: new Uint8Array(32),
            publicKeyEncoded: 'x25519:AAAA',
        }),
        deriveFileOfferAuthKey: () => new Uint8Array(32).fill(1),
        authenticateFileOffer: () => 'TESTMAC',
        verifyFileOffer: () => true,
    };
});
vi.mock('../api/keyVerification', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api/keyVerification')>();
    return { ...actual, resolvePinnedIdentityKey: async () => 'x25519:BBBB' };
});
vi.mock('../api/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api/auth')>();
    return { ...actual, getToken: () => 'tok', decodeJwtPayload: () => ({ sub: 99 }) };
});

/** The fingerprint every fake certificate reports, and the one a remote SDP
 *  must carry to be accepted. */
const FAKE_HEX = 'AB:'.repeat(31) + 'AB';
export const PEER_FP = `sha-256 ${FAKE_HEX}`;
/** A minimal data-channel SDP presenting `fp`. */
const fakeSdp = (fp: string) => ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', `a=fingerprint:${fp}`].join('\r\n');

/** Records what the code asked of a peer connection, and lets a test drive it. */
class FakePeerConnection {
    static last: FakePeerConnection | null = null;
    /** The last certificate handed out, so a test can assert the connection
     *  pinned THAT object and not merely "one certificate". */
    static lastCert: unknown = null;
    static async generateCertificate() {
        const cert = { getFingerprints: () => [{ algorithm: 'sha-256', value: FAKE_HEX }] };
        FakePeerConnection.lastCert = cert;
        return cert;
    }
    /** The configuration the manager built: the certificate must be pinned. */
    config: RTCConfiguration | undefined;
    remoteDescription: unknown = null;
    connectionState = 'new';
    addedCandidates: RTCIceCandidateInit[] = [];
    createdChannels: string[] = [];
    closed = false;
    onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
    ondatachannel: ((e: { channel: unknown }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    /** What getStats reports — drives the relay policy. */
    statsCandidateType: 'host' | 'relay' = 'host';
    /**
     * When set, getStats ALSO reports a spare succeeded relay pair that is NOT
     * selected — the exact stats shape (TURN allocation completed, direct pair
     * nominated) that used to make the policy refuse direct transfers.
     */
    statsExtraRelayPair = false;
    /** ICE settled: the refusal path trusts the reading without polling. */
    iceConnectionState = 'completed';

    constructor(config?: RTCConfiguration) { this.config = config; FakePeerConnection.last = this; }

    /** The channel the manager created, so tests can fire its events. */
    lastChannel: ReturnType<FakePeerConnection['createDataChannel']> | null = null;

    createDataChannel(label: string) {
        this.createdChannels.push(label);
        const ch = {
            label, binaryType: 'arraybuffer', readyState: 'open',
            bufferedAmount: 0, bufferedAmountLowThreshold: 0,
            send: vi.fn(), close: vi.fn(),
            addEventListener: vi.fn(), removeEventListener: vi.fn(),
            onopen: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onmessage: null as ((e: MessageEvent) => void) | null,
        };
        this.lastChannel = ch;
        return ch;
    }
    async createOffer() { return { type: 'offer', sdp: fakeSdp(PEER_FP) }; }
    async createAnswer() { return { type: 'answer', sdp: fakeSdp(PEER_FP) }; }
    async setLocalDescription() { /* no-op */ }
    async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
    async addIceCandidate(c: RTCIceCandidateInit) {
        // A real implementation THROWS when there is no remote description —
        // which is exactly why the manager has to queue.
        if (!this.remoteDescription) throw new Error('no remote description');
        this.addedCandidates.push(c);
    }
    async getStats() {
        const pair = {
            type: 'candidate-pair', state: 'succeeded', nominated: true,
            localCandidateId: 'L', remoteCandidateId: 'R',
        };
        const local = { type: 'local-candidate', candidateType: this.statsCandidateType };
        const transport = { type: 'transport', selectedCandidatePairId: 'P' };
        const map = new Map<string, unknown>([
            ['P', pair], ['L', local], ['R', { candidateType: 'host' }], ['T', transport],
        ]);
        if (this.statsExtraRelayPair) {
            // Succeeded but NOT selected/nominated — must be ignored.
            map.set('P2', {
                type: 'candidate-pair', state: 'succeeded', nominated: false,
                localCandidateId: 'L2', remoteCandidateId: 'R2',
            });
            map.set('L2', { type: 'local-candidate', candidateType: 'relay' });
            map.set('R2', { candidateType: 'relay' });
        }
        return {
            forEach: (fn: (v: unknown) => void) => map.forEach(fn),
            get: (id: string) => map.get(id),
        };
    }
    close() { this.closed = true; }
}

vi.stubGlobal('RTCPeerConnection', FakePeerConnection);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blobShim = (Blob.prototype as any);
if (typeof blobShim.arrayBuffer !== 'function') {
    blobShim.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as ArrayBuffer);
            fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(this);
        });
    };
}

import { fileTransferManager, RELAY_MAX_BYTES } from '../api/fileTransferManager';
import { HASH_READ_SIZE } from '../api/fileTransfer';

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    sent.length = 0;
    fileTransferManager.forgetSeenOffers();
    FakePeerConnection.last = null;
    fileTransferManager.wire();
});

describe('offering a file', () => {
    it('sends an offer carrying the real digest and size', async () => {
        const file = new File([new Uint8Array([1, 2, 3, 4])], 'notes.txt', { type: 'text/plain' });
        const id = await fileTransferManager.offerFile(42, 'bob', file);

        const offer = sent.find(m => m.type === 'FileOffer');
        expect(offer).toBeTruthy();
        expect(offer!.payload.target_user).toBe(42);
        expect(offer!.payload.transfer_id).toBe(id);
        expect(offer!.payload.size).toBe(4);
        // The KNOWN digest of [1,2,3,4]. A /^[0-9a-f]{64}$/ shape check would
        // accept the digest of the wrong bytes just as happily, and the
        // receiver's whole integrity guarantee rests on this field.
        expect(offer!.payload.sha256).toBe(
            '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
        );
    });

    it('uses an id the server will accept (8..64 chars, [A-Za-z0-9-])', async () => {
        const file = new File([new Uint8Array([1])], 'a.bin');
        const id = await fileTransferManager.offerFile(1, 'x', file);
        expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    });

    it('spends the hash pass in preparing, and offers with the counter reset', async () => {
        const file = new File([new Uint8Array(1000)], 'prep.bin');
        const seen: string[] = [];
        const unsub = fileTransferManager.subscribe(list => {
            const t = list.find(x => x.name === 'prep.bin');
            if (t) seen.push(t.state);
        });
        const id = await fileTransferManager.offerFile(5, 'pat', file);
        unsub();

        // The card must exist — as 'preparing', not 'offered' — before the
        // offer goes out: 'offered' renders "Waiting for the peer", which is a
        // lie during a phase the peer has not even been told about.
        expect(seen[0]).toBe('preparing');
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('offered');
        // The hash pass drove t.bytes; sent-byte accounting starts from zero.
        expect(t.bytes).toBe(0);
        expect(sent.find(m => m.type === 'FileOffer' && m.payload.transfer_id === id)).toBeTruthy();
    });

    it('a parked offer stays live and proceeds normally once accepted', async () => {
        // The server HOLDS an offer whose target has no live socket (a
        // backgrounded phone) and says so via FileParked. That is not a
        // cancellation: the card explains, the transfer stays in 'offered',
        // and a later FileAccepted proceeds exactly as if delivery had been
        // immediate.
        const file = new File([new Uint8Array([9, 9, 9])], 'parked.bin');
        const id = await fileTransferManager.offerFile(7, 'my phone', file);

        handlers.get('FileParked')!({
            type: 'FileParked',
            payload: {
                from_user: 7, transfer_id: id,
                reason: 'your other device isn’t connected — the offer will reach it when Puca opens there',
            },
        });
        let t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('offered'); // NOT failed, NOT cancelled
        expect(t.parkedReason).toContain('other device');

        // The phone comes online, collects the held offer, accepts.
        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            payload: { from_user: 7, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('connecting'); // the normal accept path ran
        expect(t.parkedReason).toBeUndefined(); // the parked note is done
    });

    it('cancel during preparing stays local: no offer, no FileCancel frame', async () => {
        // The claimed size spans TWO hash slices, so the cancel lands between
        // them and the abort signal is consulted MID-read. A file under one
        // slice would finish hashing before the cancel was ever visible and
        // the abort plumbing could be deleted without failing this test.
        const file = new File([new Uint8Array(16)], 'cancel-mid-hash.bin');
        Object.defineProperty(file, 'size', { value: HASH_READ_SIZE * 2 });
        const pending = fileTransferManager.offerFile(6, 'kai', file);
        // The entry is registered synchronously, before the first read await.
        const t = fileTransferManager.list().find(x => x.name === 'cancel-mid-hash.bin')!;
        expect(t.state).toBe('preparing');

        fileTransferManager.cancel(t.id);
        await pending;

        // The server never learned this transfer id, so NOTHING may be sent
        // about it — a FileCancel would come back "Unknown transfer".
        expect(sent.filter(m => m.payload?.transfer_id === t.id)).toHaveLength(0);
        const after = fileTransferManager.list().find(x => x.id === t.id)!;
        // 'cancelled', NOT 'failed': the thrown abort must be recognised as
        // the cancel it is, not reported as a red error card.
        expect(after.state).toBe('cancelled');
        // And the hash pass genuinely stopped early.
        expect(after.bytes).toBeLessThan(HASH_READ_SIZE * 2);
    });
});

describe('ICE candidate ordering', () => {
    /**
     * Candidates routinely arrive before the description they belong to.
     * Adding one then throws, and a manager that dropped them would lose
     * exactly the candidates needed to connect — producing a transfer that
     * hangs in 'connecting' with no error to explain it.
     */
    it('queues candidates that arrive before the remote description, then applies them', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);

        // Recipient accepts -> the manager builds its connection.
        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            payload: { from_user: 7, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        const pc = FakePeerConnection.last!;
        expect(pc.createdChannels).toEqual(['file']);

        // A candidate lands BEFORE the answer.
        handlers.get('FileSignal')!({
            type: 'FileSignal',
            payload: { from_user: 7, transfer_id: id, payload: JSON.stringify({ kind: 'ice', candidate: { candidate: 'early' } }) },
        });
        await flush();
        expect(pc.addedCandidates).toHaveLength(0);   // held, not thrown away

        handlers.get('FileSignal')!({
            type: 'FileSignal',
            payload: { from_user: 7, transfer_id: id, payload: JSON.stringify({ kind: 'answer', sdp: fakeSdp(PEER_FP) }) },
        });
        await flush();
        expect(pc.addedCandidates.map(c => c.candidate)).toEqual(['early']);
    });

    it('ignores a malformed signal instead of throwing', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);
        // The handler is async, so a synchronous .not.toThrow() would pass even
        // if it rejected. Drive it and await the queue, then assert the
        // transfer is untouched and no signal was emitted in response.
        const before = sent.length;
        handlers.get('FileSignal')!({
            type: 'FileSignal',
            payload: { from_user: 7, transfer_id: id, payload: 'not json' },
        });
        await flush();
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('offered');          // not failed, not advanced
        expect(sent.length).toBe(before);         // nothing sent in reply
    });
});

describe('relay policy', () => {
    /**
     * Plan §4: when ICE picks a TURN relay, every byte crosses the host's home
     * connection twice. A large transfer must be refused rather than quietly
     * costing the host — the failure mode this feature was sold against.
     */
    it('cancels a large transfer that would run over a TURN relay', async () => {
        const big = new File([new Uint8Array(16)], 'big.bin');
        Object.defineProperty(big, 'size', { value: RELAY_MAX_BYTES + 1 });
        const id = await fileTransferManager.offerFile(9, 'dan', big);

        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            payload: { from_user: 9, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        const pc = FakePeerConnection.last!;
        pc.statsCandidateType = 'relay';

        // Opening the channel is what starts the send — and is where the
        // policy is enforced. The refusal is DEFERRED now: the relay pair
        // always completes first, so the check keeps polling for a direct pair
        // for a size-scaled budget before trusting a relay reading. Drive that
        // clock rather than asserting into the middle of the settle window.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            pc.lastChannel!.onopen?.();
            await vi.advanceTimersByTimeAsync(5_000);
            await flush();
        } finally {
            vi.useRealTimers();
        }

        const cancel = sent.find(m => m.type === 'FileCancel' && m.payload.transfer_id === id);
        expect(cancel, 'a relayed transfer this large must be refused').toBeTruthy();
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('cancelled');
        // Assert on MEANING, not wording: the reason must name the cause and
        // the limit, since it is now sent to the peer verbatim and is the only
        // thing telling them why their transfer stopped.
        expect(t.error?.toLowerCase()).toContain('no direct connection');
        expect(t.error).toContain('MB');
        expect(t.error?.toLowerCase()).toContain('settings');
    });

    /**
     * THE RESEND BUG. The desktop sink keeps a `.part` keyed by the file's
     * DIGEST, so re-sending a file that mostly arrived resumes near the end —
     * the receiver's FileAccepted carries `resume_from`. Gating on the file's
     * TOTAL size refused a resend that owed only a sliver, and the message
     * even quoted the whole file ("this 1229 MB file"). Judge what is actually
     * still to send.
     */
    it('allows a RESEND whose remaining bytes fit, even over a relay', async () => {
        const big = new File([new Uint8Array(16)], 'big.bin');
        Object.defineProperty(big, 'size', { value: RELAY_MAX_BYTES * 12 });
        const id = await fileTransferManager.offerFile(13, 'ren', big);

        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            // Nearly everything already on disk from the previous attempt: a
            // kilobyte left, far under the cap.
            payload: { from_user: 13, transfer_id: id, resume_from: RELAY_MAX_BYTES * 12 - 1024, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        const pc = FakePeerConnection.last!;
        pc.statsCandidateType = 'relay';   // genuinely relayed, and that is FINE at 1 KB

        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            pc.lastChannel!.onopen?.();
            await vi.advanceTimersByTimeAsync(5_000);
            await flush();
        } finally {
            vi.useRealTimers();
        }

        expect(
            sent.find(m => m.type === 'FileCancel' && m.payload.transfer_id === id),
            'a resume that owes less than the cap must not be refused',
        ).toBeFalsy();
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).not.toBe('cancelled');
    });

    it('allows the same large transfer when the path is DIRECT', async () => {
        const big = new File([new Uint8Array(16)], 'big.bin');
        Object.defineProperty(big, 'size', { value: RELAY_MAX_BYTES + 1 });
        const id = await fileTransferManager.offerFile(11, 'kim', big);

        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            payload: { from_user: 11, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        const pc = FakePeerConnection.last!;
        pc.statsCandidateType = 'host';        // direct path
        pc.lastChannel!.onopen?.();
        await flush();

        expect(sent.find(m => m.type === 'FileCancel' && m.payload.transfer_id === id)).toBeFalsy();
    });

    it('ignores a succeeded-but-unselected relay pair when the SELECTED pair is direct', async () => {
        // The regression this fix exists for: with TURN configured, the relay
        // allocation always completes a connectivity check, so a stats report
        // routinely holds a succeeded relay pair beside the nominated direct
        // one. Judging "any succeeded pair" refused genuinely direct transfers.
        const big = new File([new Uint8Array(16)], 'big.bin');
        Object.defineProperty(big, 'size', { value: RELAY_MAX_BYTES + 1 });
        const id = await fileTransferManager.offerFile(12, 'lee', big);

        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            payload: { from_user: 12, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        const pc = FakePeerConnection.last!;
        pc.statsCandidateType = 'host';     // selected pair: direct
        pc.statsExtraRelayPair = true;      // plus a succeeded relay pair
        pc.lastChannel!.onopen?.();
        await flush();

        expect(sent.find(m => m.type === 'FileCancel' && m.payload.transfer_id === id)).toBeFalsy();
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('transferring');
    });

    it('allows a SMALL transfer over a relay — the policy is size-scoped', async () => {
        const small = new File([new Uint8Array(16)], 'small.bin');
        const id = await fileTransferManager.offerFile(9, 'dan', small);

        handlers.get('FileAccepted')!({
            type: 'FileAccepted',
            payload: { from_user: 9, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP },
        });
        await flush();
        const pc = FakePeerConnection.last!;
        pc.statsCandidateType = 'relay';    // relayed, but small
        pc.lastChannel!.onopen?.();
        await flush();

        // Earlier this test asserted only state === 'offered' and never fired
        // onopen, so it never reached isRelayed() at all — it would have passed
        // with the whole policy deleted.
        expect(sent.find(m => m.type === 'FileCancel' && m.payload.transfer_id === id)).toBeFalsy();
    });
});

describe('incoming offers', () => {
    it('surfaces an offer and refuses it when no sink exists', async () => {
        handlers.get('FileOffered')!({
            type: 'FileOffered',
            payload: {
                from_user: 3, from_username: 'eve', transfer_id: 'incoming1',
                name: 'photo.png', size: 1234, mime: 'image/png', sha256: 'a'.repeat(64),
                auth: 'TESTMAC', auth_v: 2, fp: PEER_FP, ts: Date.now(),
            },
        });
        // onOffered verifies the offer's MAC asynchronously (it awaits the
        // sender's pinned key), so let that settle before asserting.
        await flush();
        const t = fileTransferManager.list().find(x => x.id === 'incoming1');
        expect(t?.direction).toBe('receive');
        expect(t?.name).toBe('photo.png');
        expect(t?.state).toBe('offered');
    });

    it('drops the transfer when the sender cancels', async () => {
        handlers.get('FileOffered')!({
            type: 'FileOffered',
            payload: {
                from_user: 3, from_username: 'eve', transfer_id: 'incoming2',
                name: 'x.bin', size: 10, mime: '', sha256: 'b'.repeat(64),
                auth: 'TESTMAC', auth_v: 2, fp: PEER_FP, ts: Date.now(),
            },
        });
        await flush();
        handlers.get('FileCancelled')!({
            type: 'FileCancelled',
            payload: { from_user: 3, transfer_id: 'incoming2', reason: 'cancelled' },
        });
        expect(fileTransferManager.list().find(x => x.id === 'incoming2')?.state).toBe('cancelled');
    });
});

describe('dismissing finished cards', () => {
    const offerIncoming = async (id: string) => {
        handlers.get('FileOffered')!({
            type: 'FileOffered',
            payload: {
                from_user: 3, from_username: 'eve', transfer_id: id,
                name: 'x.bin', size: 10, mime: '', sha256: 'c'.repeat(64),
                auth: 'TESTMAC', auth_v: 2, fp: PEER_FP, ts: Date.now(),
            },
        });
        await flush();
    };

    it('removes a terminal card locally and sends NOTHING on the wire', async () => {
        await offerIncoming('dismiss1');
        handlers.get('FileCancelled')!({
            type: 'FileCancelled',
            payload: { from_user: 3, transfer_id: 'dismiss1', reason: 'cancelled' },
        });
        const before = sent.length;
        fileTransferManager.dismiss('dismiss1');
        expect(fileTransferManager.list().find(x => x.id === 'dismiss1')).toBeFalsy();
        // The registry slot is already gone server-side; a FileCancel here
        // would bounce back as an "Unknown transfer" error alert.
        expect(sent.length).toBe(before);
    });

    it('is a no-op on a LIVE transfer', async () => {
        await offerIncoming('dismiss2');
        const before = sent.length;
        fileTransferManager.dismiss('dismiss2');
        const t = fileTransferManager.list().find(x => x.id === 'dismiss2');
        expect(t?.state).toBe('offered');
        expect(sent.length).toBe(before);
    });

    it('clearFinished sweeps every terminal card and only those', async () => {
        await offerIncoming('sweep-live');
        await offerIncoming('sweep-done');
        handlers.get('FileCancelled')!({
            type: 'FileCancelled',
            payload: { from_user: 3, transfer_id: 'sweep-done', reason: 'cancelled' },
        });
        fileTransferManager.clearFinished();
        expect(fileTransferManager.list().find(x => x.id === 'sweep-done')).toBeFalsy();
        expect(fileTransferManager.list().find(x => x.id === 'sweep-live')?.state).toBe('offered');
    });
});

describe('DTLS fingerprint binding (the server cannot substitute the peer)', () => {
    const offered = (over: Record<string, unknown> = {}) => ({
        type: 'FileOffered',
        payload: {
            from_user: 7, from_username: 'ann', transfer_id: 'offer-' + Math.random().toString(36).slice(2, 10),
            name: 'f.bin', size: 8, mime: 'application/octet-stream', sha256: 'ab'.repeat(32),
            auth: 'TESTMAC', auth_v: 2, fp: PEER_FP, ts: Date.now(),
            ...over,
        },
    });

    it('the offer names our certificate: auth_v 2, the fingerprint and a timestamp', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);
        const offer = sent.find(m => m.type === 'FileOffer' && m.payload.transfer_id === id)!;
        expect(offer.payload.auth_v).toBe(2);
        expect(offer.payload.fp).toBe(PEER_FP);
        expect(Math.abs(Date.now() - offer.payload.ts)).toBeLessThan(5000);
    });

    it('the connection pins the certificate the record named', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);
        handlers.get('FileAccepted')!({ type: 'FileAccepted', payload: { from_user: 7, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP } });
        await flush();
        expect(FakePeerConnection.last!.config?.certificates).toHaveLength(1);
        expect(FakePeerConnection.last!.config?.certificates?.[0]).toBe(FakePeerConnection.lastCert);
    });

    it('an accept from an older app (no auth_v) is refused with an update message, and the peer is told', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);
        handlers.get('FileAccepted')!({ type: 'FileAccepted', payload: { from_user: 7, transfer_id: id, resume_from: 0 } });
        await flush();
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('failed');
        expect(t.error).toContain('older than yours');
        expect(sent.some(m => m.type === 'FileCancel' && m.payload.transfer_id === id)).toBe(true);
        expect(sent.some(m => m.type === 'FileComplete' && m.payload.transfer_id === id)).toBe(false); // not fail()
    });

    it('an answer whose DTLS fingerprint is not the one the receiver authenticated is refused before negotiation', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);
        handlers.get('FileAccepted')!({ type: 'FileAccepted', payload: { from_user: 7, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP } });
        await flush();
        const pc = FakePeerConnection.last!;
        const mitm = `sha-256 ${'FF:'.repeat(31)}FF`;
        handlers.get('FileSignal')!({ type: 'FileSignal', payload: { from_user: 7, transfer_id: id, payload: JSON.stringify({ kind: 'answer', sdp: fakeSdp(mitm) }) } });
        await flush();
        expect(pc.remoteDescription).toBeNull();
        const t = fileTransferManager.list().find(x => x.id === id)!;
        expect(t.state).toBe('failed');
        expect(t.error).toContain('did not match');
        expect(sent.some(m => m.type === 'FileCancel' && m.payload.transfer_id === id)).toBe(true);
    });

    it('a sender ignores a reflected offer, and a second description after the first', async () => {
        const file = new File([new Uint8Array(8)], 'f.bin');
        const id = await fileTransferManager.offerFile(7, 'ann', file);
        handlers.get('FileAccepted')!({ type: 'FileAccepted', payload: { from_user: 7, transfer_id: id, resume_from: 0, auth: 'TESTMAC', auth_v: 2, fp: PEER_FP } });
        await flush();
        const pc = FakePeerConnection.last!;
        handlers.get('FileSignal')!({ type: 'FileSignal', payload: { from_user: 7, transfer_id: id, payload: JSON.stringify({ kind: 'offer', sdp: fakeSdp(PEER_FP) }) } });
        await flush();
        expect(pc.remoteDescription).toBeNull();   // a sender takes answers only
        handlers.get('FileSignal')!({ type: 'FileSignal', payload: { from_user: 7, transfer_id: id, payload: JSON.stringify({ kind: 'answer', sdp: fakeSdp(PEER_FP) }) } });
        await flush();
        const first = pc.remoteDescription;
        expect(first).not.toBeNull();
        handlers.get('FileSignal')!({ type: 'FileSignal', payload: { from_user: 7, transfer_id: id, payload: JSON.stringify({ kind: 'answer', sdp: fakeSdp(PEER_FP) + '\r\na=x' }) } });
        await flush();
        expect(pc.remoteDescription).toBe(first);   // replay: not renegotiated
    });

    it('a v2 offer is shown with the sender\'s fingerprint remembered; an old-format offer is refused with the update message', async () => {
        const fresh = offered();
        handlers.get('FileOffered')!(fresh);
        await flush();
        const t = fileTransferManager.list().find(x => x.id === fresh.payload.transfer_id)!;
        expect(t.state).toBe('offered');
        const old = offered({ auth_v: undefined, fp: undefined, ts: undefined });
        handlers.get('FileOffered')!(old);
        await flush();
        const o = fileTransferManager.list().find(x => x.id === old.payload.transfer_id)!;
        expect(o.state).toBe('failed');
        expect(o.error).toContain('older than yours');
    });

    it('a stale offer (outside the freshness window) and a re-delivered id are not accepted', async () => {
        const stale = offered({ ts: Date.now() - 16 * 60_000 });
        handlers.get('FileOffered')!(stale);
        await flush();
        expect(fileTransferManager.list().find(x => x.id === stale.payload.transfer_id)!.state).toBe('failed');
        const fresh = offered();
        handlers.get('FileOffered')!(fresh);
        await flush();
        const before = fileTransferManager.list().length;
        handlers.get('FileOffered')!({ ...fresh, payload: { ...fresh.payload, name: 'clobber.bin' } });
        await flush();
        expect(fileTransferManager.list().length).toBe(before);
        expect(fileTransferManager.list().find(x => x.id === fresh.payload.transfer_id)!.name).toBe('f.bin');
    });
});
