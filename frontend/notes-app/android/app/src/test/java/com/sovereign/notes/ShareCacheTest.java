package com.sovereign.notes;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class ShareCacheTest {

    private File root;

    @Before
    public void setUp() throws Exception {
        root = Files.createTempDirectory("sharecache").toFile();
    }

    @After
    public void tearDown() {
        ShareCache.wipe(root);
        //noinspection ResultOfMethodCallIgnored
        root.delete();
    }

    private static File write(File dir, String name, long mtime) throws Exception {
        File f = new File(dir, name);
        try (FileOutputStream o = new FileOutputStream(f)) {
            o.write("- [ ] milk".getBytes("UTF-8"));
        }
        assertTrue(f.setLastModified(mtime));
        assertTrue(dir.setLastModified(mtime));
        return f;
    }

    @Test
    public void aSecondShareLeavesTheFirstStillReadable() throws Exception {
        long now = System.currentTimeMillis();
        File first = write(ShareCache.newShareDir(root, now - 60_000L), "notes.md", now - 60_000L);
        // the second share starts: prune, then its own directory
        ShareCache.pruneOlderThan(root, now, ShareCache.KEEP_MS);
        File second = write(ShareCache.newShareDir(root, now), "notes.md", now);
        assertTrue("the earlier target may still be reading it", first.exists());
        assertTrue(second.exists());
        assertNotEquals("the same file name must not overwrite the earlier copy",
                first.getParentFile(), second.getParentFile());
        assertArrayEquals("- [ ] milk".getBytes("UTF-8"), Files.readAllBytes(first.toPath()));
    }

    @Test
    public void copiesOlderThanTheWindowAreDeleted() throws Exception {
        long now = System.currentTimeMillis();
        File old = write(ShareCache.newShareDir(root, now - ShareCache.KEEP_MS - 60_000L), "old.md",
                now - ShareCache.KEEP_MS - 60_000L);
        File fresh = write(ShareCache.newShareDir(root, now - 1000L), "fresh.md", now - 1000L);
        ShareCache.pruneOlderThan(root, now, ShareCache.KEEP_MS);
        assertFalse(old.exists());
        assertFalse(old.getParentFile().exists());
        assertTrue(fresh.exists());
    }

    @Test
    public void signOutWipesEvenAFreshCopy() throws Exception {
        long now = System.currentTimeMillis();
        write(ShareCache.newShareDir(root, now), "fresh.md", now);
        ShareCache.wipe(root);
        String[] left = root.list();
        assertEquals(0, left == null ? 0 : left.length);
    }
}
