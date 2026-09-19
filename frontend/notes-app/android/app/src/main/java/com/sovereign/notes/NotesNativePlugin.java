package com.sovereign.notes;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.CalendarContract;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Púca Notes' own native bridge: due reminders that fire with the app
 * closed, the background refresh, notification / exact-alarm / battery
 * status, the share sheet, "add to the phone's calendar", and landing a
 * notification tap on the Reminders view.
 *
 * Reached from frontend/src/notes/native/notesNative.ts, which feature-detects
 * the plugin (the browser and older Notes APKs have none) and never throws.
 * Every method is content-free except shareText and addToPhoneCalendar, which
 * carry exactly what the USER chose to send out of the app, at that moment.
 */
@CapacitorPlugin(
    name = "NotesNative",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NotesNativePlugin extends Plugin {

    /** Bumped when a method is added, so the page can feature-detect. */
    private static final int API_LEVEL = 1;

    /** The nav target of the intent that started the activity, held until
     *  the page asks (it boots after the WebView loads). */
    private static volatile String pendingNav;

    @Override
    public void load() {
        NotesNotifier.ensureChannels(getContext());
        if (getActivity() != null) takeNav(getActivity().getIntent(), false);
    }

    private void takeNav(Intent intent, boolean announce) {
        if (intent == null) return;
        String nav = intent.getStringExtra(NotesNotifier.EXTRA_NAV);
        if (nav == null || nav.isEmpty()) return;
        // Consumed: a recreation (rotation, theme) re-delivers the same intent,
        // and a stale nav yanking the user away mid-use would look like a bug.
        intent.removeExtra(NotesNotifier.EXTRA_NAV);
        pendingNav = nav;
        if (announce) {
            JSObject data = new JSObject();
            data.put("target", nav);
            notifyListeners("navigate", data);
        }
    }

    /** A notification tap while the app runs (singleTask -> onNewIntent). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        takeNav(intent, true);
    }

    @PluginMethod
    public void consumeLaunchNav(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("target", pendingNav);
        pendingNav = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("api", API_LEVEL);
        JSArray features = new JSArray();
        for (String f : new String[] { "reminders", "backgroundRefresh", "exactAlarm", "battery",
                "share", "calendar", "launchNav" }) {
            features.put(f);
        }
        ret.put("features", features);
        call.resolve(ret);
    }

    // --- due reminders ---------------------------------------------------------

    /**
     * Replace the reminder entries for `account` and re-arm. Entries are
     * {id, at, mark, due?}: a task id, the effective fire time in epoch ms,
     * the opaque mark it fires under (re-fires when it changes), and the raw
     * server due_at when the page knows it. Nothing else is read, so nothing
     * else can be stored.
     */
    @PluginMethod
    public void syncReminders(PluginCall call) {
        String account = call.getString("account");
        JSArray arr = call.getArray("entries");
        if (account == null || account.isEmpty()) {
            call.reject("account is required");
            return;
        }
        List<ReminderPlan.Entry> entries = new ArrayList<>();
        try {
            for (int i = 0; arr != null && i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!o.has("id") || !o.has("at")) continue;
                long at = (long) o.getDouble("at");
                String due = o.has("due") && !o.isNull("due") ? o.getString("due") : null;
                entries.add(new ReminderPlan.Entry(o.getLong("id"), at, o.optString("mark", ""), due));
            }
        } catch (Exception e) {
            call.reject("bad reminder entries: " + e.getMessage());
            return;
        }
        synchronized (ReminderStore.LOCK) {
            ReminderStore.bindAccount(getContext(), account);
            ReminderStore.setEntries(getContext(), entries);
        }
        ReminderAlarms.arm(getContext());
        JSObject ret = new JSObject();
        ret.put("count", entries.size());
        call.resolve(ret);
    }

    /** Every way out of a session: no alarm, marker, token, job, fence or
     *  notice outlives it. */
    @PluginMethod
    public void clearAll(PluginCall call) {
        Context ctx = getContext();
        ReminderAlarms.cancel(ctx);
        ReminderRefreshJob.cancel(ctx);
        synchronized (ReminderStore.LOCK) {
            ReminderStore.wipe(ctx);
        }
        GeofenceStore.save(ctx, new org.json.JSONArray());
        NotesGeofenceService.stop(ctx);
        NotesNotifier.cancelSessionNotices(ctx);
        call.resolve();
    }

    // --- background refresh ------------------------------------------------------

    /**
     * Hand the refresh job its credentials: the page's own API base and the
     * session token (which lives in WebView storage Java cannot read). A null
     * token clears them and cancels the job. Never swaps a fresher token the
     * job renewed for the staler one the page still holds (JwtClaims.newer).
     */
    @PluginMethod
    public void setBackgroundRefresh(PluginCall call) {
        Context ctx = getContext();
        String apiBase = call.getString("apiBase");
        String token = call.getString("token");
        String account = call.getString("account");
        if (token == null || token.isEmpty() || apiBase == null || account == null) {
            synchronized (ReminderStore.LOCK) {
                ReminderStore.clearToken(ctx);
            }
            ReminderRefreshJob.cancel(ctx);
            call.resolve();
            return;
        }
        synchronized (ReminderStore.LOCK) {
            ReminderStore.bindAccount(ctx, account);
            ReminderStore.setCredentials(ctx, apiBase, JwtClaims.newer(ReminderStore.token(ctx), token));
            ReminderStore.setStaleNoticePosted(ctx, false);
        }
        NotesNotifier.cancel(ctx, NotesNotifier.ID_STALE);
        ReminderRefreshJob.schedule(ctx);
        JSObject ret = new JSObject();
        ret.put("scheduled", ReminderRefreshJob.scheduled(ctx));
        call.resolve(ret);
    }

    /** The token the background job holds (possibly renewed since the page
     *  last ran) and the account it is for. The page adopts it only when it
     *  is the same account and lives longer than its own. */
    @PluginMethod
    public void takeRenewedToken(PluginCall call) {
        JSObject ret = new JSObject();
        synchronized (ReminderStore.LOCK) {
            ret.put("token", ReminderStore.token(getContext()));
            ret.put("account", ReminderStore.account(getContext()));
        }
        call.resolve(ret);
    }

    // --- notification permission (Púca's SovereignAppPlugin pattern) --------------

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return getPermissionState("notifications") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void notificationStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted = canPostNotifications();
        ret.put("granted", granted);
        ret.put("needsRequest", Build.VERSION.SDK_INT >= 33 && !granted);
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        // blocked: off at the app or Reminders-channel level — states a granted
        // runtime permission cannot see and re-requesting cannot fix; only the
        // settings screen can, so the page routes there.
        ret.put("blocked", !enabled || NotesNotifier.remindersChannelOff(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (canPostNotifications()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationResult");
    }

    @PermissionCallback
    private void notificationResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", canPostNotifications());
        call.resolve(ret);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= 26) {
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:" + getContext().getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open notification settings: " + e.getMessage());
        }
    }

    // --- exact alarms -----------------------------------------------------------

    @PluginMethod
    public void exactAlarmStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("exact", ReminderAlarms.exactAllowed(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < 31) {
            call.resolve();
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open alarm settings: " + e.getMessage());
        }
    }

    // --- battery optimisation --------------------------------------------------------

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject ret = new JSObject();
        ret.put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(ret);
    }

    /** The system "let this app run in the background?" dialog. Sideloaded,
     *  so Play's restriction on this permission does not apply. */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("battery dialog unavailable: " + e.getMessage());
        }
    }

    // --- share sheet ---------------------------------------------------------------

    /**
     * Send text out through Android's share sheet as a FILE (a content:// URI
     * from the FileProvider this app already declares, read permission granted
     * to the chosen target only). The user picks where it goes; what goes is
     * plaintext — the page says so before calling this.
     */
    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text");
        String filename = safeFileName(call.getString("filename", "notes.txt"));
        String mime = call.getString("mime", "text/plain");
        String subject = call.getString("subject", filename);
        if (text == null) {
            call.reject("text is required");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("no cache directory");
            // One outgoing file at a time: the previous share's copy is not
            // left lying in the cache.
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
                f.delete();
            File out = new File(dir, filename);
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(text.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", out);
            Intent send = new Intent(Intent.ACTION_SEND)
                    .setType(mime)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .putExtra(Intent.EXTRA_SUBJECT, subject)
                    .putExtra(Intent.EXTRA_TITLE, filename)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(ClipData.newRawUri(filename, uri));
            Intent chooser = Intent.createChooser(send, "Share " + filename)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(chooser);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("reason", "could not open the share sheet: " + e.getMessage());
            call.resolve(ret);
        }
    }

    /** A file name with no path in it: the page's names are ours, but a
     *  note title can contain anything. */
    static String safeFileName(String name) {
        if (name == null) return "notes.txt";
        String s = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_").trim();
        while (s.startsWith(".")) s = s.substring(1);
        if (s.isEmpty()) s = "notes.txt";
        return s.length() > 120 ? s.substring(0, 120) : s;
    }

    // --- the phone's calendar ------------------------------------------------------------

    /**
     * Open the phone's calendar app on a pre-filled new event. ACTION_INSERT
     * needs no calendar permission: the calendar app shows the event and the
     * user saves it (or not) there. The title becomes plaintext in that app,
     * which may sync it to its own account — the page says so first.
     */
    @PluginMethod
    public void addToPhoneCalendar(PluginCall call) {
        String title = call.getString("title", "");
        Double begin = call.getDouble("beginMs");
        Double end = call.getDouble("endMs");
        boolean allDay = Boolean.TRUE.equals(call.getBoolean("allDay", false));
        String location = call.getString("location");
        JSObject ret = new JSObject();
        if (begin == null) {
            ret.put("ok", false);
            ret.put("reason", "beginMs is required");
            call.resolve(ret);
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_INSERT)
                    .setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, title)
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin.longValue())
                    .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, allDay)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (end != null) i.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.longValue());
            if (location != null && !location.isEmpty()) i.putExtra(CalendarContract.Events.EVENT_LOCATION, location);
            getContext().startActivity(i);
            ret.put("ok", true);
        } catch (ActivityNotFoundException e) {
            ret.put("ok", false);
            ret.put("reason", "no calendar app on this phone");
        } catch (Exception e) {
            ret.put("ok", false);
            ret.put("reason", "could not open the calendar: " + e.getMessage());
        }
        call.resolve(ret);
    }
}
