package com.sovereign.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Where a download lands and what it is called — decided by the BYTES, with
 * the sender's name and MIME treated as the untrusted strings they are.
 */
public class SaveTargetTest {

    private static final Map<String, String> EXT = new HashMap<>();
    static {
        EXT.put("mp4", "video/mp4");
        EXT.put("jpg", "image/jpeg");
        EXT.put("svg", "image/svg+xml");
        EXT.put("html", "text/html");
        EXT.put("pdf", "application/pdf");
        EXT.put("zip", "application/zip");
        EXT.put("txt", "text/plain");
        EXT.put("mp3", "audio/mpeg");
        EXT.put("weird", "not a mime");
        EXT.put("avi", "video/x-msvideo");
        EXT.put("ts", "video/mp2t");
        EXT.put("bmp", "image/bmp");
        EXT.put("ogv", "video/ogg");
    }
    private static final SaveTarget.ExtensionMimes MIMES = EXT::get;

    private static byte[] mp4(String brand) {
        byte[] b = new byte[32];
        b[3] = 24;
        System.arraycopy("ftyp".getBytes(StandardCharsets.ISO_8859_1), 0, b, 4, 4);
        System.arraycopy(brand.getBytes(StandardCharsets.ISO_8859_1), 0, b, 8, 4);
        return b;
    }

