/**
 * The pending-attachment model. The load-bearing claims:
 *  - the sovereign-enc href (which carries the file's AES key) appears in the
 *    serialized output ONLY after markReady — never for uploading/failed
 *    chips, which is what keeps keys out of the composer;
 *  - the composer cannot send while an upload is in flight (and CAN once it
 *    is ready — the positive control);
 *  - image vs file markdown syntax and the spoiler wrap match what the
 *    message renderer parses.
 */
import { describe, it, expect } from 'vitest';
import {
    buildOutgoingContent,
    canSendComposer,
    markFailed,
    markReady,
    markUploading,
    pendingAttachment,
    removeAttachment,
    serializeAttachments,
    toggleSpoiler,
} from '../api/composerAttachments';

const HREF = 'sovereign-enc:abc123?k=SECRETKEY&m=image%2Fpng';

function imageChip() {
    return pendingAttachment({ name: 'shot.png', type: 'image/png' }, 'blob:preview', false);
}

describe('serialization', () => {
    it('an uploading chip serializes to NOTHING — the key-bearing href only appears once ready', () => {
        const list = [imageChip()];
        expect(serializeAttachments(list)).toBe('');
        expect(buildOutgoingContent('hello', list)).toBe('hello');

        const ready = markReady(list, list[0].localId, HREF);
        expect(serializeAttachments(ready)).toBe(`![shot.png](${HREF})`);
        expect(buildOutgoingContent('hello', ready)).toBe(`hello ![shot.png](${HREF})`);
    });

    it('a failed chip is never serialized', () => {
        const chip = imageChip();
        const failed = markFailed([chip], chip.localId, 'boom');
        expect(serializeAttachments(failed)).toBe('');
    });

    it('files get link syntax, images image syntax, spoilers wrap in ||', () => {
        const img = imageChip();
        const file = pendingAttachment({ name: 'notes.pdf', type: 'application/pdf' }, null, false);
        let list = [img, file];
        list = markReady(list, img.localId, HREF);
        list = markReady(list, file.localId, 'sovereign-enc:def?k=K2&m=application%2Fpdf');
        expect(serializeAttachments(list))
            .toBe(`![shot.png](${HREF}) [notes.pdf](sovereign-enc:def?k=K2&m=application%2Fpdf)`);

        list = toggleSpoiler(list, img.localId);
        expect(serializeAttachments(list))
            .toBe(`||![shot.png](${HREF})|| [notes.pdf](sovereign-enc:def?k=K2&m=application%2Fpdf)`);
    });

    it('markdown-breaking filename characters are stripped from the LABEL only', () => {
        // ']' is legal in filenames everywhere; emitted raw it breaks the
        // parser's label class ([^\]\n]) — the attachment rendered as literal
        // text with the key-bearing href on screen — and a crafted name could
        // smuggle a real external image link.
        const evil = pendingAttachment({ name: 'x](https://evil/a.png) y.png', type: 'image/png' }, null, false);
        const list = markReady([evil], evil.localId, HREF);
        // Only [ ] ( ) and newline are stripped (slashes are harmless in a
        // label) — what matters is that no `](` pair survives to close the
        // label early and open an attacker-chosen destination.
        expect(serializeAttachments(list)).toBe(`![x__https://evil/a.png_ y.png](${HREF})`);
        // The chip keeps the true name — only the wire form is stripped.
        expect(list[0].name).toBe('x](https://evil/a.png) y.png');

        const newline = pendingAttachment({ name: 'a\nb].png', type: 'image/png' }, null, false);
        const l2 = markReady([newline], newline.localId, HREF);
        const label = serializeAttachments(l2).slice(2).split('](')[0];
        expect(label).not.toMatch(/[[\]\n()]/);
    });

    it('attachments alone make a message; text alone stays untouched', () => {
        const chip = imageChip();
        const list = markReady([chip], chip.localId, HREF);
        expect(buildOutgoingContent('   ', list)).toBe(`![shot.png](${HREF})`);
        expect(buildOutgoingContent('just words', [])).toBe('just words');
    });
});

describe('canSendComposer', () => {
    it('refuses while ANY chip uploads, allows once ready (positive control)', () => {
        const chip = imageChip();
        expect(canSendComposer('text', [chip]), 'mid-upload send would drop the file').toBe(false);
        const ready = markReady([chip], chip.localId, HREF);
        expect(canSendComposer('', ready)).toBe(true);
        expect(canSendComposer('text', ready)).toBe(true);
    });

    it('refuses an empty composer, and a failed chip alone is not content', () => {
        expect(canSendComposer('', [])).toBe(false);
        expect(canSendComposer('   ', [])).toBe(false);
        const chip = imageChip();
        const failed = markFailed([chip], chip.localId, 'boom');
        expect(canSendComposer('', failed), 'a failed chip is never serialized, so it cannot justify a send').toBe(false);
        expect(canSendComposer('but text still sends', failed)).toBe(true);
    });
});

describe('list transitions', () => {
    it('retry clears the error and goes back to uploading', () => {
        const chip = imageChip();
        let list = markFailed([chip], chip.localId, 'network down');
        expect(list[0].status).toBe('failed');
        list = markUploading(list, chip.localId);
        expect(list[0]).toMatchObject({ status: 'uploading', error: undefined });
    });

    it('remove drops exactly the named chip', () => {
        const a = imageChip();
        const b = pendingAttachment({ name: 'b.txt', type: 'text/plain' }, null, false);
        expect(removeAttachment([a, b], a.localId).map(x => x.name)).toEqual(['b.txt']);
    });
});
