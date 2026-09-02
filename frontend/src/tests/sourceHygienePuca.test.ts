/**
 * The hygiene lint's spelling rule: "Púca" in prose, identifiers untouched.
 *
 * The boundary that matters is the one a careless global replace would cross:
 * the `sovereign-enc:` / `X-Puca-*` / `<Downloads>/Puca` identifiers are wire
 * and filesystem identity, and changing them breaks history. The rule must
 * fire on the product name in a sentence and NOT on any of those.
 */
import { describe, it, expect } from 'vitest';
import { UNACCENTED_PRODUCT, stripComments } from '../../scripts/check-source-hygiene.mjs';

describe('UNACCENTED_PRODUCT', () => {
    it('fires on the product name in prose', () => {
        expect(UNACCENTED_PRODUCT.test('<h2>Welcome to Puca!</h2>')).toBe(true);
        expect(UNACCENTED_PRODUCT.test("'Puca Tasks'")).toBe(true);
        expect(UNACCENTED_PRODUCT.test('Restart Puca and click "Try Again"')).toBe(true);
        expect(UNACCENTED_PRODUCT.test('(Puca uses Edge WebView)')).toBe(true);
    });
    it('leaves identifiers alone — by shape, not by list', () => {
        for (const ok of [
            "'X-Puca-File-Cap'",
            "headers['X-Puca-Want-Cap'] = '1'",
            '`${downloads.path}/Puca`',
            '<Downloads>/Puca/',
            'https://github.com/Fossferous/Puca/blob/main/docs/SECURITY_MODEL.md',
            '%ProgramFiles%\\Puca\\service',
            '"Puca:control"',
            'PucaDelivery',
            'sovereign-enc:',
            'sovereign-clip:v1',
        ]) {
            expect(UNACCENTED_PRODUCT.test(ok), ok).toBe(false);
        }
    });
    it('does not fire on the accented spelling', () => {
        expect(UNACCENTED_PRODUCT.test('Welcome to Púca!')).toBe(false);
    });
});

describe('stripComments', () => {
    it('drops // and /* */ comments, including multi-line blocks, but not URLs', () => {
        const out = stripComments([
            'const a = 1; // Puca in a comment',
            '/* Puca',
            '   still a comment */ const b = "Puca";',
            "const url = 'https://x.example.org/Puca';",
            '{/* jsx comment about Puca */}',
        ]);
        expect(out[0]).toBe('const a = 1;');
        expect(out[1]).toBe('');
        expect(out[2]).toBe(' const b = "Puca";');
        expect(out[3]).toContain('https://x.example.org/Puca');
        expect(out[4]).toBe('{}');
    });
});
