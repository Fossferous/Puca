/**
 * "Save to Notes" — the pure half (api/captureToNote.ts).
 *
 * The assertion that earns its keep: a captured message must not carry a
 * `sovereign-enc:` href into a note. That href embeds the file's AES key AND
 * its fetch capability, so one left behind is a live key parked in a second
 * place with a second lifetime — and it would name a file the note does not
 * own. Everything else here guards the edges that have bitten this codebase
 * before: an upper-case scheme, and a clip ref whose payload IS the clip key.
 */
import { describe, it, expect } from 'vitest';
import {
    attachmentRefsInMessage,
    captureTextFromMessage,
    captureTitle,
    CAPTURE_TITLE_MAX,
} from '../api/captureToNote';

const REF = 'sovereign-enc:FILEID123?k=SECRETKEY&m=image%2Fpng&c=CAPTOKEN';

describe('captureTextFromMessage', () => {
    it('drops an attachment entirely — key, capability and file id', () => {
        const out = captureTextFromMessage(`look at this\n![beach.png](${REF})\nlovely`);
        expect(out).toContain('look at this');
        expect(out).toContain('lovely');
        expect(out).not.toContain('SECRETKEY');
        expect(out).not.toContain('CAPTOKEN');
        expect(out).not.toContain('FILEID123');
        expect(out).not.toContain('sovereign-enc');
    });

    it('drops an UPPER-CASE scheme too (the case trap that leaked a key before)', () => {
        const out = captureTextFromMessage('here: [f](SOVEREIGN-ENC:FILEID123?k=SECRETKEY&m=text/plain)');
        expect(out).not.toContain('SECRETKEY');
        expect(out).not.toContain('FILEID123');
    });

    it('drops a BARE ref, not just a markdown one', () => {
        const out = captureTextFromMessage(`grab it from ${REF} thanks`);
        expect(out).not.toContain('SECRETKEY');
        expect(out).not.toContain('FILEID123');
        expect(out).toContain('grab it from');
        expect(out).toContain('thanks');
    });

    it('reduces a clip ref to its bare scheme — the payload IS the clip key', () => {
        const out = captureTextFromMessage('watch sovereign-clip:v1?PACKEDMANIFEST99 now');
        expect(out).toContain('sovereign-clip:v1');
        expect(out).not.toContain('PACKEDMANIFEST99');
    });

    it('a message that is only a picture yields nothing, so the caller can fall back to the name', () => {
        expect(captureTextFromMessage(`![beach.png](${REF})`)).toBe('');
    });

    it('positive control: a plain message round-trips unchanged', () => {
        expect(captureTextFromMessage('pack the tent and the stove')).toBe('pack the tent and the stove');
    });
});

describe('attachmentRefsInMessage', () => {
    it('finds each ref once, with its display name', () => {
        const other = 'sovereign-enc:OTHER?k=K2&m=image/png';
        const refs = attachmentRefsInMessage(`![a.png](${REF})\ntext\n![b.png](${other})\n![a.png](${REF})`);
        expect(refs.map(r => r.name)).toEqual(['a.png', 'b.png']);
        expect(refs[0].href).toBe(REF);
    });

    it('finds nothing in a message with no attachments (positive control)', () => {
        expect(attachmentRefsInMessage('just words')).toEqual([]);
    });
});

describe('captureTitle', () => {
    it('is the first non-empty line, capped', () => {
        expect(captureTitle('\n\n  pack the tent  \nand the stove')).toBe('pack the tent');
        expect(captureTitle('x'.repeat(400))).toHaveLength(CAPTURE_TITLE_MAX);
    });

    it('falls back when there is nothing to name it after', () => {
        expect(captureTitle('   ')).toBe('Saved message');
        expect(captureTitle('', 'beach.png')).toBe('beach.png');
    });
});
