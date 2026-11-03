/**
 * Message content parser.
 *
 * Produces a tree of typed nodes from a raw message string, supporting the
 * familiar chat-app markdown subset plus mentions, channel links and emoji. Unlike
 * the previous placeholder-substitution approach, this is a real tokenizer:
 * user text like `__BOLD_0__` can't spoof formatting, styles nest correctly,
 * and it degrades to plain text when nothing matches.
 *
 * The parser is pure and knows nothing about members/channels — the renderer
 * resolves `mentionUser`/`channel` names against the current context.
 */

export type Node =
    | { type: 'text'; value: string }
    | { type: 'strong'; children: Node[] }
    | { type: 'em'; children: Node[] }
    | { type: 'underline'; children: Node[] }
    | { type: 'strike'; children: Node[] }
    | { type: 'spoiler'; children: Node[] }
    | { type: 'code'; value: string }
    | { type: 'codeblock'; value: string; lang: string | null }
    | { type: 'blockquote'; children: Node[] }
    | { type: 'link'; href: string; label: string }
    | { type: 'url'; href: string }
    | { type: 'image'; alt: string; href: string }
    | { type: 'mentionUser'; name: string }
    | { type: 'mentionEveryone' }
    | { type: 'mentionHere' }
    | { type: 'channel'; name: string }
    | { type: 'emoji'; name: string };

const MAX_DEPTH = 12;

/**
 * One reading of a message: `asItWas` (see `parseMessage`) or not, and how much it
 * may still spend on walks for a closer: the whole walk when it finds none, and every
 * address it reads when it does. Such a walk can be repeated from the next opener,
 * since what it stepped over is not always what gets read: `[x](https://a)_b`, over
 * and over, has `_` that only the link's reading opens. A real message spends a few
 * lengths of itself. Past that a delimiter closes at the first one, as it used to,
 * which always moves on, so a message of 8000 cannot cost more than this however it
 * was made.
 */
interface Reading { asItWas: boolean; walkLeft: number }
const WALK_PER_CHAR = 32;
// A link's target, 2048 long at most, and the `)` after it.
const LINK_TARGET_RE = /^\S{0,2049}/;

// Inline delimiters, longest-first so `**` wins over `*` and `__` over `_`.
const INLINE_DELIMS: { open: string; type: 'strong' | 'em' | 'underline' | 'strike' | 'spoiler' }[] = [
    { open: '**', type: 'strong' },
    { open: '__', type: 'underline' },
    { open: '~~', type: 'strike' },
    { open: '||', type: 'spoiler' },
    { open: '*', type: 'em' },
    { open: '_', type: 'em' },
];

/** A bare URL at the START of the input: http(s) only, and the tail class
 *  keeps trailing punctuation out of the href. A raw `>` or `"` is in neither:
 *  they are only ever what is put around an address (`<https://…>`,
 *  `{"url":"https://…"}`). */
