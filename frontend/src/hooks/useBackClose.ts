import { useEffect, useRef } from 'react';
import { interceptBack } from '../api/mobileApp';

/**
 * While `active`, Android's BACK gesture calls `onClose` instead of sending
 * the app away (api/mobileApp.ts interceptBack, which stacks: the layer
 * opened last closes first). Every menu, dialog, sheet and viewer a phone can
 * open calls this, and `src/tests/backCloseCoverage.test.ts` fails a new one
 * that does not.
 *
 * `onClose` is read when back is pressed, never re-registered: a re-register
 * on every render would move a parent above the dialog it opened. Nothing at
 * all off Android (the web, the desktop app).
 */
export function useBackClose(onClose: () => void, active = true): void {
    const latest = useRef(onClose);
    useEffect(() => { latest.current = onClose; });
    useEffect(() => {
        if (!active) return;
        return interceptBack(() => latest.current());
    }, [active]);
}
