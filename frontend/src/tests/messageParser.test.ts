import { describe, it, expect } from 'vitest';
import { parseMessage, extractMentions, isSafeUrl, type Node } from '../utils/messageParser';

// Helper: flatten a node tree back to plain text for concise assertions.
function text(nodes: Node[]): string {
    return nodes
        .map((n) => {
            switch (n.type) {
                case 'text': return n.value;
                case 'code': return n.value;
                case 'codeblock': return n.value;
                case 'url': return n.href;
                case 'link': return n.label;
                case 'image': return n.alt;
                case 'mentionUser': return '@' + n.name;
                case 'mentionEveryone': return '@everyone';
                case 'mentionHere': return '@here';
                case 'channel': return '#' + n.name;
                case 'emoji': return ':' + n.name + ':';
                default: return 'children' in n ? text(n.children) : '';
            }
        })
        .join('');
}

describe('markdown', () => {
    it('parses bold, italic, underline, strike, spoiler', () => {
        expect(parseMessage('**b**')[0]).toMatchObject({ type: 'strong' });
        expect(parseMessage('*i*')[0]).toMatchObject({ type: 'em' });
        expect(parseMessage('__u__')[0]).toMatchObject({ type: 'underline' });
        expect(parseMessage('~~s~~')[0]).toMatchObject({ type: 'strike' });
        expect(parseMessage('||spoiler||')[0]).toMatchObject({ type: 'spoiler' });
    });

    it('nests formatting', () => {
        const nodes = parseMessage('**bold _and italic_**');
        expect(nodes[0].type).toBe('strong');
        const inner = (nodes[0] as Extract<Node, { type: 'strong' }>).children;
        expect(inner.some((n: Node) => n.type === 'em')).toBe(true);
        expect(text(nodes)).toBe('bold and italic');
    });

    it('parses inline code without inner formatting', () => {
        const nodes = parseMessage('use `**not bold**` here');
        const code = nodes.find((n) => n.type === 'code') as Extract<Node, { type: 'code' }>;
        expect(code.value).toBe('**not bold**');
    });

    it('parses fenced code blocks with a language tag', () => {
        const nodes = parseMessage('```js\nconst x = 1;\n```');
        expect(nodes[0]).toMatchObject({ type: 'codeblock', lang: 'js', value: 'const x = 1;' });
    });

    it('parses fenced code block without a language', () => {
        const nodes = parseMessage('```\nplain\n```');
        expect(nodes[0]).toMatchObject({ type: 'codeblock', lang: null, value: 'plain' });
    });

    it('parses blockquotes', () => {
        const nodes = parseMessage('> quoted line');
        expect(nodes[0].type).toBe('blockquote');
        expect(text(nodes)).toBe('quoted line');
    });

    it('parses links and bare URLs', () => {
        expect(parseMessage('[site](https://example.com)')[0]).toMatchObject({
            type: 'link', href: 'https://example.com', label: 'site',
        });
        const bare = parseMessage('see https://example.com/x now');
        expect(bare.find((n) => n.type === 'url')).toMatchObject({ href: 'https://example.com/x' });
    });

    it('does not let user text spoof the old placeholder scheme', () => {
        // Previously `__BOLD_0__` could impersonate rendered markup.
        const nodes = parseMessage('literally __BOLD_0__ text');
        // Rendered text must contain the raw string, not a bold node from index 0.
        expect(text(nodes)).toContain('BOLD_0');
    });
});

describe('mentions & channels', () => {
    it('parses user, everyone, here mentions and channels', () => {
        const nodes = parseMessage('hey @alice and @everyone in #general');
        expect(nodes.some((n) => n.type === 'mentionUser' && n.name === 'alice')).toBe(true);
        expect(nodes.some((n) => n.type === 'mentionEveryone')).toBe(true);
        expect(nodes.some((n) => n.type === 'channel' && n.name === 'general')).toBe(true);
    });

    it('parses @here distinctly from @herevariant', () => {
        expect(parseMessage('@here')[0].type).toBe('mentionHere');
        // @heretic should be a user mention "heretic", not @here + tic
        const m = parseMessage('@heretic');
        expect(m[0]).toMatchObject({ type: 'mentionUser', name: 'heretic' });
    });

    it('extractMentions collects names and everyone flag', () => {
        const res = extractMentions('@alice **@bob** hi @everyone');
        expect(res.users.sort()).toEqual(['alice', 'bob']);
        expect(res.everyone).toBe(true);
    });

    it('parses shortcode emoji', () => {
        expect(parseMessage(':smile:')[0]).toMatchObject({ type: 'emoji', name: 'smile' });
    });
});

