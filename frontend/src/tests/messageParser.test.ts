import { describe, it, expect } from 'vitest';
import { parseMessage, extractMentions, isSafeUrl, type Node } from '../utils/messageParser';
import { parseMessage as parsedAsItWas } from './fixtures/messageParserAsItWas';

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

/** Every address in a message, as the message links it. */
function hrefs(content: string): string[] {
    const out: string[] = [];
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if (n.type === 'url' || n.type === 'link' || n.type === 'image') out.push(n.href);
            else if ('children' in n) walk(n.children);
        }
    };
    walk(parseMessage(content));
    return out;
}

describe('an address ending in a bracket it opened keeps it', () => {
    const RUST = 'https://example.org/wiki/Rust_(programming_language)';

    it.each([
        ['alone', RUST, RUST],
        ['in a sentence', `read ${RUST} today`, RUST],
        ['at the end of a sentence', `read ${RUST}.`, RUST],
        ['before a comma', `${RUST}, and more`, RUST],
        ['in brackets', `(see ${RUST})`, RUST],
        ['in brackets, and a full stop', `(see ${RUST}).`, RUST],
        ['in bold', `**${RUST}**`, RUST],
        ['(v=vs.85)', 'https://example.org/library/ms123(v=vs.85)', 'https://example.org/library/ms123(v=vs.85)'],
        ['one with a full stop in it', 'https://example.org/wiki/Speaker_(U.S.)', 'https://example.org/wiki/Speaker_(U.S.)'],
        ['two in one address', 'https://example.org/a_(b)_(c)', 'https://example.org/a_(b)_(c)'],
        ['one inside another', 'https://example.org/a_(b_(c))', 'https://example.org/a_(b_(c))'],
        ['one after a stray one', 'https://example.org/a)(b)', 'https://example.org/a)(b)'],
    ])('%s', (_, content, href) => {
        expect(hrefs(content)).toEqual([href]);
    });

    it('the bracket after it is still words', () => {
        expect(parseMessage(`(see ${RUST})`)).toEqual([
            { type: 'text', value: '(see ' },
            { type: 'url', href: RUST },
            { type: 'text', value: ')' },
        ]);
    });

    it.each([
        ['closes a bracket before the address', '(https://example.org/a)', 'https://example.org/a'],
        ['and a full stop', '(https://example.org/a).', 'https://example.org/a'],
        ['with a full stop inside', '(https://example.org/a.)', 'https://example.org/a'],
        ['an address with no bracket of its own', 'https://example.org/a)', 'https://example.org/a'],
        ['one opened and never closed', 'https://example.org/a(b, and then c)', 'https://example.org/a(b'],
    ])('CONTROL: a bracket that is not the address\'s: %s', (_, content, href) => {
        expect(hrefs(content)).toEqual([href]);
    });
});

