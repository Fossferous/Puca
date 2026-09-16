/**
 * THE FIT — the viewer's half.
 *
 * The host encoded its monitor at native size and the viewer decoded every
 * pixel to show a fraction of them: the owner's phone, held sideways, decoded
 * a 1440x2560 portrait monitor (15.8 ms a frame, half the budget at 30 fps)
 * to display it at 607x1080. The device protocol had no way to ask for fewer
 * pixels. Now the stage reports its size and the host fits the picture to it.
 *
 * Pinned here: the arithmetic the stage reports (viewSizeFor), what the host
 * will accept off the wire (isViewDim), and the exact frames written to the
 * agent — the SAME literals crates/puca-agent/src/protocol.rs parses in its
 * own tests, because a renamed field on either side would leave every host
 * streaming at native size with nothing logged: the swallow that keeps an old
 * agent harmless makes a mismatched new one silent too.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { agentHostBackend, agentAnswerOffer } from '../api/devices/hostAgent';
import {
    viewSizeFor,
    isViewDim,
    MAX_VIEW_EDGE,
    MIN_STAGE_CSS_PX,
    readFitResolutionPreference,
    FIT_RESOLUTION_KEY,
} from '../api/devices/viewSize';

describe('what the stage reports (viewSizeFor)', () => {
    test("the owner's phone held sideways: a 2400x1080 stage", () => {
        // 800x360 CSS px at a device pixel ratio of 3 — a 2400x1080 panel.
        expect(viewSizeFor({ w: 800, h: 360 }, 3, 1, 'fit')).toEqual({ w: 2400, h: 1080 });
    });

    test('a pinch zoom reports a larger stage, so the host sends the pixels back', () => {
        expect(viewSizeFor({ w: 800, h: 360 }, 3, 2, 'fit')).toEqual({ w: 4800, h: 2160 });
    });

    test("full resolution is the wire's 0x0, whatever the stage", () => {
        expect(viewSizeFor({ w: 800, h: 360 }, 3, 1, 'full')).toEqual({ w: 0, h: 0 });
        expect(viewSizeFor(null, 3, 1, 'full')).toEqual({ w: 0, h: 0 });
    });

    test('nothing is reported before layout or for a stage mid-transition', () => {
        expect(viewSizeFor(null, 3, 1, 'fit')).toBeNull();
        expect(viewSizeFor({ w: MIN_STAGE_CSS_PX - 1, h: 500 }, 3, 1, 'fit')).toBeNull();
        expect(viewSizeFor({ w: 500, h: 0 }, 3, 1, 'fit')).toBeNull();
    });

    test('a runaway ratio or zoom cannot become a runaway request', () => {
        expect(viewSizeFor({ w: 800, h: 360 }, Number.NaN, 1, 'fit')).toEqual({ w: 800, h: 360 });
        expect(viewSizeFor({ w: 800, h: 360 }, 0, 1, 'fit')).toEqual({ w: 800, h: 360 });
        // A zoom under fitted does not exist on the stage; read as fitted.
        expect(viewSizeFor({ w: 800, h: 360 }, 3, 0.5, 'fit')).toEqual({ w: 2400, h: 1080 });
        expect(viewSizeFor({ w: 10_000, h: 10_000 }, 4, 8, 'fit')).toEqual({ w: MAX_VIEW_EDGE, h: MAX_VIEW_EDGE });
    });

    test('the preference defaults to fit, honours a stored full, and survives a bad store', () => {
        // The test environment's localStorage is a vi.fn() mock that stores
        // nothing, so the round trip is driven through getItem directly. An
        // implementation that ignored storage would pass the default case and
        // fail the stored one — which is the case that matters: the user's
        // "Full resolution" choice has to survive a reload.
        const getItem = vi.mocked(localStorage.getItem);
        getItem.mockReturnValueOnce(null);
        expect(readFitResolutionPreference()).toBe('fit');
        getItem.mockReturnValueOnce('full');
        expect(readFitResolutionPreference()).toBe('full');
        getItem.mockReturnValueOnce('fit');
        expect(readFitResolutionPreference()).toBe('fit');
        getItem.mockReturnValueOnce('sideways');
        expect(readFitResolutionPreference()).toBe('fit');
        getItem.mockImplementationOnce(() => { throw new Error('private mode'); });
        expect(readFitResolutionPreference()).toBe('fit');
        expect(getItem).toHaveBeenCalledWith(FIT_RESOLUTION_KEY);
    });
});

describe('what the host accepts off the wire (isViewDim)', () => {
    test('non-negative integers up to the agent bound, nothing else', () => {
        for (const ok of [0, 1, 1080, 2400, MAX_VIEW_EDGE]) {
            expect(isViewDim(ok), String(ok)).toBe(true);
        }
        for (const bad of [-1, 1.5, MAX_VIEW_EDGE + 1, Number.NaN, Number.POSITIVE_INFINITY, '2400', null, undefined]) {
            expect(isViewDim(bad), String(bad)).toBe(false);
        }
    });
});

describe('the frames the agent is written', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'ok' }));
    });

    test('set_view_size is the literal crates/puca-agent/src/protocol.rs parses', async () => {
        const backend = agentHostBackend();
        expect(backend.setViewSize, 'the agent backend implements the fit').toBeTypeOf('function');
        await backend.setViewSize?.('s1', 2400, 1080);
        expect(invokeMock).toHaveBeenCalledWith('agent_request', {
            request: '{"cmd":"set_view_size","session_id":"s1","width":2400,"height":1080}',
        });
    });

    test('an agent older than the command is swallowed, not surfaced', async () => {
        invokeMock.mockRejectedValueOnce(new Error('bad request'));
        await expect(agentHostBackend().setViewSize?.('s1', 2400, 1080)).resolves.toBeUndefined();
    });

    test('a media restart carries the fit into start_stream; a fresh session omits it', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'agent_request') return JSON.stringify({ ok: 'ok', answer_sdp: 'v=0' });
            return JSON.stringify({});
        });

        await agentAnswerOffer('s1', 'offer-sdp', 0, { viewSize: { w: 2400, h: 1080 } });
        const restart = JSON.parse((invokeMock.mock.calls[0][1] as { request: string }).request);
        expect(restart.cmd).toBe('start_stream');
        expect([restart.view_width, restart.view_height]).toEqual([2400, 1080]);

        invokeMock.mockClear();
        await agentAnswerOffer('s2', 'offer-sdp', 0);
        const fresh = JSON.parse((invokeMock.mock.calls[0][1] as { request: string }).request);
        expect(fresh.cmd).toBe('start_stream');
        // Omitted, not sent as 0: the agent's fields default to native, and
        // an older agent must not see a field it does not know.
        expect('view_width' in fresh).toBe(false);
        expect('view_height' in fresh).toBe(false);
    });
});
