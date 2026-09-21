/**
 * The twelve card tints as a radio group of swatches. Shared chrome: Púca
 * Notes' editor and selection bar and Púca's own Tasks view all open this
 * one picker (styles/noteChrome.css dresses it for both).
 *
 * Colour is never the only carrier: each swatch is labelled by name, and
 * the card also carries the name in its title attribute (notesModel
 * NOTE_COLORS).
 */
import { CheckIcon } from '../Icons';
import { NOTE_COLORS, type NoteColor } from '../../notes/model/notesModel';

interface ColorPickerProps {
    value: NoteColor;
    onChange: (c: NoteColor) => void;
}

export function ColorPicker({ value, onChange }: ColorPickerProps) {
    return (
        <div role="radiogroup" aria-label="Note colour" className="notes-swatches">
            {NOTE_COLORS.map(c => (
                <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={c === value}
                    aria-label={c === 'default' ? 'No colour' : c}
                    title={c === 'default' ? 'No colour' : c}
                    className={`notes-swatch ${c === value ? 'selected' : ''}`}
                    data-color={c}
                    onClick={() => onChange(c)}
                >
                    {c === value && <CheckIcon size={14} />}
                </button>
            ))}
        </div>
    );
}
