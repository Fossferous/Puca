import { createContext } from 'react';

/** True inside a spoiler that is not revealed yet: a player there is
 *  covered, and nothing in it may be focused or pressed (VideoPlayer's
 *  `covered`). The cover itself is CSS (Chat.css, Spoilered media), which
 *  already keeps the pointer out; this keeps the keyboard out too. Its own
 *  module, not Spoiler.tsx's: a component file may export only components. */
export const SpoilerCover = createContext(false);
