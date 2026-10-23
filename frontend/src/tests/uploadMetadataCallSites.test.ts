// @vitest-environment jsdom
/**
 * Every picture the app uploads in the clear (avatar, server icon, emoji, the
 * create-a-server wizard's icon, anything added later) must lose its EXIF
 * before it leaves.
 *
 * The first version of this fix patched three components that called
 * uploadFile and missed the fourth (the wizard, api/serverTemplates.ts), which
 * then served a phone photo's GPS to everyone; no test noticed, because none
 * looked at what a caller actually uploaded. So the strip now lives in
 * uploadFile itself, and these tests pin that, a real caller that nobody
 * remembered the first time, and the walk that keeps a new caller from going
 * around it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const posted = vi.hoisted(() => ({ files: [] as Blob[], endpoints: [] as string[] }));
vi.mock('../api/client', () => ({
    apiClient: {
        post: vi.fn(async (endpoint: string, body: FormData) => {
            posted.endpoints.push(endpoint);
            posted.files.push(body.get('file') as Blob);
            return { id: 'file-1', original_name: 'x', mime_type: 'x', size_bytes: 1, url: '/files/file-1' };
        }),
    },
}));
vi.mock('../api/servers', async (orig) => ({
    ...(await orig<typeof import('../api/servers')>()),
    updateServerSettings: vi.fn(async () => undefined),
    listChannels: vi.fn(async () => []),
}));

import { uploadFile } from '../api/uploads';
import { finishServerCreation } from '../api/serverTemplates';
import { cat, enc, indexOfBytes, jpeg, leaked, png, webp } from './fixtures/photoMetadata';

function readBlob(b: Blob): Promise<Uint8Array> {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => rej(r.error);
        r.readAsArrayBuffer(b);
    });
}
const fileOf = (bytes: Uint8Array, name: string, type: string) => new File([Uint8Array.from(bytes)], name, { type });

beforeEach(() => { posted.files.length = 0; posted.endpoints.length = 0; });

const phonePhoto = () => jpeg({ xmp: true, comment: true, iptc: true });
/** The same photo with its Exif segment's length made to run off the end of the file. */
const damagedPhoto = () => {
    const bad = Uint8Array.from(phonePhoto());
    const at = indexOfBytes(bad, Uint8Array.from([0xFF, 0xE1]));
    bad[at + 2] = 0xFF; bad[at + 3] = 0xFF;
    return bad;
};

describe('uploadFile, the one door for plaintext pictures', () => {
    it('control: the photo going in carries GPS, camera and time', () => {
        expect(leaked(phonePhoto())).toEqual(expect.arrayContaining(['GPS latitude', 'camera make', 'capture date']));
    });

    it('a JPEG, PNG or WebP goes up without any of it', async () => {
        for (const [bytes, name, type] of [
            [phonePhoto(), 'me.jpg', 'image/jpeg'], [png({ unknown: true }), 'me.png', 'image/png'], [webp({ xmp: true }), 'me.webp', 'image/webp'],
        ] as Array<[Uint8Array, string, string]>) {
            posted.files.length = 0;
            await uploadFile(fileOf(bytes, name, type));
            expect(posted.endpoints).toContain('/upload');
            const sent = await readBlob(posted.files[0]);
            expect(leaked(bytes), `${name} control`).not.toEqual([]);
            expect(leaked(sent), name).toEqual([]);
            expect((posted.files[0] as File).name).toBe(name);
            expect((posted.files[0] as File).type).toBe(type);
        }
    });

    it('a sealed attachment (octet-stream), a sound and a GIF go up byte for byte', async () => {
        // Ciphertext can start with ANY bytes, including a JPEG's magic: it must never be parsed.
        const cipher = cat([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF], enc('SECRETCOMMENT-not-a-photo'));
        for (const [bytes, name, type] of [
            [cipher, 'attachment.enc', 'application/octet-stream'],
            [enc('ID3 sound'), 'join.mp3', 'audio/mpeg'],
            [cat(enc('GIF89a'), enc('SECRETCOMMENT-gif')), 'a.gif', 'image/gif'],
        ] as Array<[Uint8Array, string, string]>) {
            posted.files.length = 0;
            await uploadFile(fileOf(bytes, name, type));
            expect(Array.from(await readBlob(posted.files[0])), name).toEqual(Array.from(bytes));
        }
    });

    it('a damaged JPEG is refused and nothing is posted', async () => {
        await expect(uploadFile(fileOf(damagedPhoto(), 'broken.jpg', 'image/jpeg'))).rejects.toMatchObject({ name: 'ImageMetadataError' });
        expect(posted.files).toHaveLength(0);
    });
});

describe('the callers', () => {
    const wizardOptions = (iconFile: File) => ({ template: 'custom', iconFile, isPublic: false } as unknown as Parameters<typeof finishServerCreation>[1]);

    it("the create-a-server wizard's icon (the caller the first fix missed)", async () => {
        const warnings = await finishServerCreation('s1', wizardOptions(fileOf(phonePhoto(), 'icon.jpg', 'image/jpeg')));
        expect(warnings).toEqual([]);
        expect(posted.files).toHaveLength(1);
        expect(leaked(await readBlob(posted.files[0]))).toEqual([]);
    });

    it('the wizard says why when the icon is refused', async () => {
        const warnings = await finishServerCreation('s1', wizardOptions(fileOf(damagedPhoto(), 'icon.jpg', 'image/jpeg')));
        expect(warnings.join(' ')).toMatch(/was not sent/);
        expect(posted.files).toHaveLength(0);
    });
});

describe('nothing goes around the door', () => {
    const root = join(__dirname, '..');
    const sources: Array<{ rel: string; text: string }> = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) { if (name !== 'tests' && name !== 'node_modules') walk(p); continue; }
            if (/\.(ts|tsx)$/.test(name)) sources.push({ rel: relative(root, p).split(sep).join('/'), text: readFileSync(p, 'utf8') });
        }
    };
    walk(root);

    it('only api/uploads.ts posts to /upload, and its uploadFile strips', () => {
        const posters = sources.filter(s => /post(?:<[^>]*>)?\(\s*['"`]\/upload['"`]/.test(s.text)).map(s => s.rel);
        // Clips have their own signed protocol and send video, never a picture (api/clips/clipUpload.ts).
        expect(posters.filter(p => !p.startsWith('api/clips/'))).toEqual(['api/uploads.ts']);
        const uploads = sources.find(s => s.rel === 'api/uploads.ts')!.text;
        expect(uploads).toMatch(/stripFileMetadata\(file\)\.then\(/);
    });

    it('every importer of uploadFile is known (a new one is a decision, made here)', () => {
        const importers = sources
            .filter(s => /import\s*\{[^}]*\buploadFile\b[^}]*\}\s*from\s*['"](?:\.\.?\/)+(?:api\/)?uploads['"]/.test(s.text))
            .map(s => s.rel).sort();
        expect(importers).toEqual([
            'api/attachments.ts', // the sealed ciphertext (octet-stream: never parsed)
            'api/serverTemplates.ts', 'components/EmojiSettings.tsx', 'components/ServerSettingsModal.tsx', 'components/UserProfileSettings.tsx',
        ]);
        // ...and the seal strips before it encrypts.
        const att = sources.find(s => s.rel === 'api/attachments.ts')!.text;
        expect(att).toMatch(/stripImageMetadata\(given \?\? /);
    });
});
