/**
 * The open note's "Add" button, in its footer — on a phone only.
 *
 * On a phone the note's own tools (Add photo, Add file, Take photo, Draw,
 * Voice note, and Show/Hide checkboxes) used to sit as a wrapping block of
 * pill buttons between the note's text and its items: about 250px, which
 * with the title row put the first item halfway down the screen and, with
 * the keyboard up, pushed it off it altogether. Google Keep keeps the same
 * tools behind a "+" in the bottom bar, and so does this: one 44px button in
 * the footer, the same actions in a menu (the shared Popover, which a coarse
 * pointer pins to the bottom of the screen). Nothing is gone — every action
 * runs the very handler its pill ran (NoteContentSection owns them).
 *
 * The wide screen keeps the pills: a modal there has the room, and they are
 * one click instead of two.
 *
 * The file inputs live HERE, not in the menu: the menu closes as the choice
 * is made, and an input unmounted with it would never deliver its files.
 */
import { useRef, useState } from 'react';
import { CameraIcon, CheckboxIcon, FileTextIcon, ImageIcon, MicIcon, PaperclipIcon, PencilIcon, PlusIcon } from '../../components/Icons';
import { Popover } from '../../components/notes/Popover';

interface Props {
    /** Pictures and files picked, as NoteImages' picker hands them on. */
    onAddPhotos?: (files: File[]) => void;
    showCamera?: boolean;
    onDraw?: () => void;
    onRecord?: () => void;
    onShowCheckboxes?: () => void;
    onHideCheckboxes?: () => void;
    /** A conversion is running: neither may start again. */
    converting?: boolean;
}

export function NoteAddMenu({ onAddPhotos, showCamera, onDraw, onRecord, onShowCheckboxes, onHideCheckboxes, converting = false }: Props) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const pickRef = useRef<HTMLInputElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const cameraRef = useRef<HTMLInputElement>(null);
    if (!onAddPhotos && !onDraw && !onRecord && !onShowCheckboxes && !onHideCheckboxes) return null;
    const close = () => setAnchor(null);
    /** Close the menu, then act — inside the same tap, so a file picker
     *  still has the user activation it needs to open. */
    const run = (act: () => void) => () => { close(); act(); };
    const pick = (which: 'photo' | 'file' | 'camera') => () => {
        close();
        (which === 'photo' ? pickRef : which === 'file' ? fileRef : cameraRef).current?.click();
    };
    const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length > 0) onAddPhotos?.(files);
    };
    return (
        <>
            <button
                type="button"
                className="notes-iconbtn notes-add-menu-btn"
                aria-label="Add to note"
                title="Add to note"
                aria-haspopup="menu"
                aria-expanded={anchor !== null}
                onClick={e => setAnchor(e.currentTarget)}
            >
                <PlusIcon />
            </button>
            {onAddPhotos && (
                <>
                    <input ref={pickRef} type="file" accept="image/*" multiple hidden onChange={onPicked} data-testid="nam-pick" />
                    <input ref={fileRef} type="file" multiple hidden onChange={onPicked} data-testid="nam-pick-file" />
                    {showCamera && <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPicked} />}
                </>
            )}
            {anchor && (
                <Popover anchor={anchor} onClose={close} label="Add to note">
                    <div className="notes-list-actions" role="menu">
                        {onAddPhotos && (
                            <>
                                <button type="button" role="menuitem" onClick={pick('photo')}><ImageIcon /> Add photo</button>
                                <button type="button" role="menuitem" onClick={pick('file')}><PaperclipIcon /> Add file</button>
                                {showCamera && (
                                    <button type="button" role="menuitem" onClick={pick('camera')}><CameraIcon /> Take photo</button>
                                )}
                            </>
                        )}
                        {onDraw && <button type="button" role="menuitem" onClick={run(onDraw)}><PencilIcon /> Draw</button>}
                        {onRecord && <button type="button" role="menuitem" onClick={run(onRecord)}><MicIcon /> Voice note</button>}
                        {onShowCheckboxes && (
                            <button type="button" role="menuitem" disabled={converting} onClick={run(onShowCheckboxes)}><CheckboxIcon /> Show checkboxes</button>
                        )}
                        {onHideCheckboxes && (
                            <button type="button" role="menuitem" disabled={converting} onClick={run(onHideCheckboxes)}><FileTextIcon /> Hide checkboxes</button>
                        )}
                    </div>
                </Popover>
            )}
        </>
    );
}
