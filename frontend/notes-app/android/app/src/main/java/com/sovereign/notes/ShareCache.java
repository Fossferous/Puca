package com.sovereign.notes;

import java.io.File;

/**
 * The plaintext copies Share hands to other apps (cache/share/).
 *
 * Each share gets its OWN subdirectory, and only copies older than
 * {@link #KEEP_MS} are deleted when the next share starts: the target app
 * reads the content URI whenever it gets round to it (a slow Drive or mail
 * upload can take minutes), so deleting the previous file the moment another
 * share begins broke that earlier share. Sign-out still wipes everything
 * (NotesNativePlugin.clearAll). Pure java.io, JUnit-tested (ShareCacheTest).
 */
final class ShareCache {

    /** How long a shared copy stays readable for the app it was sent to. */
    static final long KEEP_MS = 15 * 60_000L;

    private ShareCache() {}

    /** A fresh, empty directory for one share, inside `root`. */
    static File newShareDir(File root, long now) throws java.io.IOException {
        for (int n = 0; n < 100; n++) {
            File d = new File(root, "s" + now + "-" + n);
            if (!d.exists()) {
                if (!d.mkdirs()) throw new java.io.IOException("no share directory");
                return d;
            }
        }
        throw new java.io.IOException("no free share directory");
    }

    /** Delete what was shared more than `keepMs` ago; keep the rest. */
    static void pruneOlderThan(File root, long now, long keepMs) {
        File[] kids = root.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (now - k.lastModified() > keepMs) delete(k);
        }
    }

    /** Everything, now (sign-out). */
    static void wipe(File root) {
        File[] kids = root.listFiles();
        if (kids == null) return;
        for (File k : kids) delete(k);
    }

    private static void delete(File f) {
        File[] kids = f.isDirectory() ? f.listFiles() : null;
        if (kids != null) for (File k : kids) delete(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
