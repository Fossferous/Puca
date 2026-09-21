/**
 * Signing out revokes the previews of pictures still waiting to be sent.
 *
 * A parked picture's CIPHERTEXT goes with the account's database, which
 * `logout()` deletes. Its PLAINTEXT is somewhere else: an object URL, cached
 * per parked id in api/parkedPreview.ts and held by the document. Púca
 * Notes' sign-out does not reload the page (it navigates to /login inside
 * the same SPA), so without an explicit revoke the next person at a shared
 * browser has a live URL to the previous account's photo.
 *
 * The cleanup existed and was documented "(sign-out)" from the day it was
 * written, and nothing called it — the repo's "a security flag needs a
 * reader" pattern. It is now registered through api/logoutHooks.ts, which is
 * what this proves end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decryptParkedBlobUrl } = vi.hoisted(() => ({ decryptParkedBlobUrl: vi.fn() }));
vi.mock('../api/attachments', async () => {
    const real = await vi.importActual<typeof import('../api/attachments')>('../api/attachments');
    return { ...real, decryptParkedBlobUrl };
});

import { logout } from '../api/auth';
import { parkedObjectUrl, setParkedReader } from '../api/parkedPreview';
import { parkedHref } from '../api/parkedMedia';

const href = parkedHref('photo-1', 'image/jpeg');

describe('a sign-out revokes a parked picture’s decrypted preview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let n = 0;
        decryptParkedBlobUrl.mockImplementation(async () => `blob:plaintext-${++n}`);
        setParkedReader(async () => ({ data: btoa('cipher'), key: 'AAAA', mime: 'image/jpeg' }));
    });

    it('the URL is revoked, and the picture is decrypted again rather than handed back', async () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        expect(await parkedObjectUrl(href)).toBe('blob:plaintext-1');
        // Positive control: it really is cached, so a second ask is the SAME
        // url and the decrypt ran once — which is what makes the revoke matter.
        expect(await parkedObjectUrl(href)).toBe('blob:plaintext-1');
        expect(decryptParkedBlobUrl).toHaveBeenCalledTimes(1);

        logout();

        expect(revoke).toHaveBeenCalledWith('blob:plaintext-1');
        // ...and the cache no longer holds it: the next ask decrypts afresh.
        expect(await parkedObjectUrl(href)).toBe('blob:plaintext-2');
        revoke.mockRestore();
    });
});
