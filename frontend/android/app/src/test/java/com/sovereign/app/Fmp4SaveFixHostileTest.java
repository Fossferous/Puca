package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Fmp4SaveFix and ClipAssembler against clips built to hurt them. A clip is
 * written by whoever posted it, so reading it must cost no more than a pass
 * over its bytes, keep a bounded record per fragment, and stop when the user
 * presses Cancel. Every shape here ran the save out of time or out of memory
 * before the limits (the numbers are in Fmp4SaveFix's class comment); the init
 * is the real mediabunny one from download-vectors.json.
 */
public class Fmp4SaveFixHostileTest {

    private static byte[] init;
    private static Fmp4SaveFix.Plan plan;

    @BeforeClass
    public static void load() throws Exception {
        DownloadVectorsTest.load();
        init = DownloadVectorsTest.clipPlains().get(0);
        plan = Fmp4SaveFix.prepareInit(init, init.length, 4000);
        assertNotNull("the real init is recognised", plan);
        assertTrue(plan.ref.video);
    }

    // ---- building boxes ---------------------------------------------------------

    static void p32(byte[] b, int o, long v) {
        DownloadVectorsTest.p32(b, o, v);
    }

    static void typ(byte[] b, int o, String t) {
        for (int i = 0; i < 4; i++) b[o + i] = (byte) t.charAt(i);
    }

    static byte[] box(String type, byte[]... kids) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        for (byte[] k : kids) bo.write(k, 0, k.length);
        byte[] body = bo.toByteArray();
        byte[] b = new byte[8 + body.length];
        p32(b, 0, b.length);
        typ(b, 4, type);
        System.arraycopy(body, 0, b, 8, body.length);
        return b;
    }

    /** A full box: version 0, the flags, then {@code fields} 32-bit words. */
    static byte[] full(String type, int flags, long... fields) {
        byte[] b = new byte[12 + 4 * fields.length];
        p32(b, 0, b.length);
        typ(b, 4, type);
        p32(b, 8, flags & 0xffffff);
        for (int i = 0; i < fields.length; i++) p32(b, 12 + 4 * i, fields[i]);
        return b;
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        for (byte[] p : parts) bo.write(p, 0, p.length);
        return bo.toByteArray();
    }

    /** A tfra (version 0, 1-byte traf/trun/sample numbers) whose entries all point at {@code moofAt}. */
    static byte[] tfra(long track, long moofAt, int n) {
        byte[] entry = new byte[11]; // time (4), moof_offset (4), traf/trun/sample numbers (1 each)
        p32(entry, 4, moofAt);
        byte[] t = concat(full("tfra", 0, track, 0, n), repeat(entry, n));
        p32(t, 0, t.length);
        return t;
    }

    static byte[] repeat(byte[] unit, int times) {
        byte[] out = new byte[unit.length * times];
        for (int i = 0; i < times; i++) System.arraycopy(unit, 0, out, i * unit.length, unit.length);
        return out;
    }

    /** traf for {@code track}: tfhd (default-base-is-moof | extra flags), tfdt v0 = 0, then the truns. */
    static byte[] traf(long track, int tfhdFlags, long[] tfhdFields, byte[]... truns) {
        long[] f = new long[1 + tfhdFields.length];
        f[0] = track;
        System.arraycopy(tfhdFields, 0, f, 1, tfhdFields.length);
        byte[][] kids = new byte[2 + truns.length][];
        kids[0] = full("tfhd", 0x020000 | tfhdFlags, f);
        kids[1] = full("tfdt", 0, 0);
        System.arraycopy(truns, 0, kids, 2, truns.length);
        return box("traf", kids);
    }

    static final byte[] EMPTY_MOOF = box("moof");

    static ClipAssembler.Sink nullSink() {
        return new ClipAssembler.Sink() {
            @Override public void write(ByteBuffer b) { b.position(b.limit()); }
            @Override public void writeAt(long p, ByteBuffer b) { b.position(b.limit()); }
        };
    }

    // ---- CPU ---------------------------------------------------------------------

    /**
     * A trun with no per-sample fields is count x the default duration. One
     * declaring 2^32 - 1 samples used to be walked sample by sample (1.3 s each
     * on a desktop JVM, so 64 of them in a 1 KB moof held the download thread
     * for well over a minute, and Cancel could not reach it).
     */
    @Test(timeout = 10_000)
    public void aRunDeclaringBillionsOfSamplesCostsNoTime() throws Exception {
        byte[][] truns = new byte[64][];
        for (int i = 0; i < truns.length; i++) truns[i] = full("trun", 0, 0xffffffffL);
        byte[] moof = box("moof", traf(plan.ref.id, 0, new long[0], truns));
        DownloadVectorsTest.MemSink sink = new DownloadVectorsTest.MemSink();
        ClipAssembler a = new ClipAssembler(sink, 4000, true);
        a.part(0, ByteBuffer.wrap(init));
        a.part(1, ByteBuffer.wrap(concat(moof, box("mdat"))));
        a.finish();
        assertTrue(a.outcome(), a.outcome().contains("fragments not understood"));
        // the duration is the manifest's, not 2^32 samples' worth
        byte[] f = sink.bytes();
        int[] moov = DownloadVectorsTest.boxes(f, 0, f.length).get(1);
        int[] mvhd = DownloadVectorsTest.child(f, moov, 8, "mvhd");
        assertEquals(4000L * DownloadVectorsTest.u32(f, mvhd[0] + 20) / 1000, DownloadVectorsTest.u32(f, mvhd[0] + 24));
    }

    /** The closed form for such a run gives exactly what the per-sample walk gave. */
    @Test
    public void aRunWithNoPerSampleFieldsLastsCountTimesTheDefault() throws Exception {
        long d = 1500; // ticks per sample, from the tfhd
        byte[] moof = box("moof", traf(plan.ref.id, 0x8, new long[] { d }, full("trun", 0, 40), full("trun", 0, 2)));
        DownloadVectorsTest.MemSink sink = new DownloadVectorsTest.MemSink();
        ClipAssembler a = new ClipAssembler(sink, 4000, true);
        a.part(0, ByteBuffer.wrap(init));
        a.part(1, ByteBuffer.wrap(concat(moof, box("mdat"))));
        a.finish();
        assertEquals("duration and seek index added", a.outcome());
        byte[] f = sink.bytes();
        int[] moov = DownloadVectorsTest.boxes(f, 0, f.length).get(1);
        for (int[] trak : DownloadVectorsTest.kids(f, moov, "trak")) {
            int[] tkhd = DownloadVectorsTest.child(f, trak, 8, "tkhd");
            if (DownloadVectorsTest.u32(f, tkhd[0] + 20) != plan.ref.id) continue;
            int[] mdhd = DownloadVectorsTest.child(f, DownloadVectorsTest.child(f, trak, 8, "mdia"), 8, "mdhd");
            assertEquals(42 * d, DownloadVectorsTest.u32(f, mdhd[0] + 24));
            return;
        }
        fail("no video trak");
    }

    // ---- memory --------------------------------------------------------------------

    /** Feed {@code bytes} to a fresh scanner in 1 MiB slices; return it unfinished. */
    static Fmp4SaveFix.Scanner scan(byte[]... parts) {
        Fmp4SaveFix.Scanner s = new Fmp4SaveFix.Scanner(plan, plan.init.length);
        for (byte[] p : parts) {
            for (int o = 0; o < p.length; o += 1 << 20) s.feed(ByteBuffer.wrap(p, o, Math.min(1 << 20, p.length - o)).slice());
        }
        return s;
    }

    /**
     * Empty moofs, 8 bytes each: every one used to cost a boxed Long in a
     * HashSet (~7.7 MB of heap per MB of clip; a 24 MB part of them ran a
     * 192 MiB heap out). Past MAX_MOOFS the scanner stops keeping them.
     */
    @Test
    public void aFloodOfEmptyMoofsKeepsABoundedRecord() {
        Fmp4SaveFix.Scanner s = scan(repeat(EMPTY_MOOF, Fmp4SaveFix.Scanner.MAX_MOOFS + 20_000));
        assertTrue("records " + s.records(), s.records() <= Fmp4SaveFix.Scanner.MAX_MOOFS);
        assertFalse(s.analysisOk());
        s.finish(4000);
    }

    /** Fragments whose tfhd carries an absolute base offset each need a patch;
     *  past MAX_PATCHES the scanner gives up instead of keeping them all. */
    @Test
    public void aFloodOfBaseOffsetFragmentsKeepsABoundedRecord() {
        byte[] t = traf(plan.ref.id, 0x1, new long[] { 0, 0 });
        byte[] moof = box("moof", repeat(t, 1000));
        Fmp4SaveFix.Scanner s = scan(repeat(moof, 80)); // 80,000 base offsets
        // at most: the 80 moofs, maxRefs + 1 references, the patch budget
        assertTrue("records " + s.records(), s.records() <= 80 + plan.maxRefs + 1 + Fmp4SaveFix.Scanner.MAX_PATCHES);
        assertFalse(s.analysisOk());
    }

    /**
     * mfra boxes whose tfra entries all point at a real moof: each entry used
     * to become a patch (five 8 MB mfra boxes ran a 192 MiB heap out). Past
     * the budget an mfra is retired whole, never half rewritten.
     */
    @Test
    public void aFloodOfIndexEntriesKeepsABoundedRecord() {
        long moofAt = plan.init.length - plan.shift; // the first moof's offset in the SEALED file
        byte[] mfra = box("mfra", tfra(plan.ref.id, moofAt, 30_000));
        Fmp4SaveFix.Scanner s = scan(concat(EMPTY_MOOF, box("mdat")), repeat(mfra, 5)); // 150,000 entries
        assertTrue("records " + s.records(), s.records() <= 1 + Fmp4SaveFix.Scanner.MAX_PATCHES);
        // the first two fit and are rewritten; the other three do not and are retired whole
        List<Fmp4SaveFix.Patch> ps = s.finish(4000);
        int frees = 0, entries = 0;
        for (Fmp4SaveFix.Patch p : ps) {
            if (p.bytes.length == 4 && new String(p.bytes, java.nio.charset.StandardCharsets.ISO_8859_1).equals("free")) frees++;
            else if (p.bytes.length == 4 && DownloadVectorsTest.u32(p.bytes, 0) == plan.init.length) entries++;
        }
        assertEquals("rewritten entries", 60_000, entries);
        assertEquals("retired mfra boxes", 3, frees);
    }

    /**
     * Part 0 is the init, held whole: a moov stuffed with 8-byte boxes used to
     * be listed box by box (~80 bytes of heap each; ONE 20 MB part 0 ran a
     * 192 MiB heap out). More than MAX_CHILDREN boxes in a container is not an
     * MP4 this fix touches: it is saved exactly as sealed.
     */
    @Test
    public void anInitStuffedWithTinyBoxesIsSavedAsSealed() throws Exception {
        List<int[]> top = DownloadVectorsTest.boxes(init, 0, init.length);
        int[] moov = top.get(top.size() - 1);
        assertEquals("the init ends with its moov", "moov", DownloadVectorsTest.t(init, moov[0]));
        byte[] stuffed = concat(init, repeat(box("free"), 5000)); // inside the moov, once it is grown
        p32(stuffed, moov[0], moov[1] + 5000 * 8);
        assertNull(Fmp4SaveFix.prepareInit(stuffed, stuffed.length, 4000));
        List<byte[]> parts = new ArrayList<>();
        parts.add(stuffed);
        parts.add(concat(EMPTY_MOOF, box("mdat")));
        assertEquals(DownloadVectorsTest.sha(DownloadVectorsTest.concat(parts)), DownloadVectorsTest.sha(DownloadVectorsTest.assemble(parts, 4000, true)));
    }

    /**
     * Reading stops (here: a box too short to be one), and an earlier mfra was
     * already rewritten: the LAST mfra, found through the trailing mfro, must
     * still be retired. Its tfra offsets were never moved, and readers find
     * the index from the end of the file.
     */
    @Test
    public void theLastIndexIsRetiredWhenReadingStopsAfterAnEarlierOne() {
        long moofAt = plan.init.length - plan.shift;
        byte[] goodMfra = box("mfra", tfra(plan.ref.id, moofAt, 1));
        byte[] broken = new byte[8];
        p32(broken, 0, 4); // a size smaller than its own header
        typ(broken, 4, "junk");
        byte[] t = tfra(plan.ref.id, moofAt, 1);
        int lastLen = 8 + t.length + 16;
        byte[] lastMfra = box("mfra", t, full("mfro", 0, lastLen));
        assertEquals(lastLen, lastMfra.length);
        byte[] media = concat(EMPTY_MOOF, box("mdat"));
        Fmp4SaveFix.Scanner s = scan(media, goodMfra, broken, lastMfra);
        long goodAt = plan.init.length + media.length;
        long lastAt = goodAt + goodMfra.length + broken.length;
        boolean retired = false, rewritten = false;
        for (Fmp4SaveFix.Patch p : s.finish(4000)) {
            if (p.offset == lastAt + 4 && new String(p.bytes, java.nio.charset.StandardCharsets.ISO_8859_1).equals("free")) retired = true;
            if (p.offset == goodAt + 8 + 24 + 4 && DownloadVectorsTest.u32(p.bytes, 0) == plan.init.length) rewritten = true;
        }
        assertTrue("the earlier mfra was rewritten", rewritten);
        assertTrue("the last mfra became a free box", retired);
    }

    /** A tfdt near 2^63 plus a sample: no wrapped, negative "duration" is used. */
    @Test
    public void aDurationPastALongIsNotADuration() throws Exception {
        byte[] tfhd = full("tfhd", 0x020000, plan.ref.id);
        byte[] tfdt = full("tfdt", 0, 0x7fffffffL, 0xffffff00L);
        tfdt[8] = 1; // version 1: a 64-bit base media decode time
        byte[] trun = full("trun", 0x100, 1, 0x1000); // one sample, its own duration
        byte[] moof = box("moof", box("traf", tfhd, tfdt, trun));
        ClipAssembler a = new ClipAssembler(nullSink(), 4000, true);
        a.part(0, ByteBuffer.wrap(init));
        a.part(1, ByteBuffer.wrap(concat(moof, box("mdat"))));
        a.finish();
        assertTrue(a.outcome(), a.outcome().contains("fragments not understood"));
    }

    @Test
    public void aContainerOfMoreThanMaxChildrenBoxesIsMalformed() {
        byte[] ok = repeat(box("free"), Fmp4SaveFix.MAX_CHILDREN);
        assertEquals(Fmp4SaveFix.MAX_CHILDREN, Fmp4SaveFix.children(ok, 0, ok.length).size());
        byte[] tooMany = repeat(box("free"), Fmp4SaveFix.MAX_CHILDREN + 1);
        assertNull(Fmp4SaveFix.children(tooMany, 0, tooMany.length));
    }

    // ---- Cancel ----------------------------------------------------------------------

    /**
     * Cancel reaches inside a part: the assembler polls once per box. Before,
     * only the download loop polled, between parts, so a part that took long to
     * read could not be stopped.
     */
    @Test
    public void aCancelStopsTheAssemblerInsideAPart() throws Exception {
        AtomicInteger polls = new AtomicInteger();
        ClipAssembler a = new ClipAssembler(nullSink(), 4000, true, () -> polls.incrementAndGet() > 100);
        a.part(0, ByteBuffer.wrap(init));
        byte[] part = repeat(concat(EMPTY_MOOF, box("mdat")), 10_000);
        try {
            a.part(1, ByteBuffer.wrap(part));
            fail("a part of 20,000 boxes ran to the end after Cancel");
        } catch (CancellationException expected) {
            assertTrue("stopped within a few boxes of the Cancel (" + polls.get() + " polls)", polls.get() <= 102);
        }
    }

    /** Also for a clip saved as sealed (no fix, so no scanner polling inside). */
    @Test
    public void aCancelBeforeAPartStopsIt() throws Exception {
        boolean[] cancelled = { false };
        ClipAssembler a = new ClipAssembler(nullSink(), 4000, false, () -> cancelled[0]);
        a.part(0, ByteBuffer.wrap(init));
        cancelled[0] = true;
        try {
            a.part(1, ByteBuffer.wrap(EMPTY_MOOF));
            fail("part accepted after Cancel");
        } catch (CancellationException expected) {
            // the save stops; NativeDownloads reports it as "cancelled" and deletes the pending file
        }
    }
}
