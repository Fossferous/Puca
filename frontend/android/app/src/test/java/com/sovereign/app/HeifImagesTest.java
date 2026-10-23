package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

/**
 * Which bytes the phone decodes as a HEIC for the page, and how much it
 * shrinks them (SovereignAppPlugin.heifToJpeg). The same rules as
 * frontend/src/api/heif.ts's sniffHeif (heif.test.ts holds the same cases).
 */
public class HeifImagesTest {

    /** An ftyp box: major brand, minor version 0, then compatible brands. */
    private static byte[] ftyp(String major, String... compatible) {
        int size = 16 + 4 * compatible.length;
        byte[] b = new byte[size + 8];
        b[0] = (byte) (size >>> 24);
        b[1] = (byte) (size >>> 16);
        b[2] = (byte) (size >>> 8);
        b[3] = (byte) size;
        put(b, 4, "ftyp");
        put(b, 8, major);
        for (int i = 0; i < compatible.length; i++) put(b, 16 + 4 * i, compatible[i]);
        put(b, size + 4, "meta");
        return b;
    }

    private static void put(byte[] b, int at, String s) {
        byte[] a = s.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(a, 0, b, at, 4);
    }

    @Test
    public void theFixturesHeaderIsAHeic() {
        // The first 32 bytes of frontend/src/tests/fixtures/heic/rotated-gps.heic
        // (libheif's output): major "heic", compatible mif1 heic miaf.
        byte[] head = {
            0, 0, 0, 0x1c, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c', 0, 0, 0, 0,
            'm', 'i', 'f', '1', 'h', 'e', 'i', 'c', 'm', 'i', 'a', 'f', 0, 0, 0x01, (byte) 0xc8,
        };
        assertTrue(HeifImages.isHeif(head));
    }

    @Test
    public void phoneBrandsAreHeic() {
        assertTrue(HeifImages.isHeif(ftyp("heic", "mif1", "heic")));
        assertTrue(HeifImages.isHeif(ftyp("heix", "mif1")));
        assertTrue(HeifImages.isHeif(ftyp("hevc", "msf1")));
        // Samsung/Android HeifWriter: major mif1, HEVC among the compatible.
        assertTrue(HeifImages.isHeif(ftyp("mif1", "mif1", "heic")));
    }

    @Test
    public void avifAndOtherIsoMediaAreNot() {
        assertFalse(HeifImages.isHeif(ftyp("avif", "mif1", "miaf")));
        assertFalse(HeifImages.isHeif(ftyp("mif1", "avif", "mif1", "miaf")));
        // An AVIF brand anywhere wins, even next to a HEVC one.
        assertFalse(HeifImages.isHeif(ftyp("mif1", "heic", "avif")));
        // A generic HEIF with nothing HEVC in it is not one this decodes.
        assertFalse(HeifImages.isHeif(ftyp("mif1", "miaf")));
        assertFalse(HeifImages.isHeif(ftyp("isom", "mp41")));
        assertFalse(HeifImages.isHeif(ftyp("qt  ")));
    }

    @Test
    public void notAnFtypAtAll() {
        assertFalse(HeifImages.isHeif(null));
        assertFalse(HeifImages.isHeif(new byte[0]));
        assertFalse(HeifImages.isHeif(new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1}));
        byte[] shifted = ftyp("heic", "mif1");
        put(shifted, 4, "free");
        assertFalse(HeifImages.isHeif(shifted));
    }

    @Test
    public void aBoxSizeLargerThanTheBytesDoesNotReadPastThem() {
        byte[] b = ftyp("mif1", "heic");
        b[0] = 0x7f; // claims ~2 GB
        assertTrue(HeifImages.isHeif(b));
        byte[] tiny = ftyp("mif1");
        tiny[3] = (byte) 0xff;
        assertFalse(HeifImages.isHeif(tiny));
    }

    @Test
    public void sampleSizeKeepsAPhoneSizedPhotoWhole() {
        assertEquals(1, HeifImages.sampleSizeFor(4000, 3000, 4096));
        assertEquals(1, HeifImages.sampleSizeFor(3000, 4000, 4096));
        assertEquals(1, HeifImages.sampleSizeFor(4096, 4096, 4096));
    }

    @Test
    public void sampleSizeBringsTheLongEdgeUnderTheCap() {
        // A 50 MP phone photo: 8160 / 2 = 4080.
        assertEquals(2, HeifImages.sampleSizeFor(8160, 6120, 4096));
        assertEquals(2, HeifImages.sampleSizeFor(6120, 8160, 4096));
        assertEquals(3, HeifImages.sampleSizeFor(12000, 9000, 4096));
        for (int edge : new int[] {4097, 8193, 20000, 100000}) {
            int n = HeifImages.sampleSizeFor(edge, 10, 4096);
            assertTrue(edge + " / " + n, (edge + n - 1) / n <= 4096);
        }
        assertEquals(1, HeifImages.sampleSizeFor(100, 100, 0));
    }

    @Test
    public void inputCapMatchesThePage() {
        // 16 MB of photo is 22369624 base64 characters (the page's cap).
        assertTrue(HeifImages.inputFits(22_369_624));
        assertFalse(HeifImages.inputFits(22_369_628));
        assertFalse(HeifImages.inputFits(0));
        assertTrue(HeifImages.inputFits(4_000_000)); // a 3 MB phone photo
    }

    @Test
    public void pixelCapLetsPhonePhotosThrough() {
        assertTrue(HeifImages.pixelsFit(4000, 3000));
        assertTrue(HeifImages.pixelsFit(8160, 6120));   // 50 MP
        assertTrue(HeifImages.pixelsFit(10000, 10000));  // the cap itself
        assertFalse(HeifImages.pixelsFit(16320, 12240)); // 200 MP
        assertFalse(HeifImages.pixelsFit(20000, 20000));
        assertFalse(HeifImages.pixelsFit(65535, 65535));
        assertFalse(HeifImages.pixelsFit(0, 100));
    }

    @Test
    public void jpegQualityFromThePage() {
        assertEquals(90, HeifImages.jpegQuality(0.9));
        assertEquals(100, HeifImages.jpegQuality(3));
        assertEquals(50, HeifImages.jpegQuality(0.01));
        assertEquals(90, HeifImages.jpegQuality(Double.NaN));
    }
}
