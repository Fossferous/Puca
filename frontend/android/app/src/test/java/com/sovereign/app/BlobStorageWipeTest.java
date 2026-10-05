package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * {@link BlobStorageWipe}: at process start, the WebView's leftover blob
 * files go (they can hold decrypted attachments as they were), and nothing
 * else in the WebView's data does — its cookies and local storage are the
 * signed-in session.
 */
public class BlobStorageWipeTest {
    private File root;

    @Before
    public void setUp() throws IOException {
        root = Files.createTempDirectory("blobwipe").toFile();
    }

    @After
    public void tearDown() {
        deleteAll(root);
    }

    private static void deleteAll(File f) {
        File[] kids = f.listFiles();
        if (kids != null && !BlobStorageWipe.isSymlink(f)) for (File k : kids) deleteAll(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static File write(File dir, String name, int bytes) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File f = new File(dir, name);
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(new byte[bytes]); }
        return f;
    }

    @Test
    public void removesEverySessionDirectoryAndCountsWhatWent() throws IOException {
        File webview = new File(root, "app_webview");
        File bs = BlobStorageWipe.blobStorageDir(webview);
        write(new File(bs, "5dc9b11e-2b84-4568-8e74-b3b915ac3884"), "0", 1000);
        write(new File(bs, "5dc9b11e-2b84-4568-8e74-b3b915ac3884"), "13", 2000);
        write(new File(bs, "163f6151-81d4-47f4-9958-3d36cea04743"), "2", 300);

        BlobStorageWipe.Result r = BlobStorageWipe.wipe(webview);

        assertEquals(3, r.files);
        assertEquals(3300, r.bytes);
        assertFalse("blob_storage is gone (Chromium makes it again)", bs.exists());
    }

    @Test
    public void leavesTheRestOfTheWebViewDataAlone() throws IOException {
        File webview = new File(root, "app_webview");
        File def = new File(webview, "Default");
        File cookies = write(def, "Cookies", 10);
        File local = write(new File(def, "Local Storage"), "leveldb.log", 10);
        File opfs = write(new File(def, "File System"), "000", 10);
        write(new File(BlobStorageWipe.blobStorageDir(webview), "x"), "0", 10);

        BlobStorageWipe.wipe(webview);

        assertTrue(cookies.exists());
        assertTrue(local.exists());
        assertTrue("the cached ciphertext (OPFS) is the web layer's to sweep", opfs.exists());
        assertTrue(def.exists());
    }

    @Test
    public void nothingThereIsNothingToDo() {
        BlobStorageWipe.Result r = BlobStorageWipe.wipe(new File(root, "app_webview"));
        assertEquals(0, r.files);
        assertEquals(0, r.bytes);
    }

    @Test
    public void aSymbolicLinkIsRemovedNeverFollowed() throws IOException {
        File outside = new File(root, "outside");
        File precious = write(outside, "keep.txt", 5);
        File webview = new File(root, "app_webview");
        File session = new File(BlobStorageWipe.blobStorageDir(webview), "s");
        //noinspection ResultOfMethodCallIgnored
        session.mkdirs();
        try {
            Files.createSymbolicLink(new File(session, "link").toPath(), outside.toPath());
        } catch (UnsupportedOperationException | IOException | SecurityException e) {
            // No symlinks on this filesystem (Windows without the privilege):
            // what matters is checked where they can be made.
            org.junit.Assume.assumeNoException(e);
        }

        BlobStorageWipe.wipe(webview);

        assertTrue("the wipe went through a link into a directory it does not own", precious.exists());
        assertFalse(BlobStorageWipe.blobStorageDir(webview).exists());
    }
}
