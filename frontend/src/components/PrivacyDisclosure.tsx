/**
 * The in-app privacy disclosure: what this app sends, to whom, and what the
 * server it talks to can and cannot see.
 *
 * Every sentence here is written against the code, and the file that a claim
 * rests on is named in the comment beside it, because a privacy notice that
 * overstates is worse than none. When one of those files changes, this text
 * is what has to change with it.
 *
 * Rendered in Settings → Privacy & Safety. The long-form statement, with the
 * same facts and their sources, is docs/PRIVACY.md in the source repository;
 * the link below resolves the repository from GET /source (AGPL §13), so a
 * fork's users land on the fork's copy.
 */
import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import { privacyDocUrl } from './privacyDisclosure.utils';

interface Row {
    label: string;
    text: string;
}

/** What leaves the device, and where it goes. Sources in the comments. */
const SENDS: Row[] = [
    {
        // frontend/package.json, Cargo.toml: no analytics/crash SDK;
        // capacitor.config.ts statsUrl: ''; deepFilter.ts / fileTransfer.ts
        // counters are read from the console and never posted.
        label: 'No analytics, no crash reporting',
        text: 'Nothing about you leaves this device except traffic to the server you signed in to. There is no analytics, crash-reporting or usage library in the app or the server, and the Android updater’s own reporting is switched off. The diagnostics you can read in the developer console (__pucaVoiceDiag, __pucaTransferDiag) stay there.',
    },
    {
        // api/appVersion.ts, components/UpdateGate.tsx, api/updateCheckBases.ts.
        label: 'Update checks',
        text: 'The desktop app asks your server for /app-version and, when you install an update, downloads the signed installer from the download host built into the app. Android asks your server’s /api/mobile-updates/check and fetches the signed bundle from the address the manifest names, on the same site as the server. A build can carry a fallback update host chosen by whoever built it, tried only when the server does not answer. The web app checks nothing — the server serves the current version.',
    },
    {
        // src/server_handlers.rs get_ice_config (Google STUN only with no
        // TURN_SERVER/STUN_SERVERS); api/iceConfig.ts (no built-in list).
        label: 'Calls',
        text: 'Your server tells the app which STUN and TURN servers to use, and those learn your IP address when a call is set up. A server with its own relay keeps that inside the operator’s infrastructure; a server with no relay configured names Google’s public STUN servers as a last resort. With “Hide my IP” on, everything goes through the operator’s relay, which then sees the relayed connections.',
    },
    {
        // frontend/capacitor.config.ts, src/wake/mod.rs (payload pinned by test).
        label: 'Wake signal (Android)',
        text: 'With background delivery on — and only if the app was built with Firebase credentials — Google’s Firebase Cloud Messaging may be sent a wake-up for this phone. Its entire body is the constant {"w":"1"}: Google learns that some install was pinged and when, never who, from whom, or what. Messages themselves travel only over the app’s own connection to your server.',
    },
    {
        // api/taskPlaces.ts, api/mobileLocation.ts, GeofenceEngine.java: no
        // network call in any of them.
        label: 'Location reminders (Android)',
        text: 'Places you save and the phone’s position stay on the phone. Nothing is uploaded or synced, and a reminder never names the task or the place.',
    },
    {
        // api/capacitorSink.ts, api/androidStorage.ts, SovereignFilesPlugin.java.
        label: 'All files access (Android)',
        text: 'Used only to write files over 100 MB that are sent to you into Downloads/Puca and, if you share a folder from this phone in My Devices, to read that folder. Nothing is scanned or uploaded on its own.',
    },
    {
        // api/linkPreview.ts (siteInitial, no fetch); settingsStore.ts
        // remoteImagesAllowed; components/MessageContent.tsx RemoteImage.
        label: 'Links and images',
        text: 'Link cards are built from the address itself; nothing is fetched. An image hosted on another site is shown as click-to-load unless you turn on “Load images from other sites”, because fetching it would hand that site your IP address and the moment you read the message. Attachments on your own server are never held back.',
    },
];

/** What the operator's server holds. Sources: docs/SECURITY_MODEL.md §3–4,
 *  §11; src/logtag.rs; src/retention.rs; handlers.rs upload_grace_days. */
const SERVER: Row[] = [
    {
        label: 'What it can see',
        text: 'Your username, display name, avatar and any e-mail you set; which servers you are in and your roles; your friends and blocks; who talks to whom and when — the timing and size of every message and attachment, presence, voice-channel joins; your IP address; the names of devices you enrol; and the ciphertext of everything below.',
    },
    {
        label: 'What it cannot read',
        text: 'The text of messages and DMs, attachment contents, task lists, your saved places, remote-control input, or voice, video and screen share in an encrypted call — which is every call from the Windows and Android apps and from Chromium browsers. Firefox, Safari and iOS cannot encrypt live media at all: there, a call is encrypted in transit but readable by the server, unless “Require encryption for calls” is on, which blocks the media instead. New installs have that on; an existing one keeps whatever it had, and Privacy & Safety shows which.',
    },
    {
        label: 'Logs and retention',
        text: 'The server log names accounts by id or a short digest, never by name or e-mail. A deleted account’s uploads are removed after 30 days by default; resolved moderation reports after 180 days and audit entries after a year, unless the operator configured other windows.',
    },
];

export function PrivacyDisclosure() {
    const [repository, setRepository] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        apiClient.get<{ repository?: string }>('/source')
            .then(r => { if (live && typeof r?.repository === 'string') setRepository(r.repository); })
            .catch(() => { /* the default repository link stands */ });
        return () => { live = false; };
    }, []);

    return (
        <>
            <h3>What Púca sends</h3>
            <div className="settings-card privacy-disclosure">
                {SENDS.map(row => (
                    <div className="settings-option" key={row.label}>
                        <div className="option-info">
                            <label>{row.label}</label>
                            <span className="option-hint">{row.text}</span>
                        </div>
                    </div>
                ))}
            </div>

            <h3>What your server can see</h3>
            <div className="settings-card privacy-disclosure">
                {SERVER.map(row => (
                    <div className="settings-option" key={row.label}>
                        <div className="option-info">
                            <label>{row.label}</label>
                            <span className="option-hint">{row.text}</span>
                        </div>
                    </div>
                ))}
                <p className="settings-hint">
                    The full statement, written to be checked against the code:{' '}
                    <a href={privacyDocUrl(repository)} target="_blank" rel="noopener noreferrer">
                        docs/PRIVACY.md
                    </a>
                    {' '}in the source repository.
                </p>
            </div>
        </>
    );
}