    private static byte[] of(int... v) {
        byte[] b = new byte[v.length];
        for (int i = 0; i < v.length; i++) b[i] = (byte) v[i];
        return b;
    }

    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.ISO_8859_1);
    }

    private static SaveTarget decide(byte[] head, String name, String mime) {
        return SaveTarget.decide(head, head.length, name, mime, MIMES);
    }

    @Test
    public void mediaIsPlacedByWhatItIs() {
        SaveTarget v = decide(mp4("isom"), "puca-clip-c36b9fd2-20261005-001700.mp4", "video/mp4");
        assertEquals(SaveTarget.Collection.VIDEO, v.collection);
        assertEquals("video/mp4", v.mime);
        assertEquals("Movies/Puca/", v.relativePath());
        assertEquals("puca-clip-c36b9fd2-20261005-001700.mp4", v.displayName);

        SaveTarget jpg = decide(of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), "photo.JPG", "image/jpeg");
        assertEquals(SaveTarget.Collection.IMAGE, jpg.collection);
        assertEquals("Pictures/Puca/", jpg.relativePath());
        assertEquals("photo.JPG", jpg.displayName);

        SaveTarget png = decide(of(0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a), "x.png", "");
        assertEquals("image/png", png.mime);
        SaveTarget webp = decide(ascii("RIFF\0\0\0\0WEBPVP8 "), "x.webp", "");
        assertEquals("image/webp", webp.mime);
        SaveTarget gif = decide(ascii("GIF89a"), "x.gif", "");
        assertEquals("image/gif", gif.mime);
        SaveTarget heic = decide(mp4("heic"), "IMG_1.HEIC", "image/heic");
        assertEquals(SaveTarget.Collection.IMAGE, heic.collection);

        SaveTarget mp3 = decide(ascii("ID3\u0004\0\0\0\0\0\0"), "song.mp3", "audio/mpeg");
        assertEquals(SaveTarget.Collection.AUDIO, mp3.collection);
        assertEquals("Music/Puca/", mp3.relativePath());
        SaveTarget ogg = decide(ascii("OggS\0\u0002"), "voice.opus", "audio/ogg");
        assertEquals("audio/ogg", ogg.mime);
        assertEquals("voice.opus", ogg.displayName);
        SaveTarget m4a = decide(mp4("M4A "), "a.m4a", "");
        assertEquals("audio/mp4", m4a.mime);
        SaveTarget wav = decide(ascii("RIFF\0\0\0\0WAVEfmt "), "a.wav", "");
        assertEquals("audio/wav", wav.mime);
        SaveTarget flac = decide(ascii("fLaC\0\0\0\""), "a.flac", "");
        assertEquals("audio/flac", flac.mime);
        SaveTarget webm = decide(of(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, 'w', 'e', 'b', 'm'), "v.webm", "video/webm");
        assertEquals("video/webm", webm.mime);
        SaveTarget mkv = decide(of(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, 'm', 'a', 't', 'r', 'o', 's', 'k', 'a'), "v.mkv", "");
        assertEquals("video/x-matroska", mkv.mime);
        SaveTarget mov = decide(mp4("qt  "), "v.mov", "video/quicktime");
        assertEquals("video/quicktime", mov.mime);
    }

    @Test
    public void theSendersMimeOnlyTellsAudioFromVideoInsideAContainer() {
        // an .m4a whose brand is the generic isom: audio, because the sender said so
        SaveTarget a = decide(mp4("isom"), "song.m4a", "audio/mp4");
        assertEquals(SaveTarget.Collection.AUDIO, a.collection);
        assertEquals("song.m4a", a.displayName);
        // but a sender cannot make a JPEG "audio", nor random bytes "video"
        assertEquals(SaveTarget.Collection.IMAGE, decide(of(0xff, 0xd8, 0xff, 0xdb), "x.mp3", "audio/mpeg").collection);
        assertEquals(SaveTarget.Collection.DOWNLOAD, decide(ascii("hello world"), "x.mp4", "video/mp4").collection);
    }

    @Test
    public void aNameThatLiesAboutTheBytesGetsTheRightExtension() {
        SaveTarget v = decide(mp4("isom"), "invoice.html", "text/html");
        assertEquals("video/mp4", v.mime);
        assertEquals("invoice.html.mp4", v.displayName);
        SaveTarget noExt = decide(of(0xff, 0xd8, 0xff), "photo", "");
        assertEquals("photo.jpg", noExt.displayName);
    }

    @Test
    public void bytesThatAreNotMediaNeverReachAGalleryWhateverTheyAreCalled() {
        SaveTarget fake = decide(ascii("<html><script>"), "cat.mp4", "video/mp4");
        assertEquals(SaveTarget.Collection.DOWNLOAD, fake.collection);
        assertEquals("application/octet-stream", fake.mime); // .mp4 claims media: refused
        assertEquals("Download/Puca/", fake.relativePath());
        // MediaStore's scanner types a file by its EXTENSION once it is
        // published (measured on the emulator, 2026-10-05: an HTML file saved
        // as "fake-video.mp4" with application/octet-stream became
        // media_type VIDEO, mime video/mp4, listed in the video collection).
        // So a name that claims media the bytes are not gets a neutral one.
        assertEquals("cat.mp4.bin", fake.displayName);

        SaveTarget svg = decide(ascii("<svg xmlns=..."), "logo.svg", "image/svg+xml");
        assertEquals(SaveTarget.Collection.DOWNLOAD, svg.collection);
        assertEquals("application/octet-stream", svg.mime);
        assertEquals("logo.svg.bin", svg.displayName);
        assertEquals("song.mp3.bin", decide(ascii("<html>"), "song.mp3", "").displayName);

        SaveTarget pdf = decide(ascii("%PDF-1.7"), "report.pdf", "application/pdf");
        assertEquals(SaveTarget.Collection.DOWNLOAD, pdf.collection);
        assertEquals("application/pdf", pdf.mime);

        SaveTarget zip = decide(of('P', 'K', 3, 4), "photos.zip", "");
        assertEquals("application/zip", zip.mime);
        SaveTarget html = decide(ascii("<!doctype html>"), "page.html", "text/html");
        assertEquals("text/html", html.mime);
        assertEquals("application/octet-stream", decide(ascii("x"), "a.weird", "").mime);
        assertEquals("application/octet-stream", decide(ascii("x"), "noextension", "").mime);
        // an HLS playlist is not media, whatever its ref said
        SaveTarget m3u = decide(ascii("#EXTM3U\n#EXT-X-VERSION:3"), "a.mp3", "audio/mpeg");
        assertEquals(SaveTarget.Collection.DOWNLOAD, m3u.collection);
        assertEquals("a.mp3.bin", m3u.displayName);
        // names that claim nothing keep exactly what they were
        assertEquals("report.pdf", decide(ascii("%PDF-1.7"), "report.pdf", "").displayName);
        assertEquals("noextension", decide(ascii("x"), "noextension", "").displayName);
    }

    /** Real media in formats beyond the everyday ones is still placed by what it is,
     *  rather than being renamed .bin for claiming media. */
    @Test
    public void lessCommonMediaFormatsAreRecognisedToo() {
        byte[] avi = ascii("RIFF\0\0\0\0AVI LIST");
        SaveTarget a = decide(avi, "old.avi", "video/x-msvideo");
        assertEquals(SaveTarget.Collection.VIDEO, a.collection);
        assertEquals("video/x-msvideo", a.mime);
        assertEquals("old.avi", a.displayName);

        byte[] ts = new byte[600];
        ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
        SaveTarget t = decide(ts, "rec.ts", "");
        assertEquals("video/mp2t", t.mime);
        assertEquals("rec.ts", t.displayName);
        byte[] m2ts = new byte[600];
        m2ts[4] = 0x47; m2ts[196] = 0x47; m2ts[388] = 0x47;
        assertEquals("video/mp2t", decide(m2ts, "cam.m2ts", "").mime);
        byte[] notTs = new byte[600];
        notTs[0] = 0x47; notTs[188] = 0x47; // only two sync bytes: not enough
        assertNull(SaveTarget.sniff(notTs, notTs.length, ""));

        assertEquals("video/mpeg", decide(of(0, 0, 1, 0xba, 0x44), "dvd.mpg", "").mime);
        assertEquals("video/x-flv", decide(ascii("FLV\u0001\u0005"), "x.flv", "").mime);
        byte[] asf = of(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c);
        assertEquals("video/x-ms-wmv", decide(asf, "clip.wmv", "").mime);
        assertEquals("audio/x-ms-wma", decide(asf, "song.wma", "audio/x-ms-wma").mime);
        assertEquals(SaveTarget.Collection.AUDIO, decide(asf, "song.wma", "audio/x-ms-wma").collection);

        byte[] bmp = new byte[32];
        bmp[0] = 'B'; bmp[1] = 'M'; bmp[14] = 40;
        assertEquals("image/bmp", decide(bmp, "x.bmp", "").mime);
        byte[] notBmp = ascii("BMW is a car, not a bitmap at all");
        assertNull(SaveTarget.sniff(notBmp, notBmp.length, ""));
        assertEquals("image/tiff", decide(of('I', 'I', 42, 0, 8, 0, 0, 0), "scan.tif", "").mime);
        assertEquals("scan.dng", decide(of('M', 'M', 0, 42, 0, 0, 0, 8), "scan.dng", "").displayName);
        byte[] ico = new byte[22];
        ico[2] = 1; ico[4] = 1; ico[6] = 16; ico[7] = 16;
        assertEquals(SaveTarget.Collection.IMAGE, decide(ico, "favicon.ico", "").collection);
        ico[9] = 7; // a reserved byte that is not 0: not an icon directory
        assertNull(SaveTarget.sniff(ico, ico.length, ""));
        SaveTarget cr3 = decide(mp4("crx "), "IMG_1.CR3", "");
        assertEquals(SaveTarget.Collection.IMAGE, cr3.collection);

        assertEquals("audio/aiff", decide(ascii("FORM\0\0\0\0AIFFCOMM"), "a.aiff", "").mime);
        assertEquals("audio/amr", decide(ascii("#!AMR\n<"), "memo.amr", "").mime);
        assertEquals("audio/amr-wb", decide(ascii("#!AMR-WB\n"), "memo.awb", "").mime);
        assertEquals("audio/midi", decide(ascii("MThd\0\0\0\u0006"), "tune.mid", "").mime);

        byte[] theora = new byte[64];
        System.arraycopy(ascii("OggS"), 0, theora, 0, 4);
        System.arraycopy(ascii("\u0080theora"), 0, theora, 28, 7);
        SaveTarget ogv = decide(theora, "film.ogv", "");
        assertEquals(SaveTarget.Collection.VIDEO, ogv.collection);
        assertEquals("film.ogv", ogv.displayName);
    }

    @Test
    public void mpegAudioFramesNeedAPlausibleHeader() {
        assertNotNull(SaveTarget.sniff(of(0xff, 0xfb, 0x90, 0x64), 4, ""));          // MPEG-1 layer III
        assertEquals("audio/aac", SaveTarget.sniff(of(0xff, 0xf1, 0x50, 0x80), 4, "").mime); // ADTS
        assertNull(SaveTarget.sniff(of(0xff, 0xff, 0xff, 0xff), 4, ""));             // bad bitrate / version
        assertNull(SaveTarget.sniff(of(0xff, 0xe9, 0x90, 0x64), 4, ""));             // reserved version
    }

    @Test
    public void namesCannotClimbOutHideOrSpoof() {
        assertEquals("_.._.._etc_passwd", SaveTarget.sanitize("/../../etc/passwd"));
        assertEquals("a_b_c_d_e_f_g_h_i", SaveTarget.sanitize("a\\b/c:d*e?f\"g<h>i"));
        assertEquals("hidden", SaveTarget.sanitize("...hidden"));
        assertEquals("file", SaveTarget.sanitize(".."));
        assertEquals("file", SaveTarget.sanitize(""));
        assertEquals("file", SaveTarget.sanitize(null));
        assertEquals("name.txt", SaveTarget.sanitize("name.txt. . "));
        assertEquals("ab", SaveTarget.sanitize("a\u0000\u0007\u001b\u007f\u0085b"));
        // a right-to-left override would make this read as "evilexe.mp4"
        assertEquals("evil4pm.exe", SaveTarget.sanitize("evil‮4pm.exe"));
        assertEquals("ab", SaveTarget.sanitize("a⁦‏‎؜​﻿b"));
        assertEquals("a b", SaveTarget.sanitize("a \t\n  b"));
        assertEquals("þúça 😀.png", SaveTarget.sanitize("þúça 😀.png"));
    }

    @Test
    public void longNamesAreCappedKeepingTheirExtension() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 400; i++) sb.append('x');
        String s = SaveTarget.sanitize(sb + ".mp4");
        assertTrue(s.endsWith(".mp4"));
        assertTrue(s.length() <= SaveTarget.MAX_NAME_CHARS);
        StringBuilder emoji = new StringBuilder();
        for (int i = 0; i < 100; i++) emoji.append("😀");
        String e = SaveTarget.sanitize(emoji + ".jpg");
        assertTrue(e.endsWith(".jpg"));
        assertTrue(e.getBytes(StandardCharsets.UTF_8).length <= SaveTarget.MAX_NAME_UTF8);
        assertFalse("never a lone surrogate", Character.isHighSurrogate(e.charAt(e.length() - 5)));
        assertArrayEquals(e.getBytes(StandardCharsets.UTF_8), new String(e.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8).getBytes(StandardCharsets.UTF_8));
    }
}
