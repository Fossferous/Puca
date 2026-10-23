/**
 * A QR code as an inline SVG, made here, with no library and no network.
 *
 *   node deploy/ops/make-qr-svg.mjs https://app.example.org [label]   # SVG on stdout
 *
 * WHY THIS EXISTS. The download page (deploy/download-site/index.html) shows a
 * QR code of the web app's address so a visitor on a computer can point an
 * iPhone at it. The page is a static file that must work with JavaScript off and
 * must not call out to a QR service or load a script from a CDN (the address is
 * the operator's own, and a third-party image would tell that third party who
 * visits). dual-ship.sh renders the template and fills `__APP_QR_SVG__` from
 * this script's output, the way it fills `__APP_HOST__` from hosts.conf.
 *
 * WHAT IT MAKES. Byte mode, error correction level M, versions 1 to 6 (up to
 * 106 bytes), the lowest-penalty of the eight masks, a 4-module quiet zone,
 * black on white whatever the page's theme (a scanner wants dark on light). A
 * text that does not fit is refused, never truncated. Versions 7 and up (which
 * add a version-information block) are deliberately out: an address is short.
 *
 * src/tests/qrSvg.test.ts checks it against a published Reed-Solomon vector and
 * by decoding the finished matrix with a reader that shares none of the
 * encoder's tables.
 */
import { pathToFileURL } from 'node:url';

/** [ec codewords per block, [[blocks, data codewords per block], ...]] at level M. */
const BLOCKS_M = {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
};
/** Alignment pattern centre coordinates (rows and columns), by version. */
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
export const MAX_BYTES = 106;

// --- Reed-Solomon over GF(256), polynomial 0x11D -----------------------------
const EXP = new Array(512);
const LOG = new Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j];
            next[j + 1] ^= gfMul(poly[j], EXP[i]);
        }
        poly = next;
    }
    return poly; // highest degree first, leading 1
}

/** The `ecLen` error-correction codewords for `data`. */
export function rsRemainder(data, ecLen) {
    const gen = generator(ecLen);
    const rem = new Array(ecLen).fill(0);
    for (const b of data) {
        const factor = b ^ rem.shift();
        rem.push(0);
        for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return rem;
}

// --- Codewords ---------------------------------------------------------------
function chooseVersion(len) {
    for (let v = 1; v <= 6; v++) {
        const [, groups] = BLOCKS_M[v];
        const capacity = groups.reduce((n, [count, data]) => n + count * data, 0);
        if (4 + 8 + 8 * len <= capacity * 8) return v;
    }
    throw new Error(`text is ${len} bytes; this encoder holds at most ${MAX_BYTES}`);
}

function dataCodewords(bytes, version) {
    const [, groups] = BLOCKS_M[version];
    const capacityBits = groups.reduce((n, [count, data]) => n + count * data, 0) * 8;
    const bits = [];
    const put = (value, n) => {
        for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    put(0b0100, 4); // byte mode
    put(bytes.length, 8); // character count: 8 bits up to version 9
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capacityBits - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
        out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    }
    for (let pad = 0xec; out.length < capacityBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
    return out;
}

/** Data and error-correction codewords, split into blocks and interleaved. */
function interleaved(data, version) {
    const [ecLen, groups] = BLOCKS_M[version];
    const blocks = [];
    let at = 0;
    for (const [count, size] of groups) {
        for (let i = 0; i < count; i++) {
            const chunk = data.slice(at, at + size);
            at += size;
            blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
        }
    }
    const out = [];
    const longest = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
}

// --- The matrix --------------------------------------------------------------
function formatBits(mask) {
    const data = (0 << 3) | mask; // level M's indicator is 0b00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m, size) {
    let score = 0;
    // N1: five or more in a row or column of one colour.
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            let run = 1;
            for (let b = 1; b < size; b++) {
                const cur = pass ? m[b][a] : m[a][b];
                const prev = pass ? m[b - 1][a] : m[a][b - 1];
                if (cur === prev) {
                    run++;
                    if (run === 5) score += 3;
                    else if (run > 5) score += 1;
                } else run = 1;
            }
        }
    }
    // N2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
        }
    }
    // N3: 1:1:3:1:1 finder-like runs with four light modules beside them.
    const pat = [1, 0, 1, 1, 1, 0, 1];
    const matches = (get, at) => pat.every((v, i) => (get(at + i) ? 1 : 0) === v);
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            const get = (i) => (pass ? m[i][a] : m[a][i]);
            for (let b = 0; b + 7 <= size; b++) {
                if (!matches(get, b)) continue;
                const light = (from, to) => {
                    for (let i = from; i < to; i++) if (i >= 0 && i < size && get(i)) return false;
                    return true;
                };
                if (light(b - 4, b) || light(b + 7, b + 11)) score += 40;
            }
        }
    }
    // N4: how far the dark share is from half.
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
}

