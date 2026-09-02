/**
 * Settings → My Account → "Your data": export the account as one JSON file.
 *
 * The flow behind the button is api/accountExport.ts (prove the password,
 * fetch the server's rows, open what this identity can, save). This is the
 * UI: an armed form like Account Removal — the password is asked for here
 * because the server refuses the export on a bare bearer token — and an
 * honest result line: how many sealed items this device could actually read.
 */
import { useState } from 'react';
import { runAccountExport, resultSummary, type ExportPhase } from '../api/accountExport';

function phaseLabel(p: ExportPhase): string {
    switch (p.phase) {
        case 'proving': return 'Confirming your password and fetching your data…';
        case 'opening': return `Decrypting on this device… ${p.done} of ${p.total}`;
        case 'saving': return 'Saving…';
    }
}

export function AccountExportCard({ username }: { username: string }) {
    const [armed, setArmed] = useState(false);
    const [password, setPassword] = useState('');
    const [phase, setPhase] = useState<ExportPhase | null>(null);
    const [summary, setSummary] = useState<string | null>(null);
    const [error, setError] = useState('');
    const working = phase !== null;

    const run = async () => {
        setError('');
        setSummary(null);
        setPhase({ phase: 'proving' });
        try {
            const { saved, stats } = await runAccountExport(username, password, setPhase);
            if (saved.cancelled) {
                setSummary('Cancelled — nothing was written.');
            } else {
                setSummary(resultSummary(saved.where, saved.onDisk, stats));
            }
            setPassword('');
            setArmed(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'The export failed.');
        } finally {
            setPhase(null);
        }
    };

    return (
        <>
            <h3>Your data</h3>
            <div className="settings-card">
                <p className="settings-hint">
                    Export a copy of your account as one JSON file: your profile, memberships,
                    friends and blocks, the messages and DMs you wrote, your tasks, the list of
                    files you uploaded, your devices and sessions. Messages are decrypted on this
                    device wherever it holds the key, so the file is readable plaintext — keep it
                    somewhere safe. Other people’s messages are not included; they are theirs.
                </p>
                {!armed ? (
                    <button className="secondary-btn" onClick={() => { setSummary(null); setArmed(true); }} disabled={working}>
                        Export my data
                    </button>
                ) : (
                    <div className="delete-account-form">
                        <input
                            type="password"
                            placeholder="Current password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            autoComplete="current-password"
                            disabled={working}
                            aria-label="Current password"
                        />
                        <div className="settings-actions">
                            <button
                                className="secondary-btn"
                                disabled={working}
                                onClick={() => { setArmed(false); setPassword(''); setError(''); }}
                            >
                                Cancel
                            </button>
                            <button
                                className="secondary-btn"
                                disabled={working || !password}
                                onClick={() => { void run(); }}
                            >
                                {phase ? phaseLabel(phase) : 'Export'}
                            </button>
                        </div>
                    </div>
                )}
                {error && <div className="password-change-error" role="alert">{error}</div>}
                {summary && <p className="settings-hint" role="status">{summary}</p>}
            </div>
        </>
    );
}
