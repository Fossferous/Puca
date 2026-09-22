/**
 * Turning a note's own text into text-and-link pieces, LOCALLY.
 *
 * This is deliberately narrower than the chat parser: a note's text is the
 * source a person typed into a textarea, so running `parseMessage` over it
 * would render `__file__` as underline, `||spoiler||` as a spoiler and
 * `#channel` as a link to something that has nothing to do with the note —
 * none of which is what was typed. Only web addresses become links here. No
 * markdown, no mentions, no emoji.
 *
 * It is also the whole privacy argument for linking notes at all: the
 * addresses are found by looking at text this device has already decrypted,
 * and NOTHING is fetched to render them. No favicon, no page title, no
 * preview card, no site icon — api/linkPreview.ts records why those were
 * deleted for chat (a render told a third party the hostname, this device's
 * IP and the moment of reading), and for a note, which the server itself
 * cannot read, it would additionally announce that someone is reading this
 * note right now.
 *
 * Pure: no React, no DOM, no network. Unit-tested in
 * src/tests/linkSegments.test.ts.
 */
import { URL_RE } from './messageParser';

export type Segment =
    | { kind: 'text'; value: string }
    | { kind: 'link'; href: string; text: string };

/**
 * Anything shaped like an absolute or protocol-relative URL is a CANDIDATE;
 * `linkableHref` is what decides. Scanning only for `https?://` would be
 * cheaper but would make the refusal unreachable, and a check that cannot
 * fire is decoration — the tests "covering" it would be green for the wrong
 * reason. A candidate that is refused is skipped WHOLE, so the tail of
 * `javascript:alert(1)` cannot be re-scanned into something linkable.
 */
const CANDIDATE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)\S*/i;

/**
 * The link `rest` starts with, or null.
 *
 * `URL_RE` (utils/messageParser.ts, shared with chat so the two cannot drift)
 * matches http(s) only and trims trailing punctuation out of the href. That
 * is strictly stronger than the repo's `isSafeUrl`, which also passes
 * `mailto:`, `sovereign-enc:`, `sovereign-clip:` and any relative path — none
 * of which belongs in a note link, and the reason a `javascript:` href here
 * would be a seed-exfiltration bug rather than a cosmetic one (the Tauri
 * webview holds the JWT and the E2EE seed in localStorage on the app origin).
 * `linkSegments.test.ts` asserts the containment as a property, rather than
 * restating it here as a call that could never fire.
 */
function linkableHref(rest: string): string | null {
    const m = URL_RE.exec(rest);
    if (!m) return null;
    return withBalancedTail(m[0], rest.slice(m[0].length));
}

/** Wikipedia-shaped URLs end in `)`. URL_RE's tail class already dropped it,
 *  so put it back only when the URL has an unmatched `(` that wants it. */
function withBalancedTail(url: string, rest: string): string {
    if (!rest.startsWith(')')) return url;
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    return opens > closes ? `${url})` : url;
}

/**
 * `input` as alternating text and link pieces. A string with no linkable
 * address comes back as exactly one text segment, so the common note costs
 * one array and renders as the plain string it was.
 */
export function linkSegments(input: string): Segment[] {
    if (!input) return [{ kind: 'text', value: '' }];
    const out: Segment[] = [];
    let text = '';
    let i = 0;
    while (i < input.length) {
        // A scheme may only start at a word boundary, or `xhttps://evil.example`
        // would linkify from its second character.
        const boundary = i === 0 || !/[A-Za-z0-9]/.test(input[i - 1]);
        const candidate = boundary ? CANDIDATE_RE.exec(input.slice(i)) : null;
        if (candidate) {
            const href = linkableHref(input.slice(i));
            if (href) {
                if (text) { out.push({ kind: 'text', value: text }); text = ''; }
                out.push({ kind: 'link', href, text: href });
                i += href.length;
            } else {
                text += candidate[0];
                i += candidate[0].length;
            }
            continue;
        }
        text += input[i];
        i++;
    }
    if (text || out.length === 0) out.push({ kind: 'text', value: text });
    return out;
}

/** True when `input` holds at least one address that would become a link. */
export function hasLink(input: string): boolean {
    return linkSegments(input).some(s => s.kind === 'link');
}
