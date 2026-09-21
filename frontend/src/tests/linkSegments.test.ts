/**
 * The note linkifier (utils/linkSegments.ts): which addresses become links,
 * and — more importantly — which do NOT.
 *
 * Each refusal below is decided by real code: the scanner takes anything
 * scheme-shaped as a CANDIDATE and `URL_RE` is what turns it down, so
 * widening the accept rule makes these go red rather than leaving a branch
 * nothing can reach. `a bare http and https URL becomes one link` is the
 * positive control that the suite is not simply refusing everything.
 */
import { describe, it, expect } from 'vitest';
import { hasLink, linkSegments } from '../utils/linkSegments';
import { isSafeUrl } from '../utils/messageParser';

const links = (s: string) => linkSegments(s).filter(x => x.kind === 'link');
const hrefs = (s: string) => links(s).map(x => (x.kind === 'link' ? x.href : ''));
/** The input, reassembled: a linkifier must never lose or add a character. */
const rebuilt = (s: string) => linkSegments(s).map(x => (x.kind === 'text' ? x.value : x.text)).join('');

describe('what becomes a link', () => {
    it('a bare http and https URL becomes one link whose href is its text', () => {
        for (const u of ['https://example.com/a', 'http://example.com/a']) {
            const segs = linkSegments(u);
            expect(segs).toHaveLength(1);
            expect(segs[0]).toEqual({ kind: 'link', href: u, text: u });
        }
    });

    it('the text around a URL survives verbatim, newlines included', () => {
        const input = 'read\nthis https://example.com/a tomorrow';
        expect(linkSegments(input)).toEqual([
            { kind: 'text', value: 'read\nthis ' },
            { kind: 'link', href: 'https://example.com/a', text: 'https://example.com/a' },
            { kind: 'text', value: ' tomorrow' },
        ]);
        expect(rebuilt(input)).toBe(input);
    });

    it('two URLs on one line make two links with the text between them', () => {
        const input = 'https://a.example and https://b.example';
        expect(hrefs(input)).toEqual(['https://a.example', 'https://b.example']);
        expect(rebuilt(input)).toBe(input);
    });

    it('trailing punctuation is not part of the address', () => {
        expect(hrefs('see https://a.example/x.')).toEqual(['https://a.example/x']);
        expect(hrefs('(https://a.example/x)')).toEqual(['https://a.example/x']);
        expect(hrefs('https://a.example/x, then')).toEqual(['https://a.example/x']);
        // …but a closing paren the URL itself opened is kept.
        expect(hrefs('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    });

    it('a scheme glued to a word is not a link', () => {
        expect(links('xhttps://evil.example')).toHaveLength(0);
        expect(rebuilt('xhttps://evil.example')).toBe('xhttps://evil.example');
    });
});

describe('what stays plain text', () => {
    const refused = [
        'javascript:alert(1)',
        '\tjavascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        '//evil.example/x',
        'mailto:a@b.example',
        'sovereign-enc:abc?k=K',
        'sovereign-clip:abc',
        'ftp://a.example/x',
    ];
    for (const s of refused) {
        it(`refuses ${JSON.stringify(s)}`, () => {
            expect(links(s)).toHaveLength(0);
            expect(linkSegments(s)).toEqual([{ kind: 'text', value: s }]);
        });
    }

    it('a string with no address is exactly one text segment (the cheap path)', () => {
        expect(linkSegments('Buy milk before Friday')).toEqual([{ kind: 'text', value: 'Buy milk before Friday' }]);
        expect(linkSegments('')).toEqual([{ kind: 'text', value: '' }]);
        expect(hasLink('Buy milk')).toBe(false);
        // POSITIVE CONTROL: hasLink does fire on one.
        expect(hasLink('Buy milk at https://shop.example')).toBe(true);
    });
});

describe('every href it emits is one the repo would render anywhere', () => {
    it('satisfies isSafeUrl — the shared predicate, checked as a property', () => {
        const corpus = [
            'https://example.com/a', 'read http://a.example/x then https://b.example/y.',
            '(https://a.example/x)', 'https://en.wikipedia.org/wiki/Foo_(bar)',
            'javascript:alert(1) and //evil.example/x and mailto:a@b.example',
            'plain words with no address at all',
        ];
        let seen = 0;
        for (const c of corpus) {
            for (const seg of linkSegments(c)) {
                if (seg.kind !== 'link') continue;
                seen++;
                expect(isSafeUrl(seg.href)).toBe(true);
                expect(seg.href).toMatch(/^https?:\/\//i);
            }
        }
        // A property check over nothing proves nothing.
        expect(seen).toBeGreaterThan(3);
    });
});
