package com.sovereign.notes;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Location reminders in Púca Notes, under the SAME JS name as Púca's plugin
 * ("SovereignLocation") so frontend/src/api/mobileLocation.ts and
 * taskPlaces.ts work unchanged. A port of Púca's SovereignLocationPlugin:
 * the two-step permission flow, the one-shot fix for "save this place", and
 * setFences' field stripping. The difference is who watches: here
 * setFences starts and stops NotesGeofenceService directly (Notes has no
 * KeepAliveService to hand the fences to).
 *
 * PRIVACY CONTRACT (as Púca's): coordinates never leave the phone. No network
 * call anywhere in this plugin or its service; fences are stored with only
 * {taskId, lat, lon, r}; place labels stay in the page's own storage. Places
 * are per app AND per device: Púca and Púca Notes on one phone have separate
 * storage, so a place saved in one is not seen by the other.
 */
@CapacitorPlugin(
    name = "SovereignLocation",
    permissions = {
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        }),
        @Permission(alias = "backgroundLocation", strings = {
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        }),
    }
)
public class NotesLocationPlugin extends Plugin {

    private static final long SINGLE_FIX_TIMEOUT_MS = 20_000L;
    private static final long LAST_KNOWN_MAX_AGE_MS = 2 * 60_000L;

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void status(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        boolean locationOn = false;
        if (lm != null) {
            locationOn = Build.VERSION.SDK_INT >= 28
                    ? lm.isLocationEnabled()
                    : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                        || lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        }
        JSObject ret = new JSObject();
        ret.put("foreground", NotesGeofenceService.hasForegroundLocation(getContext()));
        ret.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        ret.put("background", NotesGeofenceService.hasBackgroundLocation(getContext()));
        ret.put("locationOn", locationOn);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestForegroundPermission(PluginCall call) {
        if (NotesGeofenceService.hasForegroundLocation(getContext())) {
            foregroundResult(call);
            return;
        }
        requestPermissionForAlias("location", call, "foregroundResult");
    }

    @PermissionCallback
    private void foregroundResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", NotesGeofenceService.hasForegroundLocation(getContext()));
        ret.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        call.resolve(ret);
    }

    /** "Allow all the time" — asked separately, after foreground (Android
     *  11+ ignores a combined request and answers this one with a trip
     *  through the app's location settings page). */
    @PluginMethod
    public void requestBackgroundPermission(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < 29 || NotesGeofenceService.hasBackgroundLocation(getContext())) {
            ret.put("granted", NotesGeofenceService.hasBackgroundLocation(getContext()));
            call.resolve(ret);
            return;
        }
        if (!NotesGeofenceService.hasForegroundLocation(getContext())) {
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "backgroundResult");
    }

    @PermissionCallback
    private void backgroundResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", NotesGeofenceService.hasBackgroundLocation(getContext()));
        call.resolve(ret);
    }

    /** One-shot fix for "save this place where I'm standing". */
    @PluginMethod
    public void currentPosition(PluginCall call) {
        if (!NotesGeofenceService.hasForegroundLocation(getContext())) {
            call.reject("no location permission");
            return;
        }
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            call.reject("no location manager");
            return;
        }
        String provider = NotesGeofenceService.pickProvider(lm);
        if (provider == null) {
            call.reject("location is off");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, null, ContextCompat.getMainExecutor(getContext()),
                        loc -> finishFix(call, lm, loc));
            } else {
                // requestSingleUpdate has no timeout of its own; `done` makes
                // whichever of fix/timeout drains second a no-op.
                Handler h = new Handler(Looper.getMainLooper());
                final boolean[] done = new boolean[1];
                final Object token = new Object();
                LocationListener once = new LocationListener() {
                    @Override
                    public void onLocationChanged(Location location) {
                        if (done[0]) return;
                        done[0] = true;
                        h.removeCallbacksAndMessages(token);
                        finishFix(call, lm, location);
                    }
                    @Override public void onStatusChanged(String p, int s, android.os.Bundle e) {}
                    @Override public void onProviderEnabled(String p) {}
                    @Override public void onProviderDisabled(String p) {}
                };
                lm.requestSingleUpdate(provider, once, Looper.getMainLooper());
                h.postAtTime(() -> {
                    if (done[0]) return;
                    done[0] = true;
                    try {
                        lm.removeUpdates(once);
                    } catch (SecurityException ignored) { /* already revoked */ }
                    finishFix(call, lm, null);
                }, token, android.os.SystemClock.uptimeMillis() + SINGLE_FIX_TIMEOUT_MS);
            }
        } catch (SecurityException e) {
            call.reject("location permission revoked");
        }
    }

    private void finishFix(PluginCall call, LocationManager lm, Location loc) {
        if (loc == null) loc = freshLastKnown(lm);
        if (loc == null) {
            call.reject("no location fix");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("lat", loc.getLatitude());
        ret.put("lon", loc.getLongitude());
        ret.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
        call.resolve(ret);
    }

    private Location freshLastKnown(LocationManager lm) {
        Location best = null;
        try {
            for (String p : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(p);
                if (l == null) continue;
                long ageMs = (android.os.SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos()) / 1_000_000L;
                if (ageMs > LAST_KNOWN_MAX_AGE_MS) continue;
                if (best == null || l.getAccuracy() < best.getAccuracy()) best = l;
            }
        } catch (SecurityException ignored) { /* revoked mid-call */ }
        return best;
    }

    /**
     * Replace the stored fence set and start/stop the watch to match. Only
     * the four content-free fields are copied; anything else the page sends
     * is dropped here so nothing labelled can reach native storage.
     */
    @PluginMethod
    public void setFences(PluginCall call) {
        try {
            JSArray fences = call.getArray("fences");
            JSONArray out = new JSONArray();
            for (int i = 0; fences != null && i < fences.length(); i++) {
                JSONObject o = fences.getJSONObject(i);
                String id = o.optString("id", "");
                double lat = o.optDouble("lat", Double.NaN);
                double lon = o.optDouble("lon", Double.NaN);
                double r = o.optDouble("radiusM", Double.NaN);
                if (id.isEmpty() || Double.isNaN(lat) || Double.isNaN(lon) || Double.isNaN(r)) continue;
                JSONObject rec = new JSONObject();
                rec.put("id", id);
                rec.put("lat", lat);
                rec.put("lon", lon);
                rec.put("r", r);
                out.put(rec);
            }
            GeofenceStore.save(getContext(), out);
            boolean watching = NotesGeofenceService.sync(getContext());
            JSObject ret = new JSObject();
            ret.put("watching", watching);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("could not store fences: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open settings: " + e.getMessage());
        }
    }
}