const URL_RE = /^https?:\/\/[^\s<>"]+[^\s<>".,:;')\]]/i;
/** The address as it was read before (see `parseMessage`). */
const URL_RE_AS_IT_WAS = /^https?:\/\/[^\s<]+[^\s<.,:;"')\]]/i;

/** Wikipedia-shaped URLs end in `)`. URL_RE's tail class already dropped it,
 *  so put it back only when the URL has an unmatched `(` that wants it, along
 *  with what the class dropped before it: `Foo_(U.S.)`. `rest` is what follows
 *  the URL. */
function withBalancedTail(url: string, rest: string): string {
    let unmatched = 0;
    for (const ch of url) {
        if (ch === '(') unmatched++;
        else if (ch === ')' && unmatched > 0) unmatched--;
    }
    let taken = 0;
    while (unmatched > 0) {
        const tail = /^[.,:;'\]]*\)/.exec(rest.slice(taken));
        if (!tail) break;
        taken += tail[0].length;
        unmatched--;
    }
    return url + rest.slice(0, taken);
}

/** The address at the START of `rest`, or null. Exported so notes' own
 *  linkifier (utils/linkSegments.ts) reads an address THIS way rather than
 *  with a second copy that would drift away from it. */
export function urlAt(rest: string): string | null {
    const m = URL_RE.exec(rest);
    return m && withBalancedTail(m[0], rest.slice(m[0].length));
}

// Allow letters, numbers, underscore, dot, hyphen in mention/channel names.
const NAME_RE = /^[a-z0-9_.-]+/i;
const SHORTCODE_RE = /^:([a-z0-9_+-]+):/i;

// Schemes we will emit as a real href/src. http/https/mailto are the safe
// external set; `sovereign-enc` is our own attachment scheme (the renderer
// routes it through a decrypt-and-render path, never a raw navigable href).
// Everything else — javascript:, data:, vbscript:, file:, … — can execute
// script or exfiltrate in the app origin (stealing the JWT + E2EE seed from
// localStorage in the Tauri webview), so a link/image carrying such a scheme is
// neutralized to plain text rather than becoming clickable. (audit H7)
// `sovereign-clip` (docs/CLIPS.md) is allow-listed ONLY because MessageContent
// dispatches it to ClipAttachment before any <a href> is emitted — the href
// carries the clip key, so it must never become a navigable link.
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'sovereign-enc', 'sovereign-clip']);

/**
 * True if `href` is safe to render as a link href or image src. A scheme-less /
 * relative href resolves within our own origin and can't run script, so it's
 * allowed. Any explicit scheme must be in the allowlist. Leading control/space
 * characters (which a browser ignores when resolving the scheme, e.g.
 * "\tjavascript:") are stripped before the scheme is read, so they can't smuggle
 * a dangerous scheme past the check.
 */
export function isSafeUrl(href: string): boolean {
    // Skip leading chars a browser ignores when resolving the scheme
    // (spaces, tabs, newlines and other C0 controls) with a charCode scan
    // rather than a control-char regex literal. Interior controls can't form
    // a valid scheme, so the scheme regex below won't match them (treated as
    // a safe relative URL), mirroring how a browser fails to parse it.
    let start = 0;
    while (start < href.length && href.charCodeAt(start) <= 0x20) start++;
    const rest = href.slice(start);
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(rest);
    if (!m) {
        // Scheme-less is NOT automatically same-origin: `//evil.com/x` is a
        // protocol-relative URL, which the browser resolves against the page's
        // scheme and loads cross-origin. Only a true relative path is safe.
        if (rest.startsWith('//')) return false;
        return true;
    }
    return SAFE_URL_SCHEMES.has(m[1].toLowerCase());
}

function isNameChar(ch: string | undefined): boolean {
    return ch !== undefined && /[a-z0-9_.-]/i.test(ch);
}

// A word, or one mark that is not a delimiter: `||:)||` is a spoiler too.
const WORD_RE = /[^\s!-/:-@[-`{-~]+|[^\s*_~`|]/g;

function wordsOf(n: Exclude<Node, { children: Node[] }>): string {
    switch (n.type) {
        case 'text':
        case 'code':
        case 'codeblock':
            return n.value;
        case 'url':
            return n.href;
        case 'link':
            return `${n.label} ${n.href}`;
        case 'image':
            return `${n.alt} ${n.href}`;
        case 'mentionUser':
        case 'channel':
        case 'emoji':
            return n.name;
        case 'mentionEveryone':
            return 'everyone';
        case 'mentionHere':
            return 'here';
    }
}

/** Every word under a spoiler in `nodes`, each with how many times. */
function hiddenWords(nodes: Node[], under = false, words = new Map<string, number>()): Map<string, number> {
    for (const n of nodes) {
        if ('children' in n) {
            hiddenWords(n.children, under || n.type === 'spoiler', words);
        } else if (under) {
            for (const word of wordsOf(n).match(WORD_RE) ?? []) words.set(word, (words.get(word) ?? 0) + 1);
        }
    }
    return words;
}

/**
 * Parse a full message into a node tree.
 *
 * A spoiler must never stop being one, and reading an address better can cost
 * one. The `_`, `*`, `~~` and backticks of a text pair up in order, so one that
 * used to be a delimiter and is now part of an address moves every pairing after
 * it, and a later one can land inside `||…||` and take that spoiler apart. Which
 * texts do that cannot be listed: rules for the ones found kept missing others,
 * and one message could cost them a second to read. So the reading as it was
 * before addresses were read better stays (`asItWas`), and if it hid a word this
 * one does not, it is the one used, for the whole message. An address in such a
 * message is read as it was too; the spoiler is what matters. messageParser.test.ts
 * holds this as a property against that parser, frozen.
 */
export function parseMessage(content: string): Node[] {
    if (!content) return [];
    const read = (asItWas: boolean) => parseBlocks(content, { asItWas, walkLeft: WALK_PER_CHAR * content.length });
    const nodes = read(false);
    const bars = content.indexOf('||');
    if (bars === -1 || content.indexOf('||', bars + 2) === -1) return nodes;
    const asItWas = read(true);
    const hidden = hiddenWords(nodes);
    for (const [word, times] of hiddenWords(asItWas)) {
        if ((hidden.get(word) ?? 0) < times) return asItWas;
    }
    return nodes;
}

/** Block level: fenced code blocks and blockquotes, then inline for the rest. */
function parseBlocks(input: string, reading: Reading): Node[] {
    const nodes: Node[] = [];
    let rest = input;

    while (rest.length > 0) {
        // Fenced code block: ```lang\n...\n``` (lang optional).
        const fence = matchCodeBlock(rest);
        if (fence) {
            nodes.push(fence.node);
            rest = rest.slice(fence.length);
            continue;
        }

        // Blockquote: a run of lines each starting with "> " (or ">").
        const quote = matchBlockquote(rest, reading);
        if (quote) {
            nodes.push(quote.node);
            rest = rest.slice(quote.length);
            continue;
        }

        // Otherwise consume up to the next block construct and inline-parse it.
        const nextFence = rest.indexOf('```', 0);
        const nextQuote = findLineStart(rest, '>');
        const stop = [nextFence, nextQuote].filter((i) => i > 0);
        const cut = stop.length ? Math.min(...stop) : rest.length;
        const chunk = rest.slice(0, cut === 0 ? rest.length : cut);
        nodes.push(...parseInline(chunk, 0, reading));
        rest = rest.slice(chunk.length);
    }

    return nodes;
}

function matchCodeBlock(s: string): { node: Node; length: number } | null {
    if (!s.startsWith('```')) return null;
    const end = s.indexOf('```', 3);
    if (end === -1) return null;
    const inner = s.slice(3, end);
    const nl = inner.indexOf('\n');
    let lang: string | null = null;
    let code = inner;
    if (nl !== -1) {
        const firstLine = inner.slice(0, nl).trim();
        // A language tag is a single non-empty token with no spaces; either way
        // the first line is not part of the code body.
        if (firstLine.length > 0 && !/\s/.test(firstLine)) {
            lang = firstLine;
        }
        code = inner.slice(nl + 1);
    }
    code = code.replace(/\n$/, '');
    return { node: { type: 'codeblock', value: code, lang }, length: end + 3 };
}

function matchBlockquote(s: string, reading: Reading): { node: Node; length: number } | null {
    if (!(s.startsWith('> ') || s.startsWith('>\n') || s === '>')) return null;
    // Up to the first line that is not quoted, and no further: a text of very short
    // quotes comes back here for each one, with nearly all of itself still to read.
    const quoted: string[] = [];
    let consumed = 0;
    while (consumed < s.length) {
        const nl = s.indexOf('\n', consumed);
        const line = s.slice(consumed, nl === -1 ? s.length : nl);
        if (line !== '>' && !line.startsWith('> ')) break;
        quoted.push(line === '>' ? '' : line.slice(2));
        consumed += line.length + 1; // + newline
    }
    if (quoted.length === 0) return null;
    const length = Math.min(consumed, s.length);
    return { node: { type: 'blockquote', children: parseInline(quoted.join('\n'), 1, reading) }, length };
}

/** Find the index of the first line (after start) beginning with `prefix`. */
function findLineStart(s: string, prefix: string): number {
    let idx = 0;
    while (idx < s.length) {
        const nl = s.indexOf('\n', idx);
        const lineStart = idx;
        if (lineStart > 0 && s.startsWith(prefix, lineStart)) return lineStart;
        if (nl === -1) break;
        idx = nl + 1;
    }
    return -1;
}

/**
 * What a link or a picture holds, at the start of `rest`, with `head` matching up to
 * the `(` of its target. The target takes in the brackets it opens, so
 * `[w](https://x/Foo_(bar))` keeps its own, and it stops at the first `)` that
 * closes none: `[a](b) (c)` does not take in `(c)`. With no such `)`, as in
 * `[a](https://x/(b)`, it stops at the first `)` it passed, as it always used to
 * (`asItWas`). Bounded, like `head`.
 */
function matchLinkParts(head: RegExp, rest: string, asItWas: boolean): { label: string; href: string; length: number } | null {
    const m = head.exec(rest);
    if (!m) return null;
    const target = LINK_TARGET_RE.exec(rest.slice(m[0].length))![0];
    if (!target.includes(')')) return null;
    let depth = 0;
    let first = -1;
    let end = -1;
    for (let i = 0; i < target.length && end === -1; i++) {
        if (target[i] === '(') depth++;
        else if (target[i] === ')') {
            if (depth === 0) end = i;
            else if (first === -1) first = i;
            depth--;
        }
    }
    if (first !== -1 && (end === -1 || asItWas)) end = first;
    return end > 0 ? { label: m[1], href: target.slice(0, end), length: m[0].length + end + 1 } : null;
}

/** Inline parser: emits text runs interleaved with markup nodes. */
function parseInline(input: string, depth: number, reading: Reading): Node[] {
    const { asItWas } = reading;
    const nodes: Node[] = [];
    let buf = '';
    let i = 0;

    const flush = () => {
        if (buf) {
            nodes.push({ type: 'text', value: buf });
            buf = '';
        }
    };

    while (i < input.length) {
        const rest = input.slice(i);
        const ch = input[i];

        // Inline code: `code` (no formatting inside).
        if (ch === '`') {
            const close = input.indexOf('`', i + 1);
            if (close !== -1 && close > i + 1) {
                flush();
                nodes.push({ type: 'code', value: input.slice(i + 1, close) });
                i = close + 1;
                continue;
            }
        }

        // Image: ![alt](url)
        // Label/href are length-bounded so a non-matching '[' bails after a fixed
        // window instead of scanning to end-of-string — otherwise a message of
        // many '[' is O(n^2) and freezes the renderer (client-side DoS).
        if (ch === '!' && input[i + 1] === '[') {
            const m = matchLinkParts(/^!\[([^\]\n]{0,512})\]\(/, rest, asItWas);
            if (m) {
                flush();
                // Neutralize a dangerous scheme (javascript:, data:, …): keep the
                // alt text, drop the href, so it never renders as an <img src>. (H7)
                if (isSafeUrl(m.href)) nodes.push({ type: 'image', alt: m.label, href: m.href });
                else if (m.label) nodes.push({ type: 'text', value: m.label });
                i += m.length;
                continue;
            }
        }

        // Link: [label](url) — bounded (see image note above) to keep parsing linear.
        if (ch === '[') {
            const m = matchLinkParts(/^\[([^\]\n]{1,512})\]\(/, rest, asItWas);
            if (m) {
                flush();
                // Neutralize a dangerous scheme: drop the href and keep the label
                // as plain text so `[x](javascript:…)` is never a clickable link. (H7)
                if (isSafeUrl(m.href)) nodes.push({ type: 'link', label: m.label, href: m.href });
                else nodes.push({ type: 'text', value: m.label });
                i += m.length;
                continue;
            }
        }

        // Bare URL, in either case: a phone's keyboard makes `Https://`.
        if (ch === 'h' || (ch === 'H' && !asItWas)) {
            const href = asItWas ? URL_RE_AS_IT_WAS.exec(rest)?.[0] : urlAt(rest);
            if (href) {
                flush();
                nodes.push({ type: 'url', href });
                i += href.length;
                continue;
            }
        }

        // Mentions and channels.
        if (ch === '@') {
            if (rest.startsWith('@everyone') && !isNameChar(rest[9])) {
                flush();
                nodes.push({ type: 'mentionEveryone' });
                i += '@everyone'.length;
                continue;
            }
            if (rest.startsWith('@here') && !isNameChar(rest[5])) {
                flush();
                nodes.push({ type: 'mentionHere' });
                i += '@here'.length;
                continue;
            }
            const nm = NAME_RE.exec(rest.slice(1));
            if (nm) {
                flush();
                nodes.push({ type: 'mentionUser', name: nm[0] });
                i += 1 + nm[0].length;
                continue;
            }
        }
        if (ch === '#') {
            const nm = NAME_RE.exec(rest.slice(1));
            if (nm) {
                flush();
                nodes.push({ type: 'channel', name: nm[0] });
                i += 1 + nm[0].length;
                continue;
            }
        }

        // Shortcode emoji: :smile: Not with // after it: `Link:https://…` is an
        // address straight after a colon, and `:smile://x` is words.
        if (ch === ':') {
            const m = SHORTCODE_RE.exec(rest);
            if (m && !asItWas && rest.startsWith('//', m[0].length)) {
                const href = urlAt(rest.slice(1));
                if (href) {
                    buf += ':';
                    flush();
                    nodes.push({ type: 'url', href });
                    i += 1 + href.length;
                } else {
                    buf += m[0];
                    i += m[0].length;
                }
                continue;
            }
            if (m) {
                flush();
                nodes.push({ type: 'emoji', name: m[1] });
                i += m[0].length;
                continue;
            }
        }

        // Emphasis delimiters (recursive), only if not too deep.
        if (depth < MAX_DEPTH) {
            const delim = INLINE_DELIMS.find((d) => rest.startsWith(d.open));
            if (delim) {
                const closeIdx = findClosing(input, i + delim.open.length, delim.open, reading);
                if (closeIdx !== -1) {
                    const innerText = input.slice(i + delim.open.length, closeIdx);
                    if (innerText.length > 0) {
                        flush();
                        nodes.push({ type: delim.type, children: parseInline(innerText, depth + 1, reading) } as Node);
                        i = closeIdx + delim.open.length;
                        continue;
                    }
                }
            }
        }

        buf += ch;
        i += 1;
    }

    flush();
    return nodes;
}

/** For `_` or `__`, the closer of one address and the opener of the next, with no
 *  space between them: `_https://x/a_,_https://x/b_`. Bounded, so a run of them in
 *  one address costs no more than its length. */
const NEXT_IN_A_LIST = new Map(['_', '__'].map((d): [string, RegExp] => [d, new RegExp(`${d}[^\\p{L}\\p{N}]{0,3}?${d}https?://`, 'iu')]));

/**
 * Where `_` or `__` closes inside the address `href`, or -1 if every one in there is
 * the address's own. It closes before the next address of a list. It closes at the
 * last one if the address ends with it (`_https://x/a_`), give or take what a sentence
 * puts after it (`_https://x/a_!`, where URL_RE takes the `!` in).
 */
function closeInAddress(href: string, open: string): number {
    const listed = NEXT_IN_A_LIST.get(open)!.exec(href);
    if (listed) return listed.index;
    const last = href.lastIndexOf(open);
    return last !== -1 && !/[\p{L}\p{N}/]/u.test(href.slice(last + open.length)) ? last : -1;
}

/** How long the @name, #name or :name: at `at` is, or 0. */
function nameLengthAt(input: string, at: number): number {
    if (input[at] === '@' || input[at] === '#') {
        const name = NAME_RE.exec(input.slice(at + 1));
        return name ? 1 + name[0].length : 0;
    }
    if (input[at] === ':') {
        const name = SHORTCODE_RE.exec(input.slice(at));
        if (!name) return 0;
        // `:https://…` is an address straight after a colon, and `:a://x` is words, whole.
        return input.startsWith('//', at + name[0].length) && urlAt(input.slice(at + 1)) ? 0 : name[0].length;
    }
    return 0;
}

/**
 * Where the delimiter `open` closes in the @name or #name `length` long at `at`, or
 * -1. NAME_RE takes in the `_` that closes and the `.` that ends the sentence after
 * it: `_see https://x/a @bob_.` is bob, in italics, as it is with no address in the
 * text. So a delimiter closes in what follows the name's last letter or digit. A
 * `:name:` has an end of its own.
 */
function closeInName(input: string, at: number, length: number, open: string): number {
    if (input[at] === ':') return -1;
    let tail = at + length;
    while (tail > at + 1 && '_.-'.includes(input[tail - 1])) tail--;
    const close = input.slice(tail, at + length).indexOf(open);
    return close === -1 ? -1 : tail + close;
}

/**
 * Find the matching closing delimiter for `open` starting at `from`. A `_` or `__`
 * in the words before an address does not close inside it, or `my_file is at
 * https://x/my_file.txt` is a link to https://x/my. Once past one it does not close
 * inside a name either, only after it: in `my_file at https://x/a_b cc @alice_c` that
 * is alice_c's mention, which it was before the address was stepped over, and with no
 * address in the text a name is what it always was. Every other delimiter closes at
 * the first one, in an address or not: `*` and `~` are next to never in a real address,
 * and `**https://x/a**'s page` is bold. A spoiler closes at the first `||` for a better
 * reason: URL_RE reads all of `https://x/a||!` as one address, and it is still a spoiler.
 */
function findClosing(input: string, from: number, open: string, reading: Reading): number {
    const stepsOver = !reading.asItWas && open.includes('_') && reading.walkLeft > 0;
    let pastAddress = false;
    let i = from;
    while (i < input.length) {
        // Don't let a closing delimiter be found inside inline code.
        if (input[i] === '`') {
            const close = input.indexOf('`', i + 1);
            if (close !== -1) {
                i = close + 1;
                continue;
            }
        }
        if (stepsOver && (input[i] === 'h' || input[i] === 'H')) {
            const href = urlAt(input.slice(i));
            if (href) {
                reading.walkLeft -= href.length;
                const inside = closeInAddress(href, open);
                if (inside !== -1) return i + inside;
                i += href.length;
                pastAddress = true;
                continue;
            }
        }
        if (stepsOver && pastAddress) {
            const name = nameLengthAt(input, i);
            if (name) {
                const close = closeInName(input, i, name, open);
                if (close !== -1) return close;
                i += name;
                continue;
            }
        }
        if (input.startsWith(open, i)) return i;
        i += 1;
    }
    reading.walkLeft -= input.length - from;
    return -1;
}

/** Collect the plain-text names of all users mentioned in a message. */
export function extractMentions(content: string): { users: string[]; everyone: boolean } {
    const users = new Set<string>();
    let everyone = false;
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if (n.type === 'mentionUser') users.add(n.name.toLowerCase());
            else if (n.type === 'mentionEveryone' || n.type === 'mentionHere') everyone = true;
            else if ('children' in n) walk(n.children);
        }
    };
    walk(parseMessage(content));
    return { users: [...users], everyone };
}
