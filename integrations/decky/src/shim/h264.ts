/**
 * The shared screen's picture as the backend hands it to the page
 * (py_modules/puca_share.py): H.264 access units in Annex B form, each
 * starting with a delimiter, every keyframe carrying its parameter sets, sent
 * as base64. Bundled into the page shim (rollup inlines it).
 */

/** The WebCodecs codec string ("avc1.PPCCLL") from an access unit's sequence
 *  parameter set, or null when it has none. */
export function codecOf(au: Uint8Array): string | null {
    for (let i = 0; i + 6 < au.length; i++) {
        if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1) continue;
        if ((au[i + 3] & 0x1f) === 7) {
            const hex = (b: number) => b.toString(16).padStart(2, '0');
            return `avc1.${hex(au[i + 4])}${hex(au[i + 5])}${hex(au[i + 6])}`;
        }
        i += 2;
    }
    return null;
}

/** The bytes of one access unit, from the backend's base64. */
export function fromBase64(data: string): Uint8Array {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
