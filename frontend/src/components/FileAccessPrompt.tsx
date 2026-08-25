/**
 * The dialog shown at the HOST when the controlling device asks to browse files.
 *
 * WHY THIS IS A SEPARATE QUESTION FROM "let this device be controlled".
 *
 * The first version of file transfer asked nothing. The agent answered any
 * filesystem request that arrived on the session's data channel with an
 * unjailed read or write of any absolute path — so someone allowed a look at
 * this screen could also read every file on the disk, and nothing here said so.
 *
 * Screen access and disk access are different powers and they get different
 * questions. This one also picks the FOLDER: the answer is not "yes", it is
 * "yes, this folder", and the agent confines every later request underneath it.
 *
 * Mounted globally alongside HostConsentPrompt, because the request arrives
 * from the session layer. Registers with the `fileAccessConsent` bridge, which
 * denies when nothing is mounted — absence is a closed door, not a hang.
 */
import { useEffect, useState } from 'react';
import { setFileAccessHandler, type FileAccessRequest } from '../api/devices/fileAccessConsent';
import { isTauri, isMobile } from '../api/platform';
import './HostConsentPrompt.css';

interface Folder {
    label: string;
    path: string;
}

export function FileAccessPrompt() {
    const [request, setRequest] = useState<FileAccessRequest | null>(null);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [chosen, setChosen] = useState('');
    /** MOBILE: all-files access is a Settings toggle, not a runtime dialog.
     *  When it is missing, this prompt can only explain and Deny — sending
     *  the user to system Settings mid-prompt would let the 30s consent
     *  deadline auto-deny behind their back. The grant lives in Settings →
     *  Devices, done once, ahead of time. */
    const [mobileBlocked, setMobileBlocked] = useState<string | null>(null);

    useEffect(() => setFileAccessHandler(req => {
        setFolders([]);
        setChosen('');
        setMobileBlocked(null);
        setRequest(req);
    }), []);

    // Offer real directories rather than making someone type an absolute path
    // from memory. Loaded when the dialog opens, not at mount, so the app does
    // not touch the filesystem for a question nobody asked.
    useEffect(() => {
        if (!request) return;
        let live = true;
        void (async () => {
            try {
                if (isTauri()) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    const list = await invoke<Folder[]>('shareable_folders');
                    if (!live) return;
                    setFolders(list);
                    setChosen(list[0]?.path ?? '');
                } else if (isMobile()) {
                    const { shareableRoots, allFilesAccessStatus } = await import('../api/devices/hostCapacitor');
                    const status = await allFilesAccessStatus();
                    if (!live) return;
                    if (!status || !status.hasAllFilesAccess) {
                        setMobileBlocked(
                            'File sharing is not enabled on this phone yet. Deny this, '
                            + 'then turn it on in the Devices view — the Devices button in '
                            + 'the left rail, under This device — and ask again.',
                        );
                        return;
                    }
                    const list = await shareableRoots();
                    if (!live) return;
                    if (list.length === 0) {
                        // No free-text field on mobile, so an empty list would
                        // leave a dialog with a "Folder to share" label, no
                        // control under it, and a permanently disabled Allow —
                        // a question with no way to answer yes and no reason
                        // given. Say what happened; Deny still works.
                        setMobileBlocked(
                            'No shareable folders were found on this phone, so there is '
                            + 'nothing to offer. Deny this and check File sharing in the '
                            + 'Devices view — the Devices button in the left rail, under '
                            + 'This device.',
                        );
                        return;
                    }
                    setFolders(list);
                    setChosen(list[0]?.path ?? '');
                }
            } catch {
                // Leave the list empty; on desktop the free-text field below
                // still works and the agent validates whatever is typed.
            }
        })();
        return () => { live = false; };
    }, [request]);

    if (!request) return null;

    const answer = (value: { root: string } | null) => {
        request.resolve(value);
        setRequest(null);
    };

    const trimmed = chosen.trim();

    return (
        <div
            className="host-consent-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Allow file access"
            onKeyDown={e => {
                // Escape DENIES. Something is waiting on an answer and "no
                // answer" is not one of the options.
                if (e.key === 'Escape') answer(null);
            }}
        >
            <div className="host-consent">
                <h2>Let this device browse your files?</h2>
                <p className="host-consent-body">
                    <strong>{request.peerDevice}</strong> is asking to read and write files
                    on this {isMobile() ? 'phone' : 'computer'}.
                    {!isMobile() && ' It can already see this screen — this is a separate, bigger ask.'}
                </p>

                {mobileBlocked ? (
                    <p className="host-consent-hint">{mobileBlocked}</p>
                ) : (
                    <label className="host-consent-monitor">
                        Folder to share
                        {folders.length > 0 && (
                            <select
                                value={folders.some(f => f.path === chosen) ? chosen : ''}
                                onChange={e => setChosen(e.target.value)}
                            >
                                {folders.map(f => (
                                    <option key={f.path} value={f.path}>{f.label} — {f.path}</option>
                                ))}
                                {/* No free-typed paths on a phone: a fixed list
                                    cannot be talked into an app-private path,
                                    and nobody wants to type /storage/… on a
                                    phone keyboard. */}
                                {!isMobile() && <option value="">Somewhere else…</option>}
                            </select>
                        )}
                        {!isMobile() && (
                            <input
                                type="text"
                                value={chosen}
                                placeholder="Full path to a folder"
                                onChange={e => setChosen(e.target.value)}
                            />
                        )}
                    </label>
                )}

                {!mobileBlocked && (
                    <p className="host-consent-hint">
                        They will be able to read, change and add files in this folder and
                        everything inside it — and nowhere else. Access ends when the session
                        does.
                    </p>
                )}

                <div className="host-consent-actions">
                    {/* Focus DENY. This dialog appears unprompted, so a Space or
                        Enter aimed at something else must not hand over a folder. */}
                    <button
                        type="button"
                        className="host-consent-deny"
                        autoFocus
                        onClick={() => answer(null)}
                    >
                        Deny
                    </button>
                    <button
                        type="button"
                        className="host-consent-allow"
                        disabled={!trimmed}
                        onClick={() => answer({ root: trimmed })}
                    >
                        Share this folder
                    </button>
                </div>
            </div>
        </div>
    );
}
