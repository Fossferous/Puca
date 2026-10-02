/**
 * The account menu's update rows — the Notes Android app only (AccountMenu
 * renders this when NATIVE): which version is running, "Check for updates"
 * (re-runs NotesUpdateGate's check through the model's runner), and, when
 * the server says a newer APK exists, a way to the download page. The
 * Version row names the installed APK too: it is what the "new app" strip
 * and that download row are about, and no OTA can change it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { currentAppVersion, installedNativeVersion } from '../../api/appVersion';
import { DownloadIcon, RefreshIcon } from '../../components/Icons';
import {
    checkNotesForUpdates, describeOutcome, downloadPage, getNativePrompt, notesVersionLabel, subscribeNativePrompt,
} from '../model/notesUpdate';

export function NotesUpdateMenu() {
    const [version, setVersion] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const prompt = useSyncExternalStore(subscribeNativePrompt, getNativePrompt, getNativePrompt);

    useEffect(() => {
        let live = true;
        (async () => notesVersionLabel(await currentAppVersion(), await installedNativeVersion()))().then(
            label => { if (live) setVersion(label); },
            () => { /* the row just stays blank */ },
        );
        return () => { live = false; };
    }, []);

    const check = async () => {
        setChecking(true);
        setResult(null);
        try {
            const outcome = await checkNotesForUpdates();
            // The prompt as this check left it, not as the last render saw it.
            setResult(describeOutcome(outcome, getNativePrompt()));
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
