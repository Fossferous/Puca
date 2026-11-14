import { describe, it, expect } from 'vitest';
import { parseMessage, parseMessageUncached, extractMentions, isSafeUrl, spoilerSpan, typedSpan, urlAt, type Node } from '../utils/messageParser';
import { messageMentionsUser } from '../utils/messageMentions';
import { extractUrls } from '../api/linkPreview';
import { parseMessage as parsedAsItWas } from './fixtures/messageParserAsItWas';
import { parseMessage as parsedAt855 } from './fixtures/messageParserAt855';
import { parseMessage as parsedAt857, spoilerSpan as spoilerSpanAt857 } from './fixtures/messageParserAt857';

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

    it('a quote takes every quoted line after it, and stops at the first that is not', () => {
        expect(parseMessage('> a\n>\n> b\nc\n> d')).toEqual([
            { type: 'blockquote', children: [{ type: 'text', value: 'a\n\nb' }] },
            { type: 'text', value: 'c\n' },
            { type: 'blockquote', children: [{ type: 'text', value: 'd' }] },
        ]);
    });

    it.each(['>', '> ', '>\n', '> a\n', '> a\n> b', '> a\n>\n> b', '> a\n\n> b', '>\n>\n', '>\n\n>\n\n', '> a\n>b', '>a\n> b', 'a\n> b\nc', '> a\r\n> b', '> a\n> b\n\n'])(
        'a quote ends where it always did: %j',
        (content) => {
            expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        },
    );

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

/** Every address in these nodes. */
function hrefsIn(nodes: Node[]): string[] {
    return nodes.flatMap(n => (n.type === 'url' || n.type === 'link' || n.type === 'image' ? [n.href] : 'children' in n ? hrefsIn(n.children) : []));
}

