import { useState } from 'react';

/**
 * Open/closed state that can only be OPEN while `allowed` holds, and is
 * forgotten (closed) the moment `allowed` goes false - so it never comes back
 * by itself when `allowed` returns. The Activities picker: switching games off
 * (or a Play Games deny, or leaving the call) takes the launcher away, and the
 * picker must not reappear unasked when the launcher does (the 2026-10-03
 * client review saw it resurrect over a member's screen).
 *
 * The reset is React's "adjust state while rendering" pattern, not an effect:
 * the stale `true` is never shown, not even for one commit.
 */
export function useOpenWhile(allowed: boolean): [boolean, (open: boolean) => void] {
    const [open, setOpen] = useState(false);
    if (open && !allowed) setOpen(false);
    return [open && allowed, setOpen];
}
