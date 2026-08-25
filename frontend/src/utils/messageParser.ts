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

// Inline delimiters, longest-first so `**` wins over `*` and `__` over `_`.
const INLINE_DELIMS: { open: string; type: 'strong' | 'em' | 'underline' | 'strike' | 'spoiler' }[] = [
    { open: '**', type: 'strong' },
    { open: '__', type: 'underline' },
    { open: '~~', type: 'strike' },
    { open: '||', type: 'spoiler' },
    { open: '*', type: 'em' },
    { open: '_', type: 'em' },
];

const URL_RE = /^https?:\/\/[^\s<]+[^\s<.,:;"')\]]/i;
// Allow letters, numbers, underscore, dot, hyphen in mention/channel names.
const NAME_RE = /^[a-z0-9_.-]+/i;

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
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(href.slice(start));
    if (!m) return true; // relative / scheme-less -> same-origin, safe
    return SAFE_URL_SCHEMES.has(m[1].toLowerCase());
}

function isNameChar(ch: string | undefined): boolean {
    return ch !== undefined && /[a-z0-9_.-]/i.test(ch);
}

/** Parse a full message into a node tree. */
export function parseMessage(content: string): Node[] {
    if (!content) return [];
    return parseBlocks(content);
}

/** Block level: fenced code blocks and blockquotes, then inline for the rest. */
function parseBlocks(input: string): Node[] {
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
        const quote = matchBlockquote(rest);
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
        nodes.push(...parseInline(chunk, 0));
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

function matchBlockquote(s: string): { node: Node; length: number } | null {
    if (!(s.startsWith('> ') || s.startsWith('>\n') || s === '>')) return null;
    const lines = s.split('\n');
    const quoted: string[] = [];
    let consumed = 0;
    for (const line of lines) {
        if (line === '>' || line.startsWith('> ')) {
            quoted.push(line === '>' ? '' : line.slice(2));
            consumed += line.length + 1; // + newline
        } else {
            break;
        }
    }
    if (quoted.length === 0) return null;
    const length = Math.min(consumed, s.length);
    return { node: { type: 'blockquote', children: parseInline(quoted.join('\n'), 1) }, length };
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

/** Inline parser: emits text runs interleaved with markup nodes. */
function parseInline(input: string, depth: number): Node[] {
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
            const m = /^!\[([^\]\n]{0,512})\]\(([^)\s]{1,2048})\)/.exec(rest);
            if (m) {
                flush();
                // Neutralize a dangerous scheme (javascript:, data:, …): keep the
                // alt text, drop the href, so it never renders as an <img src>. (H7)
                if (isSafeUrl(m[2])) nodes.push({ type: 'image', alt: m[1], href: m[2] });
                else if (m[1]) nodes.push({ type: 'text', value: m[1] });
                i += m[0].length;
                continue;
            }
        }

        // Link: [label](url) — bounded (see image note above) to keep parsing linear.
        if (ch === '[') {
            const m = /^\[([^\]\n]{1,512})\]\(([^)\s]{1,2048})\)/.exec(rest);
            if (m) {
                flush();
                // Neutralize a dangerous scheme: drop the href and keep the label
                // as plain text so `[x](javascript:…)` is never a clickable link. (H7)
                if (isSafeUrl(m[2])) nodes.push({ type: 'link', label: m[1], href: m[2] });
                else nodes.push({ type: 'text', value: m[1] });
                i += m[0].length;
                continue;
            }
        }

        // Bare URL.
        if ((ch === 'h') && URL_RE.test(rest)) {
            const m = URL_RE.exec(rest)!;
            flush();
            nodes.push({ type: 'url', href: m[0] });
            i += m[0].length;
            continue;
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

        // Shortcode emoji: :smile:
        if (ch === ':') {
            const m = /^:([a-z0-9_+-]+):/i.exec(rest);
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
                const closeIdx = findClosing(input, i + delim.open.length, delim.open);
                if (closeIdx !== -1) {
                    const innerText = input.slice(i + delim.open.length, closeIdx);
                    if (innerText.length > 0) {
                        flush();
                        nodes.push({ type: delim.type, children: parseInline(innerText, depth + 1) } as Node);
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

/** Find the matching closing delimiter for `open` starting at `from`. */
function findClosing(input: string, from: number, open: string): number {
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
        if (input.startsWith(open, i)) return i;
        i += 1;
    }
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