describe('robustness', () => {
    it('returns empty for empty input', () => {
        expect(parseMessage('')).toEqual([]);
    });

    it('treats unclosed delimiters as literal text', () => {
        expect(text(parseMessage('**unclosed'))).toBe('**unclosed');
        expect(text(parseMessage('a * b * c')).replace(/\s+/g, ' ')).toBe('a b c'.replace('b', 'b'));
    });

    it('handles plain text unchanged', () => {
        expect(text(parseMessage('just a normal sentence.'))).toBe('just a normal sentence.');
    });

    it('does not crash on adversarial nesting', () => {
        const evil = '*'.repeat(500) + 'x' + '*'.repeat(500);
        expect(() => parseMessage(evil)).not.toThrow();
    });
});

// Link/image scheme allowlist — the javascript: (and data:/vbscript:) link XSS
// that would run attacker JS in the app origin, reading the JWT + E2EE seed from
// localStorage. A dangerous scheme must NEVER become a clickable href. (audit H7)
describe('link scheme safety (H7)', () => {
    it('does NOT produce an executable href for [x](javascript:alert(1))', () => {
        const nodes = parseMessage('[x](javascript:alert(1))');
        // No link node at all — the label survives as plain text, no href emitted.
        expect(nodes.some((n) => n.type === 'link')).toBe(false);
        const anyHref = JSON.stringify(nodes).toLowerCase();
        expect(anyHref).not.toContain('javascript:');
        expect(text(nodes)).toContain('x'); // label survives as plain text
    });

    it('neutralizes a javascript: image to plain alt text', () => {
        const nodes = parseMessage('![pwn](javascript:alert(1))');
        expect(nodes.some((n) => n.type === 'image')).toBe(false);
        expect(JSON.stringify(nodes).toLowerCase()).not.toContain('javascript:');
    });

    it('blocks data: and vbscript: too, and ignores leading whitespace/control tricks', () => {
        expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
        expect(isSafeUrl('JavaScript:alert(1)')).toBe(false); // case-insensitive
        expect(isSafeUrl('\t\n javascript:alert(1)')).toBe(false); // leading controls stripped
    });

    it('still allows http/https/mailto and the sovereign-enc attachment scheme', () => {
        const nodes = parseMessage('[ok](https://example.com/page)');
        expect(nodes[0]).toMatchObject({ type: 'link', href: 'https://example.com/page' });
        expect(isSafeUrl('http://example.com')).toBe(true);
        expect(isSafeUrl('https://example.com')).toBe(true);
        expect(isSafeUrl('mailto:a@b.com')).toBe(true);
        expect(isSafeUrl('sovereign-enc:abc?k=key&m=image%2Fpng')).toBe(true);
        expect(isSafeUrl('/relative/path')).toBe(true); // scheme-less → same-origin
    });

    /**
     * `//evil.com/x` has NO scheme, so the scheme allowlist never sees it — but
     * the browser resolves it against the page's own scheme and loads it
     * cross-origin. The old comment on that branch claimed scheme-less meant
     * same-origin; for a protocol-relative authority that is simply false, and
     * it made `[x](//evil.com)` a live target=_blank anchor and
     * `![x](//evil.com/a.png)` a remote image request.
     */
    it('refuses a protocol-relative authority, which is NOT same-origin', () => {
        expect(isSafeUrl('//evil.com')).toBe(false);
        expect(isSafeUrl('//evil.com/a.png')).toBe(false);
        // The control-character skip must not smuggle one past either.
        expect(isSafeUrl('\t//evil.com')).toBe(false);
        expect(isSafeUrl('\n\r  //evil.com')).toBe(false);
        // A scheme-relative URL is still refused when it carries credentials.
        expect(isSafeUrl('//user:pw@evil.com/x')).toBe(false);
    });

    it('still allows genuinely relative hrefs (the regression this must not cause)', () => {
        expect(isSafeUrl('/x')).toBe(true);
        expect(isSafeUrl('x.png')).toBe(true);
        expect(isSafeUrl('./a/b')).toBe(true);
        expect(isSafeUrl('../up')).toBe(true);
        expect(isSafeUrl('#anchor')).toBe(true);
        expect(isSafeUrl('?q=1')).toBe(true);
        expect(isSafeUrl('')).toBe(true);
    });

    it('a protocol-relative link or image degrades to plain text', () => {
        const link = parseMessage('[x](//evil.com)');
        expect(link.some((n) => n.type === 'link')).toBe(false);
        expect(link).toEqual([{ type: 'text', value: 'x' }]);
        const img = parseMessage('![x](//evil.com/a.png)');
        expect(img.some((n) => n.type === 'image')).toBe(false);
        expect(JSON.stringify(img)).not.toContain('evil.com');
    });
});
