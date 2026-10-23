// @vitest-environment jsdom
/**
 * What the agent says on the caret channel besides carets, read the way
 * session.ts reads it: the latency probe's answer (latency.rs `probe_reply`)
 * and the host pointer's shape (pointer_shape.rs `cursor_line`). The exact
 * lines are pinned on the Rust side too; a renamed field on either side would
 * leave the probe unanswered or the pointer stuck as an arrow, silently.
 */
import { describe, it, expect, vi } from 'vitest';

// session.ts opens a WebSocket subscription at import; nothing here sends.
vi.mock('../api/websocket', () => ({
    wsClient: { isConnected: true, on: () => {}, send: () => {} },
}));

import { parseCursorShape, parseInputRefused, parseProbeAnswer } from '../api/devices/session';

describe('the probe answer', () => {
    it('reads the line latency.rs writes', () => {
        expect(parseProbeAnswer('{"k":"probe","p":7,"ts":123456,"host":3.5}')).toEqual({ p: 7, ts: 123456, host: 3.5 });
        expect(parseProbeAnswer('{"k":"probe","p":7,"ts":123456}')).toEqual({ p: 7, ts: 123456, host: null });
    });

    it('anything else is not an answer — a caret report included', () => {
        expect(parseProbeAnswer('{"vis":true,"x":0.1,"y":0.2,"seq":3}')).toBeNull();
        expect(parseProbeAnswer('{"k":"probe","p":"7","ts":1}')).toBeNull();
        expect(parseProbeAnswer('{"k":"probe","p":1.5,"ts":1}')).toBeNull();
        expect(parseProbeAnswer('{"k":"cursor","css":"text"}')).toBeNull();
        expect(parseProbeAnswer('not json "probe"')).toBeNull();
        expect(parseProbeAnswer(42)).toBeNull();
    });
});

describe('a refused text frame', () => {
    it('reads the line stream.rs writes', () => {
        expect(parseInputRefused('{"k":"refused","t":"text","why":"text contains the control character"}'))
            .toBe('text contains the control character');
    });

    it('the reason is made printable and short; a missing one still says something', () => {
        const odd = parseInputRefused('{"k":"refused","t":"text","why":"bad\\u0085here\\u0007"}');
        expect(odd).toBe('bad here');
        const long = parseInputRefused(JSON.stringify({ k: 'refused', t: 'text', why: 'w'.repeat(1000) }));
        expect(long!.length).toBeLessThanOrEqual(200);
        expect(parseInputRefused('{"k":"refused","t":"text"}')).toBe('the other computer refused it');
    });

    it('anything else is not a refusal', () => {
        expect(parseInputRefused('{"k":"refused","t":"key","why":"x"}')).toBeNull();
        expect(parseInputRefused('{"k":"cursor","css":"text"}')).toBeNull();
        expect(parseInputRefused('{"k":"probe","p":1,"ts":2}')).toBeNull();
        expect(parseInputRefused('not json "refused"')).toBeNull();
    });
});

describe('the host pointer shape', () => {
    it('reads the line pointer_shape.rs writes', () => {
        expect(parseCursorShape('{"k":"cursor","css":"text"}')).toBe('text');
        expect(parseCursorShape('{"k":"cursor","css":"none"}')).toBe('none');
        expect(parseCursorShape('{"k":"cursor","css":"nwse-resize"}')).toBe('nwse-resize');
    });

    it('only a known keyword: the value lands in a style', () => {
        expect(parseCursorShape('{"k":"cursor","css":"url(x.png), auto"}')).toBeNull();
        expect(parseCursorShape('{"k":"cursor","css":"text; background: red"}')).toBeNull();
        expect(parseCursorShape('{"k":"cursor","css":7}')).toBeNull();
        expect(parseCursorShape('{"k":"probe","p":1,"ts":2}')).toBeNull();
        expect(parseCursorShape('{"vis":false,"seq":1}')).toBeNull();
    });
});
