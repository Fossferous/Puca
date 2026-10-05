package com.sovereign.app;

import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

/**
 * The page's handle on {@link NativeDownloads}: "save this clip" / "save this
 * attachment", progress events, cancel.
 *
 * <p>A NEW plugin name on purpose. OTA web bundles reach phones still running
 * an older APK; {@code Capacitor.isPluginAvailable('SovereignDownloads')} is
 * false there (the bridge lists only the plugins this APK registered), and
 * the page keeps its old JavaScript save path (api/nativeDownloads.ts).
 *
 * <p>THE PAGE NEVER CHOOSES A URL. It passes file ids, keys and its bearer;
 * the URL is always {@code <apiBase>/files/<uuid>}, with apiBase the API
 * origin this APK was BUILT for ({@code plugins.SovereignDownloads.apiBase}
 * in capacitor.config.json, written at `cap sync` from VITE_API_URL). The page
 * also sends the base it talks to, and a mismatch is refused — so the token is
 * never sent to an origin the page did not mean, even after an OTA bundle that
 * points somewhere else. https only, except in a debug build.
 *
 * <p>Below Android 10 (API 29) there is no MediaStore pending-item API; the
 * plugin says {@code supported: false} and the page uses its existing
 * Documents/Puca path, which those versions have always used.
 */
@CapacitorPlugin(name = "SovereignDownloads")
public class SovereignDownloadsPlugin extends Plugin {

    /** Bumped when the call shapes change; the page checks it. */
    static final int VERSION = 1;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= 29) NativeDownloads.sweepStalePending(getContext());
    }

    private String pinnedApiBase() {
        return DownloadInputs.normalizeApiBase(getConfig().getString("apiBase", null), BuildConfig.DEBUG);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("version", VERSION);
        ret.put("supported", Build.VERSION.SDK_INT >= 29);
        String base = pinnedApiBase();
        ret.put("apiBase", base == null ? JSObject.NULL : base);
        call.resolve(ret);
    }

    @PluginMethod
    public void saveClip(PluginCall call) {
        NativeDownloads.Job job = common(call);
        if (job == null) return;
        byte[] key = DownloadInputs.key32(call.getString("key"));
        byte[] prefix = DownloadInputs.base64(call.getString("noncePrefix"));
        byte[] clipId = DownloadInputs.uuidBytes(call.getString("clipId"));
        JSArray parts = call.getArray("parts");
        if (key == null || prefix == null || prefix.length != 8 || clipId == null || parts == null
                || parts.length() < 1 || parts.length() > 64) {
            call.reject("This clip reference is malformed.", "bad-input");
            return;
        }
        String[] ids = new String[parts.length()];
        try {
            for (int i = 0; i < ids.length; i++) {
                ids[i] = parts.getString(i);
                if (!DownloadInputs.isUuid(ids[i])) {
                    call.reject("This clip reference is malformed.", "bad-input");
                    return;
                }
            }
        } catch (JSONException e) {
            call.reject("This clip reference is malformed.", "bad-input");
            return;
        }
        job.key = key;
        job.noncePrefix = prefix;
        job.clipId = clipId;
        job.parts = ids;
        Double total = call.getDouble("totalBytes");
        Double dur = call.getDouble("durationMs");
        job.totalBytes = total == null ? 0 : Math.max(0, total.longValue());
        job.durationMs = dur == null ? 0 : Math.max(0, dur.longValue());
        NativeDownloads.enqueue(getContext(), job);
    }

    @PluginMethod
    public void saveAttachment(PluginCall call) {
        NativeDownloads.Job job = common(call);
        if (job == null) return;
        String fileId = call.getString("fileId");
        byte[] key = DownloadInputs.key32(call.getString("key"));
        String cap = call.getString("cap");
        if (!DownloadInputs.isUuid(fileId) || key == null || (cap != null && !DownloadInputs.isCap(cap))) {
            call.reject("This attachment reference is malformed.", "bad-input");
            return;
        }
        job.fileId = fileId;
        job.key = key;
        job.cap = cap;
        String mime = call.getString("mime", "");
        job.senderMime = mime == null ? "" : mime;
        NativeDownloads.enqueue(getContext(), job);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        JSObject ret = new JSObject();
        ret.put("cancelled", id != null && NativeDownloads.cancel(id));
        call.resolve(ret);
    }

    /** What every save needs: an id, the origin check, the bearer, a name. null = rejected. */
    private NativeDownloads.Job common(PluginCall call) {
        if (Build.VERSION.SDK_INT < 29) {
            call.reject("Native downloads need Android 10 or newer.", "unsupported");
            return null;
        }
        String id = call.getString("id");
        if (!DownloadInputs.isJobId(id) || NativeDownloads.has(id)) {
            call.reject("Bad download id.", "bad-input");
            return null;
        }
        String pinned = pinnedApiBase();
        String asked = DownloadInputs.normalizeApiBase(call.getString("apiBase"), BuildConfig.DEBUG);
        if (pinned == null || asked == null || !pinned.equals(asked)) {
            call.reject("This app was built for a different server than the page is using.", "origin");
            return null;
        }
        String token = call.getString("token");
        if (token == null || token.isEmpty() || token.length() > 8192 || token.indexOf('\r') >= 0 || token.indexOf('\n') >= 0) {
            call.reject("Not signed in.", "denied");
            return null;
        }
        String name = call.getString("name", "file");
        return new NativeDownloads.Job(id, pinned, token, name == null ? "file" : name, new Reporter(call, id));
    }

    /** Sends a job's progress to the page and settles its call. */
    private final class Reporter implements NativeDownloads.Callback {
        private final PluginCall call;
        private final String id;

        Reporter(PluginCall call, String id) {
            this.call = call;
            this.id = id;
        }

        @Override
        public void progress(long bytesDone, long totalBytes, int partsDone, int partsTotal) {
            JSObject e = new JSObject();
            e.put("id", id);
            e.put("bytesDone", bytesDone);
            e.put("totalBytes", totalBytes);
            e.put("done", partsDone);
            e.put("total", partsTotal);
            notifyListeners("progress", e);
        }

        @Override
        public void saved(String where, String uri, long bytes, String container) {
            JSObject ret = new JSObject();
            ret.put("where", where);
            ret.put("uri", uri);
            ret.put("bytes", bytes);
            ret.put("container", container);
            call.resolve(ret);
        }

        @Override
        public void failed(String code, String message) {
            call.reject(message, code);
        }
    }
}
