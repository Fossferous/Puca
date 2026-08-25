import { describe, it, expect } from 'vitest';
import { subnetOf, planWake } from '../api/devices/wake';
import {
    buildClipboardEvent,
    isClipboardEvent,
    clipboardWireBytes,
    MAX_CLIPBOARD_BYTES,
} from '../api/devices/clipboard';
import type { VerifiedDevice } from '../api/devices';

function dev(over: Partial<VerifiedDevice> & { id: string }): VerifiedDevice {
    return {
        device_pub: 'x25519:AAA',
        sign_pub: 'ed25519:BBB',
        name: over.id,
        platform: 'windows',
        auth_record: '{}',
        auth_sig: 's',
        host_enabled: false,
        host_policy: null,
        host_sig: null,
        lan_info: null,
        created_at: '2026-07-28T00:00:00Z',
        last_seen_at: null,
        online: true,
        verified: true,
        isThisDevice: false,
        ...over,
    } as VerifiedDevice;
}

describe('subnet parsing', () => {
    it('extracts the /24 prefix', () => {
        expect(subnetOf('192.168.0.42')).toBe('192.168.0');
        expect(subnetOf(' 10.0.1.7 ')).toBe('10.0.1');
    });

    it('rejects anything that is not a dotted quad', () => {
        // A bogus value that parsed anyway would make two devices on DIFFERENT
        // networks look like neighbours, and the wake packet would go nowhere.
        expect(subnetOf(undefined)).toBeNull();
        expect(subnetOf('')).toBeNull();
        expect(subnetOf('192.168.0')).toBeNull();
        expect(subnetOf('192.168.0.999')).toBeNull();
        expect(subnetOf('::1')).toBeNull();
        expect(subnetOf('not an ip')).toBeNull();
    });
});

describe('wake planning', () => {
    // planWake decrypts lan_info, and there is no identity in these tests, so
    // every device reads as "no LAN details" — which is itself the case worth
    // pinning, because it is what a fresh install looks like.
    it('explains itself when the target has no recorded network details', async () => {
        const target = dev({ id: 'pc', name: 'Study PC' });
        const plan = await planWake(target, [target, dev({ id: 'phone' })], 'phone');
        expect(plan.waker).toBeNull();
        expect(plan.mac).toBeNull();
        // A disabled button with no reason is a support ticket.
        expect(plan.reason).toMatch(/network details/i);
        expect(plan.reason).toContain('Study PC');
    });

    it('never proposes the target as its own waker', async () => {
        const target = dev({ id: 'pc' });
        const plan = await planWake(target, [target], null);
        expect(plan.waker?.id).not.toBe('pc');
    });
});

describe('clipboard events', () => {
    it('builds a text event', () => {
        expect(buildClipboardEvent('hello')).toEqual({
            t: 'clip', mime: 'text/plain', data: 'hello',
        });
    });

    it('refuses empty text', () => {
        expect(buildClipboardEvent('')).toBeNull();
    });

    it('refuses text over the cap', () => {
        // The control channel is capped at 8 KiB server-side; something far
        // larger is a file or image dump and would be rejected mid-flight with
        // no explanation.
        expect(buildClipboardEvent('a'.repeat(MAX_CLIPBOARD_BYTES + 1))).toBeNull();
        expect(buildClipboardEvent('a'.repeat(MAX_CLIPBOARD_BYTES))).not.toBeNull();
    });

    it('a payload AT the cap still fits the relay frame (src/ws.rs MAX_CONTROL_EVENT_LEN = 8 KiB)', () => {
        // The old cap (256 KiB) let a paste be "sent" and thrown away by the
        // server as "input too long". The sealed frame is base64(nonce(12) ‖
        // ciphertext ‖ tag(16)) of the JSON `{s, e}` envelope; model that
        // expansion on the worst realistic text — every byte JSON-escaped
        // (`"` → `\"` doubles it) — and it must land under 8192.
        const RELAY_CAP = 8 * 1024;
        // The worst text at the cap: all quotes (each is 2 wire bytes).
        const worst = '"'.repeat(MAX_CLIPBOARD_BYTES / 2);
        const event = buildClipboardEvent(worst);
        expect(event).not.toBeNull();
        const json = JSON.stringify({ s: 999_999, e: event });
        const sealedBase64Len = Math.ceil((json.length + 12 + 16) / 3) * 4;
        expect(sealedBase64Len).toBeLessThanOrEqual(RELAY_CAP);
        // POSITIVE CONTROL: the previous cap did NOT fit — proves this
        // assertion is capable of failing.
        const oldJson = JSON.stringify({ s: 999_999, e: { t: 'clip', mime: 'text/plain', data: 'a'.repeat(256 * 1024) } });
        expect(Math.ceil((oldJson.length + 28) / 3) * 4).toBeGreaterThan(RELAY_CAP);
    });

    it('measures the cap in BYTES, not characters', () => {
        // An emoji is 4 UTF-8 bytes. Counting characters would let a payload
        // four times the intended size through.
        const emoji = '😀'.repeat(Math.floor(MAX_CLIPBOARD_BYTES / 4));
        expect(emoji.length).toBeLessThan(MAX_CLIPBOARD_BYTES);
        expect(buildClipboardEvent(emoji + '😀')).toBeNull();
    });

    it('measures AFTER JSON escaping — quotes and newlines cost two bytes on the wire', () => {
        // The relay sees the escaped form; a cap on raw bytes would let a
        // quote-heavy paste through and the server would drop it unseen.
        const quotes = '"'.repeat(MAX_CLIPBOARD_BYTES / 2);
        expect(clipboardWireBytes(quotes)).toBe(MAX_CLIPBOARD_BYTES);
        expect(buildClipboardEvent(quotes)).not.toBeNull();
        expect(buildClipboardEvent(quotes + '"')).toBeNull();
        // a + LF + b is 3 chars but the LF is escaped to two bytes on the wire.
        expect(clipboardWireBytes('a' + String.fromCharCode(10) + 'b')).toBe(4);
    });

    it('recognises a well-formed inbound event', () => {
        expect(isClipboardEvent({ t: 'clip', mime: 'text/plain', data: 'x' })).toBe(true);
    });

    /**
     * The guard that matters: this decides whether a payload is written to the
     * user's clipboard or handed to the INPUT INJECTOR. Anything sloppy here
     * either drops real clipboard data or feeds the injector a shape it will
     * try to parse as a keystroke.
     */
    it('rejects anything that is not exactly a text clipboard event', () => {
        expect(isClipboardEvent(null)).toBe(false);
        expect(isClipboardEvent('clip')).toBe(false);
        expect(isClipboardEvent({ t: 'move', x: 0.5, y: 0.5 })).toBe(false);
        expect(isClipboardEvent({ t: 'clip', mime: 'image/png', data: 'x' })).toBe(false);
        expect(isClipboardEvent({ t: 'clip', mime: 'text/plain' })).toBe(false);
        expect(isClipboardEvent({ t: 'clip', mime: 'text/plain', data: 42 })).toBe(false);
    });

    it('rejects an oversized INBOUND event too', () => {
        // The cap has to hold on receive as well: a peer is not obliged to
        // respect it, and this is what lands in the user's clipboard.
        expect(isClipboardEvent({
            t: 'clip', mime: 'text/plain', data: 'a'.repeat(MAX_CLIPBOARD_BYTES + 1),
        })).toBe(false);
    });
});
