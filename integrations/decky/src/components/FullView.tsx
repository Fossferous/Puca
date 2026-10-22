/**
 * The full Púca view (/puca): the hidden browser view shown over this page,
 * for messages, signing in and everything the Quick Access panel does not
 * cover. Touch it like a phone; the on-screen keyboard opens for typing. B
 * comes back.
 *
 * The view is measured from a placeholder filling the page, the way Steam's
 * own web browser places its views (getBoundingClientRect, then SetBounds in
 * the main window's CSS pixels), and re-measured when the page resizes (the
 * keyboard, an external display).
 */
import { Focusable, Navigation } from '@decky/ui';
import { useLayoutEffect, useRef } from 'react';
import { controller } from '../controller';

/** Steam's header bar stays visible above the view. */
const TOP = 40;

export function FullView() {
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const place = () => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) controller.showView({ x: r.left, y: r.top, width: r.width, height: r.height });
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(el);
        const win = el.ownerDocument.defaultView;
        win?.addEventListener('resize', place);
        return () => {
            observer.disconnect();
            win?.removeEventListener('resize', place);
            controller.hideView();
        };
    }, []);

    return (
        <Focusable
            onCancelButton={() => Navigation.NavigateBack()}
            onCancelActionDescription="Back"
            style={{ position: 'fixed', left: 0, right: 0, top: TOP, bottom: 0 }}
        >
            <div ref={ref} style={{ width: '100%', height: '100%' }} />
        </Focusable>
    );
}
