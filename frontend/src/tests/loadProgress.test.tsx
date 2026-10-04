/**
 * Long waits must look alive (owner report 2026-10-04: clips on the phone
 * "took very long" — they worked, but nothing on screen moved).
 *
 * What the waits are made of is bytes on the wire: ~88% of a clip's time to
 * first frame was network and decryption a few tens of ms, yet the plate said
 * a static "Decrypting…"; the Download button moved once per 24 MiB part
 * ("2/7", every 7-15 s); and an ordinary video sat behind a static
 * "Decrypting attachment…" for as long as it took to arrive. Each now counts
 * the bytes:
 *
 *   - the pure readouts (api/loadProgressText.ts);
 *   - the clip plate: "Loading 1.0 / 24 MB" and a progress bar, from the
 *     player's onLoadProgress (the player's side is clipPlayerWindow.test.ts);
 *   - an encrypted attachment: "Loading attachment… 1.0 MB" while its body
 *     streams in, through the real decryptToBlobUrl, then the player.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryLocalStorage } from './fixtures/fakeSink';
import type { ClipLoadProgress } from '../api/clips/clipPlayback';

const player = vi.hoisted(() => ({
    onLoadProgress: null as ((p: ClipLoadProgress) => void) | null,
    release: null as (() => void) | null,
}));
vi.mock('../api/clips/clipPlayback', async (orig) => {
    const real = await orig<typeof import('../api/clips/clipPlayback')>();
    return {
        ...real,
        createClipPlayer: () => {
            const handle: { mode: 'mse'; attach: () => Promise<void>; destroy: () => void; onLoadProgress?: (p: ClipLoadProgress) => void } = {
                mode: 'mse',
                attach: () => new Promise<void>((r) => { player.onLoadProgress = handle.onLoadProgress ?? null; player.release = r; }),
                destroy: () => {},
            };
            return handle;
        },
    };
});

import { bytesOfText, downloadPercent, downloadSaving, formatLoadedMB, playLoadPercent, playLoadText } from '../api/loadProgressText';
import { ClipAttachment } from '../components/ClipAttachment';
import { MessageContent } from '../components/MessageContent';
import { encodeClipRef } from '../api/clips/clipRef';
import { newClipSecrets } from '../api/clips/clipCrypto';
import { clearBlobCache } from '../api/attachments';

const MIB = 1024 * 1024;

describe('the readouts', () => {
    it('MB with one decimal under 10, whole above; "x / y MB" when the total is known', () => {
        expect(formatLoadedMB(0)).toBe('0.0 MB');
        expect(formatLoadedMB(1.04 * MIB)).toBe('1.0 MB');
        expect(formatLoadedMB(24.4 * MIB)).toBe('24 MB');
        expect(bytesOfText(3.2 * MIB, null)).toBe('3.2 MB');
        expect(bytesOfText(3.2 * MIB, 24 * MIB)).toBe('3.2 / 24 MB');
        expect(bytesOfText(30 * MIB, 24 * MIB)).toBe('30 / 30 MB'); // an estimate that ran short never reads backwards
    });
    it('the plate counts what the Play waits for', () => {
        expect(playLoadText(null)).toBe('Loading…');
        expect(playLoadText({ loaded: 0, needed: 24 * MIB })).toBe('Loading…');
        expect(playLoadText({ loaded: 6 * MIB, needed: 24 * MIB })).toBe('Loading 6.0 / 24 MB');
        expect(playLoadPercent({ loaded: 6 * MIB, needed: 24 * MIB })).toBe(25);
        expect(playLoadPercent({ loaded: 30, needed: 20 })).toBe(100);
    });
    it('the download counts percent of the clip, never 100 before it is saved, then "saving"', () => {
        const p = (bytesDone: number, done = 0) => ({ done, total: 7, bytesDone, totalBytes: 1000 });
        expect(downloadPercent(null)).toBe(0);
        expect(downloadPercent(p(456))).toBe(45);
        expect(downloadPercent(p(999))).toBe(99);
        expect(downloadPercent(p(1000, 6))).toBe(99);
        expect(downloadSaving(p(999))).toBe(false);
        expect(downloadSaving(p(1000, 6))).toBe(true);
        expect(downloadSaving(p(1000, 7))).toBe(true); // desktop: assembling the file and saving it
    });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    // jsdom implements no playback; nothing here is ever audible either way.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearBlobCache();
});
const settle = async () => {
    await act(async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); });
};

describe('the clip plate while a Play loads', () => {
    it('shows the bytes it is waiting for, and a progress bar, instead of a frozen "Decrypting…"', async () => {
        const s = newClipSecrets('0000abcd-0000-4000-8000-0000000000aa');
        const href = encodeClipRef({
            key: s.key, noncePrefix: s.noncePrefix, clipId: '0000abcd-0000-4000-8000-0000000000aa', videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2',
            durationMs: 120_000, width: 2560, height: 1440, totalCipherBytes: 129 * MIB,
            parts: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], partDurMs: [0, 120_000],
        });
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { (container.querySelector('.clip-attachment-play') as HTMLButtonElement).click(); });
        await settle();
        const overlay = () => container.querySelector('.clip-attachment-overlay')?.textContent ?? '';
        const bar = () => container.querySelector('.clip-attachment-progress[role="progressbar"]');
        expect(overlay()).toBe('Loading…');
        expect(overlay()).not.toMatch(/Decrypting/);
        await act(async () => { player.onLoadProgress!({ loaded: 6 * MIB, needed: 24 * MIB }); });
        expect(overlay()).toBe('Loading 6.0 / 24 MB');
        expect(bar()?.getAttribute('aria-valuenow')).toBe('25');
        await act(async () => { player.onLoadProgress!({ loaded: 18 * MIB, needed: 24 * MIB }); });
        expect(overlay()).toBe('Loading 18 / 24 MB');
        expect(bar()?.getAttribute('aria-valuenow')).toBe('75');
        await act(async () => { player.release!(); });
        await settle();
        expect(container.querySelector('.clip-attachment-overlay')).toBeNull(); // playing: the readout is gone
    });

    it('tells a screen reader once that the clip is loading, not every MB', async () => {
        // The old overlay was a polite live region ("Decrypting…"); the MB
        // readout is not one (it would speak every network chunk), and a
        // progressbar is only read when focused.
        const s = newClipSecrets('0000abcd-0000-4000-8000-0000000000ab');
        const href = encodeClipRef({
            key: s.key, noncePrefix: s.noncePrefix, clipId: '0000abcd-0000-4000-8000-0000000000ab', videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2',
            durationMs: 120_000, width: 2560, height: 1440, totalCipherBytes: 129 * MIB,
            parts: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], partDurMs: [0, 120_000],
        });
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        const live = () => [...container.querySelectorAll('[aria-live="polite"]')];
        // Already in the page before Play, empty, so the change is what is announced.
        expect(live().map(e => e.textContent)).toEqual(['']);
        const region = live()[0];
        await act(async () => { (container.querySelector('.clip-attachment-play') as HTMLButtonElement).click(); });
        await settle();
        expect(live()).toEqual([region]);
        expect(region.textContent).toBe('Loading the clip');
        await act(async () => { player.onLoadProgress!({ loaded: 6 * MIB, needed: 24 * MIB }); });
        expect(region.textContent).toBe('Loading the clip'); // the MB readout is not in it
        expect(region.closest('.clip-attachment-overlay')).toBeNull();
        await act(async () => { player.release!(); });
        await settle();
        expect(region.textContent).toBe('');
    });
});

// ---- an ordinary encrypted attachment, end to end through decryptToBlobUrl ----
function b64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('an encrypted attachment while it downloads', () => {
    it('shows the bytes received, then the player once the whole blob is in', async () => {
        const plain = new Uint8Array(3 * MIB).map((_, i) => i & 0xff);
        const rawKey = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
        const blob = new Uint8Array(12 + ct.byteLength);
        blob.set(nonce); blob.set(ct, 12);

        // The body arrives in three pieces, each released by the test.
        let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
        const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            if (!String(u).includes('/files/')) throw new Error(`unexpected fetch ${u}`);
            return new Response(body);
        }));
        URL.createObjectURL = vi.fn(() => 'blob:decrypted-video');

        const id = '11111111-2222-4333-8444-555555555555';
        await act(async () => { root.render(<MessageContent members={[]} content={`[clip.mp4](sovereign-enc:${id}?k=${b64url(rawKey)}&m=video%2Fmp4)`} />); });
        await settle();
        const placeholder = () => container.querySelector('.message-attachment.loading')?.textContent ?? '';
        expect(placeholder()).toMatch(/Loading attachment…$/);
        expect(placeholder()).not.toMatch(/Decrypting/);

        await act(async () => { ctl!.enqueue(blob.slice(0, MIB + 12)); });
        await settle();
        expect(placeholder()).toMatch(/Loading attachment… 1\.0 MB$/);
        await act(async () => { ctl!.enqueue(blob.slice(MIB + 12, 2 * MIB + 12)); });
        await settle();
        expect(placeholder()).toMatch(/Loading attachment… 2\.0 MB$/);

        await act(async () => { ctl!.enqueue(blob.slice(2 * MIB + 12)); ctl!.close(); });
        await settle();
        await settle();
        expect(container.querySelector('.message-attachment.loading')).toBeNull();
        expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:decrypted-video');
    });
});
