import { describe, it, expect } from 'vitest';
import { parseMessage, extractMentions, isSafeUrl, urlAt, type Node } from '../utils/messageParser';
import { messageMentionsUser } from '../utils/messageMentions';
import { extractUrls } from '../api/linkPreview';
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
        // A `||` with a space either side opens nothing over a block, but what either hid is what matters here.
        ['my_file ||w0_w1|| w2 || w3\n> w4\nw5 || w6', ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']],
        ['my_file || w0_w1 || w2 || w3\n> w4\nw5 || w6', ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']],
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

    // What goes wrong, in any order. Everything the parser as it was hid must not be printed now.
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
        const bad: string[] = [];
        for (let k = 0; k < 30000; k++) {
            let id = 0;
            const pieces: string[] = [];
            for (let j = 1 + next(parts); j > 0; j--) pieces.push(PARTS[next(PARTS.length)].replace(/W/g, () => `w${id++}`));
            const content = pieces.join(between);
            if (hiddenBy(parsedAsItWas(content)).size) spoilers++;
            const out = leaked(content, parseMessage(content));
            if (out.length) bad.push(`${JSON.stringify(content)} prints ${out.join(', ')}`);
        }
        expect(bad).toEqual([]);
        // Over nothing it would prove nothing.
        expect(spoilers).toBeGreaterThan(500);
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
        // In a fence a spoiler is code.
        [`${FENCE}\n||a||\n${FENCE}`],
        [`${FENCE}\n||a\n> b||\n${FENCE}`],
    ])('CONTROL: what is no spoiler around a block is as it was: %j', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
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
            parseMessage(content);
            best = Math.min(best, performance.now() - started);
        } while (best >= bar && performance.now() < giveUp);
        return best;
    };
    const WAIT = 60_000;

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
        expect(fastest(content, 30)).toBeLessThan(30);
    }, WAIT);

    it('a delimiter only the end of a link opens: every one closes at the next', () => {
        const content = '[x](http://a)_b '.repeat(490);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(parseMessage(content).filter(n => n.type === 'em')).toHaveLength(245);
        expect(fastest(content, 10)).toBeLessThan(10);
    }, WAIT);

    // Found by searching for what is cheap only because of this charge, with it taken out.
    it('an address with a `||` in it, read to the end of its word each time: 3 ms, or 26 if it pays only for what it stepped over', () => {
        const content = `__${'](http://a||b)!#a_b]('.repeat(380)}* ||s||`;
        expect(content.length).toBeGreaterThan(7500);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, 12)).toBeLessThan(12);
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
    ])('%s', (_, content) => {
        expect(content.length).toBeGreaterThan(7000);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, 30)).toBeLessThan(30);
    }, WAIT);

    it.each(['[', '!['])('%s over and over: 3 ms, or 20 and more with a look at 512 characters for each', (open) => {
        const content = `_${open.repeat(7990 / open.length)}_ ||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, 12)).toBeLessThan(12);
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
        expect(fastest(content, 20)).toBeLessThan(20);
    }, WAIT);

    it('a run of one delimiter in an address: 1 ms, or 25 with no bound on what stands between a closer and an opener', () => {
        const content = `_https://example.org/${'_'.repeat(7900)}a ||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, 10)).toBeLessThan(10);
    }, WAIT);

    it('very short quotes and one small spoiler: 2 ms, or 116 if each quote reads all that is left of the text', () => {
        const content = `${'>\n\n'.repeat(2665)}||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content, 30)).toBeLessThan(30);
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
