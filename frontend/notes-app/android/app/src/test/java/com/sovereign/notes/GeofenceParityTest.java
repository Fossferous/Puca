package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Púca Notes carries a COPY of Púca's geofence engine, fence store and engine
 * test (two separate Gradle roots; the classes are package-bound). A copy that
 * drifts is two different location-reminder behaviours on one phone, so this
 * pins each copy to Púca's source byte for byte after the package line (line
 * endings normalised — a CRLF checkout is not a drift). It FAILS, never skips,
 * when Púca's source cannot be found: a parity check that can silently not
 * run is the "tests that are never run" failure CLAUDE.md warns about.
 */
public class GeofenceParityTest {

    private static File frontend() {
        // Gradle runs unit tests with the module (notes-app/android/app) as cwd.
        File f = new File(System.getProperty("user.dir")).getAbsoluteFile();
        for (int i = 0; i < 6 && f != null; i++, f = f.getParentFile()) {
            if (new File(f, "android/app/src/main/java/com/sovereign/app").isDirectory()
                    && new File(f, "notes-app").isDirectory()) {
                return f;
            }
        }
        throw new AssertionError("could not find frontend/ from " + System.getProperty("user.dir"));
    }

    private static String afterPackageLine(File file) throws Exception {
        assertTrue("missing " + file, file.isFile());
        String s = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).replace("\r\n", "\n");
        assertTrue(file + " must start with its package line", s.startsWith("package com.sovereign."));
        return s.substring(s.indexOf('\n') + 1);
    }

    private static void same(String pucaPath, String notesPath) throws Exception {
        File root = frontend();
        String puca = afterPackageLine(new File(root, pucaPath));
        String notes = afterPackageLine(new File(root, notesPath));
        assertEquals(notesPath + " has drifted from Púca's " + pucaPath + " — change both, together", puca, notes);
    }

    @Test
    public void engineMatchesPuca() throws Exception {
        same("android/app/src/main/java/com/sovereign/app/GeofenceEngine.java",
                "notes-app/android/app/src/main/java/com/sovereign/notes/GeofenceEngine.java");
    }

    @Test
    public void storeMatchesPuca() throws Exception {
        same("android/app/src/main/java/com/sovereign/app/GeofenceStore.java",
                "notes-app/android/app/src/main/java/com/sovereign/notes/GeofenceStore.java");
    }

    @Test
    public void engineTestMatchesPuca() throws Exception {
        same("android/app/src/test/java/com/sovereign/app/GeofenceEngineTest.java",
                "notes-app/android/app/src/test/java/com/sovereign/notes/GeofenceEngineTest.java");
    }
}
