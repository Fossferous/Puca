/**
 * The twelve card tints as a radio group of swatches. Colour is never the
 * only carrier: each swatch is labelled by name, and the card also carries
 * the name in its title attribute (keepModel NOTE_COLORS).
 */
import { CheckIcon } from '../../components/Icons';
import { NOTE_COLORS, type NoteColor } from '../model/keepModel';

interface ColorPickerProps {
    value: NoteColor;
    onChange: (c: NoteColor) => void;
}

export function ColorPicker({ value, onChange }: ColorPickerProps) {
    return (
        <div role="radiogroup" aria-label="Note colour" className="keep-swatches">
            {NOTE_COLORS.map(c => (
                <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={c === value}
                    aria-label={c === 'default' ? 'No colour' : c}
                    title={c === 'default' ? 'No colour' : c}
                    className={`keep-swatch ${c === value ? 'selected' : ''}`}
                    data-color={c}
                    onClick={() => onChange(c)}
                >
                    {c === value && <CheckIcon size={14} />}
                </button>
            ))}
        </div>
    );
}
