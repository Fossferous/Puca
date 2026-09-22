// The pager's arithmetic: which pages exist, which page an address is on,
// and which address a page index means (notes/model/notesPages.ts).
//
// DISTRUST GREEN TESTS: the one way this module can fail quietly is by
// answering "the All page" to everything — index 0, route '/' — which is also
// its deliberate fallback for an address naming a label that no longer
// exists. So every case below asserts a page that is NOT All (a non-zero
// index, a '/label/...' route), and the round-trip test walks every page. A
// `pageIndexForPath` stubbed to `return 0` or a `routeForIndex` stubbed to
// `return '/'` fails all of them; only the two fallback cases would pass.
import { describe, it, expect } from 'vitest';
import {
    ALL_PAGE_KEY, hasPageForPath, labelRoute, pageIndexForPath, pageRoutes, routeForIndex,
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