/** Every address in a message, as the message links it. */
function hrefs(content: string): string[] {
    return hrefsIn(parseMessage(content));
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
    ])('%s%s', (words, href) => {
        expect(parseMessage(words + href)).toEqual([{ type: 'text', value: words }, { type: 'url', href }]);
    });

    it('it closes after the address', () => {
        expect(parseMessage('_see https://example.org/a_b now_')).toEqual([
            { type: 'em', children: [{ type: 'text', value: 'see ' }, { type: 'url', href: 'https://example.org/a_b' }, { type: 'text', value: ' now' }] },
        ]);
        expect(parseMessage('__see https://example.org/a__b__ more')).toEqual([
            { type: 'underline', children: [{ type: 'text', value: 'see ' }, { type: 'url', href: 'https://example.org/a__b' }] },
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
        expect(hrefs('_https://example.org/a_b_')).toEqual(['https://example.org/a_b']);
        expect(parseMessage('***https://example.org/a***')).toEqual(parsedAsItWas('***https://example.org/a***'));
    });

    it.each([
        ['**', 'strong'],
        ['*', 'em'],
        ['~~', 'strike'],
    ])('an opener right up against the address closes at the first one, whatever is glued on: %s', (d, type) => {
        const href = 'https://example.org/a';
        const wrapped = { type, children: [{ type: 'url', href }] };
        for (const after of ['\'s page', '-based', '2', '/b', 's', '\u3092\u898b\u3066']) {
            expect(parseMessage(`${d}${href}${d}${after}`)).toEqual([wrapped, { type: 'text', value: after }]);
        }
        expect(extractMentions(`${d}${href}${d}@bob`).users).toEqual(['bob']);
        expect(extractMentions(`${d}${href}${d}/@everyone`).everyone).toBe(true);
    });

    it('CONTROL: `_` and `__` are in real addresses, so more of the address after one is the address\'s', () => {
        expect(hrefs('_https://example.org/a_b')).toEqual(['https://example.org/a_b']);
        expect(hrefs('__https://example.org/a__b')).toEqual(['https://example.org/a__b']);
        expect(hrefs('_https://example.org/a_2')).toEqual(['https://example.org/a_2']);
        expect(hrefs('_https://example.org/a_/')).toEqual(['https://example.org/a_/']);
        expect(hrefs('_https://example.org/a_/b')).toEqual(['https://example.org/a_/b']);
        // A word in any script: this address is the bug this fix is for, not bold around one.
        expect(hrefs('my_file https://example.org/\u6771\u4eac_\u30bf\u30ef\u30fc')).toEqual(['https://example.org/\u6771\u4eac_\u30bf\u30ef\u30fc']);
    });

    // `*` and `~` are next to never in a real address, and stepping over one cost what
    // people do write: bold around an address or a link with something glued on after it.
    it.each([
        ['5*3 is at https://example.org/a*b'],
        ['a**b is at https://example.org/a**b'],
        ['old~~name: https://example.org/old~~name'],
        ['**https://example.org/a**b**'],
        ['~~see https://example.org/a~~b~~ more'],
        ['*see https://example.org/a*@everyone'],
    ])('every delimiter but `_` closes at the first one, as it always did: %s', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each([
        ['**', 'strong'],
        ['*', 'em'],
        ['~~', 'strike'],
    ])('words before the address, or a link, and something glued on after: %s', (d, type) => {
        const href = 'https://example.org/a';
        const link = { type: 'link', label: 'docs', href };
        for (const after of ['\'s page', '-based', 's', '\u3092\u898b\u3066']) {
            expect(parseMessage(`${d}see ${href}${d}${after}`)).toEqual([
                { type, children: [{ type: 'text', value: 'see ' }, { type: 'url', href }] },
                { type: 'text', value: after },
            ]);
            expect(parseMessage(`${d}[docs](${href})${d}${after}`)).toEqual([
                { type, children: [link] },
                { type: 'text', value: after },
            ]);
        }
    });

    it('two with a word between them are two', () => {
        const a = 'https://example.org/a';
        const b = 'https://example.org/b';
        expect(hrefs(`**${a}**\u3068**${b}**`)).toEqual([a, b]);
        expect(hrefs(`**${a}**and**${b}**`)).toEqual([a, b]);
    });

    it.each([
        ['**', 'strong', ','],
        ['**', 'strong', '/'],
        ['**', 'strong', '|'],
        ['*', 'em', ','],
        ['_', 'em', ','],
        ['__', 'underline', ','],
        ['~~', 'strike', ','],
    ])('two in one word, with only a mark between them, are two: %s%s%s', (d, type, mark) => {
        const a = 'https://example.org/a';
        const b = 'https://example.org/b';
        expect(parseMessage(`${d}${a}${d}${mark}${d}${b}${d}`)).toEqual([
            { type, children: [{ type: 'url', href: a }] },
            { type: 'text', value: mark },
            { type, children: [{ type: 'url', href: b }] },
        ]);
    });

    it('CONTROL: an address in an address is one, with no closer and opener in it', () => {
        const href = 'https://example.org/web/2020/https://example.org/a_b';
        expect(parseMessage(`_${href}_`)).toEqual([{ type: 'em', children: [{ type: 'url', href }] }]);
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
    /** The words a parser before this one (the one as it was, by default) hid in `content` that `nodes` prints. */
    const leaked = (content: string, nodes: Parsed[], before: (content: string) => Parsed[] = parsedAsItWas) => {
        const printed = printedBy(nodes);
        return [...hiddenBy(before(content))].filter(w => printed.has(w));
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

    it('it closes at the first `||`, even one in an address with more after it', () => {
        expect(parseMessage('||a https://example.org/b||c d||')).toEqual([
            { type: 'spoiler', children: [{ type: 'text', value: 'a ' }, { type: 'url', href: 'https://example.org/b' }] },
            { type: 'text', value: 'c d||' },
        ]);
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

    it('neither the address nor the spoiler gives way: a `_` in the spoiler, or a `||` in the address', () => {
        expect(addresses('w0_w1 https://example.org/w2_w3 ||https://example.org/w4_w5||')).toEqual({
            hidden: ['https://example.org/w4_w5'],
            shown: ['https://example.org/w2_w3'],
        });
        expect(parseMessage('_https://example.org/w0_w1||w2||_')).toEqual([{
            type: 'em',
            children: [{ type: 'url', href: 'https://example.org/w0_w1' }, { type: 'spoiler', children: [{ type: 'text', value: 'w2' }] }],
        }]);
    });

    it.each([
        // The address's `||` takes the spoiler's as its pair, and what it hides is one space.
        ['https://x.invalid/a|| ||secret||'],
        ['http://>|| ||secret||'],
        // A `>` or `"` leaves too little of a short address, so a delimiter in it comes alive.
        ['https://`> ||secret||`'],
        ['https://[> ||secret](x)||'],
        // A word shaped like an address and not read as one, with a `[` or a backtick in it.
        ['my_file https://[ ||the butler|| https://x.invalid/d_e](f)'],
        // A link takes the spoiler into its target.
        ['[a](https://x/(b)||secret||)'],
        // In a quote too, and a fence in the spoiler is as it was: a reading as it was is that.
        ['> https://x.invalid/a|| ||```secret```||'],
    ])('it is read as it was where the better reading would print it and hide nothing it did not: %s', (content) => {
        expect(JSON.stringify(parsedAsItWas(content))).toContain('"spoiler"');
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each<[string, string[]]>([
        // Each one hid what the other prints: there is no telling which `||` pairs with which.
        ['my_file ||w0_w1|| and ||w2_w3||', ['w0', 'w1', 'w2', 'w3']],
        ['my_file ||w0_w1|| and ||w2||', ['w0', 'w1', 'w2']],
        ['w0*w1 ||w2*w3|| and ||w4*w5||', ['w2', 'w3', 'w4', 'w5']],
        ['||```\nw0\n```|| and ||w1||', ['w0', 'w1']],
        ['||w0\n> w1\nw2|| and ||w3||', ['w0', 'w1', 'w2', 'w3']],
        ['my_file ||w0_w1|| w2 || w3', ['w0', 'w1', 'w2']],
        // The stretches run from the first `||` to the last, and neither of those is an `or`.
        ['my_file ||w0_w1|| w2 || w3\n> w4\nw5 || w6', ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']],
        // A `||` in the words takes the next `||` as its pair, once no delimiter takes it first.
        ['**a||w0** ||w1||', ['w0', 'w1']],
        ['*a||w0* ||w1||', ['w0', 'w1']],
        ['_a||w0_ ||w1||', ['w0', 'w1']],
        ['__a||w0__ ||w1||', ['w0', 'w1']],
        ['~~a||w0~~ ||w1||', ['w0', 'w1']],
        // A closer that moved re-pairs the delimiters in later addresses.
        ['_use https://x.invalid/a_b or _a || w0 at https://x.invalid/c_d ||w1 w2||', ['w0', 'w1', 'w2']],
        ['*https://x.invalid/a*b *||w0 https://x.invalid/d* ||w1||', ['w0', 'w1']],
        ['~~https://x.invalid/a~~~~ ||https://x.invalid/w0~~ ||w1||', ['w0', 'w1']],
    ])('where each hides what the other prints, nothing either hid is printed: %s', (content, hidden) => {
        const read = parseMessage(content);
        expect([...hiddenBy(read)].sort()).toEqual(hidden);
        expect(leaked(content, read)).toEqual([]);
        expect([...printedBy(read)].filter(w => hidden.includes(w))).toEqual([]);
    });

    it('where each hides what the other prints, each stretch is a spoiler of its own, with no `||` left to see', () => {
        const spoiler = (...children: unknown[]) => ({ type: 'spoiler', children });
        const said = (value: string) => ({ type: 'text', value });
        expect(parseMessage('my_file ||a_b|| and ||c_d||')).toEqual([said('my_file '), spoiler(said('a_b')), spoiler(said(' and ')), spoiler(said('c_d'))]);
        expect(parseMessage('my_file ||a_b|| and ||c_d|| more')).toEqual([said('my_file '), spoiler(said('a_b')), spoiler(said(' and ')), spoiler(said('c_d')), said(' more')]);
        expect(parseMessage('||```\na\n```|| and ||b||')).toEqual([
            spoiler({ type: 'codeblock', value: 'a', lang: null }),
            spoiler(said(' and ')),
            spoiler(said('b')),
        ]);
        // CONTROL: the first `_` closes nothing in it, so nothing is in question.
        expect(parseMessage('my_file ||a|| and ||c_d||')).toEqual([said('my_file '), spoiler(said('a')), said(' and '), spoiler(said('c_d'))]);
    });

    it.each([
        ['see <https://*> and ||the *butler* did it||'],
        ['<https://*> ||https://example.org/the-butler*||'],
        ['https://_> ||_secret||'],
        ['https://.>_a ||secret_ c||'],
        ['_Https://x/[||secret||https://x/a_](b)'],
        ['_https://x.invalid/a_`b Https://x.invalid/`||`secret||'],
        ['_Https://example.org/[||https://example.org/hiddenword||_](y)'],
        ['Https://example.org/a||secret||'],
        ['Link:https://example.org/a||secret||'],
        ['my_file at https://example.org/my_file ||secret_word||'],
        ['**my_file at https://example.org/my_file ||secret_word||**'],
        ['> my_file at https://example.org/my_file ||secret_word||'],
        ['_||https://example.org/a|| https://example.org/b_c ||secret_ d||'],
    ])('the better reading keeps what it hid, with no need to read as it was: %s', (content) => {
        const hidden = (nodes: Node[]): string[] => nodes.flatMap(n => (n.type === 'spoiler' ? [text([n])] : 'children' in n ? hidden(n.children) : []));
        expect(hidden(parseMessage(content))).toEqual(hidden(parsedAsItWas(content)));
        expect(parseMessage(content)).not.toEqual(parsedAsItWas(content));
    });

    it('the better reading is kept where it loses nothing', () => {
        const content = 'a*b Https://example.org/c_d https://example.org/e*f ||https://example.org/g_h|| and ||the butler did it||';
        expect(addresses(content)).toEqual({
            hidden: ['https://example.org/g_h'],
            shown: ['Https://example.org/c_d', 'https://example.org/e'],
        });
        expect(parseMessage(content).filter(n => n.type === 'spoiler').map(n => text([n]))).toEqual(['https://example.org/g_h', 'the butler did it']);
    });

    it.each([
        ['a word', 'secret'],
        ['a word in another script', '\u79d8\u5bc6'],
        ['a mark', ':)'],
        ['code', '`secret`'],
        ['an address', 'https://example.org/secret'],
        ['a link', '[secret](x)'],
        ['a link\'s address', '[x](secret)'],
        ['a picture', '![secret](x)'],
        ['someone mentioned', '@secret'],
        ['everyone', '@everyone'],
        ['here', '@here'],
        ['a channel', '#secret'],
        ['an emoji', ':secret:'],
    ])('whatever it hid counts: %s', (_, hidden) => {
        // The address's `||` takes this spoiler's first `||` as its pair, hides one space, and it all prints.
        const content = `https://x.invalid/a|| ||${hidden}||`;
        expect(parsedAsItWas(content).some(n => n.type === 'spoiler')).toBe(true);
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it('a word it hid twice has to stay hidden twice, wherever else it is said', () => {
        const content = '||a|| https://x.invalid/b|| ||a||';
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        expect(parseMessage(content).filter(n => n.type === 'spoiler')).toHaveLength(2);
    });

    it('CONTROL: a word it did not hide is free to be read better, and one it would still hide is too', () => {
        // Every word of the spoiler is hidden both ways, and the address is whole.
        expect(addresses('my_file ||https://example.org/hidden|| https://example.org/my_file').shown).toEqual(['https://example.org/my_file']);
        // Nothing was hidden: this was never a spoiler, and now it is.
        expect(parsedAsItWas('_||https://example.org/a_b||_').some(n => n.type === 'spoiler')).toBe(false);
        expect(addresses('_||https://example.org/a_b||_').hidden).toEqual(['https://example.org/a_b']);
    });

    it.each([
        // 0.9.855 read the address whole and the `||` in the bold as words; the parser as it
        // was closed a `_` in the address and hid nothing, so it had nothing to hold this to.
        ['see config_file, **staging || prod** only: ||https://x.org/w0_w1||'],
        ['Https://x.org/a_b **staging || prod** ||w0_w1||'],
        ['Link:https://x.org/a_b **staging || prod** ||w0_w1||'],
        ['*staging || prod* Https://x.org/a_b ||![w0.png](sovereign-enc:abc?k=w1_w2&m=image%2Fpng&c=w3_w4)||'],
    ])('what 0.9.855 hid stays hidden, where the parser as it was hid none of it: %s', (content) => {
        expect(hiddenBy(parsedAsItWas(content)).size).toBe(0);
        const then = [...hiddenBy(parsedAt855(content))];
        expect(then.length).toBeGreaterThan(0);
        expect(leaked(content, parseMessage(content), parsedAt855)).toEqual([]);
        expect([...hiddenBy(parseMessage(content))]).toEqual(expect.arrayContaining(then));
    });

    it('a picture 0.9.855 drew is drawn, with no key printed, where the parser as it was lost it', () => {
        const href = 'sovereign-enc:abc?k=AA_BB&m=image%2Fpng&c=CC_DD';
        const content = `Https://x.org/a_b **staging||prod** ||e|| \`f||g\` ![p.png](${href})`;
        expect(hrefsIn(parsedAsItWas(content))).not.toContain(href);
        expect(hrefsIn(parsedAt855(content))).toContain(href);
        expect(hrefs(content)).toContain(href);
        expect(text(parseMessage(content))).not.toMatch(/AA|BB|CC/);
    });

    // What goes wrong, in any order. Everything either parser before this one hid must not be printed now.
    const PARTS = ['||', '||', '||', '**', '*', '__', '_', '_', '~~', '`', ' ', ' ', ' ', 'W', 'W', 'W',
        'https://x/W', 'https://x/W_W', 'https://x/W*W', 'https://x/W~~W', 'Https://x/W', 'Https://x/W_W',
        'HTTP://x/W*W', 'https://x/W||W', 'Https://x/W||W', ':', '://', ':https:', '//', ':W_W:', '@W', '#W_W',
        '(', ')', '[W](', ']', '![W](', '!', '.', ',', '>', '"', '<', '\n', '> ', 'W_W', 'W*W', 'W~~W',
        'https://x/(W', 'https://x/W)', 'Link:https://x/W_W', 'Link:Https://x/W', '[W](https://x/(W)', '-', '?',
        'https://*>', 'https://_>', 'https://[', 'https://`>', 'Https://x/[W', 'https://x/W**', 'https://x/W>_W', 'https://x/W"*W',
        '@W_', '@W_.', '#W_'];

    it.each<[number, number, string]>([
        [20261103, 10, ''],
        [8, 10, ''],
        [5, 16, ''],
        [1, 24, ''],
        [2, 40, ''],
        [3, 16, ' '],
        [4, 40, ' '],
    ])('as a property, over text made of what goes wrong: seed %i, up to %i parts, joined by "%s"', (start, parts, between) => {
        let seed = start;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        let spoilers = 0;
        let spoilersAt855 = 0;
        const bad: string[] = [];
        for (let k = 0; k < 30000; k++) {
            let id = 0;
            const pieces: string[] = [];
            for (let j = 1 + next(parts); j > 0; j--) pieces.push(PARTS[next(PARTS.length)].replace(/W/g, () => `w${id++}`));
            const content = pieces.join(between);
            if (hiddenBy(parsedAsItWas(content)).size) spoilers++;
            if (hiddenBy(parsedAt855(content)).size) spoilersAt855++;
            const read = parseMessage(content);
            const out = [...new Set([...leaked(content, read), ...leaked(content, read, parsedAt855)])];
            if (out.length) bad.push(`${JSON.stringify(content)} prints ${out.join(', ')}`);
        }
        expect(bad).toEqual([]);
        // Over nothing it would prove nothing.
        expect(spoilers).toBeGreaterThan(500);
        expect(spoilersAt855).toBeGreaterThan(500);
    }, 120_000);

    it('CONTROL: the check finds words that are printed, and leaves alone words that are not', () => {
        expect(leaked('||w0||', parseMessage('w0'))).toEqual(['w0']);
        expect(leaked('||w0|| w1', parseMessage('||w0|| w1'))).toEqual([]);
        // What stepping over this address with no care would give: the address takes the spoiler in.
        expect(leaked('w0_https://x/w1_w2||w3||', [{ type: 'url', href: 'https://x/w1_w2||w3||' }])).toEqual(['w3']);
    });
});

describe('an address straight after a colon', () => {
    it.each([
        ['Link:', 'https://example.org/page'],
        ['Download here:', 'https://example.org/file'],
        ['Source:', 'http://example.org/a_b_c'],
        ['(see:', 'https://example.org/page'],
    ])('%s%s', (words, href) => {
        expect(parseMessage(words + href)).toEqual([{ type: 'text', value: words }, { type: 'url', href }]);
    });

    it('in a sentence, in bold, and with a delimiter in it', () => {
        expect(hrefs('the Link:https://example.org/page is here')).toEqual(['https://example.org/page']);
        expect(hrefs('**Link:https://example.org/a_b**')).toEqual(['https://example.org/a_b']);
        expect(hrefs('my_file Link:https://example.org/my_file')).toEqual(['https://example.org/my_file']);
    });

    it(':name: with // after it is not a shortcode, and stays as typed', () => {
        expect(parseMessage(':smile://x')).toEqual([{ type: 'text', value: ':smile://x' }]);
        expect(parseMessage('see :smile://x/y now')).toEqual([{ type: 'text', value: 'see :smile://x/y now' }]);
        // Words, whole: its `_` opens nothing, as a shortcode's never did.
        expect(parseMessage(':a_b://x _c_')).toEqual([
            { type: 'text', value: ':a_b://x ' },
            { type: 'em', children: [{ type: 'text', value: 'c' }] },
        ]);
    });

    it('CONTROL: a shortcode is still one, right up against an address or with a slash after a space', () => {
        expect(parseMessage(':smile:')).toEqual([{ type: 'emoji', name: 'smile' }]);
        expect(parseMessage(':https:')).toEqual([{ type: 'emoji', name: 'https' }]);
        expect(parseMessage(':smile: //x')).toEqual([{ type: 'emoji', name: 'smile' }, { type: 'text', value: ' //x' }]);
        expect(parseMessage(':smile:https://example.org/a')).toEqual([
            { type: 'emoji', name: 'smile' },
            { type: 'url', href: 'https://example.org/a' },
        ]);
    });

    it('@ in it is no mention, and one beside it still is', () => {
        expect(extractMentions('Link:https://example.org/@alice/1')).toEqual({ users: [], everyone: false });
        expect(extractMentions('@bob Link:https://example.org/@alice/1 @carol')).toEqual({ users: ['bob', 'carol'], everyone: false });
    });

    it('a spoiler stays one beside it, or in its word', () => {
        const spoiler = (value: string) => ({ type: 'spoiler', children: [{ type: 'text', value }] });
        expect(parseMessage('Link:https://example.org/a ||hidden||')).toEqual([
            { type: 'text', value: 'Link:' },
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: ' ' },
            spoiler('hidden'),
        ]);
        expect(parseMessage('Link:https://example.org/a||hidden||')).toEqual([
            { type: 'text', value: 'Link:' },
            { type: 'url', href: 'https://example.org/a' },
            spoiler('hidden'),
        ]);
    });
});

describe('a raw > or " is never part of an address', () => {
    it.each([
        ['<https://example.org>', '<', 'https://example.org', '>'],
        ['<https://example.org/page>', '<', 'https://example.org/page', '>'],
        ['{"url":"https://example.org/x"}', '{"url":"', 'https://example.org/x', '"}'],
        ['<a href="https://example.org/x">link</a>', '<a href="', 'https://example.org/x', '">link</a>'],
        ['"https://example.org/x"', '"', 'https://example.org/x', '"'],
        ['https://example.org/x"y', '', 'https://example.org/x', '"y'],
        ['https://example.org/x>y', '', 'https://example.org/x', '>y'],
    ])('%s', (content, before, href, after) => {
        const expected: Node[] = [{ type: 'url', href }, { type: 'text', value: after }];
        if (before) expected.unshift({ type: 'text', value: before });
        expect(parseMessage(content)).toEqual(expected);
    });

    it('two in one word, and markup around them', () => {
        expect(hrefs('{"a":"https://example.org/a","b":"https://example.org/b"}')).toEqual(['https://example.org/a', 'https://example.org/b']);
        expect(parseMessage('**<https://example.org/a>**')).toEqual([
            { type: 'strong', children: [{ type: 'text', value: '<' }, { type: 'url', href: 'https://example.org/a' }, { type: 'text', value: '>' }] },
        ]);
        // It stops the delimiter's reading of the address too.
        expect(hrefs('my_file <https://example.org/my_file>')).toEqual(['https://example.org/my_file']);
    });

    it('a real mention right after one is a mention, and an @ in one is not', () => {
        expect(extractMentions('<https://example.org/@alice> @bob')).toEqual({ users: ['bob'], everyone: false });
    });

    it('what comes after one is read as anything else is', () => {
        expect(parseMessage('<https://example.org/a>_b c_d')).toEqual([
            { type: 'text', value: '<' },
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: '>' },
            { type: 'em', children: [{ type: 'text', value: 'b c' }] },
            { type: 'text', value: 'd' },
        ]);
        expect(parseMessage('https://example.org/a>`b`')).toEqual([
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: '>' },
            { type: 'code', value: 'b' },
        ]);
    });

    it('and it cannot take a spoiler apart', () => {
        expect(parseMessage('<https://example.org/a>_b ||c_d||')).toEqual([
            { type: 'text', value: '<' },
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: '>_b ' },
            { type: 'spoiler', children: [{ type: 'text', value: 'c_d' }] },
        ]);
    });
});

describe('a capital scheme, which a phone keyboard makes', () => {
    it.each([
        ['Https://example.org/wiki/Foo_Bar_Baz'],
        ['Https://example.org/page#top'],
        ['Https://mastodon.example.org/@alice/123'],
        ['HTTP://example.org/a_b'],
        ['HTTPS://EXAMPLE.ORG/A_B_C'],
    ])('%s is one address, as typed', (href) => {
        expect(parseMessage(href)).toEqual([{ type: 'url', href }]);
        expect(hrefs(`see ${href} now`)).toEqual([href]);
        expect(isSafeUrl(href)).toBe(true);
    });

    it('@ in it is no mention, and one beside it still is', () => {
        expect(extractMentions('Https://mastodon.example.org/@alice/123')).toEqual({ users: [], everyone: false });
        expect(extractMentions('@bob Https://mastodon.example.org/@alice/123 @carol')).toEqual({ users: ['bob', 'carol'], everyone: false });
    });

    it('as any other address in markup, after a colon, in brackets, and in a delimiter\'s way', () => {
        expect(parseMessage('**Https://example.org/a**')).toEqual([{ type: 'strong', children: [{ type: 'url', href: 'Https://example.org/a' }] }]);
        expect(hrefs('Link:Https://example.org/a')).toEqual(['Https://example.org/a']);
        expect(hrefs('(see Https://example.org/Foo_(bar))')).toEqual(['Https://example.org/Foo_(bar)']);
        expect(hrefs('my_file Https://example.org/my_file')).toEqual(['Https://example.org/my_file']);
        expect(hrefs('<Https://example.org/a>')).toEqual(['Https://example.org/a']);
    });

    it('CONTROL: a word that starts the same is a word', () => {
        for (const words of ['Hello there', 'Https', 'Https:', 'Https://', 'HTTP/1.1', 'Http: the protocol']) {
            expect(parseMessage(words)).toEqual([{ type: 'text', value: words }]);
        }
    });

    it('a spoiler stays one beside it, or in its word', () => {
        const spoiler = (value: string) => ({ type: 'spoiler', children: [{ type: 'text', value }] });
        expect(parseMessage('Https://example.org/a_b ||hidden||')).toEqual([
            { type: 'url', href: 'Https://example.org/a_b' },
            { type: 'text', value: ' ' },
            spoiler('hidden'),
        ]);
        expect(parseMessage('Https://example.org/a||hidden||')).toEqual([{ type: 'url', href: 'Https://example.org/a' }, spoiler('hidden')]);
        // The `_` after it does not close inside the spoiler.
        expect(parseMessage('Https://example.org/a_b c_d ||e_f||')).toEqual([
            { type: 'url', href: 'Https://example.org/a_b' },
            { type: 'text', value: ' c_d ' },
            spoiler('e_f'),
        ]);
    });
});

describe('brackets in a link\'s target', () => {
    const link = (label: string, href: string) => ({ type: 'link', label, href });

    it('it keeps the ones it opens', () => {
        expect(parseMessage('[w](https://example.org/wiki/Foo_(bar))')).toEqual([link('w', 'https://example.org/wiki/Foo_(bar)')]);
        expect(parseMessage('[w](https://example.org/wiki/Foo_(bar)_baz) after')).toEqual([
            link('w', 'https://example.org/wiki/Foo_(bar)_baz'),
            { type: 'text', value: ' after' },
        ]);
        expect(parseMessage('[w](https://example.org/a_(b)_(c))')).toEqual([link('w', 'https://example.org/a_(b)_(c)')]);
        expect(parseMessage('[w](https://example.org/a_(b_(c)))')).toEqual([link('w', 'https://example.org/a_(b_(c))')]);
        expect(parseMessage('(see [w](https://example.org/Foo_(bar)))')).toEqual([
            { type: 'text', value: '(see ' },
            link('w', 'https://example.org/Foo_(bar)'),
            { type: 'text', value: ')' },
        ]);
    });

    it('a picture\'s too', () => {
        expect(parseMessage('![p](https://example.org/a_(1).png)')).toEqual([{ type: 'image', alt: 'p', href: 'https://example.org/a_(1).png' }]);
    });

    it('CONTROL: a bracket it opens and never closes is as it was', () => {
        expect(parseMessage('[a](https://x/(b)')).toEqual([link('a', 'https://x/(b')]);
        expect(parseMessage('[a](x(y) z)')).toEqual([link('a', 'x(y'), { type: 'text', value: ' z)' }]);
    });

    it('CONTROL: it stops at the first ) that closes nothing', () => {
        expect(parseMessage('[a](b) (c)')).toEqual([link('a', 'b'), { type: 'text', value: ' (c)' }]);
        expect(parseMessage('[a](b))')).toEqual([link('a', 'b'), { type: 'text', value: ')' }]);
        expect(parseMessage('[a](b)(c)')).toEqual([link('a', 'b'), { type: 'text', value: '(c)' }]);
    });

    it('CONTROL: no target and no closing are no link', () => {
        expect(parseMessage('[a]()')).toEqual([{ type: 'text', value: '[a]()' }]);
        expect(parseMessage('[a](b')).toEqual([{ type: 'text', value: '[a](b' }]);
        expect(parseMessage('[a](b c)')).toEqual([{ type: 'text', value: '[a](b c)' }]);
    });

    it('CONTROL: a space of any kind ends a target, and what only looks like one does not', () => {
        for (const space of ['\t', '\n', '\r', '\u00a0', '\u2003', '\u3000', '\ufeff']) {
            expect(parseMessage(`[a](b${space}c)`)).toEqual(parsedAsItWas(`[a](b${space}c)`));
            expect(parseMessage(`[a](b${space}c)`).some(n => n.type === 'link')).toBe(false);
        }
        expect(parseMessage('[a](b\u200bc)')).toEqual([{ type: 'link', label: 'a', href: 'b\u200bc' }]);
        // Every code unit ends a target exactly where `\s` says it does.
        const wrong: string[] = [];
        for (let unit = 0; unit < 0x10000; unit++) {
            const ch = String.fromCharCode(unit);
            if (ch === '(' || ch === ')') continue;
            if (parseMessage(`[a](/b${ch}c)`).some(n => n.type === 'link') === /\s/.test(ch)) wrong.push(unit.toString(16));
        }
        expect(wrong).toEqual([]);
    });

    it.each([
        ['javascript:alert(1)'],
        ['JavaScript:alert((1))'],
        ['data:text/html,(a)'],
        ['vbscript:msgbox(1)'],
        ['//example.org/(a)'],
    ])('a dangerous target stays neutralised, whole: %s', (target) => {
        expect(parseMessage(`[x](${target})`)).toEqual([{ type: 'text', value: 'x' }]);
        expect(parseMessage(`![x](${target})`)).toEqual([{ type: 'text', value: 'x' }]);
    });

    it('a spoiler after the first ) is still one', () => {
        expect(parseMessage('[a](https://x/(b)||c||)')).toEqual([
            link('a', 'https://x/(b'),
            { type: 'spoiler', children: [{ type: 'text', value: 'c' }] },
            { type: 'text', value: ')' },
        ]);
        expect(parseMessage('[w](https://example.org/Foo_(bar)) ||c||')).toEqual([
            link('w', 'https://example.org/Foo_(bar)'),
            { type: 'text', value: ' ' },
            { type: 'spoiler', children: [{ type: 'text', value: 'c' }] },
        ]);
    });

    it('it stays bounded: a target past the limit is no link, and a message of openers takes no time', () => {
        const target = `https://example.org/${'a'.repeat(2028)}`;
        expect(target).toHaveLength(2048);
        expect(parseMessage(`[a](${target})`)).toEqual([{ type: 'link', label: 'a', href: target }]);
        expect(parseMessage(`[a](${target}b)`).some(n => n.type === 'link')).toBe(false);
        // Past the limit, a first `)` further back is what it stops at, as before it stopped there.
        expect(hrefs(`[a](x(y)${'a'.repeat(3000)})`)).toEqual(['x(y']);
        const started = performance.now();
        parseMessage('[a]('.repeat(5000));
        parseMessage('[a](('.repeat(4000));
        parseMessage(`[a](${'('.repeat(20000)}`);
        expect(performance.now() - started).toBeLessThan(5000);
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

// messageMentionsUser is what decides who gets highlighted and hears the mention sound.
describe('who an address mentions: nobody', () => {
    const alice = { username: 'alice' };

    it.each([
        ['https://example.org/@alice/1'],
        ['Https://example.org/@alice/1'],
        ['HTTP://example.org/@alice/1'],
        ['Link:https://example.org/@alice/1'],
        ['<https://example.org/@alice>'],
        ['{"url":"https://example.org/@alice"}'],
        ['https://example.org/(@alice)'],
        ['[the post](https://example.org/@alice/1)'],
        ['[the post](https://example.org/(@alice))'],
        ['my_file https://example.org/@alice_file'],
    ])('%s', (content) => {
        expect(messageMentionsUser(content, alice)).toBe(false);
        expect(extractMentions(content).users).toEqual([]);
    });

    it.each([
        ['@alice https://example.org/@bob/1'],
        ['https://example.org/@bob/1 @alice'],
        ['Https://example.org/@bob/1 @alice'],
        ['Link:https://example.org/@bob/1 @alice'],
        ['<https://example.org/@bob> @alice'],
        ['(https://example.org/Foo_(bar)) @alice'],
        ['[the post](https://example.org/Foo_(bar)) @alice'],
        ['**@alice** https://example.org/a_b'],
    ])('CONTROL: a real mention beside one still is: %s', (content) => {
        expect(messageMentionsUser(content, alice)).toBe(true);
        expect(extractMentions(content).users).toEqual(['alice']);
    });
});

describe('a delimiter past an address does not close inside a name', () => {
    it.each<[string, string[]]>([
        ['see my_file at https://example.org/a_b cc @alice_c', ['alice_c']],
        ['test_case failed: https://ci.example.org/job_1 @bob_smith please look', ['bob_smith']],
        ['the build_log is at https://ci.example.org/run_7, ping @carol_d and @erin', ['carol_d', 'erin']],
        ['my__file at https://example.org/a__b @alice__c', ['alice__c']],
    ])('%s', (content, users) => {
        expect(extractMentions(content).users).toEqual(users);
        expect(messageMentionsUser(content, { username: users[0] })).toBe(true);
        // and the name's first half is nobody
        expect(messageMentionsUser(content, { username: users[0].split('_')[0] })).toBe(false);
    });

    it('a channel and an emoji are the same', () => {
        expect(parseMessage('my_file https://example.org/a_b #my_channel').at(-1)).toEqual({ type: 'channel', name: 'my_channel' });
        expect(parseMessage('my_file https://example.org/a_b :thumbs_up:').at(-1)).toEqual({ type: 'emoji', name: 'thumbs_up' });
    });

    it('nor does it stop there: it closes after the name', () => {
        expect(parseMessage('_see https://example.org/a_b @alice_c now_')).toEqual([{
            type: 'em',
            children: [
                { type: 'text', value: 'see ' },
                { type: 'url', href: 'https://example.org/a_b' },
                { type: 'text', value: ' ' },
                { type: 'mentionUser', name: 'alice_c' },
                { type: 'text', value: ' now' },
            ],
        }]);
    });

    // A name takes in the `_` that closes, and the `.` after it, so an address earlier in the
    // sentence used to change who it pinged: to `bob_`, or from everyone to nobody.
    it('a `_` at the end of a name closes there, and the name is the one meant', () => {
        const content = '_see https://example.org/a @bob_';
        expect(parseMessage(content)).toEqual([{
            type: 'em',
            children: [
                { type: 'text', value: 'see ' },
                { type: 'url', href: 'https://example.org/a' },
                { type: 'text', value: ' ' },
                { type: 'mentionUser', name: 'bob' },
            ],
        }]);
        expect(extractMentions(content).users).toEqual(['bob']);
        expect(messageMentionsUser(content, { username: 'bob' })).toBe(true);
        expect(messageMentionsUser(content, { username: 'bob_' })).toBe(false);
    });

    it.each(['_see https://example.org/a @everyone_', '_see https://example.org/a @here_', '_see https://example.org/a @everyone_.'])(
        '%s pings everyone',
        (content) => {
            expect(extractMentions(content)).toEqual({ users: [], everyone: true });
            expect(messageMentionsUser(content, { username: 'carol' })).toBe(true);
        },
    );

    it.each([
        '__see https://example.org/a @bob__',
        '_see https://example.org/a @bob_.',
        '_see https://example.org/a @bob_, thanks',
        '_see https://example.org/a @bob__',
        '__see https://example.org/a @bob___',
        '__see https://example.org/a @bob_',
        '_cc @alice https://example.org/a @bob_',
        '_see https://example.org/a #general_',
        '_see https://example.org/a #general_.',
        '_see https://example.org/a @_',
        '_see https://example.org/a @bob_ and @carol_',
        'my_file at https://example.org/a cc @alice_',
        '*see https://example.org/a @bob_*',
        '**see https://example.org/a @bob_**',
    ])('%s reads as it does with no address in it', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each<[string, string]>([
        ['_see https://example.org/a @alice_c_', 'alice_c'],
        ['_see https://example.org/a_b @alice_c_.', 'alice_c'],
        ['__see https://example.org/a @alice__c__', 'alice__c'],
        ['my_file at https://example.org/a_b cc @alice_c.', 'alice_c.'],
    ])('CONTROL: a `_` with more of the name after it is the name\'s: %s', (content, name) => {
        expect(extractMentions(content).users).toEqual([name]);
    });

    it('an address straight after a colon is still an address there, not a shortcode to step over', () => {
        expect(hrefs('my_file https://example.org/a_b :https://example.org/c_d')).toEqual(['https://example.org/a_b', 'https://example.org/c_d']);
    });

    it(':name:// with no address in it is words, as the parser reads it', () => {
        expect(parseMessage('my_file https://example.org/a_b :c_d://x e_f')).toEqual([
            { type: 'text', value: 'my' },
            { type: 'em', children: [{ type: 'text', value: 'file ' }, { type: 'url', href: 'https://example.org/a_b' }, { type: 'text', value: ' :c_d://x e' }] },
            { type: 'text', value: 'f' },
        ]);
    });

    it('CONTROL: with no address before it, a name is what it always was', () => {
        for (const content of ['my_file cc @alice_c', 'my_file #my_channel', 'my_file :thumbs_up:', 'my_file @alice_c https://example.org/a_b']) {
            expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        }
    });
});

describe('text with no address and no spoiler in it', () => {
    const WORDS = ['**', '*', '__', '_', '~~', '`', ' ', '\n', '> ', 'w', 'w_w', 'w*w', 'w~~w', ']', '(', ')', '!', '.', ',', 'h', 'H', 'http', 'Http', '<', '>', '"', '|'];
    const NAMES = ['@w', '@w_w', '#w_w', ':w:', ':w_w:', ':w', '['];
    // No `[` to make a link with a `_` in its label, which a `_` now goes past, and no name:
    // a link is an address, and a name past one is whole, as a name past any address is.
    const LINKS = ['[w](w)', '![w](w)'];

    it.each([['names', NAMES], ['links', LINKS]])('reads as it always did, with %s', (_, more) => {
        const parts = [...WORDS, ...more];
        let seed = 20261103;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        const bad: string[] = [];
        for (let k = 0; k < 30000; k++) {
            let content = '';
            for (let j = 1 + next(14); j > 0; j--) content += parts[next(parts.length)];
            if (JSON.stringify(parseMessage(content)) !== JSON.stringify(parsedAsItWas(content))) bad.push(JSON.stringify(content));
        }
        expect(bad).toEqual([]);
    });

    it('but for what was asked for: the brackets a link\'s target opens, :name:// being no shortcode, and a `_` going past a link', () => {
        expect(parseMessage('[a](b(c))')).toEqual([{ type: 'link', label: 'a', href: 'b(c)' }]);
        expect(parsedAsItWas('[a](b(c))')).toEqual([{ type: 'link', label: 'a', href: 'b(c' }, { type: 'text', value: ')' }]);
        expect(parseMessage(':a://x')).toEqual([{ type: 'text', value: ':a://x' }]);
        expect(parsedAsItWas(':a://x')).toEqual([{ type: 'emoji', name: 'a' }, { type: 'text', value: '//x' }]);
        expect(parseMessage('_[a_b](c)_')).toEqual([{ type: 'em', children: [{ type: 'link', label: 'a_b', href: 'c' }] }]);
        expect(parsedAsItWas('_[a_b](c)_')).toEqual([{ type: 'em', children: [{ type: 'text', value: '[a' }] }, { type: 'text', value: 'b](c)_' }]);
        expect(parseMessage('w_w [w](w) @w_w').at(-1)).toEqual({ type: 'mentionUser', name: 'w_w' });
        expect(parsedAsItWas('w_w [w](w) @w_w').at(-1)).toEqual({ type: 'text', value: 'w' });
    });
});

describe('a delimiter in the words before a spoiler does not close inside it', () => {
    const spoiler = (value: string) => ({ type: 'spoiler', children: [{ type: 'text', value }] });
    const said = (value: string) => ({ type: 'text', value });

    it.each([
        ['my_file ||secret_word||', 'my_file ', 'secret_word'],
        ['my__file ||secret__word||', 'my__file ', 'secret__word'],
        ['a*b ||c*d||', 'a*b ', 'c*d'],
        ['a**b ||c**d||', 'a**b ', 'c**d'],
        ['~~a ||b~~c||', '~~a ', 'b~~c'],
        ['_a ||b_ c||', '_a ', 'b_ c'],
        // An empty pair is no spoiler: the reader starts at the last two of them.
        ['a_b ||||c_d||', 'a_b |', '|c_d'],
    ])('%s', (content, words, hidden) => {
        expect(parseMessage(content)).toEqual([said(words), spoiler(hidden)]);
    });

    it.each([
        ['_', 'em'],
        ['__', 'underline'],
        ['*', 'em'],
        ['**', 'strong'],
        ['~~', 'strike'],
    ])('it closes after the spoiler: %s', (d, type) => {
        const inside = `b${d}c`;
        expect(parseMessage(`${d}a ||${inside}|| d${d} e`)).toEqual([
            { type, children: [said('a '), spoiler(inside), said(' d')] },
            said(' e'),
        ]);
    });

    it('in a quote, and a spoiler that holds no delimiter is what it always was', () => {
        expect(parseMessage('> my_file ||secret_word||')).toEqual([{ type: 'blockquote', children: [said('my_file '), spoiler('secret_word')] }]);
        for (const content of ['_a ||b|| c_', '*a ||b|| c*', '**a ||b|| c**', '~~a ||b|| c~~', 'a_b ||c|| d_e', '||a_b|| c_d', 'a_b c_d ||e_f||']) {
            expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        }
    });

    it.each([
        ['a_b || c_d'],
        ['a*b || c*d'],
        ['~~a || b~~ c'],
        ['a**b || c**d'],
        ['a_b ||||c_d'],
        ['a_b `||` c_d || e'],
        ['a_b || `||` c_d'],
    ])('CONTROL: with no `||` to close it there is no spoiler, and a delimiter closes where it always did: %s', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each<[string, string]>([
        ['my_file ||a_b|| @alice_c', 'alice_c'],
        ['my_file ||a|| @alice_c', 'alice_c'],
        ['my_file ||a_b|| @alice_c now', 'alice_c'],
    ])('a name past one is whole: %s', (content, name) => {
        expect(extractMentions(content).users).toEqual([name]);
        expect(messageMentionsUser(content, { username: name })).toBe(true);
    });

    // Everything a word can put in front of a spoiler or after it, in any order.
    const AROUND = ['w_w', 'w__w', 'w*w', 'w**w', 'w~~w', '_', '__', '*', '**', '~~', ' ', ' ', ' ', '\n', 'w', '.', ',', '@w', '@w_w', '#w_w', ':w:', ':w_w:', '`w`', '`w_w`',
        'https://x/w', 'https://x/w_w', 'https://x/w*w', 'Https://x/w~~w', 'Link:https://x/w_w', '[w](https://x/w_w)', '[w_w](w_w)', '![w](sovereign-enc:w?k=w_w&m=image%2Fpng)', '\n> w\n', '\n```\nw\n```\n'];
    const THE_SPOILER = '||s_s*s~~s**s__s||';
    const made = (seed: number, count: number) => {
        let at = seed;
        const next = (n: number) => { at = (at * 1664525 + 1013904223) >>> 0; return (at >>> 8) % n; };
        const words = () => {
            let out = '';
            for (let j = next(9); j > 0; j--) out += AROUND[next(AROUND.length)];
            return out;
        };
        return Array.from({ length: count }, () => `${words()}${THE_SPOILER}${words()}`);
    };
    const printsIt = (nodes: Node[]): boolean =>
        nodes.some(n => (n.type === 'spoiler' ? false : 'children' in n ? printsIt(n.children) : /s[_*~]/.test(JSON.stringify(n))));

    it('as a property: nothing around it prints it, or another spoiler like it', () => {
        const once = made(20261103, 30000);
        const twice = made(8, 30000).map((content, k) => `${content}${once[k]}`);
        const bad = [...once, ...twice].filter((content) => {
            const read = parseMessage(content);
            return printsIt(read) || !JSON.stringify(read).includes('"spoiler"');
        });
        expect(bad).toEqual([]);
    }, 120_000);

    it('NEGATIVE CONTROL: the same check finds it printed by the parser as it was', () => {
        const once = made(20261103, 30000);
        const twice = made(8, 30000).map((content, k) => `${content}${once[k]}`);
        expect(once.filter(content => printsIt(parsedAsItWas(content))).length).toBeGreaterThan(9000);
        expect(twice.filter(content => printsIt(parsedAsItWas(content))).length).toBeGreaterThan(9000);
    }, 120_000);

    // A `||` here is an `or`, by the look of it, but two hide what is between them, as they always
    // did. What this costs: `_a || b_` now hides more than it used to, and is no italics of its own.
    it('it hides what is between two `||` however they look', () => {
        expect(parseMessage('_a || b_ or _c || d_')).toEqual([{ type: 'em', children: [said('a '), { type: 'spoiler', children: [said(' b'), { type: 'em', children: [said(' or ')] }, said('c ')] }, said(' d')] }]);
        expect(parsedAsItWas('_a || b_ or _c || d_').map(n => n.type)).toEqual(['em', 'text', 'em']);
        expect(parseMessage('a || b or c || d')).toEqual(parsedAsItWas('a || b or c || d'));
    });

    // What the change costs `*`, `**`, `~~`, `_` and `__`, all of it: nothing but this.
    it('a delimiter reads as if each spoiler were one word in it, or the message reads as it did, or each stretch is hidden', () => {
        const WORD = '\uE000';
        const BAR = '\uE001';
        // Everything from the first `||` that pairs to the last: `|| ||` a word, and as many as there are.
        const everyStretch = (s: string) => {
            const first = s.indexOf('||');
            const last = s.lastIndexOf('||');
            if (first === -1 || last <= first + 1) return s.replaceAll('|', BAR);
            const stretches = s.slice(first + 2, last).split('||').length;
            return s.slice(0, first).replaceAll('|', BAR) + WORD.repeat(stretches) + s.slice(last + 2).replaceAll('|', BAR);
        };
        // Bars that pair with nothing stay out of the way of the word's reading.
        const oneWord = (s: string) => {
            let out = '';
            let i = 0;
            while (i < s.length) {
                if (s.startsWith('||', i)) {
                    const close = s.indexOf('||', i + 2);
                    if (close > i + 2) {
                        out += WORD;
                        i = close + 2;
                        continue;
                    }
                }
                out += s[i] === '|' ? BAR : s[i];
                i++;
            }
            return out;
        };
        const flat = (nodes: Node[]): string => nodes.map(n => {
            if (n.type === 'spoiler') return WORD;
            if (n.type === 'text') return n.value;
            if ('children' in n) return `<${n.type}>${flat(n.children)}</${n.type}>`;
            return JSON.stringify(n);
        }).join('').replaceAll('|', BAR);
        const PARTS = ['||', '||', '||', '**', '*', '__', '_', '~~', ' ', ' ', 'w', 'w_w', 'w*w', 'w~~w', '.', ','];
        let seed = 20261103;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        const bad: string[] = [];
        let spoilers = 0;
        let changed = 0;
        for (let k = 0; k < 30000; k++) {
            let content = '';
            for (let j = 1 + next(14); j > 0; j--) content += PARTS[next(PARTS.length)];
            // An empty pair is no spoiler, and what it leaves pairs up on its own terms.
            if (content.includes('|||')) continue;
            const read = parseMessage(content);
            const old = parsedAsItWas(content);
            if (JSON.stringify(read).includes('"spoiler"')) spoilers++;
            if (JSON.stringify(read) === JSON.stringify(old)) continue;
            changed++;
            if (flat(read) !== flat(parsedAsItWas(oneWord(content))) && flat(read) !== flat(parsedAsItWas(everyStretch(content)))) bad.push(JSON.stringify(content));
        }
        expect(bad).toEqual([]);
        // Over nothing it would prove nothing.
        expect(spoilers).toBeGreaterThan(5000);
        expect(changed).toBeGreaterThan(1000);
    }, 120_000);
});

describe('a delimiter in the words before a link or a picture does not close inside it', () => {
    const said = (value: string) => ({ type: 'text', value });
    const PICTURE = 'sovereign-enc:abc?k=AA_BB&m=image%2Fpng&c=CC_DD';
    const FILE = 'sovereign-enc:abc?k=AA_BB&m=application%2Fzip';

    it.each(['my_file ', 'my__file ', 'see my_file\n', '_', '__', 'a_b_c ', 'a__b__c '])('%s and a picture', (words) => {
        const read = parseMessage(`${words}![p.png](${PICTURE})`);
        expect(read.at(-1)).toEqual({ type: 'image', alt: 'p.png', href: PICTURE });
        expect(JSON.stringify(read.slice(0, -1))).not.toContain('k=');
    });

    it('a file, a clip and two of them', () => {
        const clip = 'sovereign-clip:abc?k=AA_BB';
        expect(parseMessage(`my_file [f.zip](${FILE})`)).toEqual([said('my_file '), { type: 'link', label: 'f.zip', href: FILE }]);
        expect(parseMessage(`my_file [c](${clip})`)).toEqual([said('my_file '), { type: 'link', label: 'c', href: clip }]);
        expect(hrefs(`my_file ![p.png](${PICTURE}) [f.zip](${FILE})`)).toEqual([PICTURE, FILE]);
        // With text after it too, and the spoiler the file may be under.
        expect(hrefs(`my_file ![p.png](${PICTURE}) other_file`)).toEqual([PICTURE]);
        expect(parseMessage(`my_file ||![p.png](${PICTURE})||`)).toEqual([said('my_file '), { type: 'spoiler', children: [{ type: 'image', alt: 'p.png', href: PICTURE }] }]);
    });

    it('it closes after it', () => {
        const picture = { type: 'image', alt: 'p', href: 'k_k' };
        expect(parseMessage('_a ![p](k_k) b_')).toEqual([{ type: 'em', children: [said('a '), picture, said(' b')] }]);
        expect(parseMessage('__a ![p](k__k) b__ c')).toEqual([{ type: 'underline', children: [said('a '), { ...picture, href: 'k__k' }, said(' b')] }, said(' c')]);
        expect(parseMessage('_see [docs](https://example.org/a)_\'s page')).toEqual([
            { type: 'em', children: [said('see '), { type: 'link', label: 'docs', href: 'https://example.org/a' }] },
            said('\'s page'),
        ]);
    });

    it('a bracket in its target is the link\'s, and what is after the bracket', () => {
        expect(parseMessage('_a [x](b(c)_d) e')).toEqual([said('_a '), { type: 'link', label: 'x', href: 'b(c)_d' }, said(' e')]);
    });

    it('words and a picture in one spoiler, with a `_` in the words: it is the picture, not its key', () => {
        const picture = 'sovereign-enc:abc?k=AA_BB&m=image%2Fpng';
        expect(parseMessage(`||my_file ![p.png](${picture})||`)).toEqual([
            { type: 'spoiler', children: [said('my_file '), { type: 'image', alt: 'p.png', href: picture }] },
        ]);
    });

    it('a label is the link\'s too, and a picture need not have one', () => {
        expect(parseMessage('my_file [a_b](c)')).toEqual([said('my_file '), { type: 'link', label: 'a_b', href: 'c' }]);
        expect(parseMessage('my_file ![a_b](c)')).toEqual([said('my_file '), { type: 'image', alt: 'a_b', href: 'c' }]);
        expect(parseMessage('my_file ![](a_b)')).toEqual([said('my_file '), { type: 'image', alt: '', href: 'a_b' }]);
    });

    it('a dangerous target stays neutralised', () => {
        expect(parseMessage('my_file [x_y](javascript:a_b)')).toEqual([said('my_file '), said('x_y')]);
        expect(parseMessage('my_file ![x_y](javascript:a_b)')).toEqual([said('my_file '), said('x_y')]);
    });

    it.each<[string]>([
        ['my_file [x](y) @alice_c'],
        ['my_file [a_b](y) @alice_c'],
        ['my_file [x](https://example.org/y) @alice_c'],
        ['my_file ![p](sovereign-enc:a?k=bc) @alice_c'],
        ['my_file ![p](sovereign-enc:a?k=b_c) @alice_c'],
    ])('a name past one is whole, whatever a key happens to hold: %s', (content) => {
        expect(extractMentions(content).users).toEqual(['alice_c']);
    });

    it.each([
        ['my_file [a_b](c d)'],
        ['my_file [a_b]'],
        ['my_file [a_b](c'],
        ['my_file [a_b]()'],
        ['my_file ![a_b](c d)'],
        ['my_file !a_b'],
    ])('CONTROL: what is no link is words, and a delimiter closes in them as it always did: %s', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each([
        ['a*b [c*d](e)'],
        ['a**b [c**d](e)'],
        ['~~a [b~~c](d)'],
        ['a*b ![c](d*e)'],
    ])('CONTROL: every delimiter but `_` closes at the first one, in a link or not, and no key holds one: %s', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    // Real keys: a file's key and its capability are 32 random bytes each, in base64url.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const refs = (count: number) => {
        let at = 20261103;
        const next = (n: number) => { at = (at * 1664525 + 1013904223) >>> 0; return (at >>> 8) % n; };
        const b64 = () => Array.from({ length: 43 }, () => ALPHABET[next(64)]).join('');
        return Array.from({ length: count }, () => `sovereign-enc:0f8e7d6c-5b4a-4938-a271-605f4e3d2c1b?k=${b64()}&m=image%2Fpng&c=${b64()}`);
    };

    it('a real key never costs the picture, or prints', () => {
        for (const href of refs(4000)) {
            expect(parseMessage(`my_file ![p.png](${href})`)).toEqual([said('my_file '), { type: 'image', alt: 'p.png', href }]);
        }
    }, 120_000);

    it('NEGATIVE CONTROL: the parser as it was lost most of them, printing the key', () => {
        const lost = refs(4000).filter(href => !hrefsIn(parsedAsItWas(`my_file ![p.png](${href})`)).includes(href));
        expect(lost.length).toBeGreaterThan(2600);
        expect(lost.length).toBeLessThan(3200);
    });
});

describe('a stray [ in the words before a link, a picture or a file', () => {
    const said = (value: string) => ({ type: 'text', value });
    const spoiler = (...children: unknown[]) => ({ type: 'spoiler', children });
    const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
    const PICTURE = `sovereign-enc:abc?k=${KEY}&m=image%2Fpng`;
    const FILE = `sovereign-enc:def?k=${KEY}&m=application%2Fzip`;
    const picture = { type: 'image', alt: 'medical-results.png', href: PICTURE };
    const file = { type: 'link', label: 'results.zip', href: FILE };
    const PICTURE_REF = `![medical-results.png](${PICTURE})`;
    const FILE_REF = `[results.zip](${FILE})`;

    /** The addresses of what is drawn in the clear, and of what is under a spoiler. */
    const placed = (content: string) => {
        const hidden: string[] = [];
        const shown: string[] = [];
        const walk = (nodes: Node[], under: boolean) => {
            for (const n of nodes) {
                if (n.type === 'link' || n.type === 'image') (under ? hidden : shown).push(n.href);
                else if ('children' in n) walk(n.children, under || n.type === 'spoiler');
            }
        };
        walk(parseMessage(content), false);
        return { hidden, shown };
    };

    it('the smiley `:[` is no link, and the file after it is the spoiler\'s (the report: it was drawn open, with the words eaten into its name)', () => {
        expect(parseMessage(`ugh :[ ||${PICTURE_REF}||`)).toEqual([said('ugh :[ '), spoiler(picture)]);
        expect(parseMessage(`ugh :[ ||${FILE_REF}||`)).toEqual([said('ugh :[ '), spoiler(file)]);
        expect(placed(`ugh :[ ||${PICTURE_REF}||`)).toEqual({ hidden: [PICTURE], shown: [] });
    });

    it.each([
        ['ugh :[ '], ['[ '], [':[ '], ['ugh [ '], ['ugh :[[ '], ['(:[ '], ['a [b '], ['see [1 '], ['[[ '], ['[\n'], ['ugh :[\n\n'],
        ['[a [b [c '], ['ugh ![ '], ['ugh :![ '], ['x [y\n'],
    ])('words with a `[` in them, then a spoilered picture, a file, and two: %j', (words) => {
        expect(parseMessage(`${words}||${PICTURE_REF}||`)).toEqual([said(words), spoiler(picture)]);
        expect(parseMessage(`${words}||${FILE_REF}||`)).toEqual([said(words), spoiler(file)]);
        expect(placed(`${words}||${PICTURE_REF}|| ||${FILE_REF}||`)).toEqual({ hidden: [PICTURE, FILE], shown: [] });
        expect(placed(`${words}||${FILE_REF}|| ||${PICTURE_REF}|| ||${FILE_REF}||`).shown).toEqual([]);
        // With words after it, and on a line of its own.
        expect(placed(`${words}||${PICTURE_REF}|| thanks`)).toEqual({ hidden: [PICTURE], shown: [] });
        expect(placed(`${words}\n||${PICTURE_REF}||`)).toEqual({ hidden: [PICTURE], shown: [] });
    });

    it('a file that is not spoilered is drawn, after the same words, and a link beside it is a link', () => {
        expect(parseMessage(`ugh :[ ${PICTURE_REF}`)).toEqual([said('ugh :[ '), picture]);
        expect(parseMessage(`ugh :[ ${FILE_REF}`)).toEqual([said('ugh :[ '), file]);
        expect(parseMessage('ugh :[ see [docs](https://example.org/a)')).toEqual([
            said('ugh :[ see '), { type: 'link', label: 'docs', href: 'https://example.org/a' },
        ]);
    });

    it('CONTROL: the same message with no stray `[` was always this', () => {
        expect(parseMessage(`ugh :( ||${PICTURE_REF}||`)).toEqual([said('ugh :( '), spoiler(picture)]);
        expect(parseMessage(`ugh :( ||${PICTURE_REF}||`)).toEqual(parsedAt857(`ugh :( ||${PICTURE_REF}||`));
    });

    it('NEGATIVE CONTROL: 0.9.857 read it as one link, the spoiler gone and the file in the clear', () => {
        expect(parsedAt857(`ugh :[ ||${PICTURE_REF}||`)).toEqual([
            said('ugh :'), { type: 'link', label: ' ||![medical-results.png', href: PICTURE }, said('||'),
        ]);
    });

    // What a text of this kind does to the message after it. A `[` that is not closed before the next
    // `[` opens nothing: the link starts at the one nearest its `](`, as in CommonMark, and what
    // stands before it is words.
    it.each<[string, unknown[]]>([
        // A link, a picture, either in either.
        ['[a [b](http://x)', [said('[a '), { type: 'link', label: 'b', href: 'http://x' }]],
        ['![a [b](http://x)', [said('![a '), { type: 'link', label: 'b', href: 'http://x' }]],
        ['[a ![b](http://x)', [said('[a '), { type: 'image', alt: 'b', href: 'http://x' }]],
        ['![a ![b](http://x)', [said('![a '), { type: 'image', alt: 'b', href: 'http://x' }]],
        // A link in brackets, a footnote, a smiley before a link.
        ['[[1](http://x)]', [said('['), { type: 'link', label: '1', href: 'http://x' }, said(']')]],
        [':[ see [docs](http://x)', [said(':[ see '), { type: 'link', label: 'docs', href: 'http://x' }]],
        // The inner one has no label: there is no link.
        ['[a [](http://example.org)', [said('[a []('), { type: 'url', href: 'http://example.org' }, said(')')]],
        // A run of them: the link is the last.
        ['[[[[a](b)', [said('[[['), { type: 'link', label: 'a', href: 'b' }]],
    ])('a link or a picture in a label: %j', (content, tree) => {
        expect(parseMessage(content)).toEqual(tree);
        expect(parsedAt857(content)).not.toEqual(tree);
    });

    it.each([
        // A `[` closed before the next one, or never followed by a `](`: the same as it was.
        ['[see [this]](http://x)'], ['[a [b] c](http://x)'], ['[a] [b](http://x)'], ['[a]( [b](http://x)'], ['a [ b ](http://x)'],
        ['[a](http://x) [b](http://y)'], ['![a](http://x) ![b](http://y)'], ['[a][b](http://x)'], ['[a [b'], ['[a [b]'], ['[[[a]](b)'],
        ['[a\n[b](http://x)'], ['[a_b](c)'], ['my_file [a_b](c)'], ['[x](javascript:alert(1))'],
        ['||[a](http://x)||'], ['||![a](http://x)||'],
    ])('CONTROL: what had no `[` in its label is as it was: %j', (content) => {
        expect(parseMessage(content)).toEqual(parsedAt857(content));
    });

    // Real keys: a file's key and its capability are 32 random bytes each, in base64url.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const refs = (count: number) => {
        let at = 20261105;
        const next = (n: number) => { at = (at * 1664525 + 1013904223) >>> 0; return (at >>> 8) % n; };
        const b64 = () => Array.from({ length: 43 }, () => ALPHABET[next(64)]).join('');
        return Array.from({ length: count }, (_, i) => {
            const href = `sovereign-enc:0f8e7d6c-5b4a-4938-a271-605f4e3d2c1b?k=${b64()}&m=${i % 2 ? 'image%2Fpng' : 'application%2Fzip'}&c=${b64()}`;
            return { href, md: `${i % 2 ? '!' : ''}[f${i}.${i % 2 ? 'png' : 'zip'}](${href})` };
        });
    };

    it('what a label swallowed is read: emphasis, a mention, a channel, an address, an emoji', () => {
        expect(parseMessage('_a [b_c [d](http://x)')).toEqual([
            { type: 'em', children: [said('a [b')] }, said('c '), { type: 'link', label: 'd', href: 'http://x' },
        ]);
        expect(parseMessage(':[ @bob #general :smile: [d](http://x)')).toEqual([
            said(':[ '), { type: 'mentionUser', name: 'bob' }, said(' '), { type: 'channel', name: 'general' }, said(' '),
            { type: 'emoji', name: 'smile' }, said(' '), { type: 'link', label: 'd', href: 'http://x' },
        ]);
        expect(parseMessage('[ https://example.org/a [d](http://x)')).toEqual([
            said('[ '), { type: 'url', href: 'https://example.org/a' }, said(' '), { type: 'link', label: 'd', href: 'http://x' },
        ]);
        // A link that is no link stays words, with the label's own text: nothing is clickable.
        expect(parseMessage('[a [b](javascript:alert(1))')).toEqual([said('[a '), said('b')]);
    });

    it('and what is read is acted on: the mention notifies, the address gets its card', () => {
        const content = ':[ @bob and https://example.org/a see [docs](https://example.org/b)';
        expect(extractMentions(content)).toEqual({ users: ['bob'], everyone: false });
        expect(messageMentionsUser(content, { username: 'bob' })).toBe(true);
        expect(extractMentions(':[ @everyone [docs](https://example.org/b)').everyone).toBe(true);
        expect(extractUrls(content)).toEqual(['https://example.org/a', 'https://example.org/b']);
        // 0.9.857 took all of it into the link's label: no mention, no card for the first address.
        const swallowed = parsedAt857(content);
        expect(swallowed.map(n => n.type)).toEqual(['text', 'link']);
        expect(swallowed[1]).toMatchObject({ type: 'link', label: ' @bob and https://example.org/a see [docs', href: 'https://example.org/b' });
    });

    it('a pairing it moves is held to what 0.9.857 hid: its reading is kept where this one would print a word of it', () => {
        // The stray `[` took a `||` into a label in 0.9.857; read without that, the pairing moves and w10 is outside
        // the bars. 0.9.855 and the parser before it hid less than 0.9.857 did here, so only holding this to
        // 0.9.857 itself keeps w10 hidden. (Found by the property below; the shortest of its finds.)
        const content = '[w0 *Https://x/w1||w2_[w3](https://x/(w4)https://x/w5_w6![w7](sovereign-enc:a?k=w8_w9&m=image%2Fpng)||Https://x/w10||w11';
        const hiddenIn = (nodes: Node[], under = false, out = new Set<string>()): Set<string> => {
            for (const n of nodes) {
                if ('children' in n) hiddenIn(n.children, under || n.type === 'spoiler', out);
                else if (under) for (const w of JSON.stringify(n).match(/w\d+/g) ?? []) out.add(w);
            }
            return out;
        };
        expect([...hiddenIn(parsedAt857(content))]).toContain('w10');
        expect([...hiddenIn(parsedAt855(content))]).not.toContain('w10');
        expect([...hiddenIn(parsedAsItWas(content))]).not.toContain('w10');
        const now = hiddenIn(parseMessage(content));
        for (const w of hiddenIn(parsedAt857(content))) expect(now.has(w), w).toBe(true);
        for (const w of hiddenIn(parsedAt855(content))) expect(now.has(w), w).toBe(true);
    });

    // The ways out of it, each found by a search over random messages (a few in a thousand of those with a `[`
    // and a `||` to move) and each the shortest of its kind. The reading that hides what 0.9.857's did not is
    // kept where it hides nothing of it less; where each hides what the other prints, every stretch between `||`
    // is a spoiler, if that hides all 0.9.857 hid and leaves no `||` to see; and where it cannot, it is 0.9.857's.
    it.each([
        // Hiding less than 0.9.857 did.
        '||w0*w1> [![w2](x)w3w4://w5Https://x/w6||w7w8||://:[]-![#w9_w10[w11](x).',
        ']:[![w0](x)-\n>|| w1:[([w2](x)w3_w4)[\n>||![||',
        // Every stretch would split a word of the address 0.9.857 hid whole (`_w0Https`), and read it as an address.
        '[||[](m)||_w0Https://x/w1||w2',
        // Every stretch would leave a `||` to see.
        ' __:[||[](m)||w0_w1]||||://> >',
        // The same, where a label was turned down in the every-stretch reading only.
        ' ![w0](x)![w1](x)||||[||[](x)||w2_w3\n>[||[](m)||!||w4*w5](x)https://x/w6 ![w7||w8Https://x/w9||w10 ',
    ])('it is read as 0.9.857 read it, labels with a `[` and all, where nothing else hides what that did: %j', (content) => {
        expect(parseMessage(content)).toEqual(parsedAt857(content));
    });

    it('where each hides what the other prints, and no `||` is left to see, every stretch between `||` is a spoiler of its own', () => {
        const said = (value: string) => ({ type: 'text', value });
        const spoiler = (...children: unknown[]) => ({ type: 'spoiler', children });
        expect(parseMessage('_[||[](m)||_> ])||')).toEqual([said('_['), spoiler(said('[](m)')), spoiler(said('_> ])'))]);
        expect(parsedAt857('_[||[](m)||_> ])||')).not.toEqual(parseMessage('_[||[](m)||_> ])||'));
    });

    it('and where the first reading hides all 0.9.857 did, it is the first, with its stray `[` a word', () => {
        const said = (value: string) => ({ type: 'text', value });
        const spoiler = (...children: unknown[]) => ({ type: 'spoiler', children });
        const content = '_> [||[](m)||w0_w1(>  ||[||';
        expect(parseMessage(content)).toEqual([
            { type: 'em', children: [said('> ['), spoiler(said('[](m)')), said('w0')] },
            said('w1(>  '),
            spoiler(said('[')),
        ]);
    });

    it.each([
        '||__[__![w0](x)|| [(w1*w2',
        '**(||_||_[w0#w1_w2![w3](x)',
        'w0_w1 [ w2_w3 ![ || || ](x)',
    ])('the parsers before 0.9.857 are held to as they were, labels with a `[` and all: %j', (content) => {
        // Here it is the same tree as the parser as it was, and not 0.9.857's.
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        expect(parseMessage(content)).not.toEqual(parsedAt857(content));
    });

    it.each([
        ' ![w0[||](x)||[w1Https://x/w2||w3',
        '_*)![[w0](https://x/(w1)||:[w2~~)||[!',
    ])('and the readings it keeps for that are those parsers, not this one with their names: %j', (content) => {
        // The first reading hides less than 0.9.857 did here; the one it falls back on has the `[` in the label
        // that makes the picture one (the alt is `w0[||`), where the same reading without it makes a link of `||`.
        expect(parseMessage(content)).toEqual(parsedAt857(content));
        expect(JSON.stringify(parseMessage(content))).toMatch(/"type":"image","alt":"[^"]*\[/);
    });

    /** The marker words (`w<N>`) a parse hides under a spoiler. */
    const hiddenWords = (nodes: Node[], under = false, out = new Set<string>()): Set<string> => {
        for (const n of nodes) {
            if ('children' in n) hiddenWords(n.children, under || n.type === 'spoiler', out);
            else if (under) for (const w of JSON.stringify(n).match(/w\d+/g) ?? []) out.add(w);
        }
        return out;
    };

    // Found by an independent search, shrunk (29 of 900,000 random messages): every stretch between `||` was a
    // spoiler only if no `||` was left to see, which a quote or a fence next to a bar can end without one, and
    // the words it ended it on printed. The reading is kept only if it hides what 0.9.857 hid as well.
    it.each([
        '|| ||)||w1\n>||[||[](m)||p||q',
        '||:||)||w2```||[||[](o)||p||q',
        '[||[w](1)||]||[||](g)||w3\n>|| ||w',
        '||`||```w4||[||[](o)||[||7',
        'p|| ||b(||[w3\n>||![[||](4)',
        '[||[](m)||5||[||](g)||\n>[w1||[](1)||w',
    ])('a quote or a fence beside a bar does not end a spoiler 0.9.857 kept: %j', (content) => {
        const now = hiddenWords(parseMessage(content));
        expect([...hiddenWords(parsedAt857(content))].filter(w => !now.has(w))).toEqual([]);
        expect([...hiddenWords(parsedAt855(content))].filter(w => !now.has(w))).toEqual([]);
        expect([...hiddenWords(parsedAsItWas(content))].filter(w => !now.has(w))).toEqual([]);
        expect(hiddenWords(parsedAt857(content)).size).toBeGreaterThan(0);
    });

    // The composer sends `text + ' ' + ||ref||` for each file it spoilers. Whatever the text before them says,
    // so long as it opens no spoiler of its own, none of them is drawn.
    const WORDS = ['ugh', 'ok', ':[', '[', '[ ', '![', '](', ']', '(', ')', 'a_b', 'my_file', '*x*', '__y__', '~~z~~', 'see [docs](https://example.org/a_b)',
        '[a](b)', '![c](d)', '@bob', '#general', ':smile:', 'https://example.org/x_y', '> ', '\n', '\n> ', '<https://example.org/a>', '[', '[', ':['];
    it('as a property, over any words before them: no file of a composer\'s message is drawn in the clear', () => {
        let seed = 20261105;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        const files = refs(64);
        const bad: string[] = [];
        let strayed = 0;
        for (let k = 0; k < 20000; k++) {
            const words = Array.from({ length: next(8) }, () => WORDS[next(WORDS.length)]).join(next(3) ? ' ' : '');
            const picked = Array.from({ length: 1 + next(3) }, () => files[next(files.length)]);
            const content = `${words} ${picked.map(f => `||${f.md}||`).join(' ')}`;
            const { shown, hidden } = placed(content);
            if (/\[[^\]\n]*\[[^\]\n]*\]\(/.test(content)) strayed++;
            const drawn = shown.filter(h => picked.some(f => f.href === h));
            if (drawn.length) bad.push(`${JSON.stringify(content)} draws ${drawn.length}, hides ${hidden.length}`);
        }
        expect(bad.slice(0, 5)).toEqual([]);
        // Over nothing it would prove nothing.
        expect(strayed).toBeGreaterThan(3000);
    }, 120_000);

    it('NEGATIVE CONTROL: the same words in 0.9.857 drew many of them', () => {
        let drawn = 0;
        let tried = 0;
        for (const f of refs(40)) {
            tried++;
            const nodes = parsedAt857(`ugh :[ ||${f.md}||`);
            if (!JSON.stringify(nodes).includes('"spoiler"')) drawn++;
        }
        expect(drawn).toBe(tried);
    });

    // Where the parser may differ from 0.9.857 at all: a `[` that is not closed before another `[` that
    // is closed by a `](`. Where there is none the tree is the same, whatever else is in the message,
    // and so is where each spoiler was typed.
    const PARTS = ['||', '||', '||', '**', '*', '__', '_', '_', '~~', '`', ' ', ' ', ' ', 'W', 'W', 'W', 'W_W', 'W*W',
        'https://x/W', 'https://x/W_W', 'Https://x/W||W', '[', '[', '[W', '![', '![W', ']', '](', '](x)', '](https://x/W)', '[W](x)', '![W](x)',
        '[W](https://x/(W)', '![W](sovereign-enc:a?k=W_W&m=image%2Fpng)', '[W](sovereign-enc:a?k=W__W)', ':[', ':', '://', ':W_W:', '@W', '#W_W',
        '(', ')', '.', '>', '"', '\n', '> ', '\n> ', '-', '!', '@W_', 'Link:https://x/W_W',
        // A quote or a fence beside a bar, bars with nothing between them, and a bar in a stray label.
        '\n>', '\n>||', '```', '|| ||', ')||', '||[||[](x)||', '[||[](m)||'];
    const STRAY = /\[[^\]\n]*\[[^\]\n]*\]\(/;
    /** Where each spoiler of a parse was typed, in the order drawn. */
    const spansOf = (nodes: Node[], of: (n: Node) => readonly [number, number] | undefined): string => {
        const out: string[] = [];
        const walk = (ns: Node[]) => {
            for (const n of ns) {
                if (n.type === 'spoiler') out.push(JSON.stringify(of(n)));
                if ('children' in n) walk(n.children);
            }
        };
        walk(nodes);
        return out.join(';');
    };

    /** Whether every character of a word (WORD_RE's) typed in a spoiler of `then` (0.9.857's) is in one of `read` (this parser's). */
    const hidesEveryLetterOf = (content: string, read: Node[], then: Node[]) => {
        const stretches = (nodes: Node[], of: (n: Node) => readonly [number, number] | undefined, out: Array<readonly [number, number]> = []) => {
            for (const n of nodes) {
                const span = of(n);
                if (span) out.push(span);
                if ('children' in n) stretches(n.children, of, out);
            }
            return out;
        };
        const mine = stretches(read, spoilerSpan);
        return stretches(then, spoilerSpanAt857).every(([from, to]) => {
            for (let at = from; at < to; at++) if (/[^\s!-/:-@[-`{-~]/u.test(content[at]) && !mine.some(([a, b]) => at >= a && at < b)) return false;
            return true;
        });
    };

    it.each<[number, number, string]>([
        [20261105, 10, ''],
        [6, 14, ''],
        [7, 30, ' '],
        [11, 40, ' '],
        [13, 12, ''],
        [17, 12, ' '],
    ])('as a property: with no stray `[` it reads as 0.9.857 did, or hides more where that printed what 0.9.855 hid, and it prints nothing any of them hid: seed %i, up to %i parts, joined by "%s"', (start, parts, between) => {
        let seed = start;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        const words = (nodes: Node[], under: boolean, out: { hidden: Set<string>; shown: Set<string> }) => {
            for (const n of nodes) {
                if ('children' in n) words(n.children, under || n.type === 'spoiler', out);
                else for (const w of JSON.stringify(n).match(/w\d+/g) ?? []) (under ? out.hidden : out.shown).add(w);
            }
            return out;
        };
        const differ: string[] = [];
        const leaked: string[] = [];
        let same = 0;
        let strayed = 0;
        let changed = 0;
        let heldMore = 0;
        for (let k = 0; k < 30000; k++) {
            let id = 0;
            const content = Array.from({ length: 1 + next(parts) }, () => PARTS[next(PARTS.length)].replace(/W/g, () => `w${id++}`)).join(between);
            const read = parseMessage(content);
            const then = parsedAt857(content);
            if (!STRAY.test(content)) {
                same++;
                if (JSON.stringify(read) !== JSON.stringify(then) || spansOf(read, spoilerSpan) !== spansOf(then, spoilerSpanAt857)) {
                    // 0.9.857 printed a letter 0.9.855 hid, by where it was typed (heldToEarly): this hides it, and
                    // every letter 0.9.857 hid. Nothing else may read otherwise.
                    if (hidesEveryLetterOf(content, read, then)) heldMore++;
                    else differ.push(content);
                }
            } else {
                strayed++;
                if (JSON.stringify(read) !== JSON.stringify(then)) changed++;
            }
            const now = words(read, false, { hidden: new Set(), shown: new Set() });
            // 0.9.857, and the two parsers before it, whose guard this is: what any of them hid is not printed.
            for (const [name, before] of [['0.9.857', then], ['0.9.855', parsedAt855(content)], ['as it was', parsedAsItWas(content)]] as const) {
                const was = words(before, false, { hidden: new Set(), shown: new Set() });
                const out = [...was.hidden].filter(w => now.shown.has(w));
                if (out.length) leaked.push(`${JSON.stringify(content)} prints ${out.join(', ')}, hidden in ${name}`);
            }
        }
        expect(differ.slice(0, 5)).toEqual([]);
        expect(leaked.slice(0, 5)).toEqual([]);
        // It is that rare: 2 of the 180,000 here, each a letter in `](x)` beside a bar.
        expect(heldMore).toBeLessThanOrEqual(2);
        // Over nothing it would prove nothing.
        expect(same).toBeGreaterThan(10000);
        expect(strayed).toBeGreaterThan(1500);
        expect(changed).toBeGreaterThan(500);
    }, 120_000);
});

describe('what 0.9.855 hid stays hidden beside a quote or a fence', () => {
    /** The marker words (`w<N>`, or the emoji `markers` finds) a parse hides, and those it prints. */
    const seen = (nodes: Node[], markers: RegExp, under = false, out = { hidden: new Set<string>(), shown: new Set<string>() }) => {
        for (const n of nodes) {
            if ('children' in n) seen(n.children, markers, under || n.type === 'spoiler', out);
            else for (const w of JSON.stringify(n).match(markers) ?? []) (under ? out.hidden : out.shown).add(w);
        }
        return out;
    };
    const W = /w\d+/g;
    const EMOJI = /\p{Extended_Pictographic}/gu;
    /** The marker words `before` hid that `read` prints. */
    const printsWhat = (read: Node[], before: Node[], markers: RegExp = W) => {
        const now = seen(read, markers);
        return [...seen(before, markers).hidden].filter(w => now.shown.has(w));
    };
    /** Whether a spoiler of `nodes` holds what was typed at `at`. */
    const hiddenAt = (nodes: Node[], of: (n: Node) => readonly [number, number] | undefined, at: number): boolean =>
        nodes.some(n => { const span = of(n); return (span !== undefined && at >= span[0] && at < span[1]) || ('children' in n && hiddenAt(n.children, of, at)); });

    // 0.9.857 held every reading to what 0.9.855 hid but one: where each hid what the other printed, every
    // stretch between two `||` was a spoiler, asked only to leave no `||` to see. A quote or a fence beside a
    // bar ends a stretch without one. The first two are from an independent search (12 shrunk in 1,960,000),
    // the rest from the property below.
    it.each([
        '||\n> l||:w8```||\n```',
        '_||__||w8Http://y` ||_B||`',
        '*||\n> w0||```>https://x/w1_w2||\n```',
        '||\n> [w0](x)w1w2||```https://x/w3||_||\n```',
        '||\n> w0\n> ||\n> `https://x/w1||_\n> ||\n> ||\n```',
        '>||\n>  ](x)||```w0||\n````w1`',
    ])('%j', (content) => {
        const read = parseMessage(content);
        expect(printsWhat(read, parsedAt855(content))).toEqual([]);
        expect(printsWhat(read, parsedAsItWas(content))).toEqual([]);
        expect(printsWhat(read, parsedAt857(content))).toEqual([]);
        // NEGATIVE CONTROL: 0.9.857 printed it, and so did every version after it up to 0.9.862.
        expect([...printsWhat(parsedAt857(content), parsedAt855(content)), ...printsWhat(parsedAt857(content), parsedAsItWas(content))].length).toBeGreaterThan(0);
    });

    it('by where it was typed, not by the words: a word said twice cannot stand in for the one hidden', () => {
        // 0.9.855 hid the last stretch, `||w*w||`; 0.9.857 hid the first and printed the last, and counting
        // words saw three `w` hidden for two.
        const content = 'w*w,||w w*w||w*w||';
        const last = content.lastIndexOf('||w*w||');
        for (const at of [last + 2, last + 4]) {
            expect(content[at]).toBe('w');
            expect(hiddenAt(parseMessage(content), spoilerSpan, at), `${at}`).toBe(true);
            // NEGATIVE CONTROL
            expect(hiddenAt(parsedAt857(content), spoilerSpanAt857, at), `${at}`).toBe(false);
        }
        // Each stretch is a spoiler, as where the readings disagree on words that are not the same.
        expect(parseMessage(content)).toEqual([
            { type: 'text', value: 'w*w,' },
            { type: 'spoiler', children: [{ type: 'text', value: 'w w*w' }] },
            { type: 'spoiler', children: [{ type: 'text', value: 'w*w' }] },
        ]);
        expect(parseMessage('**||w~~w**||___w~~||~~').filter(n => n.type === 'spoiler')).toHaveLength(2);
    });

    it('an emoji is a word as much as a letter is: it stays hidden too', () => {
        // Counting only letters and digits held the tree to 0.9.855's reading, which hid every letter
        // 0.9.857's did and printed the fox 0.9.857 and 0.9.862 hid.
        const fox = '*||\n> \u{1F98A}||```>https://x/a_b||\n```';
        // CONTROL: 0.9.855 prints the fox 0.9.857 hid.
        expect(printsWhat(parsedAt855(fox), parsedAt857(fox), EMOJI)).toEqual(['\u{1F98A}']);
        // And the changelog's own message, with an emoji where its w8 is: 0.9.857 printed the party 0.9.855 hid.
        const party = 'Guess ||\n> \u{1F98A}\u{1F355}||:\u{1F389}```||\n```';
        expect(printsWhat(parsedAt857(party), parsedAt855(party), EMOJI)).toEqual(['\u{1F389}']);
        for (const content of [fox, party]) {
            for (const before of [parsedAt857(content), parsedAt855(content), parsedAsItWas(content)]) {
                expect(printsWhat(parseMessage(content), before, EMOJI), content).toEqual([]);
            }
        }
    });

    it('where no one reading hides all the others did, from the first `||` any opened to the last any closed is one spoiler', () => {
        const content = '_||__||w8Http://y` ||_B||`';
        // CONTROL: 0.9.857 prints the w8 0.9.855 hid, and 0.9.855 the B 0.9.857 hid.
        expect(printsWhat(parsedAt857(content), parsedAt855(content))).toEqual(['w8']);
        expect(JSON.stringify(parsedAt855(content).filter(n => n.type === 'text'))).toContain('B');
        expect(JSON.stringify(parsedAt857(content).filter(n => n.type === 'spoiler'))).toContain('_B');
        const read = parseMessage(content);
        expect(read.map(n => n.type)).toEqual(['text', 'spoiler', 'text']);
        expect(spoilerSpan(read[1])).toEqual([1, content.length - 1]);
        expect(read[0]).toEqual({ type: 'text', value: '_' });
        expect(read[2]).toEqual({ type: 'text', value: '`' });
        // A quote in it is read as a quote.
        const quoted = parseMessage('||\n> l||:w8```||\n```');
        expect(quoted[0].type).toBe('spoiler');
        expect(JSON.stringify(quoted[0])).toContain('"blockquote"');
    });

    // Bars beside quotes and fences, and what reads differently there: a `_`, a backtick, a link's end.
    const NEAR: Record<string, string[]> = {
        quotes: ['||', '||', '||', '||\n> ', '||\n```', '```', '\n> ', 'W', 'W', ' ', '_', '`', '[W](x)', 'https://x/W'],
        fences: ['||', '||\n> ', '||\n```', '```', 'W', 'W', ' ', ':', '_', '*', '`', '](x)', '>'],
        both: ['||', '||', '||\n> ', '||\n```', '```', '||```', '\n> ', 'W', 'W', 'W', ' ', ':', '_', '*', '`', '](x)', '[W](x)', 'Http://y`', 'https://x/W_W', '>', '!', ')'],
    };
    it('as a property: nothing 0.9.855, the parser before it or 0.9.857 hid is printed, letters or emoji', () => {
        const bad: string[] = [];
        let controls = 0;
        // Each marker an emoji where asked: one a rule of letters and digits cannot see.
        const marked = { w: (id: number) => `w${id}`, emoji: (id: number) => String.fromCodePoint(0x1f400 + id) };
        for (const [parts, size, marker] of [['quotes', 12, 'w'], ['fences', 12, 'w'], ['both', 16, 'w'], ['both', 16, 'emoji']] as const) {
            let seed = 20261114;
            const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
            const markers = marker === 'w' ? W : EMOJI;
            for (let k = 0; k < 30000; k++) {
                let id = 0;
                const content = Array.from({ length: 1 + next(size) }, () => NEAR[parts][next(NEAR[parts].length)].replace(/W/g, () => marked[marker](id++))).join('');
                const before = [parsedAt855(content), parsedAsItWas(content)];
                const out = [...before, parsedAt857(content)].flatMap(was => printsWhat(parseMessage(content), was, markers));
                if (out.length) bad.push(`${JSON.stringify(content)} prints ${out.join(', ')}`);
                if (before.some(was => printsWhat(parsedAt857(content), was, markers).length)) controls++;
            }
        }
        expect(bad.slice(0, 5)).toEqual([]);
        // NEGATIVE CONTROL: 0.9.857 printed some, so the sweep reaches them.
        expect(controls).toBeGreaterThanOrEqual(5);
    }, 120_000);
});

describe('a spoiler around a fence or a quote', () => {
    const FENCE = '```';
    const said = (value: string) => ({ type: 'text', value });
    const spoiler = (...children: unknown[]) => ({ type: 'spoiler', children });
    const code = (value: string, lang: string | null = null) => ({ type: 'codeblock', value, lang });
    const quote = (value: string) => ({ type: 'blockquote', children: [said(value)] });

    it('holds the fence as a fence, however it is wrapped', () => {
        expect(parseMessage(`||${FENCE}py\nthe answer\n${FENCE}||`)).toEqual([spoiler(code('the answer', 'py'))]);
        expect(parseMessage(`||a\n${FENCE}\nb\n${FENCE}\nc||`)).toEqual([spoiler(said('a\n'), code('b'), said('\nc'))]);
        expect(parseMessage(`x ||${FENCE}\nb\n${FENCE}|| y`)).toEqual([said('x '), spoiler(code('b')), said(' y')]);
        expect(parseMessage(`**||${FENCE}\nb\n${FENCE}||**`)).toEqual([{ type: 'strong', children: [spoiler(code('b'))] }]);
        expect(parseMessage(`my_file ||${FENCE}\nb_c\n${FENCE}||`)).toEqual([said('my_file '), spoiler(code('b_c'))]);
        expect(parseMessage(`> ||${FENCE}b${FENCE}||`)).toEqual([{ type: 'blockquote', children: [spoiler(code('b'))] }]);
    });

    it('a spoiler with spaces in it, or a `||` on a line of its own, holds it too', () => {
        expect(parseMessage(`|| a\n${FENCE}\nb\n${FENCE}\nc ||`)).toEqual([spoiler(said(' a\n'), code('b'), said('\nc '))]);
        expect(parseMessage(`||\n${FENCE}\nb\n${FENCE}\n||`)).toEqual([spoiler(said('\n'), code('b'), said('\n'))]);
        expect(parseMessage('|| a\n> b\nc ||')).toEqual([spoiler(said(' a\n'), quote('b'), said('c '))]);
    });

    it('holds the quote as a quote', () => {
        expect(parseMessage('||a\n> b\nc||')).toEqual([spoiler(said('a\n'), quote('b'), said('c'))]);
        expect(parseMessage('||a\n> b||')).toEqual([spoiler(said('a\n'), quote('b'))]);
        expect(parseMessage('||a\n> b\nc || d')).toEqual([spoiler(said('a\n'), quote('b'), said('c ')), said(' d')]);
        expect(parseMessage('||> a\n> b||')).toEqual([spoiler({ type: 'blockquote', children: [said('a\nb')] })]);
    });

    it('another one in the words after it holds its own', () => {
        expect(parseMessage('||a\n> b|| x\n||c\n> d||')).toEqual([spoiler(said('a\n'), quote('b')), said(' x\n'), spoiler(said('c\n'), quote('d'))]);
    });

    it('an empty pair is no spoiler, and the one after it is', () => {
        expect(parseMessage('||||a\n> b||')).toEqual([said('|'), spoiler(said('|a\n'), quote('b'))]);
    });

    it('and what follows it is read as it always was', () => {
        expect(parseMessage(`||${FENCE}\nb\n${FENCE}||\n${FENCE}\nc\n${FENCE}\n> d`)).toEqual([spoiler(code('b')), said('\n'), code('c'), said('\n'), quote('d')]);
        expect(parseMessage('||a\n> b||\n> c\n||d\n> e||')).toEqual([spoiler(said('a\n'), quote('b')), said('\n'), quote('c'), spoiler(said('d\n'), quote('e'))]);
    });

    it('a line starting with `>` that is no quote, and a fence never closed, are in it as words', () => {
        expect(parseMessage('||a\n>b||')).toEqual([spoiler(said('a\n>b'))]);
        expect(parseMessage(`||a ${FENCE}b c||`)).toEqual([spoiler(said(`a ${FENCE}b c`))]);
    });

    it('no card under the message gives away what is in it', () => {
        expect(extractUrls(`||${FENCE}\nhttps://example.org/hidden\n${FENCE}||`)).toEqual([]);
        expect(extractUrls('||a\n> https://example.org/hidden\nb||')).toEqual([]);
        // CONTROL
        expect(extractUrls(`${FENCE}\nhttps://example.org/shown\n${FENCE}`)).toEqual(['https://example.org/shown']);
    });

    it.each([
        // The `||` that would close it is code.
        [`a || b\n${FENCE}\nc || d\n${FENCE}`],
        // Closed before the block starts.
        [`||a||\n${FENCE}\nb\n${FENCE}\n||c||`],
        ['||a||\n> b\n||c||'],
        // Nothing to close it.
        ['a || b\n> c'],
        [`a || b\n${FENCE}\nc\n${FENCE}`],
        // A quote is a block of its own from its first line, whatever opens in it.
        ['> ||a\nb||'],
        ['> a || b\nc || d'],
        // A `||` with a space either side is an `or`, and takes nothing over a block.
        ['if a || b:\n```\nsome code\n```\nor c || d:'],
        ['if a || b:\n> a quote\nor c || d:'],
        ['a || b\n> c\n||secret||'],
        ['a || b\n```\nc\n```\n||secret||'],
        ['||secret|| a\n> c\nor b || d'],
        // So is one with a letter or a digit right outside it.
        [`x||y fails:\n${FENCE}\nerror_here\n${FENCE}\nbut p||q works`],
        ['a||b\n> quoted line\nc||d'],
        [`run it||\n${FENCE}\nx\n${FENCE}\n||2 times`],
        // And where the readings disagree, as `_` in the words makes them.
        [`if is_admin || is_mod || is_owner || is_staff:\n${FENCE}py\ngrant_access()\n${FENCE}\notherwise has_role || has_perm`],
        // In a fence a spoiler is code.
        [`${FENCE}\n||a||\n${FENCE}`],
        [`${FENCE}\n||a\n> b||\n${FENCE}`],
    ])('CONTROL: what is no spoiler around a block is as it was: %j', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it('where the readings disagree and only an `or` would take a block in, it is read as 0.9.855 read it', () => {
        const content = 'my_file || w0_w1 || w2 || w3\n> w4\nw5 || w6';
        expect(parseMessage(content)).toEqual(parsedAt855(content));
        expect(parseMessage(content)).toContainEqual(quote('w4'));
    });

    it('CONTROL: a spoiler right up against what is not a letter or a digit holds the block', () => {
        expect(parseMessage(`answer:||${FENCE}\nx\n${FENCE}||.`)).toEqual([said('answer:'), spoiler(code('x')), said('.')]);
        expect(parseMessage('(||a\n> b\nc||)')).toEqual([said('('), spoiler(said('a\n'), quote('b'), said('c')), said(')')]);
    });
});

describe('an address ends where a spoiler starts', () => {
    const said = (value: string) => ({ type: 'text', value });
    const url = (href: string) => ({ type: 'url', href });
    const spoiler = (value: string) => ({ type: 'spoiler', children: [said(value)] });
    const A = 'https://example.org/a';

    it.each<[string, unknown[]]>([
        [`see ${A}||secret||`, [said('see '), url(A), spoiler('secret')]],
        [`${A}||secret||`, [url(A), spoiler('secret')]],
        [`${A}||secret|| and more`, [url(A), spoiler('secret'), said(' and more')]],
        [`${A}.||secret||`, [url(A), said('.'), spoiler('secret')]],
        [`${A}||two words||`, [url(A), spoiler('two words')]],
        ['Https://example.org/a||secret||', [url('Https://example.org/a'), spoiler('secret')]],
        ['Link:https://example.org/a||secret||', [said('Link:'), url(A), spoiler('secret')]],
        ['https://example.org/(a||secret||)', [url('https://example.org/(a'), spoiler('secret'), said(')')]],
        [`**${A}||secret||**`, [{ type: 'strong', children: [url(A), spoiler('secret')] }]],
        [`_${A}_b||secret||_`, [{ type: 'em', children: [url(`${A}_b`), spoiler('secret')] }]],
        [`_${A}_||secret||`, [{ type: 'em', children: [url(A)] }, spoiler('secret')]],
    ])('%s', (content, nodes) => {
        expect(parseMessage(content)).toEqual(nodes);
    });

    it('so the words in it are on no link and no card', () => {
        expect(hrefs(`see ${A}||secret||`)).toEqual([A]);
        expect(extractUrls(`see ${A}||secret||`)).toEqual([A]);
    });

    it.each([
        [`${A}||b`],
        [`${A}||`],
        [`${A}||||`],
        [`${A}||||b`],
        ['https://example.org/?q=a||b'],
    ])('CONTROL: with nothing to close it, it is the address\'s, as it always was: %s', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it('CONTROL: `||` in code closes nothing, and Notes has no spoilers to stop for', () => {
        expect(hrefs(`${A}||b \`||\``)).toEqual([`${A}||b`]);
        expect(urlAt(`${A}||secret||`)).toBe(`${A}||secret||`);
    });
});

describe('what a message costs to read', () => {
    /**
     * The fastest it reads in, tried until that is under `bar` or for 20 s. What else is
     * on the machine only ever adds to it and comes and goes, so a machine under load
     * still gets there, and a message that really costs this much never does. These run
     * beside the whole suite: 0.5 ms here has been 34 ms there, on every one of five runs.
     */
    const fastest = (content: string, bar: number) => {
        const giveUp = performance.now() + 20_000;
        let best = Infinity;
        do {
            const started = performance.now();
            parseMessageUncached(content);
            best = Math.min(best, performance.now() - started);
        } while (best >= bar && performance.now() < giveUp);
        return best;
    };
    const WAIT = 60_000;
    /**
     * The bar each row is held to, on this machine or on CI. GitHub's runners read these
     * slower than a quiet desktop does, under the whole suite: `[` before targets in another
     * script, 9 ms quiet and 26 ms under the suite here, was 36.4 ms (0.9.859) and 36.5 ms
     * (0.9.861) there, at its BEST over 20 s of tries, against a bar of 35. So where GitHub
     * says CI (it sets CI=true), every bar is twice what it is here. The slowdowns these rows
     * exist for are slower there in the same proportion (that row's 50 ms would read about
     * 180 there, against 70), so they still fail on CI; a smaller one is the local gates'
     * to catch, where the bars stay as written.
     */
    const CI_HEADROOM = process.env.CI === 'true' ? 2 : 1;
    const bar = (ms: number) => ms * CI_HEADROOM;

    // A message is at most 8000 long, and is read on the UI thread, on receipt and on
    // every render of the chat. The first three took 1100, 500 and 60 ms with guards for
    // spoilers that walked the text at every address and sent the next opener back into
    // it.
    it.each([
        ['nested openers, an address and a `||` over and over, and a spoiler', `**__~~*_${'>http://a_b_c||'.repeat(532)}_ ||s||`],
        ['one `_`, and an address and a `||` over and over', `_${'http://a_b_c ||'.repeat(532)}* ||s||`],
        ['one word of addresses', `*${'http://a**b>#'.repeat(615)}_`],
        ['words of a shortcode with an address in them', `**${'~~)"~~@:Hbhttp://****b__H)('.repeat(295)}_ ||s||`],
        ['every delimiter, and an address that takes them in', `\`${'_***http://:**b~~~~____'.repeat(347)} ||s||`],
        ['a list of addresses with a spoiler', `my_list:\n${'https://example.org/some_long_path_name\n'.repeat(199)}||s|| *`],
    ])('%s', (_, content) => {
        expect(content.length).toBeGreaterThan(7500);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(30))).toBeLessThan(bar(30));
    }, WAIT);

    it('a delimiter only the end of a link opens: every one closes at the next', () => {
        const content = '[x](http://a)_b '.repeat(490);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(parseMessage(content).filter(n => n.type === 'em')).toHaveLength(245);
        expect(fastest(content, bar(10))).toBeLessThan(bar(10));
    }, WAIT);

    // Found by searching for what is cheap only because of this charge, with it taken out.
    it('an address with a `||` in it, read to the end of its word each time: 3 ms, or 26 if it pays only for what it stepped over', () => {
        const content = `__${'](http://a||b)!#a_b]('.repeat(380)}* ||s||`;
        expect(content.length).toBeGreaterThan(7500);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(12))).toBeLessThan(bar(12));
    }, WAIT);

    it('what turns out no link is paid for too: past the budget a `_` closes at the first one, as it used to', () => {
        const href = 'https://example.org/a_b';
        // CONTROL: a few tries leave the address after them whole.
        expect(hrefs(`_ ${'[a](b c) '.repeat(4)}_ x_y ${href}`)).toEqual([href]);
        expect(hrefs(`_ ${'[a](b c) '.repeat(200)}_ x_y ${href}`)).toEqual(['https://example.org/a']);
        // And the budget stops the walk that spends it trying: this link is not stepped over.
        expect(hrefs(`_ ${'[a](b c) '.repeat(4)}[x](d_e) f_`)).toEqual(['d_e']);
        expect(hrefs(`_ ${'[a](b c) '.repeat(200)}[x](d_e) f_`)).toEqual([]);
        // Past it the whole word is one address: reading it up to each `||` costs ten times this.
        expect(hrefs(`_ ${'[a](b c) '.repeat(4)}_ https://example.org/a||b||`)).toEqual(['https://example.org/a']);
        expect(hrefs(`_ ${'[a](b c) '.repeat(200)}_ https://example.org/a||b||`)).toEqual(['https://example.org/a||b||']);
    });

    it.each([
        ['spoilers holding every delimiter, with every opener before them', `**__~~*_${'||*_~~**__||'.repeat(665)}`],
        ['a walk over a word of addresses with a `||` in each', `_${'http://a||'.repeat(799)}`],
        ['a spoiler over a fence, over and over', `||a\n\`\`\`\nb\n\`\`\`\nc|| `.repeat(440)],
        ['a spoiler over a quote, over and over', '||a\n> b\nc|| '.repeat(610)],
        ['a `||` and a block, over and over', 'a||\n> b\n'.repeat(888)],
        ['spoilers the readings disagree on, over and over', `a_b ${'||c_d|| e '.repeat(796)}`],
        ['the same, around quotes', `a_b ${'||c_d\n> e\nf|| g '.repeat(470)}`],
        // Held to 0.9.855 by where each letter was typed, and read again as each stretch or one spoiler.
        ['a word said twice where the readings disagree, over and over', 'w*w,||w w*w||w*w|| '.repeat(420)],
        ['a quote and a fence beside a bar, over and over', '||\n> l||:w8```||\n```'.repeat(400)],
        ['a link\'s end beside the bars, over and over', `_||__||w8Http://y\` ||_B||\` ${'[a](b) '.repeat(1000)}`],
    ])('%s', (_, content) => {
        expect(content.length).toBeGreaterThan(7000);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(30))).toBeLessThan(bar(30));
    }, WAIT);

    it.each(['[', '!['])('%s over and over: 3 ms, or 20 and more with a look at 512 characters for each', (open) => {
        const content = `_${open.repeat(7990 / open.length)}_ ||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(12))).toBeLessThan(bar(12));
    }, WAIT);

    // A target is read one character at a time, up to its `)` or a space, as often as there is a `[`
    // before it. In another script a regular expression for each character cost 4 to 5 times this.
    it('`[` over and over before targets in another script: 10 ms, or 50 with a regular expression for each character', () => {
        const unit = `${'['.repeat(500)}](${'秘'.repeat(1400)} )`;
        const content = unit.repeat(Math.floor(8000 / unit.length));
        expect(content.length).toBeGreaterThan(7500);
        // 9 ms on a quiet machine and 26 under the whole suite: the bar sits between that and 50.
        expect(fastest(content, bar(35))).toBeLessThan(bar(35));
    }, WAIT);

    it('`[` over and over with no `)` after them, and spoilers the readings disagree on: 7 ms, or 60 reading each target to its end', () => {
        const unit = `${'['.repeat(16)}](${'秘'.repeat(16)}`;
        const content = `my_file ||a_b|| and ||c_d|| ${unit.repeat(233)} ||s||`;
        expect(content.length).toBeGreaterThan(7500);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(35))).toBeLessThan(bar(35));
    }, WAIT);

    it('a `[` with no `](` after it is no try at a link, so a list of them leaves a walk its budget', () => {
        const href = 'https://example.org/a_b';
        const content = `_ ${'[1] '.repeat(200)}_ x_y ${href}`;
        expect(hrefs(content)).toEqual([href]);
        expect(extractUrls(content)).toEqual([href]);
    });

    it('a walk that closes in an address pays for it: 3 ms, or 40 if only a walk that finds nothing does', () => {
        const content = `||s|| ${'_http://_'.repeat(488)}${'('.repeat(1800)}${')'.repeat(1800)}`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(20))).toBeLessThan(bar(20));
    }, WAIT);

    it('a run of one delimiter in an address: 1 ms, or 25 with no bound on what stands between a closer and an opener', () => {
        const content = `_https://example.org/${'_'.repeat(7900)}a ||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(10))).toBeLessThan(bar(10));
    }, WAIT);

    it('very short quotes and one small spoiler: 2 ms, or 116 if each quote reads all that is left of the text', () => {
        const content = `${'>\n\n'.repeat(2665)}||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(30))).toBeLessThan(bar(30));
    }, WAIT);

    // A link turned down for a `[` in its label is read again, as 0.9.857 read it, to hold the first to what
    // that hid (`Strays`): up to six readings where there were four, the 0.9.855 pair shared, and no more. An
    // 8000-character message built to cost trunk 26 ms (a quote under a spoiler over and over, then a stray
    // `[` and an unclosed `||`) costs 42 here; the rows below are the shapes the suite has always held to 30.
    it.each([
        ['spoilers the readings disagree on, over and over', `:[ [a](b) a_b ${'||c_d|| e '.repeat(780)}`],
        ['a spoiler over a fence, over and over', `:[ [a](b) ${'||a\n```\nb\n```\nc|| '.repeat(430)}`],
        ['a spoiler over a quote, over and over', `:[ [a](b) ${'||a\n> b\nc|| '.repeat(600)}`],
        ['the same, around quotes', `:[ [a](b) a_b ${'||c_d\n> e\nf|| g '.repeat(460)}`],
        ['nested openers, an address and a `||` over and over', `:[ [a](b) **__~~*_${'>http://a_b_c||'.repeat(520)}_ ||s||`],
        ['`[` over and over with no `)` after them, and spoilers the readings disagree on', (() => {
            const unit = `${'['.repeat(16)}](${'秘'.repeat(16)}`;
            return `:[ [a](b) my_file ||a_b|| and ||c_d|| ${unit.repeat(230)} ||s||`;
        })()],
    ])('behind a `[` it turns down, read again: %s', (_, content) => {
        expect(content.length).toBeGreaterThan(7000);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(30))).toBeLessThan(bar(30));
    }, WAIT);

    it('a text of `[` it turns down, one link and two spoilers: read again at most', () => {
        const content = `${'[a [b](c) '.repeat(790)} ||s|| ||t||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, bar(30))).toBeLessThan(bar(30));
    }, WAIT);

    it('CONTROL: what is cheap is still read in full: a list of addresses, all whole, and every name', () => {
        const line = 'https://example.org/some_long_path @alice_c\n';
        const content = `my_list:\n${line.repeat(179)}`;
        expect(content.length).toBeGreaterThan(7500);
        expect(hrefs(content)).toEqual(Array(179).fill('https://example.org/some_long_path'));
        expect(extractMentions(content).users).toEqual(['alice_c']);
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

describe('where a spoiler was typed (spoilerSpan)', () => {
    /** Every spoiler of the parse, in the order drawn, as the part of the message it was typed in. */
    function typedIn(content: string): string[] {
        const found: string[] = [];
        const walk = (nodes: Node[]) => {
            for (const n of nodes) {
                if (n.type === 'spoiler') {
                    const span = spoilerSpan(n);
                    found.push(span ? content.slice(span[0], span[1]) : '(no span)');
                }
                if ('children' in n) walk(n.children);
            }
        };
        walk(parseMessage(content));
        return found;
    }

    it('is the spoiler\'s own bars and what they hold, wherever it is', () => {
        expect(typedIn('a ||b|| c')).toEqual(['||b||']);
        expect(typedIn('||b|| and ||c||')).toEqual(['||b||', '||c||']);
        expect(typedIn('**x ||b|| y** ||c||')).toEqual(['||b||', '||c||']);
        expect(typedIn('_x ||b|| y_ and __z ||c||__')).toEqual(['||b||', '||c||']);
        expect(typedIn('my_file_name ||b_c|| ok')).toEqual(['||b_c||']);
        expect(typedIn('a *b ~~c ||d|| e~~ f* ||g||')).toEqual(['||d||', '||g||']);
        expect(typedIn('see `||code||` and ||real||')).toEqual(['||real||']);
        expect(typedIn('a ||b ![p](sovereign-enc:x?k=1&m=image%2Fpng) c||')).toEqual(['||b ![p](sovereign-enc:x?k=1&m=image%2Fpng) c||']);
        expect(typedIn('h ||a\nb\nc|| t')).toEqual(['||a\nb\nc||']);
    });

    it('is found again through a quote, whose `> ` the words were read without', () => {
        expect(typedIn('> a ||b|| c')).toEqual(['||b||']);
        expect(typedIn('before\n> a ||b||\n> c ||d|| e\nafter ||f||')).toEqual(['||b||', '||d||', '||f||']);
        expect(typedIn('> ||a\n> b||')).toEqual(['||a\n> b||']);
        expect(typedIn('>\n> x ||y||')).toEqual(['||y||']);
        expect(typedIn('> a\n> \n> b ||c||')).toEqual(['||c||']);
        // A spoiler at the very start of a quoted line after the first: the line it is on is the one
        // that begins there, not the one before (an off-by-one here starts its span at the `> `).
        expect(typedIn('> a\n> ||b||')).toEqual(['||b||']);
        expect(typedIn('> a\n> b\n> ||c|| d\n> ||e||')).toEqual(['||c||', '||e||']);
        expect(typedIn('> **a ||b||** c')).toEqual(['||b||']);
        // A spoiler that holds a quote is one spoiler, typed from its bars to its bars.
        expect(typedIn('x ||a\n> b\nc|| tail')).toEqual(['||a\n> b\nc||']);
    });

    it('is found again after a fenced block, and in what a spoiler holds', () => {
        expect(typedIn('```\ncode ||no||\n```\nthen ||yes||')).toEqual(['||yes||']);
        expect(typedIn('||a```py\nx\n```b||')).toEqual(['||a```py\nx\n```b||']);
    });

    it('is each stretch between two bars, where the readings disagree and they all are spoilers', () => {
        // `everyBar`: the closing bars of one open the next, so the two share them.
        const spans = typedIn('my_file ||a_b|| and ||c_d||');
        expect(spans.length).toBeGreaterThan(0);
        for (const t of spans) expect(t.startsWith('||') && t.endsWith('||'), t).toBe(true);
        expect(spans.join('')).toContain('a_b');
        expect(spans.join('')).toContain('c_d');
    });

    it('is nothing for a node that is not a spoiler of a parse', () => {
        expect(spoilerSpan({ type: 'spoiler', children: [] })).toBeUndefined();
        expect(spoilerSpan({ type: 'text', value: '||a||' })).toBeUndefined();
        // A link of a parse has a span of its own (typedSpan), and is still no spoiler.
        const [link] = parseMessage('[a](https://x/y)');
        expect(typedSpan(link)).toEqual([0, 16]);
        expect(spoilerSpan(link)).toBeUndefined();
    });
});

describe('where a node was typed (typedSpan)', () => {
    /** Every node of the parse that has a span, as its type and what was typed there; runs of words only if asked. */
    const typedIn = (content: string, words = false): string[] => {
        const found: string[] = [];
        const walk = (nodes: Node[]) => {
            for (const n of nodes) {
                const span = typedSpan(n);
                if (span && (words || n.type !== 'text')) found.push(`${n.type} ${content.slice(span[0], span[1])}`);
                if ('children' in n) walk(n.children);
            }
        };
        walk(parseMessage(content));
        return found;
    };

    it('is each node drawn as more than words, as typed', () => {
        expect(typedIn('a `b` [l](https://x/y) ![p](sovereign-enc:k) https://e/f @bob @everyone @here #gen :fire: Link:https://g/h')).toEqual([
            'code `b`', 'link [l](https://x/y)', 'image ![p](sovereign-enc:k)', 'url https://e/f', 'mentionUser @bob',
            'mentionEveryone @everyone', 'mentionHere @here', 'channel #gen', 'emoji :fire:', 'url https://g/h',
        ]);
        expect(typedIn('```js\nx\n```')).toEqual(['codeblock ```js\nx\n```']);
    });

    it('is found again through a quote and a spoiler, and after a fence', () => {
        expect(typedIn('> a `b`\n> c [l](u) d\n```js\nx\n```\n|| @bob ||')).toEqual([
            'code `b`', 'link [l](u)', 'codeblock ```js\nx\n```', 'spoiler || @bob ||', 'mentionUser @bob',
        ]);
        expect(typedIn('> x\n> ![p](sovereign-enc:k) ||y||')).toEqual(['image ![p](sovereign-enc:k)', 'spoiler ||y||']);
    });

    it('is the file as the list draws it, where a code range read by a pattern would see code', () => {
        // A backtick, a FILE, and a fence never closed: `` `[^`]+` `` reads a span of code from the first
        // backtick to the fence, and Edit left the file, key and all, in the box (api/messagePreview.ts).
        expect(typedIn('`[g](sovereign-enc:k)```')).toEqual(['link [g](sovereign-enc:k)']);
    });

    it('is each run of words too, as typed, through a quote and inside markup', () => {
        expect(typedIn('a **b** c', true)).toEqual(['text a ', 'text b', 'text  c']);
        expect(typedIn('> x y\n> z `c`', true)).toEqual(['text x y\n> z ', 'code `c`']);
        expect(typedIn('see sovereign-enc:k?k=A_B_C ok', true)).toEqual(['text see sovereign-enc:k?k=A', 'text B', 'text C ok']);
        // A dangerous link is drawn as its label, which was not typed where it is drawn: no span.
        expect(typedIn('[x](javascript:alert(1)) y', true)).toEqual(['text  y']);
    });

    it('is nothing for what only holds others, and for a node not of a parse', () => {
        const nodes = parseMessage('**a** _b_ c');
        expect(nodes.map(n => typedSpan(n))).toEqual([undefined, [5, 6], undefined, [9, 11]]);
        expect(typedSpan({ type: 'url', href: 'https://x' })).toBeUndefined();
        expect(typedSpan({ type: 'text', value: 'a' })).toBeUndefined();
    });
});

describe('a text read before is not read again', () => {
    it('is the same tree, frozen, and the same as reading it anew', () => {
        const content = 'a ||b|| _c_ ![p](sovereign-enc:k)';
        const first = parseMessage(content);
        expect(parseMessage(content)).toBe(first);
        expect(first).toEqual(parseMessageUncached(content));
        // Everyone who asks holds this one tree: nothing may change it for the next.
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first[1])).toBe(true);
        expect(Object.isFrozen((first[1] as { children: Node[] }).children)).toBe(true);
        expect(() => { (first as Node[]).push({ type: 'text', value: 'x' }); }).toThrow(TypeError);
        // Where it was typed is kept with it.
        expect(spoilerSpan(parseMessage(content)[1])).toEqual([2, 7]);
        // CONTROL: read anew, it is another tree each time.
        expect(parseMessageUncached(content)).not.toBe(parseMessageUncached(content));
    });

    it('keeps only so much: a few long messages are as many as it keeps', () => {
        // A message of 8000 can be a tree of a megabyte, and five hundred of those is half a gigabyte.
        const long = (i: number) => `${i} ${'||a|| '.repeat(1300)}`;
        const first = parseMessage(long(0));
        for (let i = 1; i < 40; i++) parseMessage(long(i));
        expect(parseMessage(long(0))).not.toBe(first);
        // CONTROL: forty short ones leave it kept.
        const short = parseMessage('short ||x||');
        for (let i = 0; i < 40; i++) parseMessage(`short ${i}`);
        expect(parseMessage('short ||x||')).toBe(short);
    });

    it('keeps only so many: one asked for long ago is read anew', () => {
        const content = 'read long ago ||x||';
        const first = parseMessage(content);
        for (let i = 0; i < 2000; i++) parseMessage(`another ${i}`);
        expect(parseMessage(content)).not.toBe(first);
        expect(parseMessage(content)).toEqual(first);
        // CONTROL: one asked for again and again stays.
        const kept = parseMessage(content);
        for (let i = 0; i < 2000; i++) {
            parseMessage(`more ${i}`);
            parseMessage(content);
        }
        expect(parseMessage(content)).toBe(kept);
    });
});
