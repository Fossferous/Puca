package com.sovereign.notes;

import android.Manifest;
import android.app.StatusBarManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.CalendarContract;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.FileUtils;
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
import java.io.InputStream;
import java.io.OutputStream;
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

    /** Bumped when a method is added, so the page can feature-detect.
     *  2: shareIn (share INTO Notes), navItem (a due notification names the
     *  one item that came due) and tile (the quick-settings tile prompt).
     *  Feature strings are added HERE and nowhere else — the audio-notes
     *  branch adds "transcribe" to this same list. */
    private static final int API_LEVEL = 2;

    /** The nav target of the intent that started the activity, held until
     *  the page asks (it boots after the WebView loads). */
    private static volatile String pendingNav;
    /** The one item that came due, when a due notification named one, or -1.
     *  An id the server already holds in clear — never a title. */
    private static volatile long pendingNavItem = -1;

    @Override
    public void load() {
        NotesNotifier.ensureChannels(getContext());
        if (getActivity() != null) {
            takeNav(getActivity().getIntent(), false);
            takeShare(getActivity().getIntent(), false);
        }
    }

    private void takeNav(Intent intent, boolean announce) {
        if (intent == null) return;
        String nav = intent.getStringExtra(NotesNotifier.EXTRA_NAV);
        if (nav == null || nav.isEmpty()) return;
        long item = intent.getLongExtra(NotesNotifier.EXTRA_ITEM, -1);
        // Consumed: a recreation (rotation, theme) re-delivers the same intent,
        // and a stale nav yanking the user away mid-use would look like a bug.
        intent.removeExtra(NotesNotifier.EXTRA_NAV);
        intent.removeExtra(NotesNotifier.EXTRA_ITEM);
        pendingNav = nav;
        pendingNavItem = item;
        if (announce) {
            JSObject data = new JSObject();
            data.put("target", nav);
            if (item > 0) data.put("item", item);
            notifyListeners("navigate", data);
        }
    }

    /** A notification tap while the app runs (singleTask -> onNewIntent). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        takeNav(intent, true);
        takeShare(intent, true);
    }

    @PluginMethod
    public void consumeLaunchNav(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("target", pendingNav);
        ret.put("item", pendingNavItem);
        pendingNav = null;
        pendingNavItem = -1;
        call.resolve(ret);
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("api", API_LEVEL);
        JSArray features = new JSArray();
        for (String f : new String[] { "reminders", "backgroundRefresh", "exactAlarm", "battery",
                "share", "calendar", "launchNav", "shareIn", "navItem", "tile" }) {
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
            // The page only calls this with a feed it just fetched
            // (startTaskReminders' onFeed): that counts as keeping up, for
            // ReminderOwnerProvider, exactly like the job's own refresh.
            ReminderStore.setLastSync(getContext(), System.currentTimeMillis());
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
        // The last share's plaintext copy is not left behind for the next
        // account (the share target has long since read it).
        clearShareCache(ctx);
        call.resolve();
    }

    private static File shareDir(Context ctx) {
        return new File(ctx.getCacheDir(), "share");
    }

    /** Where a share that came IN is copied to (cache/share-in/). Already
     *  covered by res/xml/file_paths.xml's cache-path, and wiped on sign-out. */
    private static File shareInDir(Context ctx) {
        return new File(ctx.getCacheDir(), "share-in");
    }

    static void clearShareCache(Context ctx) {
        ShareCache.wipe(shareDir(ctx));
        ShareCache.wipe(shareInDir(ctx));
        pendingShare = null;
    }

    // --- share INTO Notes ------------------------------------------------------------

    /** One file another app shared, already copied out of its content:// URI. */
    private static final class SharedFile {
        final File file;
        final String name;
        final String mime;
        final long size;

        SharedFile(File file, String name, String mime, long size) {
            this.file = file;
            this.name = name;
            this.mime = mime;
            this.size = size;
        }
    }

    /**
     * What another app shared, waiting for the page to take it.
     *
     * DECRYPTED NOTE CONTENT. It lives here and in the cache copy until
     * consumeLaunchShare hands it over, and nowhere else: never
     * SharedPreferences, never ReminderStore (ids, times and marks only),
     * never a notification - and never a Log call. Printing the intent
     * anywhere on this path would put what the user shared into logcat.
     */
    private static final class PendingShare {
        final String text;
        final String subject;
        final List<SharedFile> files;

        PendingShare(String text, String subject, List<SharedFile> files) {
            this.text = text;
            this.subject = subject;
            this.files = files;
        }
    }

    private static volatile PendingShare pendingShare;

    /**
     * Read an ACTION_SEND / ACTION_SEND_MULTIPLE intent NOW, while the read
     * grant on its content:// URIs is still alive - it is tied to this
     * activity's intent and can lapse before a cold-starting WebView asks.
     * Then erase the extras, because singleTask re-delivers the same intent
     * on a rotation and a replayed share would re-open the composer over
     * whatever the user was doing.
     */
    private void takeShare(Intent intent, boolean announce) {
        if (intent == null) return;
        String action = intent.getAction();
        boolean multiple = Intent.ACTION_SEND_MULTIPLE.equals(action);
        if (!Intent.ACTION_SEND.equals(action) && !multiple) return;
        Context ctx = getContext();
        if (ctx == null) return;

        // As CharSequence, NOT getStringExtra: both extras are documented
        // CharSequence, and an app sharing styled or selected text puts a
        // Spanned in them. Bundle.getString() answers null for one, silently,
        // so a real share would arrive as nothing at all — the app would open
        // on the notes grid with no sign that anything came.
        String text = asText(intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        String subject = asText(intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT));
        List<Uri> uris = new ArrayList<>();
        if (multiple) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        if (uris.isEmpty()) {
            // Some senders put the pictures only in the clip data.
            ClipData clip = intent.getClipData();
            for (int i = 0; clip != null && i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }

        // Erased before anything can fail: a half-read share must not replay.
        intent.removeExtra(Intent.EXTRA_TEXT);
        intent.removeExtra(Intent.EXTRA_SUBJECT);
        intent.removeExtra(Intent.EXTRA_STREAM);
        intent.setClipData(null);

        List<SharedFile> files = new ArrayList<>();
        if (!uris.isEmpty()) {
            try {
                File root = shareInDir(ctx);
                long now = System.currentTimeMillis();
                if (root.exists()) ShareCache.pruneOlderThan(root, now, ShareCache.KEEP_MS);
                if (root.exists() || root.mkdirs()) {
                    File dir = ShareCache.newShareDir(root, now);
                    int allowed = ShareIntake.cap(uris.size());
                    for (int i = 0; i < uris.size(); i++) {
                        Uri u = uris.get(i);
                        // The mime is the one WE resolve, never the sender's.
                        String mime = ctx.getContentResolver().getType(u);
                        if (ShareIntake.isSharedText(mime)) {
                            // A shared .txt is words, not an attachment: the
                            // page has nowhere but the picture list to put a
                            // file, and a .txt sealed as a photo is a note
                            // with a picture nothing can render. The first
                            // one fills a body the sender did not send.
                            if (!hasText(text)) text = readTextIn(ctx, u);
                            continue;
                        }
                        if (files.size() >= allowed) continue;
                        SharedFile f = copyIn(ctx, u, mime, dir, i);
                        if (f != null) files.add(f);
                    }
                }
            } catch (Exception e) {
                // Deliberately no message: an exception here could quote a
                // name the user shared. The page gets whatever was copied.
                files.clear();
            }
        }

        boolean hasWords = hasText(text);
        if (!hasWords && files.isEmpty()) return;
        pendingShare = new PendingShare(hasWords ? text : null, subject, files);
        // A bare ping: the event carries NO content. The page then asks.
        if (announce) notifyListeners("share", new JSObject());
    }

    /** Copy one shared picture into our own cache, or null if it is not
     *  something a note can hold. `mime` is the one WE resolved, never the
     *  sender's claim. */
    private SharedFile copyIn(Context ctx, Uri uri, String mime, File dir, int index) {
        if (!ShareIntake.acceptsScheme(uri.getScheme())) return null;
        if (!ShareIntake.acceptsPicture(mime)) return null;
        File out = new File(dir, ShareIntake.safeName(displayName(ctx, uri), index, mime));
        long written = 0;
        try (InputStream in = ctx.getContentResolver().openInputStream(uri);
             OutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                written += n;
                if (written > ShareIntake.MAX_FILE_BYTES) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    return null;
                }
                os.write(buf, 0, n);
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            return null;
        }
        return new SharedFile(out, out.getName(), ShareIntake.normalMime(mime), written);
    }

    /**
     * Read a shared text stream into the note's body, capped. Same grant rule
     * as copyIn — each entry point states it, rather than trusting the
     * caller. Decoded as UTF-8 and not stored anywhere: it goes into the one
     * static field the page drains, like any other shared text.
     */
    private String readTextIn(Context ctx, Uri uri) {
        if (!ShareIntake.acceptsScheme(uri.getScheme())) return null;
        try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            byte[] buf = new byte[8 * 1024];
            java.io.ByteArrayOutputStream acc = new java.io.ByteArrayOutputStream();
            int n;
            while (acc.size() < ShareIntake.MAX_TEXT_BYTES && (n = in.read(buf)) > 0) {
                acc.write(buf, 0, Math.min(n, ShareIntake.MAX_TEXT_BYTES - acc.size()));
            }
            String out = new String(acc.toByteArray(), StandardCharsets.UTF_8);
            return hasText(out) ? out : null;
        } catch (Exception e) {
            // No message: it could quote what the user shared.
            return null;
        }
    }

    private static boolean hasText(String s) {
        return s != null && !s.trim().isEmpty();
    }

    /** An extra that is documented CharSequence, as the String we need. */
    private static String asText(CharSequence cs) {
        return cs == null ? null : cs.toString();
    }

    /** The sender's own name for the file, if it offers one. */
    private static String displayName(Context ctx, Uri uri) {
        try (android.database.Cursor c = ctx.getContentResolver()
                .query(uri, new String[] { android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // A provider that refuses the query: the mime names the file.
        }
        return null;
    }

    /**
     * Hand the page what was shared, once. The files go as same-origin URLs
     * (the app's own https://localhost/_capacitor_file_/...) that the page
     * fetches into Blobs - not as base64 across the bridge, which would copy
     * a whole photo through the JSON channel.
     */
    @PluginMethod
    public void consumeLaunchShare(PluginCall call) {
        PendingShare p = pendingShare;
        pendingShare = null;
        JSObject ret = new JSObject();
        ret.put("text", p == null ? null : p.text);
        ret.put("subject", p == null ? null : p.subject);
        JSArray files = new JSArray();
        if (p != null) {
            String host = getBridge() == null ? null : getBridge().getLocalUrl();
            for (SharedFile f : p.files) {
                JSObject o = new JSObject();
                o.put("url", host == null ? null
                        : FileUtils.getPortablePath(getContext(), host, Uri.fromFile(f.file)));
                o.put("name", f.name);
                o.put("mime", f.mime);
                o.put("size", f.size);
                files.put(o);
            }
        }
        ret.put("files", files);
        call.resolve(ret);
    }

    // --- the quick-settings tile ------------------------------------------------------

    /**
     * Ask Android to offer "add this tile" (13+). Below that, and if the
     * system refuses, the answer is false and the page says to add it from
     * the shade's edit screen instead. Carries one constant label.
     */
    @PluginMethod
    public void requestAddTile(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < 33) {
            ret.put("ok", false);
            ret.put("reason", "unsupported");
            call.resolve(ret);
            return;
        }
        try {
            StatusBarManager sbm = (StatusBarManager) getContext().getSystemService(Context.STATUS_BAR_SERVICE);
            if (sbm == null) throw new Exception("no status bar service");
            sbm.requestAddTileService(
                    new ComponentName(getContext(), NotesTileService.class),
                    NotesTileService.LABEL,
                    Icon.createWithResource(getContext(), R.drawable.ic_qs_new_note),
                    Runnable::run,
                    result -> { /* the user answers in the system dialog */ });
            ret.put("ok", true);
        } catch (Exception e) {
            ret.put("ok", false);
            ret.put("reason", "could not ask for the tile");
        }
        call.resolve(ret);
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
            File root = shareDir(getContext());
            if (!root.exists() && !root.mkdirs()) throw new Exception("no cache directory");
            // Earlier shares stay readable for a while (the app they went to
            // may still be uploading them); only old copies go (ShareCache).
            long now = System.currentTimeMillis();
            ShareCache.pruneOlderThan(root, now, ShareCache.KEEP_MS);
            File out = new File(ShareCache.newShareDir(root, now), filename);
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
     *  note title can contain anything. One implementation, shared with the
     *  intake for names that came from another app (ShareIntake.clean). */
    static String safeFileName(String name) {
        return ShareIntake.clean(name, "notes.txt");
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
        // Not call.getDouble: an epoch-ms number arrives as a Long, which
        // getDouble answers null for (PluginArgs).
        Long begin = PluginArgs.millis(call, "beginMs");
        Long end = PluginArgs.millis(call, "endMs");
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
