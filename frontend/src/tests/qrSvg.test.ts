/**
 * deploy/ops/make-qr-svg.mjs: the QR code on the download page's "iPhone and
 * iPad" section, made with no library. A QR code that does not scan looks
 * exactly like one that does, so these cases do not just check that something
 * was drawn:
 *
 *  - the Reed-Solomon step is checked against the published worked example
 *    (the "HELLO WORLD" version 1-Q codewords every QR tutorial uses);
 *  - the finished matrix is READ BACK by a decoder written here that shares
 *    none of the encoder's code: it finds the data modules from zones, not from
 *    the encoder's drawing order, un-masks, de-interleaves, checks every block's
 *    Reed-Solomon syndromes are zero (own GF(256) by shift-and-add), checks the
 *    format word's BCH code, and reads the text back out;
 *  - the module count per version is the published total-codewords table;
 *  - a flipped data module must make the same decoder FAIL (negative control).
 *
 * What this cannot prove is that a phone's camera reads it: that needs a real
 * scanner (the hand-over note says what was and was not tried).
 */
import { describe, it, expect } from 'vitest';
import { qrMatrix, qrSvg, rsRemainder, MAX_BYTES } from '../../../deploy/ops/make-qr-svg.mjs';

// --- an independent reader ---------------------------------------------------
function gfMulSlow(a: number, b: number): number {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const carry = a & 0x80;
        a = (a << 1) & 0xff;
        if (carry) a ^= 0x1d;
        b >>= 1;
    }
    return p;
}
const alphaPow = (n: number) => { let v = 1; for (let i = 0; i < n; i++) v = gfMulSlow(v, 2); return v; };

