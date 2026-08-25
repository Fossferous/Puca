package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * JVM tests for the geofence decision core. This is the only part of the
 * native layer that can run off-device, and it is where the subtle bugs live
 * (baselines, hysteresis, re-arming) — the LocationManager plumbing around it
 * is thin by design. NOTE: `cargo test` and the frontend gates never run
 * these; run `gradlew test` in frontend/android when touching the engine.
 *
 * Geometry helper: at this latitude band one degree of latitude is ~111 km,
 * so 0.001° ≈ 111 m — fixtures step in latitude only to keep distances easy
 * to reason about.
 */
public class GeofenceEngineTest {

    private static final double LAT = 51.5;
    private static final double LON = -0.12;

    private static GeofenceEngine.Fence fence(String id, double radiusM) {
        return new GeofenceEngine.Fence(id, LAT, LON, radiusM);
    }

    /** A latitude offset that is `meters` away from (LAT, LON). */
    private static double latAt(double meters) {
        return LAT + meters / 111_320.0;
    }

    /** A LONGITUDE offset `meters` away — meters-per-degree shrinks by
     *  cos(lat) east-west, so this exercises the half of the haversine the
     *  latitude fixtures never touch. */
    private static double lonAt(double meters) {
        return LON + meters / (111_320.0 * Math.cos(Math.toRadians(LAT)));
    }

    private static GeofenceEngine engineWith(GeofenceEngine.Fence... fences) {
        GeofenceEngine e = new GeofenceEngine();
        e.setFences(Arrays.asList(fences));
        return e;
    }

    @Test
    public void haversineSanity() {
        double d = GeofenceEngine.distanceM(LAT, LON, latAt(150), LON);
        assertTrue("expected ~150m north, got " + d, Math.abs(d - 150) < 2);
        double e = GeofenceEngine.distanceM(LAT, LON, LAT, lonAt(150));
        assertTrue("expected ~150m east, got " + e, Math.abs(e - 150) < 2);
    }

    /** East-west entry: a longitude-only approach must fire exactly like the
     *  latitude ones — without this, a broken cos()/dLon term (which every
     *  other fixture holds at zero) would pass the whole suite. */
    @Test
    public void entryAcrossLongitudeFires() {
        GeofenceEngine e = engineWith(fence("42", 150));
        assertEquals(0, e.onFix(LAT, lonAt(1000), 10f).fired.size()); // baseline: outside
        assertEquals(Collections.singletonList("42"), e.onFix(LAT, lonAt(50), 10f).fired);
    }

    // Positive control first: prove the rig CAN fire, so every "does not
    // fire" assertion below means something.
    @Test
    public void entryFromOutsideFires() {
        GeofenceEngine e = engineWith(fence("42", 150));
        assertEquals(0, e.onFix(latAt(1000), LON, 10f).fired.size()); // baseline: outside
        List<String> fired = e.onFix(latAt(50), LON, 10f).fired;      // walk in
        assertEquals(Collections.singletonList("42"), fired);
    }

    @Test
    public void baselineInsideIsSilent_untilExitAndReentry() {
        GeofenceEngine e = engineWith(fence("42", 150));
        // First-ever fix already inside: creating a reminder while standing
        // at the place (or a process restart there) must not fire.
        assertEquals(0, e.onFix(latAt(0), LON, 10f).fired.size());
        assertEquals(0, e.onFix(latAt(50), LON, 10f).fired.size());   // still inside
        assertEquals(0, e.onFix(latAt(1000), LON, 10f).fired.size()); // leave
        assertEquals(1, e.onFix(latAt(50), LON, 10f).fired.size());   // return → fires
    }

    @Test
    public void firesOncePerVisit_withHysteresis() {
        GeofenceEngine e = engineWith(fence("42", 150));
        e.onFix(latAt(1000), LON, 10f);                               // baseline outside
        assertEquals(1, e.onFix(latAt(100), LON, 10f).fired.size());  // enter
        assertEquals(0, e.onFix(latAt(100), LON, 10f).fired.size());  // linger
        // The fixtures BRACKET the exit threshold (150*1.5+50 = 275 m) from
        // ~10 m either side, so they pin the actual formula rather than any
        // band that happens to lie between "past the radius" and "far away":
        // 265 (inside the band) must NOT re-arm...
        assertEquals(0, e.onFix(latAt(265), LON, 10f).fired.size());
        // ...so bouncing back in must NOT re-fire.
        assertEquals(0, e.onFix(latAt(100), LON, 10f).fired.size());
        // ...while 290 (just past it) re-arms, and the next entry fires.
        assertEquals(0, e.onFix(latAt(290), LON, 10f).fired.size());
        assertEquals(1, e.onFix(latAt(100), LON, 10f).fired.size());
    }

    @Test
    public void untrustedFixesChangeNothing() {
        GeofenceEngine e = engineWith(fence("42", 150));
        e.onFix(latAt(1000), LON, 10f);                               // baseline outside
        // A 500m-accuracy blob "inside" is noise: no fire, no state change.
        assertEquals(0, e.onFix(latAt(0), LON, 500f).fired.size());
        // The armed state survived the garbage fix — a good fix still fires.
        assertEquals(1, e.onFix(latAt(0), LON, 10f).fired.size());
    }

    @Test
    public void editedFenceResetsToBaseline() {
        GeofenceEngine e = engineWith(fence("42", 150));
        e.onFix(latAt(1000), LON, 10f);                               // armed
        // Same id, MOVED circle (place edited — the center changes, not just
        // the radius): old armed state is about a different place and must
        // not carry over. If it did, the fix inside the new circle would be
        // an outside->inside transition and FIRE; instead it baselines.
        e.setFences(Collections.singletonList(
                new GeofenceEngine.Fence("42", latAt(100), LON, 150)));
        assertEquals(0, e.onFix(latAt(100), LON, 10f).fired.size());  // silent baseline
    }

    @Test
    public void unchangedFenceKeepsArmedStateAcrossSetFences() {
        GeofenceEngine e = engineWith(fence("42", 150));
        e.onFix(latAt(1000), LON, 10f);                               // armed
        // Re-push of the same set plus a newcomer (the JS syncs wholesale).
        e.setFences(Arrays.asList(fence("42", 150), fence("99", 150)));
        // The surviving fence still fires on entry; the newcomer baselines.
        assertEquals(Collections.singletonList("42"),
                e.onFix(latAt(50), LON, 10f).fired);
    }

    @Test
    public void everyTaskAtThePlaceFires() {
        GeofenceEngine e = engineWith(fence("1", 150), fence("2", 150));
        e.onFix(latAt(1000), LON, 10f);
        assertEquals(2, e.onFix(latAt(0), LON, 10f).fired.size());
    }

    @Test
    public void intervalAdaptsToDistance() {
        GeofenceEngine e = engineWith(fence("42", 150));
        // 20 km out: nothing can change for a long while → ceiling.
        assertEquals(GeofenceEngine.MAX_INTERVAL_MS,
                e.onFix(latAt(20_000), LON, 10f).nextIntervalMs);
        // 200 m out (50 m to the edge): could enter within seconds → floor.
        assertEquals(GeofenceEngine.MIN_INTERVAL_MS,
                e.onFix(latAt(200), LON, 10f).nextIntervalMs);
    }
}
