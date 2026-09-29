/**
 * useLiveRouteQuery — the query of the route as the HISTORY holds it, under
 * either router Notes runs in.
 *
 * Why it exists (the pager-settle fix): React Router renders a navigation
 * inside startTransition, so a note opened a moment before a swipe settles is
 * already in the history and not yet in the last render; a settle that read
 * the render dropped `?note=` and closed the note by itself. The first cut
 * read `window.location.hash`, which is the HashRouter's store only: inside
 * the desktop app Notes runs under a MemoryRouter and the hash is the main
 * app's, so that version answered '' there and every settle closed the note
 * again.
 *
 * Each case navigates and reads IN THE SAME TICK — the window in which the
 * render has not caught up — so a reader of the rendered location fails it,
 * and the MemoryRouter case fails a reader of the hash.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HashRouter, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useLiveRouteQuery } from '../notes/components/useLiveRouteQuery';

let root: Root | null = null;
let probe: { go: (to: string) => string; rendered: () => string } | null = null;

function Probe() {
    const navigate = useNavigate();
    const live = useLiveRouteQuery();
    const rendered = useLocation().search;
    useEffect(() => {
        probe = {
            // Navigate, then read straight away, as a settle landing in the
            // same task as a card click does.
            go: (to: string) => { navigate(to); return live(); },
            rendered: () => rendered,
        };
    });
    return null;
}

function mount(ui: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(ui); });
}

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    probe = null;
    document.body.innerHTML = '';
    window.location.hash = '';
});

describe('the live route query', () => {
    it('under a MemoryRouter (Notes inside the desktop app): the note just opened, before the render has it', () => {
        mount(<MemoryRouter initialEntries={['/label/Home']}><Probe /></MemoryRouter>);
        let read = '';
        act(() => { read = probe!.go('/label/Home?note=list%3A7'); });
        expect(read).toBe('?note=list%3A7');
        // …and the hash, which that router never writes, holds none of it.
        expect(window.location.hash).not.toContain('note=');
    });

    it('under a HashRouter (Notes’ own page): the same, from the hash router’s history', () => {
        mount(<HashRouter><Probe /></HashRouter>);
        let read = '';
        act(() => { read = probe!.go('/label/Home?note=list%3A9'); });
        expect(read).toBe('?note=list%3A9');
    });

    it('CONTROL: in that same tick the rendered location has not caught up — which is why the live one is read', () => {
        mount(<MemoryRouter initialEntries={['/']}><Probe /></MemoryRouter>);
        let rendered = 'unset';
        act(() => {
            const before = probe!;
            before.go('/?note=list%3A3');
            rendered = before.rendered();
        });
        expect(rendered).toBe('');
        expect(probe!.rendered()).toBe('?note=list%3A3');
    });

    it('with no query at all it reads empty, not the last one', () => {
        mount(<MemoryRouter initialEntries={['/?note=list%3A1']}><Probe /></MemoryRouter>);
        let read = 'unset';
        act(() => { read = probe!.go('/archive'); });
        expect(read).toBe('');
    });
});
