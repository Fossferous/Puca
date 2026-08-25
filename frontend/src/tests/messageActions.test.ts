// Unit tests for the pure message-action text helpers behind the unified
// message toolbar: Quote (markdown "> " block appended to the composer) and
// Forward (the "> ↪ Forwarded" prefix composed before re-encryption for the
// target channel/DM).
import { describe, it, expect } from 'vitest';
import { formatQuote, buildForwardText, stripAttachmentKeys } from '../components/contextMenuUtils';

describe('formatQuote', () => {
    it('quotes a single line and ends with a newline', () => {
        expect(formatQuote('hello world')).toBe('> hello world\n');
    });

    it('quotes every line of a multiline message', () => {
        expect(formatQuote('first\nsecond\nthird')).toBe('> first\n> second\n> third\n');
    });

    it('preserves interior blank lines as empty quote lines', () => {
        expect(formatQuote('a\n\nb')).toBe('> a\n> \n> b\n');
    });

    it('strips trailing newlines instead of quoting them', () => {
        expect(formatQuote('a\n')).toBe('> a\n');
        expect(formatQuote('a\n\n\n')).toBe('> a\n');
        expect(formatQuote('a\nb\n')).toBe('> a\n> b\n');
    });

    it('quotes empty content to a single empty quote line', () => {
        expect(formatQuote('')).toBe('> \n');
    });

    it('leaves markdown (attachment links, formatting) untouched inside the quote', () => {
        expect(formatQuote('look **at** ![img](enc://abc#key)'))
            .toBe('> look **at** ![img](enc://abc#key)\n');
    });
});

describe('buildForwardText', () => {
    it('prefixes content with the quoted Forwarded marker line', () => {
        expect(buildForwardText('hi there')).toBe('> ↪ Forwarded\nhi there');
    });

    it('keeps multiline content verbatim after the marker', () => {
        expect(buildForwardText('line1\nline2')).toBe('> ↪ Forwarded\nline1\nline2');
    });

    it('forwards attachment markdown byte-for-byte (the embedded key must survive)', () => {
        const attachment = '![file.png](enc://blob123#secretkey)';
        expect(buildForwardText(attachment)).toBe(`> ↪ Forwarded\n${attachment}`);
    });

    it('handles empty content (marker line plus empty body)', () => {
        expect(buildForwardText('')).toBe('> ↪ Forwarded\n');
    });
});

describe('stripAttachmentKeys', () => {
    it('removes the embedded AES key from a sovereign-enc ref, keeping id + mime', () => {
        const ref = 'sovereign-enc:abc123?k=SECRETKEY&m=image%2Fpng';
        expect(stripAttachmentKeys(`![photo](${ref})`))
            .toBe('![photo](sovereign-enc:abc123?m=image%2Fpng)');
    });

    it('drops the query entirely when k was the only param', () => {
        expect(stripAttachmentKeys('[f](sovereign-enc:id9?k=SECRET)'))
            .toBe('[f](sovereign-enc:id9)');
    });

    it('drops the whole payload of a clip ref (the key is inside the packed manifest) and leaves the marker that renders as "clip removed"', () => {
        const href = 'sovereign-clip:v1?AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAAATiAeAA0AAAATSAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB9A';
        const out = stripAttachmentKeys(`look [Clip 0:05](${href}) wow`);
        expect(out).toBe('look [Clip 0:05](sovereign-clip:v1) wow');
        expect(out).not.toContain('AQEBAQ');
    });

    it('scrubs every attachment in a multi-attachment message', () => {
        const s = 'a ![x](sovereign-enc:i1?k=K1&m=text%2Fplain) b ![y](sovereign-enc:i2?k=K2)';
        const out = stripAttachmentKeys(s);
        expect(out).not.toContain('K1');
        expect(out).not.toContain('K2');
        expect(out).toContain('sovereign-enc:i1?m=text%2Fplain');
        expect(out).toContain('sovereign-enc:i2');
    });

    it('leaves ordinary text and non-attachment links untouched', () => {
        const s = 'hi [site](https://example.com?k=notakey) there';
        expect(stripAttachmentKeys(s)).toBe(s);
    });

    it('forward KEEPS the key (it re-encrypts) — only copy/quote strip it', () => {
        const ref = '![p](sovereign-enc:abc?k=SECRET&m=image%2Fpng)';
        expect(buildForwardText(ref)).toContain('k=SECRET');
    });
});

describe('buildForwardText refuses to carry a clip key (review #2)', () => {
    it('scrubs the clip payload even though ordinary attachment keys are kept', () => {
        const href = 'sovereign-clip:v1?AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAAATiAeAA0AAAATSAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB9A';
        const out = buildForwardText(`[Clip 0:05](${href}) and ![p](sovereign-enc:id?k=KEEP)`);
        expect(out).toBe('> ↪ Forwarded\n[Clip 0:05](sovereign-clip:v1) and ![p](sovereign-enc:id?k=KEEP)');
    });
});

describe('replyPreviewText', () => {
    it('summarises a clip post as "Clip · m:ss" instead of leaking the 1.6k href; slices plain text', async () => {
        const { replyPreviewText } = await import('../components/contextMenuUtils');
        const { encodeClipRef } = await import('../api/clips/clipRef');
        const href = encodeClipRef({
            key: new Uint8Array(32).fill(1), noncePrefix: new Uint8Array(8).fill(2), clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
            videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 124_000, width: 1920, height: 1080, totalCipherBytes: 1234,
            parts: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], partDurMs: [0, 124_000],
        });
        expect(replyPreviewText(`[Clip 2:04](${href})`, 50)).toBe('Clip · 2:04');
        expect(replyPreviewText('[Clip 2:04](sovereign-clip:v1)', 50)).toBe('Clip (removed)');
        expect(replyPreviewText('hello world', 5)).toBe('hello...');
        expect(replyPreviewText('hi', 5)).toBe('hi');
    });
});