describe('a delimiter in the words before an address does not close inside it', () => {
    it.each([
        ['my_file is at ', 'https://example.org/my_file.txt'],
        ['API_URL=', 'https://example.org/v1_beta'],
        ['my_repo: ', 'https://example.org/me/my_repo'],
        ['a__b at ', 'https://example.org/a__b'],
        ['5*3 is at ', 'https://example.org/a*b'],
        ['a**b is at ', 'https://example.org/a**b'],
        ['old~~name: ', 'https://example.org/old~~name'],
    ])('%s%s', (words, href) => {
        expect(parseMessage(words + href)).toEqual([{ type: 'text', value: words }, { type: 'url', href }]);
    });

    it('it closes after the address', () => {
        expect(parseMessage('_see https://example.org/a_b now_')).toEqual([
            { type: 'em', children: [{ type: 'text', value: 'see ' }, { type: 'url', href: 'https://example.org/a_b' }, { type: 'text', value: ' now' }] },
        ]);
        expect(parseMessage('~~see https://example.org/a~~b~~ more')).toEqual([
            { type: 'strike', children: [{ type: 'text', value: 'see ' }, { type: 'url', href: 'https://example.org/a~~b' }] },
            { type: 'text', value: ' more' },
        ]);
    });

    it('a link\'s target is an address too', () => {
        expect(parseMessage('_a [the link](https://example.org/b_c) d_')).toEqual([
            { type: 'em', children: [{ type: 'text', value: 'a ' }, { type: 'link', label: 'the link', href: 'https://example.org/b_c' }, { type: 'text', value: ' d' }] },
        ]);
    });

    it.each([
        ['**', 'strong'],
        ['*', 'em'],
        ['__', 'underline'],
        ['_', 'em'],
        ['~~', 'strike'],
    ])('it closes inside when the address ends with it: %s', (d, type) => {
        const href = 'https://example.org/a';
        const wrapped = { type, children: [{ type: 'url', href }] };
        expect(parseMessage(`${d}${href}${d}`)).toEqual([wrapped]);
        expect(parseMessage(`${d}${href}${d}, and more`)).toEqual([wrapped, { type: 'text', value: ', and more' }]);
        // URL_RE takes these into the address. They are the sentence's.
        expect(parseMessage(`${d}${href}${d}!`)).toEqual([wrapped, { type: 'text', value: '!' }]);
        expect(parseMessage(`${d}${href}${d}?`)).toEqual([wrapped, { type: 'text', value: '?' }]);
        expect(parseMessage(`${d}${href}${d}-- more`)).toEqual([wrapped, { type: 'text', value: '-- more' }]);
    });

    it('it closes at the end of an address that holds another of it', () => {
        expect(hrefs('**https://example.org/a**b**')).toEqual(['https://example.org/a**b']);
        expect(hrefs('_https://example.org/a_b_')).toEqual(['https://example.org/a_b']);
        expect(parseMessage('***https://example.org/a***')).toEqual([
            { type: 'strong', children: [{ type: 'em', children: [{ type: 'url', href: 'https://example.org/a' }] }] },
        ]);
    });

    it('CONTROL: one with more of the address after it is the address\'s', () => {
        expect(hrefs('**https://example.org/a**b')).toEqual(['https://example.org/a**b']);
        expect(hrefs('_https://example.org/a_/b')).toEqual(['https://example.org/a_/b']);
    });
});

