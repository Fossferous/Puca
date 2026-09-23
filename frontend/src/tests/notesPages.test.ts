// The pager's arithmetic: which pages exist, which page an address is on,
// and which address a page index means (notes/model/notesPages.ts).
//
// DISTRUST GREEN TESTS: the one way this module can fail quietly is by
// answering "the All page" to everything — index 0, route '/', [All] — which
// is also its deliberate answer for an address naming a label that no longer
// exists, and for an account with no labels. So EVERY test below asserts at
// least one page that is NOT All (a non-zero index, a '/label/...' route, a
// second page), the fallback cases included: each of those carries its
// positive control in the same test. Stubbed to answer All for everything
// (pageRoutes -> [All], pageIndexForPath -> 0, routeForIndex -> '/',
// pagesOnScreen -> [0, 0]), every test in this file fails.
import { describe, it, expect } from 'vitest';
import {
    ALL_PAGE_KEY, hasPageForPath, labelRoute, pageDomId, pageIndexForPath, pageRoutes, pagesOnScreen, routeForIndex,
} from '../notes/model/notesPages';

// allLabels() hands these over sorted and de-duplicated, one casing each.
const LABELS = ['Errands', 'Bits & bobs', 'Trip'];

describe('pageRoutes', () => {
    it('is All notes, then one page per label, in the order given', () => {
        const pages = pageRoutes(LABELS);
        expect(pages.map(p => p.label)).toEqual(['All notes', 'Errands', 'Bits & bobs', 'Trip']);
        expect(pages[0]).toEqual({ key: ALL_PAGE_KEY, label: 'All notes', route: '/' });
        expect(pages.map(p => p.route)).toEqual(['/', '/label/Errands', '/label/Bits%20%26%20bobs', '/label/Trip']);
    });

    it('with no labels there is one page and nothing to swipe between', () => {
        expect(pageRoutes([])).toHaveLength(1);
        // ...and it is the LABELS that were missing: one label is two pages.
        expect(pageRoutes(['Trip']).map(p => p.route)).toEqual(['/', '/label/Trip']);
    });

    it('keys are unique and case-folded, so a label named "all" is not the All page', () => {
        const pages = pageRoutes(['all', 'ALL notes']);
        expect(pages.map(p => p.key)).toEqual(['all', 'label:all', 'label:all notes']);
        expect(new Set(pages.map(p => p.key)).size).toBe(3);
    });
});

describe('pageIndexForPath', () => {
    it('finds the page for a plain label', () => {
        expect(pageIndexForPath('/label/Trip', LABELS)).toBe(3);
    });

    it('finds the page for a label whose address needs encoding', () => {
        // The address the rail and the chips actually navigate to.
        expect(labelRoute('Bits & bobs')).toBe('/label/Bits%20%26%20bobs');
        expect(pageIndexForPath('/label/Bits%20%26%20bobs', LABELS)).toBe(2);
    });

    it('compares names the way the label manager does — case-insensitively', () => {
        expect(pageIndexForPath('/label/errands', LABELS)).toBe(1);
        expect(pageIndexForPath('/label/ERRANDS', LABELS)).toBe(1);
    });

    it('answers All for the All address and for a view that is not a page', () => {
        expect(pageIndexForPath('/', LABELS)).toBe(0);
        expect(pageIndexForPath('/archive', LABELS)).toBe(0);
        expect(pageIndexForPath('/reminders', LABELS)).toBe(0);
        // The control: the same call on a label address is not 0.
        expect(pageIndexForPath('/label/Trip', LABELS)).toBe(3);
    });

    it('falls back to All for a label address that names no page', () => {
        expect(pageIndexForPath('/label/Nonsense', LABELS)).toBe(0);
        expect(hasPageForPath('/label/Nonsense', LABELS)).toBe(false);
        // ...and says so, which is how the shell tells this apart from All.
        expect(hasPageForPath('/label/Trip', LABELS)).toBe(true);
        expect(hasPageForPath('/', LABELS)).toBe(true);
        expect(hasPageForPath('/archive', LABELS)).toBe(false);
    });

    it('a malformed escape cannot throw during a render', () => {
        // decodeURIComponent('%E0%A4%A') throws; the raw segment names no
        // label, so the pager lands on All instead of crashing the app.
        expect(() => pageIndexForPath('/label/%E0%A4%A', LABELS)).not.toThrow();
        expect(pageIndexForPath('/label/%E0%A4%A', LABELS)).toBe(0);
        expect(hasPageForPath('/label/%E0%A4%A', LABELS)).toBe(false);
        // The raw segment is really what is compared: a label literally named
        // that (typed by hand) IS found, on its own page.
        expect(pageIndexForPath('/label/%E0%A4%A', [...LABELS, '%E0%A4%A'])).toBe(4);
        expect(hasPageForPath('/label/%E0%A4%A', [...LABELS, '%E0%A4%A'])).toBe(true);
    });
});

