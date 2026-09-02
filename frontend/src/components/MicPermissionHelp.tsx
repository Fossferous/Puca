/**
 * The "Microphone Access Blocked" dialog, with instructions for the platform
 * the user is actually on.
 *
 * Extracted from VoicePanel so the three arms can be tested. The Android app
 * used to fall into the browser arm — "click the lock icon in your address
 * bar" — which in a WebView with no address bar was a dead end, and its only
 * other button re-requested a permission Android refuses to prompt for again
 * after "Don't allow". The Android arm names the real path and offers the
 * deep link to it; on an APK without that method the button says so instead
 * of silently doing nothing.
 */
import { useState } from 'react';
import { LockIcon, MicIcon } from './Icons';

export type MicHelpPlatform = 'tauri' | 'android' | 'web';

export interface MicPermissionHelpProps {
    platform: MicHelpPlatform;
    onRetry: () => void;
    onDismiss: () => void;
    /** Desktop only: wipe WebView2's permission store and relaunch. */
    onResetDesktop?: () => void;
    /** Android only: resolves false when the APK cannot open its settings page. */
    onOpenAndroidSettings?: () => Promise<boolean>;
}

export function MicPermissionHelp({ platform, onRetry, onDismiss, onResetDesktop, onOpenAndroidSettings }: MicPermissionHelpProps) {
    const [settingsFailed, setSettingsFailed] = useState(false);

    return (
        <div className="permission-help-overlay">
            <div className="permission-help-modal" role="dialog" aria-labelledby="mic-help-title">
                <h3 id="mic-help-title"><MicIcon /> Microphone Access Blocked</h3>
                <p>You'll need to allow microphone access to join voice chat.</p>

                <div className="permission-instructions">
                    <p><strong>To fix this:</strong></p>
                    {platform === 'tauri' ? (
                        // Desktop app — Windows instructions (Tauri uses Edge WebView2)
                        <ol>
                            <li>Open <strong>Windows Settings</strong> (Win + I)</li>
                            <li>Go to <strong>Privacy &amp; Security → Microphone</strong></li>
                            <li>Make sure <strong>"Microphone access"</strong> is ON</li>
                            <li>Make sure <strong>"Let desktop apps access your microphone"</strong> is ON</li>
                            <li>If still blocked, check <strong>Microsoft Edge</strong> in the app list (Púca uses Edge WebView)</li>
                            <li>Restart Púca and click "Try Again"</li>
                        </ol>
                    ) : platform === 'android' ? (
                        // Android app — there is no site-permission menu; the only
                        // remedy after "Don't allow" is the app's own settings page.
                        <ol>
                            <li>Open <strong>Android Settings → Apps → Púca → Permissions</strong></li>
                            <li>Tap <strong>Microphone</strong> and choose <strong>Allow only while using the app</strong></li>
                            <li>Come back here and tap "Try Again"</li>
                        </ol>
                    ) : (
                        // Browser — standard instructions
                        <ol>
                            <li>Click the <span className="icon-hint"><LockIcon /></span> icon in your browser's address bar</li>
                            <li>Find "Microphone" in the permissions list</li>
                            <li>Change it from "Block" to "Allow"</li>
                            <li>Refresh the page or click "Try Again" below</li>
                        </ol>
                    )}
                    {platform === 'android' && settingsFailed && (
                        <p className="permission-note">
                            This phone would not open the settings page from here — open Android
                            Settings by hand and follow the steps above.
                        </p>
                    )}
                </div>

                <div className="permission-help-buttons">
                    <button className="permission-retry-btn" onClick={onRetry}>
                        Try Again
                    </button>
                    {platform === 'android' && onOpenAndroidSettings && !settingsFailed && (
                        <button
                            className="permission-reset-btn"
                            onClick={() => {
                                void onOpenAndroidSettings().then(ok => { if (!ok) setSettingsFailed(true); });
                            }}
                        >
                            Open app settings
                        </button>
                    )}
                    {platform === 'tauri' && onResetDesktop && (
                        <button className="permission-reset-btn" onClick={onResetDesktop}>
                            Reset Permissions &amp; Restart
                        </button>
                    )}
                    <button className="permission-dismiss-btn" onClick={onDismiss}>
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    );
}
