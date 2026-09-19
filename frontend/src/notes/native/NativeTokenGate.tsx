/**
 * Holds the session gate back for one bridge call in the Android app: the
 * background refresh may have renewed the session token while Notes was
 * closed, and that renewal must be adopted BEFORE anything reads the token —
 * otherwise an app left closed for two days opens on "session expired" even
 * though its native copy is still good, and the expiry path would then clear
 * that copy too. Renders children immediately where there is no plugin.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { getToken, storeRenewedToken } from '../../api/auth';
import { adoptNativeRenewedToken, notesNativeAvailable } from './notesNative';

export function NativeTokenGate({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(() => !notesNativeAvailable());
    useEffect(() => {
        if (ready) return;
        let live = true;
        void adoptNativeRenewedToken(getToken, storeRenewedToken)
            .catch(() => false)
            .then(() => { if (live) setReady(true); });
        return () => { live = false; };
    }, [ready]);
    return ready ? <>{children}</> : null;
}
