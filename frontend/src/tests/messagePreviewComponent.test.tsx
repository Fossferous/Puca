/**
 * MessagePreview draws api/messagePreview's segments: an attachment is an
 * icon from Icons.tsx plus its name, never the ref; a spoiler keeps its name
 * hidden; plain text renders as text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessagePreview } from '../components/MessagePreview';
import { MusicIcon, PaperclipIcon } from '../components/Icons';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

function render(content: string, max?: number) {
    host = document.createElement('span');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<MessagePreview content={content} max={max} />));
    return host;
}

describe('<MessagePreview>', () => {
    it('an image, a file and a spoiler: icon + label each, no ref, no key', () => {
        const el = render(
            `hi ![photo.png](sovereign-enc:1?k=${KEY}&m=image%2Fpng) [report.pdf](sovereign-enc:2?k=${KEY}&m=application%2Fpdf) ||![twist.png](sovereign-enc:3?k=${KEY}&m=image%2Fpng)||`,
        );
        expect(el.textContent).not.toMatch(/sovereign-enc|\]\(/i);
        expect(el.textContent).not.toContain(KEY.slice(0, 10));
        expect(el.textContent).not.toContain('twist');
        const chips = Array.from(el.querySelectorAll('.msg-preview-att'));
        expect(chips.map(c => c.className)).toEqual([
            'msg-preview-att msg-preview-att-image',
            'msg-preview-att msg-preview-att-file',
            'msg-preview-att msg-preview-att-spoiler',
        ]);
        expect(chips.map(c => c.querySelector('.msg-preview-att-name')?.textContent)).toEqual(['photo.png', 'report.pdf', 'Spoiler image']);
        expect(chips.map(c => c.getAttribute('title'))).toEqual(['Image: photo.png', 'File: report.pdf', 'Spoiler image']);
        // Each carries a drawn icon (an Icons.tsx SVG), hidden from screen
        // readers because the title already names the kind.
        for (const c of chips) {
            const icon = c.querySelector('.msg-preview-att-icon');
            expect(icon?.getAttribute('aria-hidden')).toBe('true');
            expect(icon?.querySelector('svg')).not.toBeNull();
        }
        expect(el.textContent?.startsWith('hi ')).toBe(true);
    });

    it('an audio file shows the music note (the icon on its player card); another file the paperclip', () => {
        const el = render(`[song.mp3](sovereign-enc:4?k=${KEY}&m=audio%2Fmpeg) [report.pdf](sovereign-enc:2?k=${KEY}&m=application%2Fpdf)`);
        const chips = Array.from(el.querySelectorAll('.msg-preview-att'));
        expect(chips.map(c => c.className)).toEqual(['msg-preview-att msg-preview-att-audio', 'msg-preview-att msg-preview-att-file']);
        const drawn = (c: Element) => c.querySelector('.msg-preview-att-icon svg')!.outerHTML;
        expect(drawn(chips[0])).toBe(renderToStaticMarkup(<MusicIcon />));
        expect(drawn(chips[1])).toBe(renderToStaticMarkup(<PaperclipIcon />));
        expect(chips[0].getAttribute('title')).toBe('Audio: song.mp3');
    });

    it('plain text renders as just that text (negative control)', () => {
        const el = render('nothing attached here', 60);
        expect(el.textContent).toBe('nothing attached here');
        expect(el.querySelector('.msg-preview-att')).toBeNull();
    });

    it('caps at max with an ellipsis', () => {
        expect(render('abcdefghij', 4).textContent).toBe('abcd…');
    });
});
