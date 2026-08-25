/**
 * The context-menu "Add Reaction" path into <MessageReactions> (openRequest).
 *
 * The load-bearing case: an openRequest that arrives while the initial
 * reactions fetch is still in flight. The component renders null during
 * loading, so there is no popover DOM to measure when showPicker flips true —
 * the picker must still be measured and shown once loading resolves. The
 * positioning layout effect depends on `loading` for exactly this; without it
 * the picker mounted at -9999/hidden and stayed there forever (review
 * finding, 0811) — on touch this is the ONLY reaction entry point, so it
 * silently ate the gesture.
 *
 * Mounted the way the repo's other component tests do it — raw
 * `react-dom/client` + `act`, no @testing-library/react (not a dependency).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const getReactions = vi.fn();
const addReaction = vi.fn(async () => undefined);
const removeReaction = vi.fn(async () => undefined);
const listEmojis = vi.fn(async () => []);
const onReactionChanged = vi.fn(() => () => undefined);
vi.mock('../api/reactions', () => ({
    getReactions: (...a: unknown[]) => getReactions(...a),
    addReaction: (...a: unknown[]) => addReaction(...a),
    removeReaction: (...a: unknown[]) => removeReaction(...a),
    listEmojis: (...a: unknown[]) => listEmojis(...a),
    onReactionChanged: (...a: unknown[]) => onReactionChanged(...a),
}));
vi.mock('../api/websocket', () => ({
    wsClient: { on: vi.fn(), off: vi.fn() },
}));

const { MessageReactions } = await import('../components/MessageReactions');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.clearAllMocks();
});

const picker = () => document.querySelector<HTMLElement>('.reaction-picker');

describe('MessageReactions openRequest', () => {
    it('a request during the initial fetch shows a POSITIONED picker once loading resolves', async () => {
        let resolveFetch: (v: unknown) => void = () => undefined;
        getReactions.mockImplementation(() => new Promise(res => { resolveFetch = res; }));

        await act(async () => {
            root!.render(<MessageReactions messageId="m1" currentUserId={1} />);
        });
        // Still loading: the whole component renders null.
        expect(picker()).toBeNull();

        // The long-press lands while the fetch is in flight.
        await act(async () => {
            root!.render(<MessageReactions messageId="m1" currentUserId={1} openRequest={{ nonce: 1, x: 200, y: 300 }} />);
        });
        expect(picker()).toBeNull(); // no DOM to show yet — that's fine

        await act(async () => { resolveFetch([]); });

        // The regression: the popover mounted at -9999/hidden and nothing
        // ever measured it. It must be visible and anchored on-screen.
        const p = picker();
        expect(p).not.toBeNull();
        expect(p!.style.visibility).toBe('visible');
        expect(p!.style.top).not.toBe('-9999px');
        expect(parseInt(p!.style.top, 10)).toBeGreaterThanOrEqual(0);
    });

    it('a stale request present at MOUNT does not pop the picker (remount protection)', async () => {
        getReactions.mockResolvedValue([]);
        await act(async () => {
            root!.render(<MessageReactions messageId="m1" currentUserId={1} openRequest={{ nonce: 5, x: 10, y: 10 }} />);
        });
        expect(picker()).toBeNull();
    });

    it('a request after load opens immediately, anchored at the press point', async () => {
        getReactions.mockResolvedValue([]);
        await act(async () => {
            root!.render(<MessageReactions messageId="m1" currentUserId={1} />);
        });
        await act(async () => {
            root!.render(<MessageReactions messageId="m1" currentUserId={1} openRequest={{ nonce: 1, x: 150, y: 500 }} />);
        });
        const p = picker();
        expect(p).not.toBeNull();
        expect(p!.style.visibility).toBe('visible');
        // jsdom measures the popover at 0x0, so positionPicker uses its
        // fallback size (370x440): 500 - 440 - 4 = 56 → opens above the
        // anchor; left clamps to the anchor x.
        expect(parseInt(p!.style.top, 10)).toBeGreaterThanOrEqual(0);
        expect(parseInt(p!.style.left, 10)).toBe(150);
    });
});
