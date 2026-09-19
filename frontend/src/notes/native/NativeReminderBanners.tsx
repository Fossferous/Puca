/**
 * The Reminders view's honest status lines in the Android app: whether a due
 * item will actually notify, and what stands in the way when it will not.
 * Renders nothing in the browser (RemindersView keeps its own browser banner
 * there) or in an APK without the NotesNative plugin.
 *
 * Re-reads the status whenever the app comes back to the foreground, because
 * every fix here happens in Android's own Settings screens.
 */
import { useCallback, useEffect, useState } from 'react';
import { BellIcon, ClockIcon, WarningIcon } from '../../components/Icons';
import {
    nativeBatteryStatus, nativeExactAlarmStatus, nativeNotificationStatus, notesNativeAvailable,
    openNativeExactAlarmSettings, openNativeNotificationSettings, requestNativeBatteryExemption,
    requestNativeNotificationPermission, type NotesNotificationStatus,
} from './notesNative';

interface Status {
    notif: NotesNotificationStatus | null;
    exact: boolean | null;
    battery: boolean | null;
}

async function readStatus(): Promise<Status> {
    const [notif, exact, battery] = await Promise.all([
        nativeNotificationStatus(), nativeExactAlarmStatus(), nativeBatteryStatus(),
    ]);
    return { notif, exact: exact?.exact ?? null, battery: battery?.ignoring ?? null };
}

export function NativeReminderBanners() {
    const [s, setS] = useState<Status | null>(null);
    // Set once an Enable tap came back still ungranted: after two denials
    // Android makes the request a silent no-op, and only Settings can help.
    const [asked, setAsked] = useState(false);
    const refresh = useCallback(() => { void readStatus().then(setS); }, []);
    const enable = useCallback(() => {
        void requestNativeNotificationPermission().then(granted => {
            if (!granted) setAsked(true);
            refresh();
        });
    }, [refresh]);

    useEffect(() => {
        if (!notesNativeAvailable()) return;
        let live = true;
        const read = () => { void readStatus().then(st => { if (live) setS(st); }); };
        read();
        const onVisible = () => { if (document.visibilityState === 'visible') read(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { live = false; document.removeEventListener('visibilitychange', onVisible); };
    }, []);

    if (!s || !s.notif) return null;
    const { notif } = s;
    // On 13+ an ungranted permission also reads as "notifications disabled"
    // (blocked), so ASKABLE is decided by needsRequest alone; blocked matters
    // once the permission is granted (the app or its channel switched off).
    const askable = notif.needsRequest && !asked;
    const off = !askable && (!notif.granted || notif.blocked);
    const working = notif.granted && !notif.blocked;
    return (
        <>
            {askable && (
                <div className="notes-status offline" data-native-banner="enable">
                    <BellIcon /> Get a notification when an item comes due, even when Notes is closed.
                    <button type="button" onClick={enable}>Enable</button>
                </div>
            )}
            {off && (
                <div className="notes-status offline" data-native-banner="blocked">
                    <BellIcon /> Notifications are off for Púca Notes; due items only show here.
                    <button type="button" onClick={() => { void openNativeNotificationSettings(); }}>Open settings</button>
                </div>
            )}
            {working && s.exact === false && (
                <div className="notes-status offline" data-native-banner="exact">
                    <ClockIcon /> Reminders may arrive a few minutes late.
                    <button type="button" onClick={() => { void openNativeExactAlarmSettings(); }}>Allow exact timing</button>
                </div>
            )}
            {working && s.battery === false && (
                <div className="notes-status offline" data-native-banner="battery">
                    <WarningIcon /> Android may hold reminders back while Notes is closed.
                    <button type="button" onClick={() => { void requestNativeBatteryExemption(); }}>Let it run</button>
                </div>
            )}
        </>
    );
}
