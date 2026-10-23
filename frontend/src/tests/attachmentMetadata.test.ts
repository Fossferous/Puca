// @vitest-environment jsdom
/**
 * A photo sent as an attachment must not carry where it was taken.
 *
 * Reproduced 2026-10-23 on the unfixed code: a JPEG with a GPS fix, sent
 * through the real attachment path (seal, upload, then opened with the key in
 * the ref), came out with the GPS block, the camera make and model and the
 * capture time intact. End-to-end encryption keeps it from the SERVER; the
 * people in the channel — who can open the file — get all of it.
 *
 * Here the real seal and upload code runs; only the HTTP post is replaced, by
 * a recorder that keeps the ciphertext the server would have been sent. The
 * test then does what a recipient's client does: read the key out of the ref
 * and AES-GCM-decrypt. What it checks is the plaintext a recipient gets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted = vi.hoisted(() => ({ files: [] as Blob[], reply: {} as Record<string, unknown> }));
vi.mock('../api/client', () => ({
    apiClient: {
        post: vi.fn(async (_endpoint: string, body: FormData) => {
            posted.files.push(body.get('file') as Blob);
            return posted.reply;
        }),
    },
}));
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { encryptAndUploadRef, parseEncAttachment, sealFileForUpload } from '../api/attachments';
import { ImageMetadataError, orientationOfTiff } from '../api/imageMetadata';
import { SCAN, cat, contains, enc, indexOfBytes, jpeg, jpegSegments, leaked, png, pngChunks, webp, riffChunkList, IDAT_BYTES, VP8_BYTES } from './fixtures/photoMetadata';

function readBlob(b: Blob): Promise<Uint8Array> {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => rej(r.error);
        r.readAsArrayBuffer(b);
    });
}

/** jsdom's File has no arrayBuffer(); the seal reads the file through it. */
function fileOf(bytes: Uint8Array, name: string, type?: string): File {
    const f = new File([bytes as BlobPart], name, type ? { type } : undefined);
    Object.defineProperty(f, 'arrayBuffer', { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    return f;
}

function fromB64url(s: string): Uint8Array {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, c => c.charCodeAt(0));
}

/** What a recipient's client does with the ciphertext and the ref: nonce(12) || AES-GCM. */
async function open(sealed: Uint8Array, keyB64url: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', fromB64url(keyB64url) as BufferSource, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) as BufferSource }, key, sealed.slice(12) as BufferSource);
    return new Uint8Array(pt);
}

/** Send a file the way the composer does and return what the recipient decrypts. */
async function sendAndOpen(file: File): Promise<Uint8Array> {
    posted.files.length = 0;
    const ref = await encryptAndUploadRef(file, { channelId: 1 });
    expect(posted.files).toHaveLength(1);
    const parsed = parseEncAttachment(ref.href)!;
    return open(await readBlob(posted.files[0]), parsed.key);
}

beforeEach(() => {
    posted.files.length = 0;
    posted.reply = { id: 'f1', original_name: 'attachment.enc', mime_type: 'application/octet-stream', size_bytes: 3, url: '/files/f1', cap: 'CAP' };
});

const everything = { xmp: true, comment: true, iptc: true, icc: true, mpf: true, trailer: enc('VIDEO-AFTER-EOI') };

describe('a photo sent in chat, a DM, a task or a note', () => {
    it('control: the photo that goes in DOES carry the location, the camera and the time', () => {
        const input = jpeg(everything);
        expect(leaked(input)).toEqual(expect.arrayContaining(['GPS latitude', 'camera make', 'camera model', 'capture date', 'XMP', 'comment', 'IPTC']));
    });

    it('JPEG: the recipient opens it with no GPS, no make or model, no time, no XMP, no comment', async () => {
        const input = jpeg(everything);
        const received = await sendAndOpen(fileOf(input, 'IMG_20261023.jpg', 'image/jpeg'));
        expect(leaked(received)).toEqual([]);
        expect(contains(received, 'VIDEO-AFTER-EOI')).toBe(false);
        // The picture itself is exactly what was sent, and it is still upright.
        expect(Array.from(received.subarray(received.length - SCAN.length - 2, received.length - 2))).toEqual(Array.from(SCAN));
        const exif = jpegSegments(received).filter(s => s.marker === 0xE1);
        expect(exif).toHaveLength(1);
        expect(orientationOfTiff(exif[0].payload.subarray(6))).toBe(6);
        expect(received.length).toBeLessThan(input.length);
    });

    it('PNG and WebP: the same', async () => {
        const p = await sendAndOpen(fileOf(png({ unknown: true }), 'shot.png', 'image/png'));
        expect(leaked(p)).toEqual([]);
        expect(Array.from(pngChunks(p).find(c => c.type === 'IDAT')!.data)).toEqual(Array.from(IDAT_BYTES));
        const w = await sendAndOpen(fileOf(webp({ xmp: true, unknown: true }), 'a.webp', 'image/webp'));
        expect(leaked(w)).toEqual([]);
        expect(Array.from(riffChunkList(w).find(c => c.type === 'VP8 ')!.data)).toEqual(Array.from(VP8_BYTES));
    });

    it('a photo whose type the browser did not give (a typeless file) is read by its bytes', async () => {
        const received = await sendAndOpen(fileOf(jpeg(everything), 'photo'));
        expect(leaked(received)).toEqual([]);
    });

    it('bytes the app decrypted itself and re-seals (a message captured into a note) are stripped too', async () => {
        posted.files.length = 0;
        const sealed = await sealFileForUpload({ bytes: jpeg(everything), name: 'old.jpg', type: 'image/jpeg' });
        const opened = await open(new Uint8Array(await readBlob(sealed.blob)), sealed.key);
        expect(leaked(opened)).toEqual([]);
        expect(sealed.mime).toBe('image/jpeg');
    });

    it('sealing alone (a note photo taken offline, parked as ciphertext) strips before it encrypts', async () => {
        const sealed = await sealFileForUpload(fileOf(jpeg(everything), 'cam.jpg', 'image/jpeg'));
        expect(leaked(await open(await readBlob(sealed.blob), sealed.key))).toEqual([]);
    });

    it('a file that is not one of the three formats goes through byte for byte', async () => {
        for (const [name, type, bytes] of [
            ['a.gif', 'image/gif', cat(enc('GIF89a'), [1, 0, 1, 0, 0, 0, 0], enc('SECRETCOMMENT-gif'))],
            ['a.svg', 'image/svg+xml', enc('<svg xmlns="http://www.w3.org/2000/svg"><metadata>SECRETXMP-creator-jane</metadata></svg>')],
            ['a.pdf', 'application/pdf', enc('%PDF-1.7 PhoneModelX-9000')],
            ['a.bin', '', Uint8Array.from([0xFF, 0xD8])],
        ] as Array<[string, string, Uint8Array]>) {
            const received = await sendAndOpen(fileOf(bytes, name, type || undefined));
            expect(Array.from(received), name).toEqual(Array.from(bytes));
        }
    });

    it('a JPEG that cannot be taken apart is NOT sent, and the error says so', async () => {
        const bad = Uint8Array.from(jpeg({ comment: true }));
        const com = indexOfBytes(bad, Uint8Array.from([0xFF, 0xFE]));
        bad[com + 2] = 0xFF; // the comment's length runs past the end
        bad[com + 3] = 0xFF;
        await expect(encryptAndUploadRef(fileOf(bad, 'broken.jpg', 'image/jpeg'))).rejects.toBeInstanceOf(ImageMetadataError);
        expect(posted.files).toHaveLength(0);
        await expect(encryptAndUploadRef(fileOf(bad, 'broken.jpg', 'image/jpeg'))).rejects.toThrow(/was not sent/);
    });
});
