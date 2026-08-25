import { describe, it, expect } from 'vitest';
import {
    MAX_UPLOAD_BYTES,
    ENCRYPTED_OVERHEAD_BYTES,
    FileTooLargeError,
    assertUploadable,
} from '../api/uploads';

/**
 * The client cap mirrors the server's (upload_handlers.rs) so an oversized file
 * is refused BEFORE it is read, encrypted and pushed up a residential uplink —
 * previously that whole round trip happened and only then returned a 413.
 *
 * The message is shown to the user verbatim, so it has to name the file, its
 * real size, and the actual limit.
 */

function fileOf(bytes: number, name = 'shot.png'): File {
    // A real File of N bytes without allocating N bytes.
    const f = new File([], name, { type: 'image/png' });
    Object.defineProperty(f, 'size', { value: bytes });
    return f;
}

describe('upload size guard', () => {
    it('accepts a file under the cap', () => {
        expect(() => assertUploadable(fileOf(5 * 1024 * 1024))).not.toThrow();
    });

    it('accepts a file exactly at the cap', () => {
        expect(() => assertUploadable(fileOf(MAX_UPLOAD_BYTES))).not.toThrow();
    });

    /** The report that prompted the raise: a 15 MB screenshot. It must now send. */
    it('accepts the 15 MB png that used to be refused', () => {
        expect(() => assertUploadable(fileOf(15 * 1024 * 1024, 'screenshot.png'))).not.toThrow();
        // ...including once encryption overhead is taken into account.
        expect(() => assertUploadable(fileOf(15 * 1024 * 1024), ENCRYPTED_OVERHEAD_BYTES)).not.toThrow();
    });

    it('rejects a genuinely oversized file, naming the file and both numbers', () => {
        try {
            assertUploadable(fileOf(30 * 1024 * 1024, 'huge.png'));
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(FileTooLargeError);
            const msg = (err as Error).message;
            expect(msg).toContain('huge.png');
            expect(msg).toContain('30.0 MB');
            expect(msg).toContain('25.0 MB');
        }
    });

    /**
     * The boundary that bit: encryption adds a nonce and a tag, so a file of
     * exactly the cap becomes cap+28 on the wire and the SERVER rejects it —
     * after the client has done all the work. The plaintext budget must shrink
     * by the overhead.
     */
    it('rejects a file that only exceeds the cap once encrypted', () => {
        const atCap = fileOf(MAX_UPLOAD_BYTES);
        expect(() => assertUploadable(atCap)).not.toThrow();
        expect(() => assertUploadable(atCap, ENCRYPTED_OVERHEAD_BYTES)).toThrow(FileTooLargeError);
    });

    it('still accepts the largest file that fits WITH encryption overhead', () => {
        const fits = fileOf(MAX_UPLOAD_BYTES - ENCRYPTED_OVERHEAD_BYTES);
        expect(() => assertUploadable(fits, ENCRYPTED_OVERHEAD_BYTES)).not.toThrow();
    });

    it('reports the reduced budget when overhead applies', () => {
        // NOTE: formatFileSize renders BOTH the cap and the cap-minus-28 as
        // "25.0 MB", so asserting on the rendered string cannot tell them
        // apart. Assert on the boundary behaviour instead, which can.
        const justOver = fileOf(MAX_UPLOAD_BYTES - ENCRYPTED_OVERHEAD_BYTES + 1);
        const justUnder = fileOf(MAX_UPLOAD_BYTES - ENCRYPTED_OVERHEAD_BYTES);
        expect(() => assertUploadable(justOver, ENCRYPTED_OVERHEAD_BYTES)).toThrow(FileTooLargeError);
        expect(() => assertUploadable(justUnder, ENCRYPTED_OVERHEAD_BYTES)).not.toThrow();
        // ...and without overhead the same file is fine, proving the budget
        // really did shrink by exactly the overhead.
        expect(() => assertUploadable(justOver)).not.toThrow();
    });
});