describe('routeForIndex', () => {
    it('names the label address for a label page', () => {
        expect(routeForIndex(1, LABELS)).toBe('/label/Errands');
        expect(routeForIndex(2, LABELS)).toBe('/label/Bits%20%26%20bobs');
    });

    it('clamps: a scroll that overshoots still names a real page', () => {
        expect(routeForIndex(-1, LABELS)).toBe('/');
        expect(routeForIndex(99, LABELS)).toBe('/label/Trip');
    });

    it('round-trips every page — the index the scroll settles on names the address that lands back on it', () => {
        const pages = pageRoutes(LABELS);
        for (let i = 0; i < pages.length; i++) {
            const route = routeForIndex(i, LABELS);
            expect(route).toBe(pages[i].route);
            expect(pageIndexForPath(route, LABELS)).toBe(i);
        }
        // The control: the loop above ran over more than just the All page.
        expect(pages.length).toBeGreaterThan(1);
    });
});

// Which pages hold a real grid while the pager moves. The quiet failure here
// is answering the ROUTE's page alone — the page being swiped towards (or
// the one being left) then shows blank — so every case below that is not at
// rest expects TWO pages, and the at-rest cases expect exactly one.
describe('pagesOnScreen', () => {
    const W = 390;

    it('at rest on a page, that page alone', () => {
        expect(pagesOnScreen(2 * W, W)).toEqual([2, 2]);
        expect(pagesOnScreen(0, W)).toEqual([0, 0]);
    });

    it('a sub-pixel off a snap point is still ONE page, either side', () => {
        expect(pagesOnScreen(2 * W + 0.4, W)).toEqual([2, 2]);
        expect(pagesOnScreen(2 * W - 0.4, W)).toEqual([2, 2]);
    });

    it('mid-swipe, both pages — the one being left and the one arriving', () => {
        expect(pagesOnScreen(595, W)).toEqual([1, 2]);
        // A couple of pixels in is already two pages: the sliver must have its notes.
        expect(pagesOnScreen(2 * W + 2, W)).toEqual([2, 3]);
        expect(pagesOnScreen(2 * W - 2, W)).toEqual([1, 2]);
    });

    it('a rubber band past the first page is still page 0, not page -1', () => {
        expect(pagesOnScreen(-30, W)).toEqual([0, 0]);
        // The clamp is at zero only: 30 px in from the start is two pages.
        expect(pagesOnScreen(30, W)).toEqual([0, 1]);
    });

    it('at a FRACTIONAL width, resting on a far page is that page alone', () => {
        // A Pixel-class phone: the pager is 411.43 px and so is every page.
        // Given that true width, page 4's offset is exactly one page.
        const w = 411.4286;
        expect(pagesOnScreen(4 * w, w)).toEqual([4, 4]);
        expect(pagesOnScreen(9 * w, w)).toEqual([9, 9]);
        // The pager must never be given clientWidth instead: rounded to 411,
        // the same offset reads as two pages — the bug this width fixed.
        expect(pagesOnScreen(4 * w, Math.round(w))).toEqual([4, 5]);
    });

    it('no width yet (not laid out) answers nothing rather than dividing by zero', () => {
        expect(pagesOnScreen(100, 0)).toBeNull();
        // The control: the same offset with a width is a real answer.
        expect(pagesOnScreen(W + 100, W)).toEqual([1, 2]);
    });
});

// The ids a tab and its panel are linked by. aria-controls is a
// space-separated LIST of ids, so an id with a space in it links a tab to
// ids that do not exist — which the raw key of any multi-word label did.
describe('pageDomId', () => {
    it('leaves no whitespace in an id, whatever the label', () => {
        const pages = pageRoutes(['Pager & co', 'tab\there', 'new\nline', 'no\u00a0break', 'Trip']);
        for (const p of pages) expect(pageDomId(p.key)).not.toMatch(/\s/);
        // The control: those keys DO have whitespace in them.
        expect(pages.filter(p => /\s/.test(p.key))).toHaveLength(4);
    });

    it('keeps different pages apart, including labels that differ only by an escape', () => {
        const keys = pageRoutes(['x y', 'x%20y', 'x_y', 'all']).map(p => p.key);
        expect(keys).toHaveLength(5);
        const ids = keys.map(pageDomId);
        expect(new Set(ids).size).toBe(keys.length);
        expect(pageDomId('label:pager & co')).toBe('label%3Apager%20%26%20co');
    });
});
