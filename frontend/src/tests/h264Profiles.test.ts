/**
 * Why every screen share this project ever logged encoded in SOFTWARE, and
 * the one-line ordering that stops it (api/rtc/h264Profiles.ts).
 *
 * The fixtures below are the REAL capability lists read on 2026-09-16 from
 * Edge 153 and from the shipped WebView2 153 runtime on an RTX 4080 SUPER,
 * with the hardware factory on and (as the control) off. The "server" in the
 * incident test is the LiveKit v1.13.4 registry (protocol/codecs: 42e01f/0,
 * 42e01f/1, 640032/1) applying the offer's relative order, which is what
 * pkg/rtc/transport.go configureReceiverCodecs does. Measured outcomes, same
 * day, same machine: 42e01f -> OpenH264, 640032 -> NVIDIA H.264 Encoder MFT.
 */
import { describe, it, expect } from 'vitest';
import { ParticipantEvent } from 'livekit-client';

import {
    applyHardwareH264Preference,
    h264ProfileLevelId,
    h264SendProfilesLine,
    hardwareH264Rank,
    hasHardwareH264,
    isHardwareEligibleH264,
    negotiatedH264Profile,
    preferHardwareH264,
    preferHardwareH264ForSender,
    type CodecLike,
} from '../api/rtc/h264Profiles';

