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
 * spoiler holding nothing but those. They keep their order and the
 * whitespace the sender put between them (pictures on separate lines are still
 * stacked). What stays where it was: everything else — words, file chips and
 * audio cards (already drawn as their own card), a picture inside a quote or
 * inside a spoiler that also holds words. A message with no words (a lone
 * picture, or pictures and a file, spoilered or not) is left exactly as it was
 * drawn. The words keep their own line and paragraph breaks.
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

const isBlank = (node: Node): boolean => node.type === 'text' && node.value.trim() === '';

/** An attachment that is not words: a file chip, an audio card, or a spoiler
 *  holding nothing but attachments and pictures (a spoilered file is still a
 *  file, so a picture beside one has no words to go above). */
function isAttachment(node: Node): boolean {
    if (node.type === 'spoiler') {
        const inside = node.children.filter(c => !isBlank(c));
        return inside.length > 0 && inside.every(c => isAttachment(c) || isMedia(c));
    }
    return (node.type === 'link' || node.type === 'image') && (isEncAttachment(node.href) || isClipRef(node.href));
}

/** Closing punctuation: glued to a picture (`look ![p].`), it belongs to the word before the picture. */
const CLOSES = /^[.,;:!?…)\]}»›”’'"]/u;
/** Opening punctuation: glued to a picture (`(![p] see)`), it belongs to the word after it. */
const OPENS = /[([{«‹“‘¿¡]$/u;

const lineBreaks = (ws: string) => ws.split('\n').length - 1;

/** Whether a node, drawn, puts what follows it on another line. */
function hasBreak(node: Node): boolean {
    switch (node.type) {
        case 'text': return node.value.includes('\n');
        case 'codeblock':
        case 'blockquote': return true;
        case 'strong':
        case 'em':
        case 'underline':
        case 'strike':
        case 'spoiler': return node.children.some(hasBreak);
        default: return false;
    }
}

/** The whitespace to keep between two pictures in the block, from what stood
 *  between them in the message. Only whitespace: exactly that (a line break
 *  still stacks them, nothing keeps them touching, a space keeps them side by
 *  side), so among themselves they are laid out exactly as before. Words too
 *  (those stay below): a line break if the pictures were on different lines,
 *  else a space. */
function between(nodes: Node[]): string {
    if (nodes.every(isBlank)) return nodes.map(n => (n as { value: string }).value).join('');
    return nodes.some(hasBreak) ? '\n' : ' ';
}

/**
 * The message's top-level pictures and videos, to draw above its words, and
 * its words; or null when there is nothing to move (no picture or video, or
 * nothing else in the message that is words).
 */
export function liftMediaAbove(nodes: Node[]): { media: Node[]; words: Node[] } | null {
    const lifted = nodes.map(isMedia);
    if (!lifted.includes(true)) return null;
    if (!nodes.some((n, i) => !lifted[i] && !isBlank(n) && !isAttachment(n))) return null;

    // The pictures, in order, with what stood between each two of them.
    const media: Node[] = [];
    let prev = -1;
    nodes.forEach((node, i) => {
        if (!lifted[i]) return;
        if (prev >= 0) {
            const sep = between(nodes.slice(prev + 1, i));
            if (sep) media.push({ type: 'text', value: sep });
        }
        media.push(node);
        prev = i;
    });

    // The words. A run of pictures (only whitespace between them) taken out of
    // the line takes the whitespace around it with it: at either end of the
    // words it goes; between two runs of words it becomes ONE joint, as wide as
    // the widest break that stood on any side of a picture in the run: a blank
    // line (a paragraph break) if there was one, else a line break, else a
    // space, else nothing. The widest, because the picture belonged to the
    // paragraph on its narrower side, so the break on its wider side is the one
    // that stood between the two paragraphs, and it still stands there without
    // the picture. Punctuation glued to the picture goes with the words it
    // closes or opens, with no space (`look ![p].` reads `look.`, `(![p] see)`
    // reads `(see)`).
    const words: Node[] = [];
    let run: { left: string; breaks: number; spaced: boolean } | null = null;
    let pending = ''; // whitespace since the run's last picture
    const take = (s: string) => /\s*$/.exec(s)![0];
    const lastText = () => {
        const last = words[words.length - 1];
        return last?.type === 'text' ? last.value : null;
    };
    nodes.forEach((node, i) => {
        if (lifted[i]) {
            if (run === null) {
                const before = lastText();
                const left = before === null ? '' : take(before);
                if (before !== null) words[words.length - 1] = { type: 'text', value: before.slice(0, before.length - left.length) };
                run = { left, breaks: lineBreaks(left), spaced: left !== '' };
            } else {
                run.breaks = Math.max(run.breaks, lineBreaks(pending));
                run.spaced ||= pending !== '';
            }
            pending = '';
            return;
        }
        if (run === null) { words.push(node); return; }
        if (isBlank(node)) { pending += (node as { value: string }).value; return; }
        const lead = node.type === 'text' ? /^\s*/.exec(node.value)![0] : '';
        const right = pending + lead;
        const rest = node.type === 'text' ? node.value.slice(lead.length) : null;
        const { left, breaks, spaced } = run;
        run = null;
        pending = '';
        if (words.every(n => n.type === 'text' && n.value === '')) {
            // Nothing before it: the words start here, with no space.
            words.push(rest !== null ? { type: 'text', value: rest } : node);
            return;
        }
        const before = lastText();
        const widest = Math.max(breaks, lineBreaks(right));
        let joint = widest > 0 ? '\n'.repeat(widest) : (spaced || right ? ' ' : '');
        if ((right === '' && rest !== null && CLOSES.test(rest)) || (left === '' && before !== null && OPENS.test(before))) joint = '';
        if (before !== null && rest !== null) words[words.length - 1] = { type: 'text', value: before + joint + rest };
        else if (rest !== null) words.push({ type: 'text', value: joint + rest });
        else if (before !== null) { words[words.length - 1] = { type: 'text', value: before + joint }; words.push(node); }
        else { if (joint) words.push({ type: 'text', value: joint }); words.push(node); }
    });
    // A picture last: the whitespace before it was already taken off.
    return { media, words: words.filter(n => !(n.type === 'text' && n.value === '')) };
}
