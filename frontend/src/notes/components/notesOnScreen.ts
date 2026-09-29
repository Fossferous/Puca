/**
 * Whether Notes is on the screen. Always true on Notes' own page and in its
 * Android app, where the page itself going to the background is what takes
 * it off (`visibilitychange`). False while Notes, embedded in the Púca
 * desktop app, is kept mounted behind whatever view the person switched to —
 * the window is still in front, so no page event says so. The desktop view
 * (components/NotesDesktopView.tsx) provides it; nothing else does.
 *
 * Whatever only the foreground may hold lets go when this turns false: the
 * voice recorder's microphone (AudioRecorder.tsx, "FOREGROUND ONLY").
 */
import { createContext } from 'react';

export const NotesOnScreenContext = createContext(true);
