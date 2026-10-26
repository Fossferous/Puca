/**
 * The stage's "<PC> runs an older Púca" line (api/devices/olderHost.ts): said
 * only from what that computer did, never with a version nobody told us.
 */
import { describe, it, expect } from 'vitest';
import { hostIsOlder, olderHostMessage } from '../api/devices/olderHost';

const none = { noShapes: false, shapeReported: false, probeAnswered: false };

describe('hostIsOlder', () => {
    it('NEGATIVE CONTROL: no evidence, no verdict', () => {
        expect(hostIsOlder(none)).toBe(false);
    });

    it('it took the pointer and said no shape while it could have: older', () => {
        expect(hostIsOlder({ ...none, noShapes: true })).toBe(true);
    });

    it('a shape that arrived outweighs the silence: only a current agent sends one', () => {
        expect(hostIsOlder({ ...none, noShapes: true, shapeReported: true })).toBe(false);
    });

    // Review 2026-10-26: the probe came in the same release as the shape, so
    // an answer proves a current agent; silence from a probe proves nothing.
    it('a probe answered outweighs it too', () => {
        expect(hostIsOlder({ ...none, noShapes: true, probeAnswered: true })).toBe(false);
    });
});

describe('olderHostMessage', () => {
    it('names the computer as the person called it, and says what to do', () => {
        expect(olderHostMessage('  Study PC ', { ...none, noShapes: true }))
            .toBe('Study PC runs an older Púca: the pointer is drawn there and can lag. Update Púca on Study PC.');
    });

    it('without a name, "that computer", as the stage\'s other banners say', () => {
        expect(olderHostMessage(null, { ...none, noShapes: true }))
            .toBe('That computer runs an older Púca: the pointer is drawn there and can lag. Update Púca on that computer.');
        expect(olderHostMessage('   ', { ...none, noShapes: true })).toMatch(/^That computer runs/);
    });

    it('never claims a version: none is known on this side', () => {
        const line = olderHostMessage('Study PC', { ...none, noShapes: true }) ?? '';
        expect(line).not.toMatch(/\d+\.\d+\.\d+/);
    });

    it('nothing to say, no line', () => {
        expect(olderHostMessage('Study PC', none)).toBeNull();
    });
});
