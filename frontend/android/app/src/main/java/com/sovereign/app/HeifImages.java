package com.sovereign.app;

/**
 * The pure half of turning a HEIC photo into a JPEG (JUnit): is it one, and
 * by how much to shrink it while decoding.
 *
 * <p>WHY. The WebView cannot decode HEIC (no Chromium can), and it is what
 * most phone cameras save, so a photo picked from the gallery and sent as it
 * is showed as a broken picture to nearly every reader (the owner's
 * IMG20261023012318.heic, 2026-10-23). The page hands the bytes to
 * {@link SovereignAppPlugin#heifToJpeg} before it encrypts them (and, for one
 * someone already sent, to show it), and Android's own ImageDecoder (API 28+)
 * decodes them. frontend/src/api/heif.ts is the other half; its sniff and
 * this one agree.
 */
final class HeifImages {

    private HeifImages() {}

    /** The largest HEIC the page hands over (api/heif.ts
     *  MAX_NATIVE_HEIF_BYTES_ANDROID): it arrives as base64 inside Capacitor's
     *  JSON message, copied by the WebView and by Java before a byte is
     *  decoded, so it is kept to what a phone photo is. */
    static final long MAX_INPUT_BYTES = 16L * 1024 * 1024;
    /** The most pixels decoded: what src-tauri/src/heif.rs allows too. A
     *  50 MP phone photo is half of it (a 200 MP one is not converted here; it
     *  is past the size cap long before). */
    static final long MAX_PIXELS = 100_000_000L;

    /** May base64 of this many characters be decoded? */
    static boolean inputFits(long base64Chars) {
        return base64Chars > 0 && base64Chars <= (MAX_INPUT_BYTES + 2) / 3 * 4;
    }

    /** May a picture of this size be decoded? (Before the sample size: the
     *  decoder reads the whole picture to make even a sampled one.) */
    static boolean pixelsFit(int width, int height) {
        return width > 0 && height > 0 && (long) width * height <= MAX_PIXELS;
    }

    /** ISO-BMFF brands of HEIF coded in HEVC (ISO/IEC 23008-12). */
    private static final String[] HEVC_BRANDS = {"heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"};
    /** The generic HEIF brands, which AVIF uses too: a HEIC only with an
     *  HEVC brand beside them and no AVIF one. */
    private static final String[] GENERIC_BRANDS = {"mif1", "msf1", "heif"};
    private static final String[] AV1_BRANDS = {"avif", "avis"};

    /** Do these bytes open as a HEVC-coded HEIF? Reads the {@code ftyp} box. */
    static boolean isHeif(byte[] b) {
        if (b == null || b.length < 16) return false;
        if (!ascii(b, 4).equals("ftyp")) return false;
        long size = ((b[0] & 0xffL) << 24) | ((b[1] & 0xffL) << 16) | ((b[2] & 0xffL) << 8) | (b[3] & 0xffL);
        int end = (int) Math.min(b.length, size >= 16 ? size : 16);
        String major = ascii(b, 8);
        boolean hevc = in(HEVC_BRANDS, major);
        for (int at = 16; at + 4 <= end; at += 4) {
            String brand = ascii(b, at);
            if (in(AV1_BRANDS, brand)) return false;
            if (in(HEVC_BRANDS, brand)) hevc = true;
        }
        if (in(AV1_BRANDS, major)) return false;
        return in(HEVC_BRANDS, major) || (in(GENERIC_BRANDS, major) && hevc);
    }

    /**
     * The sample size (ImageDecoder.setTargetSampleSize) that brings the long
     * edge to at most {@code maxEdge}: 1 for a photo that already fits. A
     * uniform factor, so it cannot distort the picture whichever way round
     * the decoder reports a rotated photo's size.
     */
    static int sampleSizeFor(int width, int height, int maxEdge) {
        int longEdge = Math.max(width, height);
        if (maxEdge <= 0 || longEdge <= maxEdge) return 1;
        return (longEdge + maxEdge - 1) / maxEdge;
    }

    /** JPEG quality 0..100 from the page's 0..1, kept to a sane range. */
    static int jpegQuality(double q) {
        if (Double.isNaN(q)) return 90;
        return (int) Math.round(Math.max(0.5, Math.min(1.0, q)) * 100);
    }

    private static String ascii(byte[] b, int at) {
        char[] c = new char[4];
        for (int i = 0; i < 4; i++) c[i] = (char) (b[at + i] & 0xff);
        return new String(c);
    }

    private static boolean in(String[] set, String s) {
        for (String x : set) if (x.equals(s)) return true;
        return false;
    }
}
