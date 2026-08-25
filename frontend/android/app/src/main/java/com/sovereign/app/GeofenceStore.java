package com.sovereign.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * App-private persistence for the geofence set, written by
 * SovereignLocationPlugin and read by KeepAliveService.
 *
 * CONTENT-FREE BY CONTRACT: records are {id, lat, lon, r} where id is a task
 * id. No place label, no task text — the JS side keeps those in its own
 * storage, so even this file never says what a circle means. Coordinates
 * stay on-device (app-private prefs, excluded from nothing extra because
 * android:allowBackup already governs the whole app dir).
 */
final class GeofenceStore {

    private static final String PREFS = "sovereign_geofences";
    private static final String KEY = "fences";

    private GeofenceStore() {}

    static void save(Context ctx, JSONArray fences) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit().putString(KEY, fences.toString()).apply();
    }

    static List<GeofenceEngine.Fence> load(Context ctx) {
        List<GeofenceEngine.Fence> out = new ArrayList<>();
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = p.getString(KEY, null);
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "");
                double lat = o.optDouble("lat", Double.NaN);
                double lon = o.optDouble("lon", Double.NaN);
                double r = o.optDouble("r", Double.NaN);
                if (id.isEmpty() || Double.isNaN(lat) || Double.isNaN(lon) || Double.isNaN(r)) continue;
                out.add(new GeofenceEngine.Fence(id, lat, lon, r));
            }
        } catch (Exception ignored) {
            // A corrupt blob degrades to "no fences", never to a crash loop
            // inside a foreground service.
        }
        return out;
    }
}
