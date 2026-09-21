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

/** What a share from another app carries, once the native side has shaped it
 *  (native/useNativeShareIn's SharedIntoNotes). */
export interface SharedPayload {
    title: string;
    body: string;
    files: File[];
}

/** What `takeShare` needs from the shell. */
export interface ShareIntakeDeps {
    /** The server's answer about what a note may hold, FETCHED if the page
     *  has not got it yet (useListContent's `ensureFeatures`). `null` when it
     *  could not be asked at all — offline, or the request failed. */
    ensureContent: () => Promise<ComposeContent | null>;
    /** What the page already believes. Used ONLY when the ask failed, so an
     *  offline share still opens something. */
    fallback: () => ComposeContent;
    /** Open the composer on it. Nothing is saved here. */
    open: (intent: Omit<ComposeIntent, 'seq'>) => void;
    /** Say out loud that the picture could not come; a share that vanished
     *  silently looks like a share that never arrived. */
    refusePicture: () => void;
}

/**
 * Take a share into the composer.
 *
 * ASYNC ON PURPOSE. A share is normally a COLD START — that is the whole
 * point of the entry point, the app was not running — and the native handoff
 * (one bridge call plus a local `_capacitor_file_` read) finishes in
 * milliseconds, while `GET /notes/features` is an HTTPS round trip to the
 * user's own server. Deciding against what the page knows at that instant
 * means deciding against NO_LIST_FEATURES: the shared picture is dropped, the
 * user is told this server cannot keep pictures when it can, and a text share
 * opens as a checklist. So wait for the answer, and fall back to what the
 * page believes only when there is no answer to be had.
 */
export async function takeShare(shared: SharedPayload, deps: ShareIntakeDeps): Promise<void> {
    const content = (await deps.ensureContent()) ?? deps.fallback();
    const files = content.pictures ? shared.files : [];
    if (shared.files.length > 0 && files.length === 0) deps.refusePicture();
    if (!shared.title && !shared.body && files.length === 0) return;
    deps.open({ mode: composeModeFor('text', content), title: shared.title, body: shared.body, files });
}
