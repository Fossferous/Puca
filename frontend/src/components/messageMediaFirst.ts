/**
 * A message's pictures and videos go ABOVE its words, on their own line.
 *
 * The composer sends the typed words first and the attachments after them on
 * the same line (api/composerAttachments.ts buildOutgoingContent:
 * `words ![photo.png](sovereign-enc:…)`), and a picture is an inline <span>
 * (.message-image in Chat.css). So a short message and its picture were laid
 * out as one line of text: the picture to the RIGHT of the words, and the
 * words sitting on its bottom edge, on the baseline (the owner's report,
 * 2026-11-12: "images should be above the message"). A video's player is a
 * block, so it was drawn under the words instead; both now go above them.
 *
 * This is the reading side only, so it holds for every message already sent
 * as well as new ones, and nothing about what is sent changes (previews,
 * search, quotes, Copy Text and edits read the same content as before).
 *
 * What moves: a top-level picture or video — an encrypted attachment whose
 * ref says it is one (the same reading EncryptedAttachment makes), a clip, a
 * picture from another site (`![](https://…)` or a bare image address), and a
 * spoiler holding nothing but those. They keep their order and the space
 * between them. What stays where it was: everything else — words, file chips
 * and audio cards (already drawn as their own card), a picture inside a quote
 * or inside a spoiler that also holds words. A message with no words (a lone
 * picture, or pictures and a file) is left exactly as it was drawn.
 */
import type { Node } from '../utils/messageParser';
import { isSafeUrl } from '../utils/messageParser';
import { isEncAttachment, parseEncAttachment, videoMimeFor, audioMimeFor } from '../api/attachments';
import { hasHeifName } from '../api/heif';
import { isImageUrl } from '../api/linkPreview';
import { isClipRef, isScrubbedClipRef } from '../api/clips/clipRef';

/** What an encrypted attachment's ref says it is, by the rules
 *  EncryptedAttachment draws it by (a video by its type or, with no useful
 *  type, its name; then audio; then a picture by its type, or a HEIC by its
 *  name). 'file' for anything drawn as a chip or card. */
export function encAttachmentKind(href: string, name: string): 'picture' | 'video' | 'audio' | 'file' {
    const info = parseEncAttachment(href);
    if (!info) return 'file';
    if (videoMimeFor(name, info.mime)) return 'video';
    if (audioMimeFor(name, info.mime)) return 'audio';
    if (info.mime.startsWith('image/')) return 'picture';
    if (hasHeifName(name) && (info.mime === 'application/octet-stream' || info.mime === '')) return 'picture';
    return 'file';
}

/** A node drawn as a picture or a video, by the same tests in the same order
 *  as MessageContent's renderNodes (a scrubbed clip is words: "(clip removed)"). */
function isMedia(node: Node): boolean {
    switch (node.type) {
        case 'image':
            if (isClipRef(node.href)) return true;
            if (isScrubbedClipRef(node.href)) return false;
            if (isEncAttachment(node.href)) return mediaKind(encAttachmentKind(node.href, node.alt));
            return isSafeUrl(node.href);
        case 'link':
            if (isClipRef(node.href)) return true;
            if (isScrubbedClipRef(node.href)) return false;
            return isEncAttachment(node.href) && mediaKind(encAttachmentKind(node.href, node.label));
        case 'url':
            return isSafeUrl(node.href) && isImageUrl(node.href);
        case 'spoiler': {
            const inside = node.children.filter(c => !isBlank(c));
            return inside.length > 0 && inside.every(isMedia);
        }
        default:
            return false;
    }
}

const mediaKind = (k: ReturnType<typeof encAttachmentKind>) => k === 'picture' || k === 'video';

const isBlank = (node: Node) => node.type === 'text' && node.value.trim() === '';

/** An attachment that is not words: a file chip, an audio card. */
function isAttachment(node: Node): boolean {
    return (node.type === 'link' || node.type === 'image') && (isEncAttachment(node.href) || isClipRef(node.href));
}

/**
 * The message's top-level pictures and videos, to draw above its words, and
 * its words; or null when there is nothing to move (no picture or video, or
 * nothing else in the message that is words).
 */
export function liftMediaAbove(nodes: Node[]): { media: Node[]; words: Node[] } | null {
    const lifted = nodes.map(isMedia);
    if (!lifted.includes(true)) return null;
    const isWord = (n: Node, i: number) => !lifted[i] && !isBlank(n);
    if (!nodes.some((n, i) => isWord(n, i) && !isAttachment(n))) return null;

    const media: Node[] = [];
    const words: Node[] = [];
    // The whitespace that only separated words from a picture taken out of
    // the line goes with it: between two runs of words (a picture in
    // mid-sentence) the whitespace on both sides becomes one space, or one
    // line break if there was one; at either end of the words it goes.
    let gap: string | null = null; // whitespace since a picture was taken out; null: none was
    const take = (s: string) => /\s*$/.exec(s)![0];
    const lastText = () => {
        const last = words[words.length - 1];
        return last?.type === 'text' ? last.value : null;
    };
    nodes.forEach((node, i) => {
        if (lifted[i]) {
            // The space that stood between two pictures stays between them.
            if (media.length > 0) media.push({ type: 'text', value: ' ' });
            media.push(node);
            if (gap === null) {
                const before = lastText();
                gap = before === null ? '' : take(before);
                if (before !== null) words[words.length - 1] = { type: 'text', value: before.slice(0, before.length - gap.length) };
            }
            return;
        }
        if (gap === null) { words.push(node); return; }
        if (isBlank(node)) { gap += (node as { value: string }).value; return; }
        const sep = gap.includes('\n') ? '\n' : gap ? ' ' : '';
        gap = null;
        const lead = node.type === 'text' ? /^\s*/.exec(node.value)![0] : '';
        const joint = lead.includes('\n') ? '\n' : (sep || (lead ? ' ' : ''));
        const rest = node.type === 'text' ? node.value.slice(lead.length) : null;
        if (words.every(n => n.type === 'text' && n.value === '')) {
            // Nothing before it: the words start here, with no space.
            words.push(rest !== null ? { type: 'text', value: rest } : node);
            return;
        }
        const before = lastText();
        if (before !== null && rest !== null) words[words.length - 1] = { type: 'text', value: before + joint + rest };
        else if (rest !== null) words.push({ type: 'text', value: joint + rest });
        else if (before !== null) { words[words.length - 1] = { type: 'text', value: before + joint }; words.push(node); }
        else { if (joint) words.push({ type: 'text', value: joint }); words.push(node); }
    });
    // A picture last: the whitespace before it was already taken off.
    return { media, words: words.filter(n => !(n.type === 'text' && n.value === '')) };
}
