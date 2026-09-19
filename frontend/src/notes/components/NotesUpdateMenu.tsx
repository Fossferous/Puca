/**
 * The account menu's update rows — the Notes Android app only (AccountMenu
 * renders this when NATIVE): which version is running, "Check for updates"
 * (re-runs NotesUpdateGate's check through the model's runner), and, when
 * the server says a newer APK exists, a way to the download page.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { currentAppVersion } from '../../api/appVersion';
import { DownloadIcon, RefreshIcon } from '../../components/Icons';
import { checkNotesForUpdates, describeOutcome, downloadPage, getNativePrompt, subscribeNativePrompt } from '../model/notesUpdate';

export function NotesUpdateMenu() {
    const [version, setVersion] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const prompt = useSyncExternalStore(subscribeNativePrompt, getNativePrompt, getNativePrompt);

    useEffect(() => {
        let live = true;
        currentAppVersion().then(v => { if (live) setVersion(v); }, () => { /* the row just stays blank */ });
        return () => { live = false; };
    }, []);

    const check = async () => {
        setChecking(true);
        setResult(null);
        try {
            setResult(describeOutcome(await checkNotesForUpdates()));
        } finally {
            setChecking(false);
        }
    };

    return (
        <>
            <div className="notes-menu-row">
                <span>Version</span>
                <span data-testid="notes-app-version">{version ?? '…'}</span>
            </div>
            <button type="button" className="notes-menu-item" onClick={check} disabled={checking}>
                <RefreshIcon /> {checking ? 'Checking for updates…' : 'Check for updates'}
            </button>
            {result && <div className="notes-menu-row" role="status">{result}</div>}
            {prompt?.downloadUrl && (
                <button type="button" className="notes-menu-item" onClick={() => downloadPage.open(prompt.downloadUrl!)}>
                    <DownloadIcon /> {prompt.kind === 'required' ? `Install Púca Notes ${prompt.need}` : `Get Púca Notes ${prompt.version}`}
                </button>
            )}
        </>
    );
}
