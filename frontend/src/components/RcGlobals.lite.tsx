/**
 * The lite build's stand-in for RcGlobals.
 *
 * vite.config.ts aliases './components/RcGlobals' here when VITE_ENABLE_RC is
 * false, which keeps the real module — and the nine remote-control components
 * it imports — out of the module graph entirely rather than merely unrendered.
 *
 * A REAL component, never an empty module: an alias to emptiness would make
 * `RcGlobals` undefined and React would throw on render, and a Proxy-style
 * auto-stub would silently swallow a genuinely missing export.
 *
 * It is not empty, though. Removing remote control from the ARTIFACT does not
 * remove it from the HOST: a previous full install can have registered a
 * LocalSystem remote-access service that no uninstaller touches. The one thing
 * this build mounts is the notice that offers to remove it.
 */
import { RcLeftoversBanner } from './RcLeftoversBanner';

export function RcGlobals() {
    return <RcLeftoversBanner />;
}
