/**
 * The dialog a CONTROLLER sees when the machine it is connecting to is armed
 * for unattended access, or is locked and reached through its sign-in-screen
 * service (then it asks for THAT screen's passphrase, by name).
 *
 * Mounted globally beside DeviceStage, because the request arrives from the
 * session layer at connect time and there may be no device UI on screen yet.
 * Registers itself with the `unattendedPrompt` bridge, which refuses safely when
 * nothing is mounted — so this component's absence is a closed door, not a hang.
 *
 * The passphrase is held in local state for exactly as long as it takes to
 * answer, then cleared. It is never stored, never cached between sessions, and
 * never sent anywhere but into the signing call — remembering it would defeat
 * the point of a secret separate from the account password.
 */
import { useEffect, useRef, useState } from 'react';
import {
    setUnattendedPassphraseHandler,
    type PassphraseRequest,
} from '../api/devices/unattendedPrompt';
import './UnattendedPassphrasePrompt.css';

export function UnattendedPassphrasePrompt() {
    const [request, setRequest] = useState<PassphraseRequest | null>(null);
    const [value, setValue] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => setUnattendedPassphraseHandler(setRequest), []);

    // Focus on appear: this dialog interrupts a connection attempt, so the
    // cursor should already be where the user must type.
    useEffect(() => {
        if (request) inputRef.current?.focus();
    }, [request]);

    if (!request) return null;

    const answer = (pass: string | null) => {
        request.resolve(pass);
        setRequest(null);
        setValue('');
    };

    // WHICH passphrase, by the name of the setting it was set under on that
    // PC (Devices, This device). A locked PC answers as its lock-screen
    // service, which checks "Passphrase for the sign-in screen", its own
    // record: asking it for "the unattended passphrase" sent a person whose
    // two differ to type the wrong one, every time.
    const pc = request.peerName ?? 'This device';
    const title = request.signIn ? 'Passphrase for the sign-in screen' : 'Unattended passphrase';

    return (
        <div
            className="ua-prompt-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onKeyDown={e => {
                // Escape refuses rather than dismissing silently: the caller is
                // waiting on an answer, and "no answer" is not one of its
                // options.
                if (e.key === 'Escape') answer(null);
            }}
        >
            <div className="ua-prompt">
                <h2>{title}</h2>
                {request.signIn ? (
                    <p className="ua-prompt-body">
                        {pc} is locked or at its sign-in screen, so it needs the passphrase set
                        for that screen on it (Devices, This device: Passphrase for the sign-in
                        screen) before it will let you in. That is not its unattended access
                        passphrase, unless you chose the same words for both, and it is not your
                        Windows password or your account password.
                    </p>
                ) : (
                    <p className="ua-prompt-body">
                        {pc} is set up for unattended access, so it needs its passphrase (the one
                        set under Unattended access on it) before it will let you in. This is not
                        your account password.
                    </p>
                )}
                <form
                    onSubmit={e => {
                        e.preventDefault();
                        answer(value);
                    }}
                >
                    <input
                        ref={inputRef}
                        type="password"
                        autoComplete="off"
                        placeholder={title}
                        aria-label={title}
                        value={value}
                        onChange={e => setValue(e.target.value)}
                    />
                    <div className="ua-prompt-actions">
                        <button type="button" className="ua-prompt-btn" onClick={() => answer(null)}>
                            Cancel
                        </button>
                        <button type="submit" className="ua-prompt-btn ua-prompt-btn-primary" disabled={!value}>
                            Connect
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
