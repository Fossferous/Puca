package com.sovereign.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * The native download path against vectors the REAL JS sealing produced
 * (download-vectors.json; frontend/src/tests/downloadVectors.test.ts proves
 * that file is byte-for-byte what clipCrypto.ts sealPart and attachments.ts
 * sealFileForUpload write today).
 *
 * Two layers: DownloadCrypto must open every part and attachment and refuse
 * every tampered one; ClipAssembler + Fmp4SaveFix must turn the decrypted
 * parts into a file whose ONLY differences from the sealed original are the
 * documented ones — proved by undoing exactly those and getting the original
 * SHA-256 back.
 */
public class DownloadVectorsTest {

    private static JSONObject v;

    @BeforeClass
    public static void load() throws Exception {
        try (InputStream in = DownloadVectorsTest.class.getClassLoader().getResourceAsStream("download-vectors.json")) {
            assertNotNull("download-vectors.json on the test classpath", in);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            v = new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    // ---- helpers -------------------------------------------------------------

    static byte[] b64(String s) {
        return Base64.getDecoder().decode(s);
    }

    static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    static String sha(byte[] b) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static ByteBuffer direct(byte[] b) {
        ByteBuffer d = ByteBuffer.allocateDirect(b.length);
        d.put(b).flip();
        return d;
    }

    static byte[] bytes(ByteBuffer b) {
        byte[] out = new byte[b.remaining()];
        b.duplicate().get(out);
        return out;
    }

    /** Opens a clip part with the production code. */
    static byte[] openPart(JSONObject secrets, int index, byte[] wire) throws DownloadCrypto.DecryptException, org.json.JSONException {
        byte[] key = b64(secrets.getString("key"));
        byte[] prefix = b64(secrets.getString("noncePrefix"));
        byte[] clipId = DownloadInputs.uuidBytes(secrets.getString("clipId"));
        ByteBuffer out = ByteBuffer.allocateDirect(Math.max(0, wire.length));
        int n = DownloadCrypto.openClipPart(key, prefix, clipId, index, direct(wire), out);
        out.flip();
        assertEquals(n, out.remaining());
        return bytes(out);
    }

    static List<byte[]> clipPlains() throws Exception {
        JSONObject clip = v.getJSONObject("clip");
        JSONArray parts = clip.getJSONArray("parts");
        List<byte[]> out = new ArrayList<>();
        for (int i = 0; i < parts.length(); i++) out.add(openPart(clip, i, b64(parts.getJSONObject(i).getString("wire"))));
        return out;
    }

    static byte[] concat(List<byte[]> parts) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        for (byte[] p : parts) bo.write(p, 0, p.length);
        return bo.toByteArray();
    }

    /** An in-memory file for ClipAssembler. */
    static final class MemSink implements ClipAssembler.Sink {
        byte[] data = new byte[0];
        int len;
        int positional;

        private void ensure(long n) {
            if (n > data.length) data = java.util.Arrays.copyOf(data, (int) Math.max(n, data.length * 2L));
        }

        @Override
        public void write(ByteBuffer b) {
            int n = b.remaining();
            ensure(len + n);
            b.get(data, len, n);
            len += n;
        }

        @Override
        public void writeAt(long pos, ByteBuffer b) {
            int n = b.remaining();
            assertTrue("a patch never extends the file", pos + n <= len);
            b.get(data, (int) pos, n);
            positional++;
        }

        byte[] bytes() {
            return java.util.Arrays.copyOf(data, len);
        }
    }

    static byte[] assemble(List<byte[]> plains, long durationHintMs, boolean fix) throws Exception {
        MemSink sink = new MemSink();
        ClipAssembler a = new ClipAssembler(sink, durationHintMs, fix);
        for (int i = 0; i < plains.size(); i++) a.part(i, direct(plains.get(i)));
        a.finish();
        return sink.bytes();
    }

    // ---- an independent box walker for the assertions (not Fmp4SaveFix's) ----

    static long u32(byte[] b, int o) {
        return ((b[o] & 0xffL) << 24) | ((b[o + 1] & 0xffL) << 16) | ((b[o + 2] & 0xffL) << 8) | (b[o + 3] & 0xffL);
    }

    static long u64(byte[] b, int o) {
        return (u32(b, o) << 32) | u32(b, o + 4);
    }

    static void p32(byte[] b, int o, long x) {
        b[o] = (byte) (x >>> 24); b[o + 1] = (byte) (x >>> 16); b[o + 2] = (byte) (x >>> 8); b[o + 3] = (byte) x;
    }

    static void p64(byte[] b, int o, long x) {
        p32(b, o, x >>> 32); p32(b, o + 4, x);
    }

    static String t(byte[] b, int o) {
        return new String(b, o + 4, 4, StandardCharsets.ISO_8859_1);
    }

    /** [start, size] of each box in b[from..to). 32-bit sizes only (all a seal writes). */
    static List<int[]> boxes(byte[] b, int from, int to) {
        List<int[]> out = new ArrayList<>();
        for (int o = from; o < to; ) {
            int size = (int) u32(b, o);
            assertTrue("box size sane at " + o, size >= 8 && o + size <= to);
            out.add(new int[] { o, size });
            o += size;
        }
        return out;
    }

    static int[] child(byte[] b, int[] parent, int hdr, String type) {
        for (int[] c : boxes(b, parent[0] + hdr, parent[0] + parent[1])) if (t(b, c[0]).equals(type)) return c;
        return null;
    }

    static List<int[]> kids(byte[] b, int[] parent, String type) {
        List<int[]> out = new ArrayList<>();
        for (int[] c : boxes(b, parent[0] + 8, parent[0] + parent[1])) if (t(b, c[0]).equals(type)) out.add(c);
        return out;
    }

    // ---- crypto -----------------------------------------------------------------

    @Test
    public void everyClipPartOpensToItsRecordedPlaintext() throws Exception {
        JSONObject clip = v.getJSONObject("clip");
        JSONArray parts = clip.getJSONArray("parts");
        List<byte[]> plains = clipPlains();
        assertTrue(parts.length() >= 4);
        for (int i = 0; i < parts.length(); i++) {
            assertEquals("part " + i, parts.getJSONObject(i).getString("plainSha256"), sha(plains.get(i)));
        }
        assertEquals(clip.getString("plainSha256"), sha(concat(plains)));
    }

    @Test
    public void edgePartsOpenIncludingHighIndexesAndAnEmptyPart() throws Exception {
        JSONObject x = v.getJSONObject("extraParts");
        JSONArray parts = x.getJSONArray("parts");
        for (int i = 0; i < parts.length(); i++) {
            JSONObject p = parts.getJSONObject(i);
            assertArrayEquals("index " + p.getInt("index"), hex(p.getString("plain")), openPart(x, p.getInt("index"), b64(p.getString("wire"))));
        }
    }

    @Test
    public void everyTamperedPartIsRefused() throws Exception {
        JSONObject x = v.getJSONObject("extraParts");
        JSONObject p = x.getJSONArray("parts").getJSONObject(1); // index 513
        int index = p.getInt("index");
        byte[] wire = b64(p.getString("wire"));
        // the positive control: the untouched part opens
        assertEquals(700, openPart(x, index, wire).length);
        int[] flips = { 0, 4, 5, 6, 7, 12, 18, 19, wire.length / 2, wire.length - 1 };
        for (int at : flips) {
            byte[] bad = wire.clone();
            bad[at] ^= 0x01;
            assertRefused("byte " + at + " flipped", x, index, bad);
        }
        assertRefused("opened as another index", x, index + 1, wire);
        assertRefused("truncated", x, index, java.util.Arrays.copyOf(wire, wire.length - 1));
        assertRefused("shorter than a header and a tag", x, index, java.util.Arrays.copyOf(wire, 34));
        JSONObject otherClip = new JSONObject(x.toString()).put("clipId", "00ff10ee-2233-4455-8899-aabbccddeef0");
        assertRefused("another clip's id (AAD)", otherClip, index, wire);
        JSONObject otherKey = new JSONObject(x.toString()).put("key", v.getJSONObject("clip").getString("key"));
        assertRefused("another clip's key", otherKey, index, wire);
    }

    private static void assertRefused(String what, JSONObject secrets, int index, byte[] wire) throws org.json.JSONException {
        try {
            openPart(secrets, index, wire);
            fail(what + ": opened");
        } catch (DownloadCrypto.DecryptException expected) {
            // refused
        }
    }

    @Test
    public void attachmentsOpenWithTheirUrlSafeKeyAndRefuseTampering() throws Exception {
        JSONArray atts = v.getJSONArray("attachments");
        boolean sawUrlSafe = false;
        for (int i = 0; i < atts.length(); i++) {
            JSONObject a = atts.getJSONObject(i);
            String k = a.getString("key");
            sawUrlSafe |= k.contains("-") && k.contains("_");
            byte[] key = DownloadInputs.key32(k);
            assertNotNull(key);
            byte[] wire = b64(a.getString("wire"));
            ByteBuffer out = ByteBuffer.allocateDirect(wire.length);
            DownloadCrypto.openAttachment(key, direct(wire), out);
            out.flip();
            assertArrayEquals(hex(a.getString("plain")), bytes(out));
            for (int at : new int[] { 0, 11, 12, wire.length - 1 }) {
                byte[] bad = wire.clone();
                bad[at] ^= 0x40;
                try {
                    DownloadCrypto.openAttachment(key, direct(bad), ByteBuffer.allocateDirect(wire.length));
                    fail("tampered attachment byte " + at + " opened");
                } catch (DownloadCrypto.DecryptException expected) {
                    // refused
                }
            }
        }
        assertTrue("the vectors exercise the url-safe alphabet", sawUrlSafe);
    }

    // ---- the clip file ------------------------------------------------------------

    @Test
    public void withoutTheFixTheFileIsThePlainConcatenation() throws Exception {
        List<byte[]> plains = clipPlains();
        assertEquals(v.getJSONObject("clip").getString("plainSha256"), sha(assemble(plains, 4000, false)));
    }

    @Test
    public void theFixAddsDurationAndAWorkingSeekIndex() throws Exception {
        List<byte[]> plains = clipPlains();
        byte[] f = assemble(plains, v.getJSONObject("clip").getLong("durationMs"), true);
        List<int[]> top = boxes(f, 0, f.length);
        assertEquals("ftyp", t(f, top.get(0)[0]));
        assertEquals("moov", t(f, top.get(1)[0]));
        assertEquals("free", t(f, top.get(2)[0]));
        assertEquals("sidx", t(f, top.get(3)[0]));
        assertEquals("the sidx ends exactly at the first moof", "moof", t(f, top.get(4)[0]));
        assertEquals("mfra", t(f, top.get(top.size() - 1)[0]));

        int[] moov = top.get(1);
        int[] mvhd = child(f, moov, 8, "mvhd");
        long movieTs = u32(f, mvhd[0] + 20);
        long movieDur = u32(f, mvhd[0] + 24);
        int[] mvex = child(f, moov, 8, "mvex");
        int[] mehd = boxes(f, mvex[0] + 8, mvex[0] + mvex[1]).get(0);
        assertEquals("mehd is mvex's first child", "mehd", t(f, mehd[0]));
        assertEquals(movieDur, u32(f, mehd[0] + 12));
        // 4.0 s of video, audio running to ~4.15 s: the movie is as long as its longest track
        double seconds = movieDur / (double) movieTs;
        assertTrue("movie duration " + seconds, seconds > 4.1 && seconds < 4.25);

        long videoTs = 0, videoDur = 0, videoId = 0;
        for (int[] trak : kids(f, moov, "trak")) {
            int[] tkhd = child(f, trak, 8, "tkhd");
            int[] mdia = child(f, trak, 8, "mdia");
            int[] mdhd = child(f, mdia, 8, "mdhd");
            int[] hdlr = child(f, mdia, 8, "hdlr");
            long ts = u32(f, mdhd[0] + 20), d = u32(f, mdhd[0] + 24);
            assertTrue("every track has a duration", d > 0);
            long tk = u32(f, tkhd[0] + 28);
            assertEquals("tkhd is the mdhd duration in the movie timescale", Math.round(d * (double) movieTs / ts), tk);
            if (new String(f, hdlr[0] + 16, 4, StandardCharsets.ISO_8859_1).equals("vide")) {
                videoTs = ts; videoDur = d; videoId = u32(f, tkhd[0] + 20);
            }
        }
        assertEquals("video: 40 frames of 0.1 s", 4.0, videoDur / (double) videoTs, 1e-9);

        // the sidx: one reference per video fragment, each the bytes from its moof to the next
        int[] sidx = top.get(3);
        assertEquals(1, f[sidx[0] + 8]);
        assertEquals(videoId, u32(f, sidx[0] + 12));
        assertEquals(videoTs, u32(f, sidx[0] + 16));
        assertEquals("earliest presentation time", 0, u64(f, sidx[0] + 20));
        assertEquals("first_offset", 0, u64(f, sidx[0] + 28));
        int refs = ((f[sidx[0] + 38] & 0xff) << 8) | (f[sidx[0] + 39] & 0xff);
        List<Integer> videoMoofs = new ArrayList<>();
        int mediaEnd = 0;
        for (int[] b : top) {
            String ty = t(f, b[0]);
            if (ty.equals("moof")) {
                for (int[] traf : kids(f, b, "traf")) if (u32(f, child(f, traf, 8, "tfhd")[0] + 12) == videoId) videoMoofs.add(b[0]);
            }
            if (ty.equals("moof") || ty.equals("mdat")) mediaEnd = b[0] + b[1];
        }
        assertEquals(4, videoMoofs.size());
        assertEquals(videoMoofs.size(), refs);
        long sumDur = 0;
        for (int i = 0; i < refs; i++) {
            int o = sidx[0] + 40 + 12 * i;
            long size = u32(f, o), dur = u32(f, o + 4), sap = u32(f, o + 8);
            long start = i == 0 ? top.get(4)[0] : videoMoofs.get(i);
            long end = i + 1 < refs ? videoMoofs.get(i + 1) : mediaEnd;
            assertEquals("reference " + i + " size", end - start, size);
            assertEquals("reference " + i + " is a keyframe start (SAP type 1)", (1L << 31) | (1L << 28), sap);
            sumDur += dur;
        }
        assertEquals("the references cover the whole video", videoDur, sumDur);

        // every tfra entry points at a moof of THIS file
        for (int[] tfra : kids(f, top.get(top.size() - 1), "tfra")) {
            assertEquals(1, f[tfra[0] + 8]);
            long n = u32(f, tfra[0] + 20);
            assertTrue(n > 0);
            for (int i = 0; i < n; i++) {
                long off = u64(f, tfra[0] + 24 + 28 * i + 8);
                assertEquals("tfra entry " + i, "moof", t(f, (int) off));
            }
        }
    }

    /**
     * THE invariant: undo exactly the documented changes — the mehd, the
     * reserved free+sidx region, the four kinds of duration field, the tfra
     * offsets — and the sealed original comes back byte for byte. So no media
     * byte moved and nothing else changed.
     */
    @Test
    public void undoingTheDocumentedChangesGivesBackTheSealedOriginal() throws Exception {
        List<byte[]> plains = clipPlains();
        byte[] f = assemble(plains, 4000, true);
        assertTrue(!sha(f).equals(v.getJSONObject("clip").getString("plainSha256")));
        assertEquals(v.getJSONObject("clip").getString("plainSha256"), sha(unfix(f)));
    }

    /** Test-side inverse of Fmp4SaveFix (independent code). */
    static byte[] unfix(byte[] f) {
        byte[] g = f.clone();
        List<int[]> top = boxes(g, 0, g.length);
        int[] moov = top.get(1);
        for (int[] x : boxes(g, moov[0] + 8, moov[0] + moov[1])) {
            String ty = t(g, x[0]);
            if (ty.equals("mvhd")) p32(g, x[0] + 24, 0);
            if (ty.equals("trak")) {
                p32(g, child(g, x, 8, "tkhd")[0] + 28, 0);
                p32(g, child(g, child(g, x, 8, "mdia"), 8, "mdhd")[0] + 24, 0);
            }
        }
        int[] mvex = child(g, moov, 8, "mvex");
        int[] mehd = boxes(g, mvex[0] + 8, mvex[0] + mvex[1]).get(0);
        int mehdLen = mehd[1];
        p32(g, moov[0], moov[1] - mehdLen);
        p32(g, mvex[0], mvex[1] - mehdLen);
        int regionStart = top.get(2)[0];
        int regionEnd = top.get(4)[0];
        long shift = mehdLen + (regionEnd - regionStart);
        int[] mfra = top.get(top.size() - 1);
        for (int[] tfra : kids(g, mfra, "tfra")) {
            long n = u32(g, tfra[0] + 20);
            for (int i = 0; i < n; i++) {
                int at = tfra[0] + 24 + 28 * i + 8;
                p64(g, at, u64(g, at) - shift);
            }
        }
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        bo.write(g, 0, mehd[0]);
        bo.write(g, mehd[0] + mehdLen, regionStart - (mehd[0] + mehdLen));
        bo.write(g, regionEnd, g.length - regionEnd);
        return bo.toByteArray();
    }

    @Test
    public void theScannerGivesTheSamePatchesHoweverTheBytesAreSliced() throws Exception {
        List<byte[]> plains = clipPlains();
        Fmp4SaveFix.Plan plan = Fmp4SaveFix.prepareInit(plains.get(0), plains.get(0).length, 4000);
        assertNotNull(plan);
        String whole = patchesOf(plan, plains, Integer.MAX_VALUE);
        for (int slice : new int[] { 1, 3, 7, 8, 9, 15, 16, 17, 64, 100, 1000 }) {
            assertEquals("slices of " + slice + " bytes", whole, patchesOf(plan, plains, slice));
        }
    }

    private static String patchesOf(Fmp4SaveFix.Plan plan, List<byte[]> plains, int slice) throws Exception {
        Fmp4SaveFix.Scanner s = new Fmp4SaveFix.Scanner(plan, plan.init.length);
        for (int i = 1; i < plains.size(); i++) {
            byte[] p = plains.get(i);
            for (int o = 0; o < p.length; o += slice) {
                int n = Math.min(slice, p.length - o);
                s.feed(ByteBuffer.wrap(p, o, n).slice());
            }
        }
        StringBuilder sb = new StringBuilder();
        for (Fmp4SaveFix.Patch p : s.finish(4000)) sb.append(p.offset).append(':').append(sha(p.bytes)).append(';');
        return sb.toString();
    }

    @Test
    public void anMfraEntryThatPointsAtNoMoofDisablesTheIndexInsteadOfLying() throws Exception {
        List<byte[]> plains = clipPlains();
        byte[] last = plains.get(plains.size() - 1).clone();
        // the mfra is at the end of the last part; corrupt its first tfra's first moof_offset
        int mfraSize = (int) u32(last, last.length - 4);
        int mfra = last.length - mfraSize;
        assertEquals("mfra", t(last, mfra));
        int tfra = mfra + 8;
        assertEquals("tfra", t(last, tfra));
        int at = tfra + 24 + 8;
        p64(last, at, u64(last, at) + 1);
        plains.set(plains.size() - 1, last);
        byte[] f = assemble(plains, 4000, true);
        List<int[]> top = boxes(f, 0, f.length);
        assertEquals("the mfra became a free box", "free", t(f, top.get(top.size() - 1)[0]));
        assertEquals("sidx", t(f, top.get(3)[0])); // the rest of the fix stands
    }

    @Test
    public void anInitItDoesNotRecogniseIsSavedExactlyAsSealed() throws Exception {
        List<byte[]> plains = clipPlains();
        // an mehd already present (another muxer fixed it): rename mvex's first child
        byte[] init = plains.get(0).clone();
        int[] moov = boxes(init, 0, init.length).get(1);
        int[] mvex = child(init, moov, 8, "mvex");
        init[mvex[0] + 8 + 4] = 'm'; init[mvex[0] + 8 + 5] = 'e'; init[mvex[0] + 8 + 6] = 'h'; init[mvex[0] + 8 + 7] = 'd';
        assertNull(Fmp4SaveFix.prepareInit(init, init.length, 4000));
        List<byte[]> withMehd = new ArrayList<>(plains);
        withMehd.set(0, init);
        assertEquals(sha(concat(withMehd)), sha(assemble(withMehd, 4000, true)));
        // not an MP4 at all
        byte[] junk = new byte[300];
        for (int i = 0; i < junk.length; i++) junk[i] = (byte) (i * 7);
        assertNull(Fmp4SaveFix.prepareInit(junk, junk.length, 4000));
        // no mvex (not fragmented)
        byte[] noMvex = plains.get(0).clone();
        noMvex[mvex[0] + 4] = 'f'; noMvex[mvex[0] + 5] = 'r'; noMvex[mvex[0] + 6] = 'e'; noMvex[mvex[0] + 7] = 'e';
        assertNull(Fmp4SaveFix.prepareInit(noMvex, noMvex.length, 4000));
    }

    @Test
    public void aManifestWithNoDurationStillGetsTheFix() throws Exception {
        List<byte[]> plains = clipPlains();
        // a manifest claiming 0 s reserves room for 16 references; this clip has 4,
        // so it still fits — a hint of 0 must not break anything
        byte[] f = assemble(plains, 0, true);
        List<int[]> top = boxes(f, 0, f.length);
        assertEquals("sidx", t(f, top.get(3)[0]));
        assertEquals(v.getJSONObject("clip").getString("plainSha256"), sha(unfix(f)));
    }
}