describe('a spoiler never stops being one', () => {
    type Parsed = { type: string; href?: string; children?: Parsed[] };
    /** What a parse hides and what it prints, by the words in it. */
    const words = (node: unknown) => JSON.stringify(node).match(/w\d+/g) ?? [];
    const hiddenBy = (nodes: Parsed[], out = new Set<string>()) => {
        for (const n of nodes) {
            if (n.type === 'spoiler') for (const w of words(n)) out.add(w);
            else if (n.children) hiddenBy(n.children, out);
        }
        return out;
    };
    const printedBy = (nodes: Parsed[], out = new Set<string>()) => {
        for (const n of nodes) {
            if (n.type === 'spoiler') continue;
            if (n.children) printedBy(n.children, out);
            else for (const w of words(n)) out.add(w);
        }
        return out;
    };
    /** The words the parser as it was hid in `content` that `nodes` prints. */
    const leaked = (content: string, nodes: Parsed[]) => {
        const printed = printedBy(nodes);
        return [...hiddenBy(parsedAsItWas(content))].filter(w => printed.has(w));
    };
    /** The addresses under a spoiler, and those not. */
    const addresses = (content: string) => {
        const hidden: string[] = [];
        const shown: string[] = [];
        const walk = (nodes: Node[], under: boolean) => {
            for (const n of nodes) {
                if (n.type === 'url') (under ? hidden : shown).push(n.href);
                else if ('children' in n) walk(n.children, under || n.type === 'spoiler');
            }
        };
        walk(parseMessage(content), false);
        return { hidden, shown };
    };

    it.each([
        ['||https://example.org/the-butler||', 'https://example.org/the-butler'],
        ['||https://example.org/the-butler||!', 'https://example.org/the-butler'],
        ['||https://example.org/the-butler||-- more', 'https://example.org/the-butler'],
        ['||https://example.org/the-butler||b', 'https://example.org/the-butler'],
        ['||https://example.org/a_b||', 'https://example.org/a_b'],
        ['**||https://example.org/the-butler||**', 'https://example.org/the-butler'],
        ['**||https://example.org/the-butler||**!', 'https://example.org/the-butler'],
        ['_||https://example.org/a_b||_', 'https://example.org/a_b'],
        ['_||https://example.org/a_b||_!', 'https://example.org/a_b'],
        ['> ||https://example.org/the-butler||!', 'https://example.org/the-butler'],
    ])('%s', (content, href) => {
        expect(addresses(content)).toEqual({ hidden: [href], shown: [] });
    });

    it('two in one line', () => {
        expect(addresses('||https://example.org/a|| and ||https://example.org/b_c||!')).toEqual({
            hidden: ['https://example.org/a', 'https://example.org/b_c'],
            shown: [],
        });
        expect(addresses('||https://example.org/a||!||https://example.org/b||!')).toEqual({
            hidden: ['https://example.org/a', 'https://example.org/b'],
            shown: [],
        });
    });

    it('beside words and an address the delimiter is stepped over for, each is what it should be', () => {
        expect(addresses('my_file at https://example.org/my_file ||https://example.org/hidden||')).toEqual({
            hidden: ['https://example.org/hidden'],
            shown: ['https://example.org/my_file'],
        });
        expect(addresses('||https://example.org/hidden|| my_file at https://example.org/my_file')).toEqual({
            hidden: ['https://example.org/hidden'],
            shown: ['https://example.org/my_file'],
        });
        expect(addresses('my_file ||https://example.org/hidden|| https://example.org/my_file')).toEqual({
            hidden: ['https://example.org/hidden'],
            shown: ['https://example.org/my_file'],
        });
    });

    it('the address gives way before the spoiler does: a `_` in the spoiler, or a `||` in the address', () => {
        // Stepping over the address would close the `_` inside the spoiler.
        expect(hiddenBy(parseMessage('w0_w1 https://example.org/w2_w3 ||w4_w5||'))).toEqual(new Set(['w4', 'w5']));
        expect(hiddenBy(parseMessage('_https://example.org/w0_w1||w2||_'))).toEqual(new Set(['w2']));
    });

    // What goes wrong, in any order. Everything the parser as it was hid must not be printed now.
    const PARTS = ['||', '||', '||', '**', '*', '__', '_', '_', '~~', '`', ' ', ' ', ' ', 'W', 'W', 'W',
        'https://x/W', 'https://x/W_W', 'https://x/W*W', 'https://x/W~~W', 'Https://x/W', 'Https://x/W_W',
        'HTTP://x/W*W', 'https://x/W||W', 'Https://x/W||W', ':', '://', ':https:', '//', ':W_W:', '@W', '#W_W',
        '(', ')', '[W](', ']', '![W](', '!', '.', ',', '>', '"', '<', '\n', '> ', 'W_W', 'W*W', 'W~~W',
        'https://x/(W', 'https://x/W)', 'Link:https://x/W_W', 'Link:Https://x/W', '[W](https://x/(W)', '-', '?'];

    it('as a property, over text made of what goes wrong', () => {
        let seed = 20261103;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        let spoilers = 0;
        const bad: string[] = [];
        for (let k = 0; k < 150000; k++) {
            let id = 0;
            let content = '';
            for (let j = 1 + next(10); j > 0; j--) content += PARTS[next(PARTS.length)].replace(/W/g, () => `w${id++}`);
            if (hiddenBy(parsedAsItWas(content)).size) spoilers++;
            const out = leaked(content, parseMessage(content));
            if (out.length) bad.push(`${JSON.stringify(content)} prints ${out.join(', ')}`);
        }
        expect(bad).toEqual([]);
        // Over nothing it would prove nothing.
        expect(spoilers).toBeGreaterThan(5000);
    });

    it('CONTROL: the check finds words that are printed, and leaves alone words that are not', () => {
        expect(leaked('||w0||', parseMessage('w0'))).toEqual(['w0']);
        expect(leaked('||w0|| w1', parseMessage('||w0|| w1'))).toEqual([]);
        // What stepping over this address with no care would give: the address takes the spoiler in.
        expect(leaked('w0_https://x/w1_w2||w3||', [{ type: 'url', href: 'https://x/w1_w2||w3||' }])).toEqual(['w3']);
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