/** The module matrix (true = dark) of `text` as UTF-8 bytes, level M. */
export function qrMatrix(text) {
    const bytes = [...new TextEncoder().encode(text)];
    const version = chooseVersion(bytes.length);
    const size = 17 + 4 * version;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => {
        modules[y][x] = dark;
        isFunction[y][x] = true;
    };

    // Timing patterns.
    for (let i = 0; i < size; i++) {
        setFn(6, i, i % 2 === 0);
        setFn(i, 6, i % 2 === 0);
    }
    // Finder patterns with their separators.
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= size || y >= size) continue;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                setFn(x, y, d !== 2 && d !== 4);
            }
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    // Alignment patterns (not where they would hit a finder).
    const pos = ALIGN[version];
    for (const cy of pos) {
        for (const cx of pos) {
            const onFinder =
                (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
            if (onFinder) continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }
    // The format areas hold the mask number and level (written per mask below);
    // marking them now keeps data out of them. The dark module is fixed.
    const formatCells = (mask) => {
        const bits = formatBits(mask);
        const bit = (i) => ((bits >>> i) & 1) === 1;
        const cells = [];
        for (let i = 0; i <= 5; i++) cells.push([8, i, bit(i)]);
        cells.push([8, 7, bit(6)], [8, 8, bit(7)], [7, 8, bit(8)]);
        for (let i = 9; i < 15; i++) cells.push([14 - i, 8, bit(i)]);
        for (let i = 0; i < 8; i++) cells.push([size - 1 - i, 8, bit(i)]);
        for (let i = 8; i < 15; i++) cells.push([8, size - 15 + i, bit(i)]);
        cells.push([8, size - 8, true]);
        return cells;
    };
    for (const [x, y, dark] of formatCells(0)) setFn(x, y, dark);

    // Place the data, zig-zagging up and down two-column strips from the right.
    const codewords = interleaved(dataCodewords(bytes, version), version);
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push(((cw >>> i) & 1) === 1);
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5; // the timing column belongs to no strip
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y][x] && k < bits.length) modules[y][x] = bits[k++];
            }
        }
    }
    if (k !== bits.length) throw new Error(`placed ${k} of ${bits.length} bits`);

    // Try each mask and keep the lowest penalty.
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const trial = modules.map((row) => row.slice());
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) trial[y][x] = !trial[y][x];
        }
        for (const [x, y, dark] of formatCells(mask)) trial[y][x] = dark;
        const score = penalty(trial, size);
        if (!best || score < best.score) best = { score, mask, modules: trial };
    }
    return { size, version, mask: best.mask, modules: best.modules };
}

/** The finished SVG: white square, black modules, 4-module quiet zone. */
export function qrSvg(text, label = text) {
    const { size, modules } = qrMatrix(text);
    const quiet = 4;
    const total = size + 2 * quiet;
    let d = '';
    for (let y = 0; y < size; y++) {
        let x = 0;
        while (x < size) {
            if (!modules[y][x]) {
                x++;
                continue;
            }
            let run = 1;
            while (x + run < size && modules[y][x + run]) run++;
            d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
            x += run;
        }
    }
    const safe = String(label).replace(/[^A-Za-z0-9 .:/_-]/g, '');
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" ` +
        `aria-label="QR code for ${safe}" shape-rendering="crispEdges">` +
        `<rect width="${total}" height="${total}" fill="#fff"/>` +
        `<path d="${d}" fill="#000"/></svg>`
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [text, label] = process.argv.slice(2);
    if (!text) {
        console.error('usage: make-qr-svg.mjs <text> [label]');
        process.exit(2);
    }
    try {
        process.stdout.write(qrSvg(text, label ?? text) + '\n');
    } catch (e) {
        console.error(`make-qr-svg: ${e.message}`);
        process.exit(1);
    }
}
