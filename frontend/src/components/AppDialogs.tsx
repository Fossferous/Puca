/**
 * The questions and notices of api/appDialogs.ts, in the page. Why they are not
 * native dialogs, and when each is used, is in that file's header.
 *
 * A QUESTION IS A MODAL <dialog>, for the top layer: above every z-index in the app
 * and above an element in fullscreen, with everything behind it inert, so no list of
 * the app's modals has to be kept in step with it. The page goes on running.
 *
 * A NOTICE takes no focus and blocks nothing but the corner it sits in, because it
 * can land while the person is typing, or long after they pressed anything.
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import {
    answerAppQuestion,
    appDialogsState,
    dismissAppNotice,
    registerAppDialogsHost,
    subscribeAppDialogs,
    type AppQuestion,
} from '../api/appDialogs';
import { CloseIcon } from './Icons';
import './AppDialogs.css';

/**
 * A press in the question goes no further than the question. The page behind it is
 * inert to the person, not to its own listeners, and a press here is a press outside
 * everything: Cancel on "Discard this note?" would make the note's composer save and
 * close (QuickAdd's outside press), and close the menu or popup that asked.
 */
const staysInTheQuestion = (e: SyntheticEvent) => e.stopPropagation();
const PRESS_STAYS_IN = {
    onPointerDown: staysInTheQuestion,
    onPointerUp: staysInTheQuestion,
    onMouseDown: staysInTheQuestion,
    onMouseUp: staysInTheQuestion,
    onTouchStart: staysInTheQuestion,
    onTouchEnd: staysInTheQuestion,
    onClick: staysInTheQuestion,
    onContextMenu: staysInTheQuestion,
};

function Question({ question }: { question: AppQuestion }) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const firstControlRef = useRef<HTMLElement | null>(null);
    const [text, setText] = useState(question.initial);
    const messageId = useId();
    const { id, kind } = question;

    /** Cancel, Escape: what window.confirm and window.prompt answer for them. */
    const refuse = useCallback(() => {
        answerAppQuestion(id, kind === 'text' ? null : false);
    }, [id, kind]);

    useEffect(() => {
        const dialog = dialogRef.current!;
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        // jsdom has no showModal: the same content, not in a top layer.
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        const first = firstControlRef.current;
        first?.focus();
        if (first instanceof HTMLInputElement) first.select();
        return () => {
            if (typeof dialog.close === 'function') dialog.close();
            before?.focus();
        };
    }, []);

    useEffect(() => {
        // The window's capture phase, so no key goes on to anything behind the
        // question: the native dialog never let the page see one. What was registered
        // here first still hears it, which is what is wanted: hotkeys.ts, so a mute key
        // still mutes and a released push-to-talk closes, and remote control's revoke
        // (api/remoteControl.ts). Stopping an event takes nothing from the browser's own
        // handling of it, so Tab, typing and Enter on a button all still work.
        let keyWentDownHere = false;
        const onKeyDown = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                // Held from whatever this question was asked in answer to, it is no answer.
                if (!e.repeat) refuse();
                return;
            }
            if (!e.repeat) {
                keyWentDownHere = true;
                return;
            }
            // A key still held from what opened this question, the Enter that pressed
            // a focused Delete button, repeats onto the OK that now has the focus.
            // That is not an answer.
            if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
        };
        // THE ENTER THAT ASKED. A key is a keydown and then a keypress, and the keypress
        // goes to whatever has the focus by then. Enter in a field whose keydown handler
        // asks (TaskTree's commit) opens this and focuses OK in between, so its keypress
        // would press OK: the question answering itself yes, with nobody seeing it.
        const onKeyPress = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (!keyWentDownHere) e.preventDefault();
        };
        const onKeyUp = (e: KeyboardEvent) => e.stopPropagation();
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keypress', onKeyPress, true);
        window.addEventListener('keyup', onKeyUp, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keypress', onKeyPress, true);
            window.removeEventListener('keyup', onKeyUp, true);
        };
    }, [refuse]);

    const accept = () => answerAppQuestion(id, kind === 'text' ? text : true);

    return (
        <dialog
            ref={dialogRef}
            className="app-question"
            role="alertdialog"
            aria-describedby={messageId}
            onCancel={e => { e.preventDefault(); refuse(); }}
            {...PRESS_STAYS_IN}
        >
            <form onSubmit={e => { e.preventDefault(); accept(); }}>
                <p id={messageId} className="app-question-message">{question.message}</p>
                {kind === 'text' && (
                    <input
                        ref={el => { firstControlRef.current = el; }}
                        className="app-question-input"
                        type="text"
                        aria-labelledby={messageId}
                        value={text}
                        onChange={e => setText(e.target.value)}
                    />
                )}
                <div className="app-question-actions">
                    {kind !== 'acknowledge' && (
                        <button type="button" className="app-question-btn" onClick={refuse}>Cancel</button>
                    )}
                    <button
                        ref={el => { if (kind !== 'text') firstControlRef.current = el; }}
                        type="submit"
                        className="app-question-btn app-question-ok"
                        // The second click of a double click, on what just opened
                        // under the pointer, is no more an answer than a held key.
                        onClick={e => { if (e.detail > 1) e.preventDefault(); }}
                    >
                        OK
                    </button>
                </div>
            </form>
        </dialog>
    );
}

export function AppDialogs() {
    const { questions, notices } = useSyncExternalStore(subscribeAppDialogs, appDialogsState);
    useEffect(() => registerAppDialogsHost(), []);
    const question = questions[0];
    return (
        <>
            {question && <Question key={question.id} question={question} />}
            {notices.length > 0 && createPortal(
                <div className="app-notices">
                    {notices.map(notice => (
                        <div key={notice.id} className="app-notice" role="alert">
                            <span className="app-notice-text">{notice.message}</span>
                            <button
                                type="button"
                                className="app-notice-close"
                                aria-label="Dismiss"
                                onClick={() => dismissAppNotice(notice.id)}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    ))}
                </div>,
                document.body,
            )}
        </>
    );
}
