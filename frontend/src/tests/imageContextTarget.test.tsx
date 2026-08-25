/**
 * The one assumption the rest of the copy-image work rests on.
 *
 * The image items are NOT attached to each <img>. Doing that would double-fire:
 * React's synthetic contextmenu still bubbles to the `.message` row, whose
 * handler calls showContextMenu again and overwrites the menu that was just
 * opened. So the row handler instead inspects `e.target` and splices in image
 * actions when the click landed on a picture.
 *
 * That only works if React reports `e.target` as the <img> rather than the
 * element the handler is bound to. If it ever retargeted to `currentTarget`,
 * imageSrcFromTarget would return null, `imageMenuItems` would return [], and
 * "Copy Image" would simply never appear — with every type check, unit test and
 * build still green, because nothing else observes it.
 *
 * The other tests all call imageMenuItems with an element they constructed
 * themselves, so none of them would notice. This one dispatches a real event
 * through a real React tree.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { imageMenuItems, imageSrcFromTarget } from '../components/contextMenuUtils';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

/** Mount a message-shaped tree and return what the row handler observed. */
function mountRow() {
    host = document.createElement('div');
    document.body.appendChild(host);
    const seen: { target: EventTarget | null }[] = [];

    root = createRoot(host);
    act(() => {
        root!.render(
            // Mirrors Chat.tsx: the handler is on the ROW, the image is nested.
            <div className="message" onContextMenu={(e) => { seen.push({ target: e.target }); }}>
                <div className="message-body">
                    <span className="message-image">
                        <img src="https://example.com/cat.png" alt="" data-role="pic" />
                    </span>
                    <span className="message-text">some words</span>
                </div>
            </div>,
        );
    });
    return { seen };
}

describe('right-click target inside a message row', () => {
    it('reports the IMG, not the row the handler is bound to', () => {
        const { seen } = mountRow();
        const img = host!.querySelector('img')!;

        act(() => {
            img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        });

        expect(seen).toHaveLength(1);
        expect((seen[0].target as HTMLElement).tagName).toBe('IMG');
        expect((seen[0].target as HTMLElement).dataset.role).toBe('pic');
        // The whole point: this is what produces the menu items.
        expect(imageSrcFromTarget(seen[0].target)).toBe('https://example.com/cat.png');
    });

    it('reports non-image text as no image, so the menu is unchanged there', () => {
        const { seen } = mountRow();
        const text = host!.querySelector('.message-text')!;

        act(() => {
            text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        });

        // CONTROL. Without this, a broken imageSrcFromTarget that returned a
        // src for EVERYTHING would still pass the test above, and every message
        // would sprout a Copy Image item that copies nothing.
        expect(imageSrcFromTarget(seen[0].target)).toBeNull();
        expect(imageMenuItems(seen[0].target, () => {})).toEqual([]);
    });
});
