/**
 * A share arriving on a COLD START, which is the normal share path: the app
 * was not running, which is the whole point of the entry point.
 *
 * The native handoff is a bridge call plus a local file read — milliseconds.
 * `GET /notes/features` is an HTTPS round trip to the user's own server. So
 * at the moment the share lands the page still believes NO_LIST_FEATURES
 * (body: false, attachments: false), and a decision taken then throws the
 * shared picture away, tells the user this server cannot keep pictures when
 * it can, and opens a text share as a checklist.
 *
 * The walk cannot catch this — its backend is localhost, so the features
 * query wins there and the picture check passes for the wrong reason. Hence
 * these, which hold the answer back on purpose.
 */
import { describe, it, expect, vi } from 'vitest';
import { takeShare, type ComposeContent, type ShareIntakeDeps } from '../notes/model/composeIntent';

const FULL: ComposeContent = { text: true, pictures: true };
/** What useListFeatures returns before the server has answered. */
const NOTHING_YET: ComposeContent = { text: false, pictures: false };

function pic(name = 'shared.png') {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

/** A share intake whose server answer arrives AFTER the share does. */
function harness(server: ComposeContent | null, page: ComposeContent = NOTHING_YET) {
    const open = vi.fn();
    const refusePicture = vi.fn();
    let release!: () => void;
    const answered = new Promise<void>(r => { release = r; });
    const deps: ShareIntakeDeps = {
        ensureContent: async () => { await answered; return server; },
        fallback: () => page,
        open,
        refusePicture,
    };
    return { deps, open, refusePicture, release };
}

describe('a share decided against the server, not against the page', () => {
    it('keeps the picture when the server answers only after the share landed', async () => {
        const { deps, open, refusePicture, release } = harness(FULL);
        const file = pic();
        const done = takeShare({ title: 'Snap', body: '', files: [file] }, deps);
        // The share is in, the answer is not: nothing may be decided yet.
        expect(open).not.toHaveBeenCalled();
        release();
        await done;
        expect(refusePicture).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0][0].files).toEqual([file]);
    });

    it('opens shared text as a text note, not as a checklist, for the same reason', async () => {
        const { deps, open, release } = harness(FULL);
        const done = takeShare({ title: 'Errand', body: 'Milk\nBread', files: [] }, deps);
        release();
        await done;
        expect(open.mock.calls[0][0].mode).toBe('text');
        expect(open.mock.calls[0][0].body).toBe('Milk\nBread');
    });

    it('still refuses the picture when the server really cannot keep one (positive control)', async () => {
        const { deps, open, refusePicture, release } = harness({ text: true, pictures: false });
        const done = takeShare({ title: 'Snap', body: '', files: [pic()] }, deps);
        release();
        await done;
        expect(refusePicture).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0][0].files).toEqual([]);
    });

    it('a picture-only share that is refused opens nothing at all', async () => {
        const { deps, open, refusePicture, release } = harness({ text: true, pictures: false });
        const done = takeShare({ title: '', body: '', files: [pic()] }, deps);
        release();
        await done;
        expect(refusePicture).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
    });

    it('falls back to what the page believes when the server cannot be asked at all', async () => {
        // Offline: ensureFeatures resolves null. An offline share must still
        // open something, judged by the last thing the page knew.
        const { deps, open, release } = harness(null, FULL);
        const file = pic();
        const done = takeShare({ title: 'Snap', body: '', files: [file] }, deps);
        release();
        await done;
        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0][0].files).toEqual([file]);
        expect(open.mock.calls[0][0].mode).toBe('text');
    });

    it('a server with no note body turns shared text into a checklist (positive control)', async () => {
        const { deps, open, release } = harness({ text: false, pictures: true });
        const done = takeShare({ title: 'Errand', body: 'Milk', files: [] }, deps);
        release();
        await done;
        expect(open.mock.calls[0][0].mode).toBe('list');
    });

    it('an empty share opens nothing', async () => {
        const { deps, open, refusePicture, release } = harness(FULL);
        const done = takeShare({ title: '', body: '', files: [] }, deps);
        release();
        await done;
        expect(open).not.toHaveBeenCalled();
        expect(refusePicture).not.toHaveBeenCalled();
    });
});
