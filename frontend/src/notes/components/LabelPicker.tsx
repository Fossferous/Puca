/**
 * Toggle a note's labels among every label in use, or type a new one.
 * Labels are sealed to the account and sync (notesPrefsSync.ts) — the hint
 * says so, once, where the user is about to rely on them.
 */
import { useState } from 'react';
import { PlusIcon } from '../../components/Icons';
import { MAX_LABELS_PER_NOTE, MAX_LABEL_LENGTH, normalizeLabel } from '../model/notesModel';

interface LabelPickerProps {
    /** Every label in use across the account's notes (rail order). */
    all: string[];
    /** This note's labels. */
    value: string[];
    onChange: (labels: string[]) => void;
}

export function LabelPicker({ all, value, onChange }: LabelPickerProps) {
    const [draft, setDraft] = useState('');
    const has = (l: string) => value.some(v => v.toLocaleLowerCase() === l.toLocaleLowerCase());
    const toggle = (l: string) => {
        if (has(l)) onChange(value.filter(v => v.toLocaleLowerCase() !== l.toLocaleLowerCase()));
        else if (value.length < MAX_LABELS_PER_NOTE) onChange([...value, l]);
    };
    const add = () => {
        const l = normalizeLabel(draft);
        if (!l) return;
        if (!has(l)) toggle(l);
        setDraft('');
    };
    // Labels this note has that are not (yet) in the union — a label typed a
    // second ago — still need a row to untick.
    const options = [...all];
    for (const v of value) if (!options.some(o => o.toLocaleLowerCase() === v.toLocaleLowerCase())) options.push(v);
    const full = value.length >= MAX_LABELS_PER_NOTE;

    return (
        <div>
            <h4>Labels</h4>
            {options.length === 0 ? (
                <div className="notes-labels-hint">No labels yet — add one below.</div>
            ) : (
                <div className="notes-labels-list">
                    {options.map(l => (
                        <label key={l}>
                            <input
                                type="checkbox"
                                checked={has(l)}
                                disabled={!has(l) && full}
                                onChange={() => toggle(l)}
                            />
                            <span>{l}</span>
                        </label>
                    ))}
                </div>
            )}
            <form className="notes-labels-new" onSubmit={e => { e.preventDefault(); add(); }}>
                <input
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder="New label"
                    maxLength={MAX_LABEL_LENGTH}
                    aria-label="New label"
                    disabled={full}
                />
                <button type="submit" className="notes-iconbtn small" aria-label="Add label" title="Add label" disabled={full || !normalizeLabel(draft)}>
                    <PlusIcon />
                </button>
            </form>
            <div className="notes-labels-hint">
                {full ? `Up to ${MAX_LABELS_PER_NOTE} labels per note.` : 'Labels and colours are encrypted on this device before they sync to your other devices.'}
            </div>
        </div>
    );
}
