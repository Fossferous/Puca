package com.sovereign.app;

import java.io.File;
import java.io.IOException;

/**
 * Removes what the WebView's blob storage left on disk by an earlier run of
 * the app: {@code app_webview/Default/blob_storage}.
 *
 * <p>Chromium keeps a page's blobs in memory only up to 1% of the phone's
 * RAM and writes the rest there as they are, so a decrypted picture or video
 * on screen is a PLAINTEXT file while it is shown (measured 2026-10-05 on a
 * 2 GB emulator: 79 of 85 MB of a channel's decrypted attachments). The app
 * lets go of them when it leaves the screen or goes to the background (the
 * web layer: api/attachmentAwake.ts, api/plaintextHost.ts), and the WebView
 * deletes the files of a normal close itself. What neither can cover is a
 * process that dies while they are on screen (a crash, or the system killing
 * it): the files stay until the WebView next starts and sweeps them, and a
 * start that never opens the WebView (a push wake, a widget update) never
 * does. This runs as the process starts, before any WebView exists in it, so
 * the next start of ANY kind removes them.
 *
 * <p>Safe only there: the files of a live WebView's blobs must never be
 * removed (its pictures and players would break). The app runs in one
 * process and Android lets only one process use a WebView data directory at
 * a time, so at process start nothing can be using them. Chromium makes a
 * new session directory under blob_storage when it starts (measured: it
 * recreates blob_storage too).
 *
 * <p>Pure Java (no Android imports): {@link BlobStorageWipeTest} runs it
 * under plain JUnit against real temporary directories.
 */
final class BlobStorageWipe {
    private BlobStorageWipe() {}

    /** What a wipe removed: files and their bytes. */
    static final class Result {
        final int files;
        final long bytes;
        Result(int files, long bytes) { this.files = files; this.bytes = bytes; }
    }

    /** {@code <webviewDir>/Default/blob_storage}, where {@code webviewDir} is the app's {@code app_webview}. */
    static File blobStorageDir(File webviewDir) {
        return new File(new File(webviewDir, "Default"), "blob_storage");
    }

    /**
     * Delete {@code blobStorageDir(webviewDir)} and everything in it. A
     * missing directory is nothing to do. Symbolic links are removed, never
     * followed (nothing but Chromium writes there; this is belt and braces).
     */
    static Result wipe(File webviewDir) {
        File dir = blobStorageDir(webviewDir);
        long[] counts = new long[2];
        if (dir.exists()) deleteTree(dir, counts);
        return new Result((int) counts[0], counts[1]);
    }

    private static void deleteTree(File f, long[] counts) {
        if (f.isDirectory() && !isSymlink(f)) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteTree(c, counts);
        } else {
            counts[0]++;
            counts[1] += f.length();
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** True when {@code f} is itself a symbolic link (API 24 has no java.nio.file). */
    static boolean isSymlink(File f) {
        try {
            File parent = f.getParentFile();
            if (parent == null) return false;
            File inCanonicalParent = new File(parent.getCanonicalFile(), f.getName());
            return !inCanonicalParent.getCanonicalFile().equals(inCanonicalParent.getAbsoluteFile());
        } catch (IOException e) {
            return true; // cannot tell: treat as a link, i.e. do not descend
        }
    }
}
