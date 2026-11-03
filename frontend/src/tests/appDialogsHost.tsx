/**
 * <AppDialogs/> on the page, as main.tsx mounts it, for a test of something that
 * asks or tells: without a host, api/appDialogs.ts falls back to the native call.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AppDialogs } from '../components/AppDialogs';

export function mountAppDialogs() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(<AppDialogs />); });
    return {
        /** The words of each notice on screen, oldest first. */
        notices: (): (string | null)[] => [...document.querySelectorAll('.app-notice-text')].map(n => n.textContent),
        unmount: () => {
            act(() => { root.unmount(); });
            host.remove();
        },
    };
}
