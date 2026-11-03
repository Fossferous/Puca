/**
 * How the app asks and tells, instead of window.confirm, alert and prompt.
 *
 * ON THE DESKTOP A NATIVE DIALOG STOPS TOO MUCH. It takes the OS focus and stops
 * the page's JavaScript until someone answers it, and on this shell the page runs
 * things that cannot wait:
 *  - a released push-to-talk. The native hook only emits events; closing the
 *    microphone is page JavaScript (hotkeys.ts, VoicePanel's applyMicGate), so with
 *    a dialog open the mic stayed open after the key came up, and mute keys did
 *    nothing, for as long as the dialog was left there, perhaps behind a game;
 *  - relayed remote control. Input arrives in the page (api/devices/session.ts), so
 *    someone controlling this PC saw the dialog on the stream and could not click
 *    it, and a new connection got no answer;
 *  - every incoming frame.
 * So in the desktop shell (and only there: isTauri) a question is a dialog in the
 * page, components/AppDialogs.tsx, and the page goes on running behind it. Nothing
 * else changes: on the web and on Android these are the browser's own, as they have
 * always been, and neither has a global hook or hosts a remote session.
 *
 * WHICH ONE TO USE:
 *  - askConfirm / askText: a question from a press. Must be awaited, which is the
 *    whole difference: `if (!askConfirm(x)) return` is the shape that made every
 *    destructive action in the desktop app go ahead unasked for two months
 *    (src/tests/desktopScriptDialogs.test.ts). tsc -b does not catch it, so
 *    scripts/check-dialog-calls.mjs, part of `npm run lint`, does. The page goes on
 *    running while it waits, so what the answer acts on may have changed by then:
 *    read it again after the await.
 *  - tellUser: the answer to a press. Fire and forget. A desktop notice, because it
 *    usually lands after a network request with no bound, by which time the person
 *    may be anywhere; on the web and Android, an alert.
 *  - leaveNotice: something nobody just pressed anything for (a socket frame, a
 *    timer, the end of an upload). The notice on every platform, and it stays until
 *    dismissed: a toast with a lifetime expires unseen behind whatever they went to.
 *
 * Calling window.confirm, alert or prompt anywhere else fails the same check.
 *
 * No React here: this module is imported by code that has none. The dialogs render
 * in <AppDialogs/>, which main.tsx and notes/main.tsx mount beside the app; with no
 * host mounted (a harness, a test of one component) these fall back to the native
 * call, so nothing is ever silently unasked or untold.
 */
import { isTauri } from './platform';

export type AppQuestionKind = 'confirm' | 'text' | 'acknowledge';

export interface AppQuestion {
    id: number;
    kind: AppQuestionKind;
    message: string;
    /** The text field's first value (`text` only). */
    initial: string;
}

export interface AppNotice {
    id: number;
    message: string;
}

export interface AppDialogsState {
    /** Oldest first: one is on screen at a time, and the rest wait their turn. */
    questions: readonly AppQuestion[];
    notices: readonly AppNotice[];
}

/** Most notices on screen at once. A burst keeps the newest. */
const MAX_NOTICES = 5;
/** How long a `brief` notice stays. */
const BRIEF_NOTICE_MS = 5_000;

let nextId = 0;
let hosts = 0;
let state: AppDialogsState = { questions: [], notices: [] };
const answers = new Map<number, (value: boolean | string | null) => void>();
const listeners = new Set<() => void>();

function publish(next: AppDialogsState): void {
    state = next;
    for (const listener of listeners) listener();
}

export function subscribeAppDialogs(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function appDialogsState(): AppDialogsState {
    return state;
}

/** <AppDialogs/> on the screen. The last one leaving takes what is open with it. */
export function registerAppDialogsHost(): () => void {
    hosts++;
    return () => {
        hosts--;
        if (hosts === 0) closeAppDialogs();
    };
}

/** Is a question on the screen? For what hears keys ahead of it, on the window: the
 *  remote-control stage, the picture viewer, the calendar. */
export function appQuestionOpen(): boolean {
    return state.questions.length > 0;
}

/** What Cancel answers. */
const refusalOf = (kind: AppQuestionKind): false | null => (kind === 'text' ? null : false);

function askInPage(kind: AppQuestionKind, message: string, initial: string): Promise<boolean | string | null> {
    return new Promise(resolve => {
        // A second press of whatever asked this, before the first has an answer. Both
        // would go on to the same yes and do the thing twice, so the second is a no.
        if (state.questions.some(q => q.kind === kind && q.message === message)) {
            resolve(refusalOf(kind));
            return;
        }
        const id = ++nextId;
        answers.set(id, resolve);
        publish({ ...state, questions: [...state.questions, { id, kind, message, initial }] });
    });
}

/** A question answered. Asked twice (OK and a `cancel` event) it answers once. */
export function answerAppQuestion(id: number, value: boolean | string | null): void {
    const answer = answers.get(id);
    if (!answer) return;
    answers.delete(id);
    publish({ ...state, questions: state.questions.filter(q => q.id !== id) });
    answer(value);
}

export function dismissAppNotice(id: number): void {
    if (!state.notices.some(n => n.id === id)) return;
    publish({ ...state, notices: state.notices.filter(n => n.id !== id) });
}

function addNotice(message: string, brief: boolean): void {
    // The same words again add nothing: a refused frame can repeat.
    if (state.notices.some(n => n.message === message)) return;
    const id = ++nextId;
    publish({ ...state, notices: [...state.notices.slice(-(MAX_NOTICES - 1)), { id, message }] });
    if (brief) setTimeout(() => dismissAppNotice(id), BRIEF_NOTICE_MS);
}

/** Sign-out: nothing asked of the last session may be answered in the next one. */
export function closeAppDialogs(): void {
    const open = [...answers.keys()];
    for (const id of open) answerAppQuestion(id, null);
    if (state.notices.length > 0) publish({ ...state, notices: [] });
}

const inPageOnThisPlatform = (): boolean => hosts > 0 && isTauri();

/** window.confirm's question, with Cancel and OK. Await it. */
export async function askConfirm(message: string): Promise<boolean> {
    if (!inPageOnThisPlatform()) return window.confirm(message);
    return (await askInPage('confirm', message, '')) === true;
}

/** window.prompt's question: the text, or null for Cancel. Await it. */
export async function askText(message: string, initial = ''): Promise<string | null> {
    if (!inPageOnThisPlatform()) return window.prompt(message, initial);
    const answer = await askInPage('text', message, initial);
    return typeof answer === 'string' ? answer : null;
}

/** The answer to a press. `brief`: good news nobody needs to dismiss. */
export function tellUser(message: string, options?: { brief?: boolean }): void {
    if (inPageOnThisPlatform()) addNotice(message, options?.brief === true);
    else window.alert(message);
}

/** tellUser for the rare step that must not go on until it has been read. */
export async function tellUserAndWait(message: string): Promise<void> {
    if (inPageOnThisPlatform()) await askInPage('acknowledge', message, '');
    else window.alert(message);
}

/**
 * What nobody just pressed anything for. Stays until dismissed, on every platform.
 * `brief`: good news nobody needs to dismiss, and no reason to stop anyone anywhere.
 */
export function leaveNotice(message: string, options?: { brief?: boolean }): void {
    if (hosts > 0) addNotice(message, options?.brief === true);
    else window.alert(message);
}
