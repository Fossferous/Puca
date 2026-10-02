/**
 * The pure paging rules behind Load more (api/devices/listPaging.ts): where a
 * further page is asked from, what of it is kept, when the folder is reported
 * as changed, and how the scroll offset keeps the user's row in place.
 */
import { describe, it, expect } from 'vitest';
import {
    LIST_PAGE_OVERLAP,
    continuationCursor,
    continuePage,
    firstContinuation,
    scrollKeepingTopRow,
} from '../api/devices/listPaging';

const f = (name: string) => ({ name, is_dir: false, size: 1 });
const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => f(`e${String(from + i).padStart(4, '0')}`));

describe('continuation', () => {
    it('a first page anchors on its LAST entry in host order', () => {
        const page = { entries: [f('zeta'), f('alpha')], truncated: true, next: 2 };
        expect(firstContinuation(page)).toEqual({ next: 2, last: 'alpha', size: 2 });
    });

    it('a complete folder, or a host from before paging, has no continuation', () => {
        expect(firstContinuation({ entries: [f('a')], truncated: false, next: null })).toBeNull();
        expect(firstContinuation({ entries: [f('a')], truncated: true, next: null })).toBeNull();
        expect(firstContinuation({ entries: [], truncated: true, next: 5 }), 'nothing to anchor on').toBeNull();
    });

    it('asks from the anchor less the overlap, and never past half a small page', () => {
        expect(continuationCursor({ next: 2000, last: 'x', size: 2000 })).toBe(2000 - 1 - LIST_PAGE_OVERLAP);
        expect(continuationCursor({ next: 3, last: 'x', size: 3 }), 'tiny pages still advance').toBe(2);
        expect(continuationCursor({ next: 10, last: 'x', size: 10 })).toBe(10 - 1 - 4);
        expect(continuationCursor({ next: 5, last: 'x', size: 100 }), 'never below 0').toBe(0);
    });
});

describe('continuePage', () => {
    const c = { next: 40, last: 'e0039', size: 40 };

    it('keeps only what follows the anchor when nothing changed', () => {
        const page = { entries: names(40, 23), truncated: true, next: 63 };
        const got = continuePage(c, page);
        expect(got.entries.map(e => e.name)).toEqual(names(23, 40).map(e => e.name));
        expect(got.gap).toBe(false);
        expect(got.more).toEqual({ next: 63, last: 'e0062', size: 40 });
    });

    it('resumes exactly after deletions before the anchor, up to the overlap', () => {
        // Five entries before the cursor were deleted: the anchor moved back
        // five places, still inside the window.
        const window = [...names(11, 28), ...names(29, 39)]; // e0028..e0038, e0039..e0067
        const got = continuePage(c, { entries: window, truncated: true, next: 63 });
        expect(got.entries[0].name).toBe('e0040');
        expect(got.gap).toBe(false);
    });

    it('reports a gap when the anchor is not in the window', () => {
        const got = continuePage(c, { entries: names(40, 60), truncated: false, next: null });
        expect(got.gap).toBe(true);
        expect(got.entries).toHaveLength(40);
        expect(got.more).toBeNull();
    });

    it('an empty page past the end of a shrunken folder is a gap, not a clean finish', () => {
        const got = continuePage(c, { entries: [], truncated: false, next: null });
        expect(got.gap).toBe(true);
        expect(got.more).toBeNull();
    });

    it('a next that does not move past the previous one ends paging and reads as cut', () => {
        const got = continuePage(c, { entries: names(17, 23), truncated: true, next: 40 });
        expect(got.more).toBeNull();
        expect(got.truncated, 'the folder is still partial and must say so').toBe(true);
    });
});

describe('scrollKeepingTopRow', () => {
    const before = names(100);
    it('moves the offset down by the rows sorted in above the top row', () => {
        const after = [f('A'), f('B'), f('C'), ...before];
        expect(scrollKeepingTopRow(before, after, 20 * 32 + 5, 32)).toBe(23 * 32 + 5);
    });
    it('leaves the offset alone when nothing sorted in above', () => {
        expect(scrollKeepingTopRow(before, [...before, f('zz')], 640, 32)).toBe(640);
    });
    it('at the very top the top stays the top, so new rows there are seen', () => {
        expect(scrollKeepingTopRow(before, [f('A'), ...before], 0, 32)).toBe(0);
    });
});