const h264 = (pm: 0 | 1, profile: string) => ({
    mimeType: 'video/H264',
    clockRate: 90000,
    sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${pm};profile-level-id=${profile}`,
});
const plain = (mimeType: string, sdpFmtpLine?: string) => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine && { sdpFmtpLine }) });

/** RTCRtpSender.getCapabilities('video').codecs on the 4080, hardware ON —
 *  the software list plus the one entry MediaFoundation adds. */
const SENDER_HW: RTCRtpCodec[] = [
    h264(1, '42001f'), h264(0, '42001f'),
    h264(1, '42e01f'), h264(0, '42e01f'),
    h264(1, '4d001f'), h264(0, '4d001f'),
    h264(1, '640032'),
    plain('video/VP8'),
    plain('video/rtx'),
    plain('video/VP9', 'profile-id=0'),
    plain('video/AV1', 'level-idx=5;profile=0;tier=0'),
    plain('video/red'),
    plain('video/ulpfec'),
    plain('video/flexfec-03', 'repair-window=10000000'),
];
/** The same list with --disable-accelerated-video-encode: OpenH264 only. */
const SENDER_SW: RTCRtpCodec[] = SENDER_HW.filter((c) => !c.sdpFmtpLine?.includes('640032'));

/** What the LiveKit v1.13.4 server answers with, given an offer in this order:
 *  the first H.264 variant it has registered. */
function livekitAnswerLeadsWith(offer: readonly CodecLike[]): string | null {
    const known = new Set(['42e01f/0', '42e01f/1', '640032/1']);
    for (const c of offer) {
        if (c.mimeType.toLowerCase() !== 'video/h264') continue;
        const pm = /packetization-mode=(\d)/.exec(c.sdpFmtpLine ?? '')?.[1] ?? '0';
        const key = `${h264ProfileLevelId(c.sdpFmtpLine)}/${pm}`;
        if (known.has(key)) return key;
    }
    return null;
}
/** The measurement table: which encoder Chromium-on-Windows hands each. */
const ENCODER_FOR: Record<string, string> = {
    '42e01f/0': 'OpenH264', '42e01f/1': 'OpenH264', '640032/1': 'NVIDIA H.264 Encoder MFT',
};

describe('ranking H.264 entries by what a hardware encoder will take', () => {
    it('claims High, Main and Baseline in mode 1, in that order', () => {
        expect(hardwareH264Rank(h264(1, '640032'))).toBe(0);
        expect(hardwareH264Rank(h264(1, '64001f'))).toBe(0);
        expect(hardwareH264Rank(h264(1, '4d001f'))).toBe(1);
        expect(hardwareH264Rank(h264(1, '42001f'))).toBe(2);
    });

    it('does NOT claim Constrained Baseline — the profile every share negotiated', () => {
        expect(hardwareH264Rank(h264(1, '42e01f'))).toBeNull();
        expect(isHardwareEligibleH264(h264(1, '42e01f'))).toBe(false);
    });

    it('does NOT claim packetization-mode 0, absent, or the constrained/exotic profiles', () => {
        expect(hardwareH264Rank(h264(0, '640032'))).toBeNull();
        expect(hardwareH264Rank(h264(0, '42001f'))).toBeNull();
        // RFC 6184: no packetization-mode means 0.
        expect(hardwareH264Rank({ mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640032' })).toBeNull();
        expect(hardwareH264Rank(h264(1, '640c1f'))).toBeNull(); // Constrained High
        expect(hardwareH264Rank(h264(1, 'f4001f'))).toBeNull(); // High 4:4:4 (decoder-only)
        expect(hardwareH264Rank(plain('video/VP8'))).toBeNull();
        expect(hardwareH264Rank(plain('video/rtx'))).toBeNull();
    });

    it('matches the MIME type case-insensitively and parses the fmtp loosely', () => {
        expect(hardwareH264Rank({ mimeType: 'VIDEO/h264', sdpFmtpLine: 'packetization-mode=1; profile-level-id=64001F' })).toBe(0);
        expect(h264ProfileLevelId('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42E01F')).toBe('42e01f');
        expect(h264ProfileLevelId('profile-level-id=zz001f')).toBeNull();
        expect(h264ProfileLevelId(undefined)).toBeNull();
    });
});

describe('reordering the offer', () => {
    it('THE INCIDENT: the browser order makes the server answer Constrained Baseline, which is software', () => {
        const picked = livekitAnswerLeadsWith(SENDER_HW);
        expect(picked).toBe('42e01f/1');
        expect(ENCODER_FOR[picked!]).toBe('OpenH264');
    });

    it('THE FIX: with High first the same server answers High, which is hardware', () => {
        const picked = livekitAnswerLeadsWith(preferHardwareH264(SENDER_HW));
        expect(picked).toBe('640032/1');
        expect(ENCODER_FOR[picked!]).toBe('NVIDIA H.264 Encoder MFT');
    });

    it('leads with High, then Main, then Baseline, all mode 1', () => {
        const head = preferHardwareH264(SENDER_HW).slice(0, 3).map((c) => c.sdpFmtpLine);
        expect(head).toEqual([
            'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032',
            'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f',
            'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
        ]);
    });

    it('adds nothing, drops nothing, rewrites nothing — same objects, one each', () => {
        // Dropping rtx/red/ulpfec from a preference list silently disables
        // retransmission; rewriting an fmtp would make setCodecPreferences
        // throw. Neither would show up in any other test.
        const out = preferHardwareH264(SENDER_HW);
        expect(out).toHaveLength(SENDER_HW.length);
        expect(new Set(out).size).toBe(SENDER_HW.length);
        for (const c of SENDER_HW) expect(out).toContain(c);
        for (const util of ['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']) {
            expect(out.some((c) => c.mimeType === util), util).toBe(true);
        }
    });

    it('keeps everything else in its original relative order', () => {
        const out = preferHardwareH264(SENDER_HW);
        const rest = out.filter((c) => !isHardwareEligibleH264(c));
        expect(rest).toEqual(SENDER_HW.filter((c) => !isHardwareEligibleH264(c)));
        // In particular 42e01f is still offered, right after the eligible
        // entries and ahead of VP8: the fallback for a server that filters
        // High out is unchanged.
        expect(rest[2].sdpFmtpLine).toContain('42e01f');
    });

    it('a software-only machine negotiates exactly what it does today', () => {
        // No High entry in its sender capabilities (OpenH264 never claims
        // one), so applyHardwareH264Preference does not touch the offer at
        // all — and even the pure reorder, were it applied, would only move
        // Main/Baseline mode 1 forward, which this server does not register.
        // Either way the answer is still 42e01f. Nothing lost, nothing broken.
        expect(hasHardwareH264(SENDER_SW)).toBe(false);
        expect(livekitAnswerLeadsWith(preferHardwareH264(SENDER_SW))).toBe('42e01f/1');
        expect(livekitAnswerLeadsWith(SENDER_SW)).toBe('42e01f/1');
    });

    it('is a no-op on an empty list', () => {
        expect(preferHardwareH264([])).toEqual([]);
    });
});

describe('applying it to a transceiver', () => {
    function fakeTransceiver() {
        const calls: RTCRtpCodec[][] = [];
        return { calls, setCodecPreferences: (codecs: RTCRtpCodec[]) => { calls.push(codecs); } };
    }

    it('sets the reordered list from the SENDER capabilities', () => {
        const t = fakeTransceiver();
        expect(applyHardwareH264Preference(t, { codecs: SENDER_HW })).toBe('applied');
        expect(t.calls).toHaveLength(1);
        expect(t.calls[0][0].sdpFmtpLine).toContain('640032');
        expect(t.calls[0]).toHaveLength(SENDER_HW.length);
    });

    it('leaves the browser order alone on a machine with no hardware encoder', () => {
        // THE REVIEW FINDING. The first cut gated on "any ranked entry", and
        // Baseline/Main are ranked — but OpenH264 advertises those too, so
        // every real Chromium read as hardware-capable, the offer was
        // reordered on machines with nothing to reach, and this branch could
        // never run. Presence is decided by High alone (hasHardwareH264).
        const t = fakeTransceiver();
        expect(applyHardwareH264Preference(t, { codecs: SENDER_SW })).toBe('none-available');
        expect(applyHardwareH264Preference(t, { codecs: [plain('video/VP8'), plain('video/rtx')] })).toBe('none-available');
        expect(t.calls, 'the software-only offer must stay byte-for-byte the browser\'s').toHaveLength(0);
    });

    it('decides hardware presence by the High entry and nothing else', () => {
        expect(hasHardwareH264(SENDER_HW)).toBe(true);
        expect(hasHardwareH264(SENDER_SW)).toBe(false);
        // Constrained High (640c) is not what the factory adds, and a
        // mode-0 High is software: neither counts.
        expect(hasHardwareH264([h264(1, '640c1f'), h264(1, '42001f'), h264(1, '4d001f')])).toBe(false);
        expect(hasHardwareH264([h264(0, '640032')])).toBe(false);
        expect(hasHardwareH264([h264(1, '64001f')])).toBe(true);
    });

    it('does nothing where the APIs are missing (jsdom, an old WebView)', () => {
        const t = fakeTransceiver();
        expect(applyHardwareH264Preference(t, null)).toBe('unsupported');
        expect(applyHardwareH264Preference({}, { codecs: SENDER_HW })).toBe('unsupported');
        expect(t.calls).toHaveLength(0);
        // jsdom has no RTCRtpSender at all: the default-argument path must
        // resolve to 'unsupported', not throw.
        expect(typeof (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender).toBe('undefined');
        expect(applyHardwareH264Preference(t)).toBe('unsupported');
    });
});

describe('the LocalSenderCreated hook', () => {
    it('livekit-client still emits the event this relies on', () => {
        // @internal in livekit-client. If an upgrade renames or removes it,
        // every share silently goes back to OpenH264 — this is the tripwire.
        expect(ParticipantEvent.LocalSenderCreated).toBe('localSenderCreated');
    });

    function room(transceivers: { sender: unknown; setCodecPreferences?: (c: RTCRtpCodec[]) => void }[]) {
        return { engine: { pcManager: { publisher: { getTransceivers: () => transceivers } } } };
    }

    it('reorders the transceiver that owns the new H.264 video sender', () => {
        const sender = {};
        const calls: RTCRtpCodec[][] = [];
        const r = room([
            { sender: {}, setCodecPreferences: () => { throw new Error('wrong transceiver'); } },
            { sender, setCodecPreferences: (c) => { calls.push(c); } },
        ]);
        expect(preferHardwareH264ForSender(r, sender, { kind: 'video', codec: 'h264' }, { codecs: SENDER_HW })).toBe('applied');
        expect(calls).toHaveLength(1);
        expect(calls[0][0].sdpFmtpLine).toContain('640032');
    });

    it('ignores audio senders and non-H.264 video (the VP8 camera)', () => {
        const sender = {};
        const r = room([{ sender, setCodecPreferences: () => { throw new Error('must not be called'); } }]);
        expect(preferHardwareH264ForSender(r, sender, { kind: 'audio' }, { codecs: SENDER_HW })).toBe('not-h264');
        expect(preferHardwareH264ForSender(r, sender, { kind: 'video', codec: 'vp8' }, { codecs: SENDER_HW })).toBe('not-h264');
        expect(preferHardwareH264ForSender(r, sender, { kind: 'video' }, { codecs: SENDER_HW })).toBe('not-h264');
    });

    it('fails OPEN when the publisher is gone or does not know the sender', () => {
        const sender = {};
        expect(preferHardwareH264ForSender({ engine: {} }, sender, { kind: 'video', codec: 'h264' }, { codecs: SENDER_HW }))
            .toBe('no-transceiver');
        expect(preferHardwareH264ForSender(room([{ sender: {} }]), sender, { kind: 'video', codec: 'h264' }, { codecs: SENDER_HW }))
            .toBe('no-transceiver');
        const throwing = { engine: { pcManager: { publisher: { getTransceivers: () => { throw new Error('closed'); } } } } };
        expect(preferHardwareH264ForSender(throwing, sender, { kind: 'video', codec: 'h264' }, { codecs: SENDER_HW }))
            .toBe('no-transceiver');
    });
});

describe('reading the negotiated profile out of a stats report', () => {
    const report = new Map<string, unknown>([
        ['C1', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' }],
        ['C2', { type: 'codec', mimeType: 'video/VP8' }],
    ]) as unknown as RTCStatsReport;

    it('names the H.264 profile behind an outbound-rtp entry', () => {
        expect(negotiatedH264Profile(report, 'C1')).toBe('42e01f');
    });

    it('is null for other codecs and for a missing or foreign codecId', () => {
        expect(negotiatedH264Profile(report, 'C2')).toBeNull();
        expect(negotiatedH264Profile(report, 'nope')).toBeNull();
        expect(negotiatedH264Profile(report, undefined)).toBeNull();
    });
});

describe('the diagnostics line', () => {
    it('lists what can be sent and answers the hardware question from the High entry', () => {
        const line = h264SendProfilesLine({ codecs: SENDER_HW });
        expect(line).toBe('h264 send 42001f/1 42001f/0 42e01f/1 42e01f/0 4d001f/1 4d001f/0 640032/1  hardware encoder: yes (High 640032/1 leads the offer)');
    });

    it('says NO on a software-only machine, whose Baseline/Main entries prove nothing', () => {
        // The review finding: the first cut printed "hardware-eligible:
        // 4d001f/1 42001f/1" here — the exact machine the line exists to
        // identify, called hardware-capable.
        const line = h264SendProfilesLine({ codecs: SENDER_SW });
        expect(line).toContain('hardware encoder: no');
        expect(line).not.toContain('yes');
    });

    it('says so when the browser offers nothing usable', () => {
        expect(h264SendProfilesLine({ codecs: [plain('video/VP8')] })).toBe('h264 send none');
        expect(h264SendProfilesLine(null)).toContain('no RTCRtpSender');
    });
});
