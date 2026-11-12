package com.sovereign.app.control;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * The page's side of controlling this phone from a call
 * (frontend/src/api/phoneControl.ts). FULL APK only: the app registers it
 * from its full-build ControlRegistrar, so in Lite the page finds no plugin
 * and nothing is offered.
 *
 * <ul>
 *   <li>{@code status()} — {enabled, connected, active, refusal, sdk}: whether
 *       the service is switched on in Android's settings, bound, in a session,
 *       and why Allow could not start one now (null when it could).</li>
 *   <li>{@code openSettings({page})} — 'accessibility' (Púca's own entry where
 *       Android has one, else the list) or 'app' (Púca's App info, where
 *       Android 13+ keeps "Allow restricted settings").</li>
 *   <li>{@code begin({viewer})} — the person pressed Allow for this viewer:
 *       {ok, refusal}.</li>
 *   <li>{@code inject({events})} — the granted viewer's input, in order, each
 *       with the page's arrival time {@code at} (ms).</li>
 *   <li>{@code end()} — the page ended the session.</li>
 *   <li>events {@code controlEnded {reason}} (a native end: notification,
 *       indicator, locked, screen-off, service-off, not-sharing, one-app) and
 *       {@code statusChanged} (the service came or went).</li>
 * </ul>
 */
@CapacitorPlugin(name = "SovereignPhoneControl")
public class SovereignPhoneControlPlugin extends Plugin {

    /** The most events one call may carry (the page sends a coalesced batch). */
    private static final int MAX_BATCH = 256;

    @Override
    public void load() {
        PhoneControl.setListener(new PhoneControl.Listener() {
            @Override
            public void ended(String reason) {
                JSObject o = new JSObject();
                o.put("reason", reason);
                notifyListeners("controlEnded", o);
            }

            @Override
            public void statusChanged() {
                notifyListeners("statusChanged", new JSObject());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        // The page that granted the session is gone: so is the session.
        PhoneControl.end("page-gone", false);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void status(PluginCall call) {
        PhoneControl.main().post(() -> {
            JSObject o = new JSObject();
            o.put("enabled", PhoneControl.serviceEnabled());
            o.put("connected", PhoneControl.serviceConnected());
            o.put("active", PhoneControl.active());
            String r = PhoneControl.beginRefusal();
            o.put("refusal", r == null ? JSObject.NULL : r);
            o.put("sdk", Build.VERSION.SDK_INT);
            call.resolve(o);
        });
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String page = call.getString("page", "accessibility");
        Intent i;
        if ("app".equals(page)) {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getContext().getPackageName(), null));
        } else {
            // Púca's own entry on Android versions that open one by name.
            i = new Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
                    .putExtra(Intent.EXTRA_COMPONENT_NAME, PhoneControl.component(getContext()).flattenToString());
        }
        // CLEAR_TASK: a Settings task already open somewhere else (the person
        // was in Display settings, say) would otherwise just come forward on
        // whatever page it was showing, and the button would land them there.
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        try {
            getContext().startActivity(i);
        } catch (ActivityNotFoundException | SecurityException e) {
            try {
                getContext().startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            } catch (RuntimeException e2) {
                call.reject("Android's settings could not be opened", "unavailable");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void begin(PluginCall call) {
        String viewer = call.getString("viewer", "");
        PhoneControl.main().post(() -> {
            String r = PhoneControl.begin(viewer);
            JSObject o = new JSObject();
            o.put("ok", r == null);
            o.put("refusal", r == null ? JSObject.NULL : r);
            call.resolve(o);
        });
    }

    @PluginMethod
    public void end(PluginCall call) {
        PhoneControl.end("page", false);
        call.resolve();
    }

    @PluginMethod
    public void inject(PluginCall call) {
        JSArray events = call.getArray("events");
        long now = SystemClock.elapsedRealtime();
        if (events == null || events.length() == 0) {
            call.resolve();
            return;
        }
        int n = Math.min(events.length(), MAX_BATCH);
        // The page's arrival times, moved onto this clock: the newest event
        // arrived now, the others as long before it as the page saw.
        double newest = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < n; i++) {
            JSONObject e = events.optJSONObject(i);
            if (e != null && e.has("at")) newest = Math.max(newest, e.optDouble("at", Double.NaN));
        }
        final JSONObject[] batch = new JSONObject[n];
        final long[] at = new long[n];
        for (int i = 0; i < n; i++) {
            JSONObject e = events.optJSONObject(i);
            batch[i] = e;
            double t = e == null ? Double.NaN : e.optDouble("at", Double.NaN);
            long back = Double.isNaN(t) || Double.isInfinite(newest) ? 0 : Math.max(0, Math.min(1000, Math.round(newest - t)));
            at[i] = now - back;
        }
        PhoneControl.main().post(() -> {
            Injector inj = PhoneControl.injector();
            if (inj == null) return;
            TouchPlanner p = inj.planner();
            for (int i = 0; i < n; i++) feed(p, batch[i], at[i]);
            inj.kick();
        });
        call.resolve();
    }

    private static boolean finite(double d) {
        return !Double.isNaN(d) && !Double.isInfinite(d);
    }

    /** One event onto the planner, validated again here (the page already
     *  did): anything malformed is dropped. */
    static void feed(TouchPlanner p, JSONObject e, long at) {
        if (e == null) return;
        String t = e.optString("t", "");
        switch (t) {
            case "move": {
                double x = e.optDouble("x", Double.NaN);
                double y = e.optDouble("y", Double.NaN);
                if (finite(x) && finite(y)) p.move(x, y, at);
                break;
            }
            case "down":
            case "up": {
                int b = e.optInt("button", -1);
                if (b < 0 || b > 2) return;
                if ("down".equals(t)) p.down(b, at);
                else p.up(b, at);
                break;
            }
            case "wheel": {
                double dy = e.optDouble("dy", Double.NaN);
                if (finite(dy)) p.wheel(dy, at);
                break;
            }
            case "key": {
                if (e.isNull("code")) return;
                String code = e.optString("code", "");
                if (code.isEmpty() || code.length() > 32 || !e.has("down")) return;
                p.key(code, e.optBoolean("down", false), at);
                break;
            }
            case "nav":
                p.nav(e.optString("a", ""), at);
                break;
            case "text": {
                if (e.isNull("s")) return;
                String s = e.optString("s", "");
                if (s.length() > 64) return;
                p.text(s, at);
                break;
            }
            default:
                break;
        }
    }
}
