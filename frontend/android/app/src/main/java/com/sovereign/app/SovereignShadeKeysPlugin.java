package com.sovereign.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Keys on the remote-control notification (frontend/src/api/devices/
 * shadeKeys.ts; {@link ShadeKeys} holds every rule).
 *
 * Its own plugin rather than more methods on SovereignApp, so an APK without
 * it fails cleanly ({@code Capacitor.isPluginAvailable} is false and the page
 * offers no notification keys) instead of half-working — the same reason
 * SovereignFiles and SovereignTransfers are separate. MainActivity does not
 * register it in Lite, which has no remote control.
 *
 * <ul>
 *   <li>{@code set({keys:[{id,label}], status})} — the complete list, from
 *       the page. Replaces whatever was there.</li>
 *   <li>event {@code press {id}} — a button was pressed, the phone unlocked
 *       and a control session live ({@link ShadeKeyReceiver}).</li>
 * </ul>
 */
@CapacitorPlugin(name = "SovereignShadeKeys")
public class SovereignShadeKeysPlugin extends Plugin {

    /** The live plugin; a WebView reload (OTA apply) makes a new one, and the
     *  newest wins, as SovereignAppPlugin's does. */
    private static volatile SovereignShadeKeysPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /**
     * The activity, and the WebView with it, is going away while the process
     * (held up by KeepAliveService) may live on — Back from the root on
     * Android 11 and older, or the system reclaiming the activity. Capacitor
     * does not drop this plugin's listeners then, so {@link #deliver} would
     * keep handing presses to a page that no longer exists. Forget this
     * instance and take the buttons down: no page, no keys.
     */
    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
            KeepAliveService.setShadeKeys(ShadeKeys.NONE);
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void set(PluginCall call) {
        List<String> ids = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        JSArray keys = call.getArray("keys");
        if (keys != null) {
            for (int i = 0; i < keys.length(); i++) {
                JSONObject k = keys.optJSONObject(i);
                if (k == null) continue;
                // isNull first: org.json reads a JSON null as the STRING "null",
                // which would pass the id pattern.
                ids.add(k.isNull("id") ? null : k.optString("id", null));
                labels.add(k.isNull("label") ? null : k.optString("label", null));
            }
        }
        String status = call.getString("status");
        KeepAliveService.setShadeKeys(ShadeKeys.from(ids, labels, status));
        call.resolve();
    }

    /**
     * Hand a press to the page. False when nothing there is listening (the
     * WebView died, or the page reloaded and has not subscribed yet) — the
     * caller then takes the buttons down, because a button whose key cannot
     * go anywhere is exactly the misleading thing they must not be.
     */
    static boolean deliver(String id) {
        SovereignShadeKeysPlugin p = instance;
        if (p == null || !p.hasListeners("press")) return false;
        JSObject data = new JSObject();
        data.put("id", id);
        p.notifyListeners("press", data);
        return true;
    }
}
