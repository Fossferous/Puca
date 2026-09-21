/**
 * What opens the composer, and with what already in it.
 *
 * Four things ask for this and they all speak the same small vocabulary: the
 * Android launcher shortcuts, the quick-settings tile, the home-screen widget
 * (all three carry one constant nav word — `compose-list`, `compose-note`,
 * `compose-draw`, `compose-photo` — from NotesNotifier.java), and a share
 * INTO Notes, which carries a title, a body and pictures as well.
 *
 * Nothing here reaches the server. A ComposeIntent is a request to OPEN the
 * composer; the note exists only once the user presses Done, which is also
 * what keeps a share from another app from silently writing into the account.
 */

/** Which composer to open on. */
export type ComposeMode = 'list' | 'text' | 'draw' | 'photo';

/** What the composer can do against THIS server (NotesShell's composerContent). */
export interface ComposeContent {
    text: boolean;
    pictures: boolean;
    camera?: boolean;
}

export interface ComposeIntent {
    /** Bumped per request, so asking twice for the same thing still re-opens
     *  and re-seeds. A monotonic counter, never an id. */
    seq: number;
    mode: ComposeMode;
    title?: string;
    body?: string;
    /** Pictures another app shared in. Files on this device; they are sealed
     *  by the ordinary upload path when the note is saved. */
    files?: File[];
}

/** The nav targets that mean "open the composer", in the widget's cell order.
 *  The Java side's own list is NotesWidgetProvider.TARGETS; a JUnit test
 *  pins those strings, and this array is the other half of that pair. */
export const COMPOSE_TARGETS: Record<string, ComposeMode> = {
    'compose-list': 'list',
    'compose-note': 'text',
    'compose-draw': 'draw',
    'compose-photo': 'photo',
};

/**
 * The mode the composer can actually honour here. A server that stores no
 * body cannot take a text note, and one with no attachments cannot take a
 * drawing or a photo — those fall back to a checklist rather than opening a
 * composer whose only control is dead.
 */
export function composeModeFor(mode: ComposeMode, content: ComposeContent | undefined): ComposeMode {
    if (!content) return 'list';
    if (mode === 'text') return content.text ? 'text' : 'list';
    if (mode === 'draw' || mode === 'photo') return content.pictures ? mode : 'list';
    return 'list';
}
