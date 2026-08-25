/**
 * Which icon set the UI draws: the drawn set, or the emoji/glyphs it replaced.
 *
 * Its own module, with no React and no import of Icons.tsx, because
 * `settingsStore` has to write it and `settingsStore` is imported by half of
 * `api/` (hotkeys, desktopNotify, noiseFilter, rtc/…). Putting the store in
 * Icons.tsx would drag 127 icon components and Icons.css into every one of
 * those bundles for the sake of one string.
 *
 * Icons.tsx subscribes with useSyncExternalStore; settingsStore.applyAppearance
 * writes it at boot and on every settings save, the same way it applies the
 * theme.
 */

export type IconStyle = 'modern' | 'classic';

let current: IconStyle = 'modern';
const listeners = new Set<() => void>();

export function setIconStyle(next: IconStyle): void {
    if (next === current) return;
    current = next;
    listeners.forEach(fn => fn());
}

export function getIconStyle(): IconStyle {
    return current;
}

export function subscribeIconStyle(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
