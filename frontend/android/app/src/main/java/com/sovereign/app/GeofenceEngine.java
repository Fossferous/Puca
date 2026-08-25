package com.sovereign.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The location-reminder decision core: which fences did this fix ENTER, and
 * how long until the next fix could change anything.
 *
 * Deliberately pure Java (no android.*, no org.json) so it runs under plain
 * JUnit on the JVM — the rest of the native layer is untestable off-device,
 * and this is the part with the bugs worth catching (hysteresis, baselines,
 * re-arming). KeepAliveService owns the LocationManager plumbing around it.
 *
 * Rules, chosen to survive GPS jitter and process restarts without a
 * persisted fired-marker:
 *
 *  - Only an observed OUTSIDE→INSIDE transition fires. The first trusted fix
 *    after a fence appears sets its baseline silently — so creating a
 *    reminder while standing at the place doesn't fire instantly, and a
 *    process restart while inside doesn't re-fire.
 *  - Hysteresis: once inside, a fence re-arms only past radius*1.5 + 50 m —
 *    a fix bouncing across the boundary can't machine-gun notifications.
 *  - A fix with accuracy worse than {@link #MAX_TRUSTED_ACCURACY_M} is
 *    ignored outright. Android 12's "approximate location" grant (~2 km)
 *    therefore never fires anything, by design not accident.
 *
 * There is no wall-clock anywhere in here: state advances only on fixes,
 * which is what makes it deterministic under test.
 */
public class GeofenceEngine {

    /** Fixes with worse accuracy than this are unusable for ~150 m fences. */
    public static final float MAX_TRUSTED_ACCURACY_M = 200f;
    /** Floor/ceiling for the adaptive update interval. */
    public static final long MIN_INTERVAL_MS = 60_000L;
    public static final long MAX_INTERVAL_MS = 15 * 60_000L;
    /** Assumed worst-case travel speed for interval planning (~60 km/h):
     *  fast enough that driving to the fence still gets a fix inside it. */
    public static final double ASSUMED_SPEED_MPS = 16.7;

    /** One watched circle. The id is a task id — content-free by contract. */
    public static final class Fence {
        public final String id;
        public final double lat;
        public final double lon;
        public final double radiusM;

        public Fence(String id, double lat, double lon, double radiusM) {
            this.id = id;
            this.lat = lat;
            this.lon = lon;
            this.radiusM = radiusM;
        }
    }

    public static final class Result {
        /** Fence ids whose circles were just entered (armed → inside). */
        public final List<String> fired;
        /** Suggested time until the next fix, clamped to the interval band. */
        public final long nextIntervalMs;

        Result(List<String> fired, long nextIntervalMs) {
            this.fired = fired;
            this.nextIntervalMs = nextIntervalMs;
        }
    }

    private List<Fence> fences = new ArrayList<>();
    /** id → last known containment. Absent = baseline pending. */
    private final Map<String, Boolean> inside = new HashMap<>();

    /**
     * Replace the fence set. Containment state survives only for fences whose
     * id AND circle are unchanged — an edited place resets to baseline (its
     * old state describes a different circle).
     */
    public void setFences(List<Fence> next) {
        Map<String, Fence> old = new HashMap<>();
        for (Fence f : fences) old.put(f.id, f);
        Map<String, Boolean> kept = new HashMap<>();
        for (Fence f : next) {
            Fence prev = old.get(f.id);
            Boolean state = inside.get(f.id);
            if (prev != null && state != null
                    && prev.lat == f.lat && prev.lon == f.lon && prev.radiusM == f.radiusM) {
                kept.put(f.id, state);
            }
        }
        fences = new ArrayList<>(next);
        inside.clear();
        inside.putAll(kept);
    }

    public boolean hasFences() {
        return !fences.isEmpty();
    }

    /** Feed one fix through every fence. */
    public Result onFix(double lat, double lon, float accuracyM) {
        List<String> fired = new ArrayList<>();
        if (accuracyM > MAX_TRUSTED_ACCURACY_M) {
            // Unusable fix: no state changes at all (not even baselines — a
            // 2 km blob "containing" a fence says nothing). Ask again soon in
            // case the next fix is better.
            return new Result(fired, MIN_INTERVAL_MS * 2);
        }
        long soonestMs = MAX_INTERVAL_MS;
        for (Fence f : fences) {
            double dist = distanceM(lat, lon, f.lat, f.lon);
            double exitAt = f.radiusM * 1.5 + 50;
            Boolean prev = inside.get(f.id);
            boolean in;
            if (prev == null) {
                in = dist <= f.radiusM;               // silent baseline
            } else if (prev) {
                in = dist < exitAt;                   // sticky until well out
            } else {
                in = dist <= f.radiusM;
                if (in) fired.add(f.id);              // the one firing edge
            }
            inside.put(f.id, in);

            double metersToChange = in ? Math.max(exitAt - dist, 0) : Math.max(dist - f.radiusM, 0);
            long t = (long) (metersToChange / ASSUMED_SPEED_MPS * 1000.0);
            if (t < soonestMs) soonestMs = t;
        }
        long next = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, soonestMs));
        return new Result(fired, next);
    }

    /** Haversine great-circle distance in meters. */
    public static double distanceM(double lat1, double lon1, double lat2, double lon2) {
        final double r = 6_371_000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