/** Published: total codewords (data + error correction) per version 1..6. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172];
/** Published, level M: [ec per block, blocks of [count, data per block]]. */
const BLOCKS: Record<number, [number, [number, number][]]> = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]],
    4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]],
};
const MASK = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number, _c: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function decode(m: boolean[][]): string {
    const size = m.length;
    const version = (size - 17) / 4;
    const at = (x: number, y: number) => (m[y][x] ? 1 : 0);

    // Format word: both copies agree, unmask with 0x5412, BCH(15,5) divides, level M.
    const first = [8, 8, 8, 8, 8, 8, 8, 8].map(() => 0);
    let word1 = 0;
    const cells1: [number, number][] = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    cells1.forEach(([x, y], i) => { word1 |= at(x, y) << i; });
    let word2 = 0;
    const cells2: [number, number][] = [
        [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [size - 8, 8],
        [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
    ];
    cells2.forEach(([x, y], i) => { word2 |= at(x, y) << i; });
    void first;
    expect(word2, 'the two copies of the format word').toBe(word1);
    const fmt = word1 ^ 0x5412;
    let rem = fmt;
    for (let bit = 14; bit >= 10; bit--) if (rem & (1 << bit)) rem ^= 0x537 << (bit - 10);
    expect(rem, 'format BCH remainder').toBe(0);
    expect(fmt >> 13, 'error correction level M').toBe(0);
    const mask = (fmt >> 10) & 7;

    // Which modules are NOT data, found by zone.
    const align = version >= 2 ? [size - 7, size - 7] : null;
    const isFn = (x: number, y: number) =>
        (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8) ||
        x === 6 || y === 6 ||
        (align !== null && Math.abs(x - align[0]) <= 2 && Math.abs(y - align[1]) <= 2);

    // Read columns in pairs from the right, up then down, skipping the timing column.
    const bits: number[] = [];
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (let i = 0; i < size; i++) {
            const y = up ? size - 1 - i : i;
            for (const x of [col, col - 1]) {
                if (isFn(x, y)) continue;
                bits.push(at(x, y) ^ (MASK[mask](y, x) ? 1 : 0));
            }
        }
        up = !up;
    }
    expect(Math.floor(bits.length / 8), 'codewords in the symbol').toBe(TOTAL_CODEWORDS[version]);
    const cw: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // De-interleave and check every block's syndromes.
    const [ecLen, groups] = BLOCKS[version];
    const sizes = groups.flatMap(([n, d]) => Array<number>(n).fill(d));
    const blocks = sizes.map(() => ({ data: [] as number[], ec: [] as number[] }));
    let k = 0;
    for (let i = 0; i < Math.max(...sizes); i++) blocks.forEach((b, j) => { if (i < sizes[j]) b.data.push(cw[k++]); });
    for (let i = 0; i < ecLen; i++) blocks.forEach((b) => b.ec.push(cw[k++]));
    for (const b of blocks) {
        const word = [...b.data, ...b.ec];
        for (let s = 0; s < ecLen; s++) {
            let acc = 0;
            for (const c of word) acc = gfMulSlow(acc, alphaPow(s)) ^ c;
            expect(acc, `syndrome ${s}`).toBe(0);
        }
    }

    // Parse: byte mode, 8-bit count.
    const data = blocks.flatMap((b) => b.data);
    const stream = data.map((c) => c.toString(2).padStart(8, '0')).join('');
    expect(stream.slice(0, 4), 'mode').toBe('0100');
    const len = parseInt(stream.slice(4, 12), 2);
    const bytes = Array.from({ length: len }, (_, i) => parseInt(stream.slice(12 + 8 * i, 20 + 8 * i), 2));
    return new TextDecoder().decode(Uint8Array.from(bytes));
}

describe('make-qr-svg', () => {
    it('Reed-Solomon matches the published HELLO WORLD 1-Q example', () => {
        const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
        expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    });

    // Byte capacity at level M: v1 14, v2 26, v3 42, v4 62, v5 84, v6 106. Each
    // text is the longest or near the longest that version holds.
    const sized = (n: number) => 'https://' + 'a'.repeat(n - 8);
    it.each([
        ['https://a.b', 1],
        [sized(14), 1],
        ['https://app.example.org/', 2],
        [sized(26), 2],
        [sized(27), 3],
        [sized(42), 3],
        [sized(43), 4],
        [sized(62), 4],
        [sized(63), 5],
        [sized(84), 5],
        [sized(85), 6],
        [sized(106), 6],
        ['https://accents.example.org/é', null],
    ])('decodes back to %s', (text, version) => {
        const q = qrMatrix(text);
        if (version !== null) expect(q.version).toBe(version);
        expect(q.size).toBe(17 + 4 * q.version);
        expect(decode(q.modules)).toBe(text);
    });

    it('the reader FAILS on a symbol with one data module flipped (negative control)', () => {
        const q = qrMatrix('https://app.example.org/');
        q.modules[q.size - 1][q.size - 1] = !q.modules[q.size - 1][q.size - 1];
        expect(() => decode(q.modules)).toThrow();
    });

    it('has the fixed patterns: three finders, the dark module, alternating timing', () => {
        const { modules: m, size } = qrMatrix('https://app.example.org/');
        for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
            for (let d = 0; d < 7; d++) {
                expect(m[y0][x0 + d] && m[y0 + 6][x0 + d] && m[y0 + d][x0] && m[y0 + d][x0 + 6]).toBe(true);
            }
            expect(m[y0 + 3][x0 + 3]).toBe(true);
            expect(m[y0 + 1][x0 + 1]).toBe(false);
        }
        expect(m[size - 8][8]).toBe(true);
        for (let i = 8; i < size - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
    });

    it('refuses a text that does not fit rather than truncating it', () => {
        expect(() => qrMatrix('x'.repeat(MAX_BYTES))).not.toThrow();
        expect(() => qrMatrix('x'.repeat(MAX_BYTES + 1))).toThrow(/at most/);
    });

    it('makes a self-contained SVG: no script, no link, no external reference', () => {
        const svg = qrSvg('https://app.example.org/', 'app.example.org');
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(svg).toContain('aria-label="QR code for app.example.org"');
        expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|href|<script|<image|url\(/);
        expect(svg).not.toMatch(/[&\\]/); // dual-ship.sh splices it with awk
        expect(svg.split('\n').length).toBe(1);
        // dark on a white square with a 4-module quiet zone
        const total = 25 + 8;
        expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
        expect(svg).toContain('fill="#fff"');
    });

    it('keeps markup characters out of the label', () => {
        expect(qrSvg('x', '"><script>&')).toContain('aria-label="QR code for script"');
    });
});
