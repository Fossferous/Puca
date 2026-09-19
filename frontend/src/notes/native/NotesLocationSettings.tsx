/**
 * "Location reminders (this phone)" in Púca Notes' account menu — Android app
 * only, and only in an APK whose location plugin answers (an older Notes APK
 * has none, and the control hides itself).
 *
 * The same feature, rules and permission flow as Púca's Settings toggle
 * (api/taskPlaces.ts requestLocationReminderPermissions): places stay on this
 * phone, the reminder never names the item or the place, and the prominent
 * disclosure comes BEFORE any permission prompt. Places are per app: the ones
 * saved in Púca are not visible here, and the other way round.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { loadSettings, saveSettings } from '../../components/settingsStore';
import { isAndroidApp } from '../../api/platform';
import { locationStatus, mobileLocationAvailable, openLocationSettings, type LocationPermissionStatus } from '../../api/mobileLocation';
import { clearAllPlaces, listPlaces, placesVersion, requestLocationReminderPermissions, subscribePlaces } from '../../api/taskPlaces';

const LOCATION_DISCLOSURE =
    'Púca Notes will use this phone’s location — including while the app is closed ("Allow all the time") — '
    + 'only to remind you when you arrive at a place you save on this phone. Places and coordinates stay on '
    + 'this phone: nothing is uploaded or synced, and the reminder never names the item or the place. '
    + 'A quiet "Location reminders on" notification shows while it watches. Continue?';

export function NotesLocationSettings() {
    useSyncExternalStore(subscribePlaces, placesVersion, placesVersion);
    const [status, setStatus] = useState<LocationPermissionStatus | null | undefined>(undefined);
    const [on, setOn] = useState(() => loadSettings().locationReminders);

    useEffect(() => {
        if (!isAndroidApp() || !mobileLocationAvailable()) return;
        let live = true;
        const read = () => { void locationStatus().then(s => { if (live) setStatus(s); }); };
        read();
        const onVisible = () => { if (document.visibilityState === 'visible') read(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { live = false; document.removeEventListener('visibilitychange', onVisible); };
    }, []);

    // No plugin answered (browser, older APK): nothing to offer.
    if (!isAndroidApp() || !status) return null;

    const toggle = (next: boolean) => {
        if (next && !window.confirm(LOCATION_DISCLOSURE)) return;
        saveSettings({ ...loadSettings(), locationReminders: next });
        setOn(next);
        if (next) {
            void requestLocationReminderPermissions().then(() => locationStatus()).then(s => setStatus(s));
        }
    };
    const places = listPlaces().length;
    const hint = !on ? null
        : !status.locationOn ? 'Location is off on this phone.'
        : !status.foreground ? 'Location permission is off for Púca Notes.'
        : !status.precise ? 'Only approximate location is allowed — too coarse for a place.'
        : !status.background ? 'Allow location "all the time" so reminders work while Notes is closed.'
        : null;

    return (
        <div className="notes-menu-location">
            <div className="notes-menu-row">
                <label htmlFor="notes-location">Location reminders (this phone)</label>
                <input id="notes-location" type="checkbox" checked={on} onChange={e => toggle(e.target.checked)} />
            </div>
            <p className="notes-menu-hint">
                Remind about an item when this phone arrives at a place you save on it (the map-pin
                button on an item). Places stay on this phone and are separate from Púca’s.
            </p>
            {hint && (
                <p className="notes-menu-hint warn">
                    {hint} <button type="button" className="notes-link-btn" onClick={() => { void openLocationSettings(); }}>Open settings</button>
                </p>
            )}
            {(on || places > 0) && (
                <div className="notes-menu-row">
                    <span>Saved places on this phone: {places}</span>
                    <button
                        type="button"
                        className="notes-link-btn"
                        onClick={() => {
                            if (places === 0) return;
                            if (window.confirm(`Delete all ${places} saved place${places === 1 ? '' : 's'} and their reminders from this phone?`)) clearAllPlaces();
                        }}
                        disabled={places === 0}
                    >
                        Delete all
                    </button>
                </div>
            )}
        </div>
    );
}
