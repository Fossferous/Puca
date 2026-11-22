/**
 * The shared plumbing of the container strippers (api/isoBmffMetadata.ts,
 * api/matroskaMetadata.ts, api/tiffMetadata.ts): they read a file through a
 * Source and say what to OVERWRITE, never what to insert or cut, so every
 * offset inside the file (an MP4's chunk offsets, a WebM's cues, a TIFF's
 * strips) stays valid and the media itself is not touched.
 *
 * A Source is either bytes already in memory (the seal reads the whole file
 * to encrypt it anyway: the patches are written into that same buffer, no
 * second copy) or a File read in slices (an upload or a peer-to-peer send of
 * a large video: only the boxes that can hold metadata are read, and the
 * result is a Blob made of slices of the original with the patches between
 * them, so a 2 GB video is never in memory at all).
 */

export interface Patch {
    /** Absolute file offset. */
    at: number;
    /** What goes there, overwriting exactly bytes.length bytes. */
    bytes: Uint8Array;
}

export interface Source {
    readonly size: number;
    /** Up to `len` bytes at `at` (fewer only at the end of the file). */
    read(at: number, len: number): Promise<Uint8Array>;
}

/** The most patch bytes one file may need (a crafted file asking for gigabytes of zeros is refused). */
export const MAX_PATCH_BYTES = 64 * 1024 * 1024;

export function memorySource(b: Uint8Array): Source {
    return { size: b.length, read: async (at, len) => b.subarray(at, Math.min(b.length, at + len)) };
}

/** A blob's bytes; FileReader where the engine's Blob has no arrayBuffer() (jsdom). */
export function readBlobBytes(b: Blob): Promise<Uint8Array> {
    if (typeof b.arrayBuffer === 'function') return b.arrayBuffer().then(x => new Uint8Array(x));
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => rej(r.error);
        r.readAsArrayBuffer(b);
    });
}

/** Reads a File in windows, so a walk of many small headers does not become one read each. */
export function fileSource(file: Blob, windowBytes = 1024 * 1024): Source {
    let winAt = -1;
    let win: Uint8Array = new Uint8Array(0);
    return {
        size: file.size,
        async read(at, len) {
            const end = Math.min(file.size, at + len);
            if (at < 0 || at > end) return new Uint8Array(0);
            if (winAt >= 0 && at >= winAt && end <= winAt + win.length) return win.subarray(at - winAt, end - winAt);
            if (end - at > windowBytes) return readBlobBytes(file.slice(at, end));
            winAt = at;
            win = await readBlobBytes(file.slice(at, Math.min(file.size, at + windowBytes)));
            return win.subarray(0, end - at);
        },
    };
}

/** Sorted, and refused (null) when two overlap, one leaves the file, or they are too many bytes in all. */
export function checkedPatches(patches: Patch[], size: number): Patch[] | null {
    const sorted = [...patches].filter(p => p.bytes.length > 0).sort((a, b) => a.at - b.at);
    let total = 0;
    let end = 0;
    for (const p of sorted) {
        if (p.at < end || p.at < 0 || p.at + p.bytes.length > size) return null;
        end = p.at + p.bytes.length;
        total += p.bytes.length;
        if (total > MAX_PATCH_BYTES) return null;
    }
    return sorted;
}

/** The patches that would change something: one that writes what is already there (a second
 *  pass over a stripped file) is dropped, so a clean file comes back as it came. */
export async function withoutNoops(patches: Patch[], src: Source): Promise<Patch[]> {
    const out: Patch[] = [];
    for (const p of patches) {
        const now = await src.read(p.at, p.bytes.length);
        let same = now.length === p.bytes.length;
        for (let i = 0; same && i < now.length; i++) if (now[i] !== p.bytes[i]) same = false;
        if (!same) out.push(p);
    }
    return out;
}

/** Writes checked patches into the bytes themselves. */
export function applyInPlace(b: Uint8Array, patches: Patch[]): void {
    for (const p of patches) b.set(p.bytes, p.at);
}

/** The file with checked patches written over it: slices of the original between them, nothing copied. */
export function patchedFile(file: File, patches: Patch[]): File {
    const parts: BlobPart[] = [];
    let at = 0;
    for (const p of patches) {
        if (p.at > at) parts.push(file.slice(at, p.at));
        parts.push(p.bytes as BlobPart);
        at = p.at + p.bytes.length;
    }
    if (at < file.size) parts.push(file.slice(at));
    return new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
}

export const ascii4 = (b: Uint8Array, at: number): string => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
