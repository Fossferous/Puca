package com.sovereign.app;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * Makes a saved Púca Clip a file the phone's own players understand — its
 * duration, and a seek bar that seeks — WITHOUT re-encoding or moving a
 * single media byte. Pure Java (JUnit).
 *
 * <p>WHY. A clip is fragmented MP4 straight out of the desktop muxer
 * (mediabunny, {@code fastStart: 'fragmented'}): the init segment is written
 * before the length is known, so mvhd/tkhd/mdhd carry duration 0 and there is
 * no {@code mvex/mehd}; the only index is an {@code mfra} at the very end.
 * Android's MediaExtractor then reports {@code durationUs -1} and cannot seek,
 * MediaStore stores no duration, and Google Photos shows neither a length nor
 * a usable seek bar (measured on the emulator, 2026-10-04: a 16-byte
 * {@code mehd} gave Photos its duration; a {@code sidx} made MediaExtractor
 * seek; a full faststart remux behaved the same as the two together).
 *
 * <p>WHAT CHANGES, and nothing else:
 * <ol>
 *   <li>{@code mehd} is inserted as the first child of {@code mvex} (moov and
 *       mvex grow by its size).</li>
 *   <li>A region is RESERVED right before the first {@code moof}, written as a
 *       {@code free} box while the parts stream past; at the end it becomes
 *       {@code free + sidx}, one reference per video fragment, ending exactly
 *       at the first {@code moof} (first_offset 0).</li>
 *   <li>At the end, the real durations — read from the fragments themselves
 *       ({@code tfdt} + the {@code trun} sample durations) — are written into
 *       mvhd, every tkhd, every mdhd and the new mehd.</li>
 *   <li>Every absolute file offset after the insertion moves by the same
 *       amount, so each {@code tfra} moof_offset (and a {@code tfhd}
 *       base_data_offset, which mediabunny never writes) is rewritten to
 *       match. An {@code mfra} whose entries do not all point at a
 *       {@code moof} this pass saw is turned into a {@code free} box instead:
 *       no index is better than a wrong one.</li>
 * </ol>
 * Fragments, samples and their bytes are untouched (default-base-is-moof makes
 * every trun data_offset relative), so removing exactly these changes gives
 * back the original file byte for byte — which is what the tests check.
 *
 * <p>STREAMING. Durations and the sidx are only known after the last part, so
 * the init goes out first with placeholders and the end of the save writes the
 * {@link Patch}es at their absolute offsets (the MediaStore file is opened
 * read-write). Memory is one moof/mfra at a time (KB), never a part.
 *
 * <p>Anything unexpected in the INIT (no mvex, an mehd already there, samples
 * or chunk offsets in the moov, a 64-bit box we cannot grow) means no fix at
 * all: {@link #prepareInit} returns null and the file is saved exactly as
 * sealed.
 *
 * <p>HOSTILE INPUT. A clip is written by whoever posted it, so every count in
 * it is the sender's. Nothing here may cost more than a pass over the bytes,
 * or keep more than a bounded record per fragment: a container holds at most
 * {@link #MAX_CHILDREN} boxes, a run with no per-sample fields is
 * {@code count x default} with no loop, and the {@link Scanner} keeps at most
 * {@link Scanner#MAX_MOOFS} fragment starts and {@link Scanner#MAX_PATCHES}
 * patches, past which it stops reading boxes. Measured before these limits
 * (JVM, 192 MiB heap, 2026-10-05): one {@code trun} declaring 2^32 samples
 * took 1.3 s and 64 of them over 30 s, with Cancel unable to stop it; a 24 MB
 * part of empty moofs, 72 MB of base-offset fragments, five 8 MB mfra boxes or
 * ONE 20 MB init of tiny boxes each ran out of memory. Giving up costs the
 * fix (the duration then comes from the manifest, with no seek index), never
 * the save.
 */
final class Fmp4SaveFix {

    private Fmp4SaveFix() {}

    /** Bytes to write at an absolute offset once every part is out. */
    static final class Patch {
        final long offset;
        final byte[] bytes;

        Patch(long offset, byte[] bytes) {
            this.offset = offset;
            this.bytes = bytes;
        }
    }

    static final class Track {
        int id;
        long timescale;
        boolean video;
        /** Output offsets of the duration fields, and their widths (4 or 8). */
        int tkhdDurOff, tkhdDurSize;
        int mdhdDurOff, mdhdDurSize;
        long trexDefaultDuration;
        long trexDefaultFlags;
    }

    /** What {@link #prepareInit} decided, for the scanner and the final patches. */
    static final class Plan {
        /** The fixed init: the original with mehd inserted, then the reservation. */
        byte[] init;
        /** Bytes of part 0 the init covers; the rest of part 0 (if any) is media. */
        int consumed;
        /** Output offset minus input offset for everything after the init. */
        long shift;
        long movieTimescale;
        int mvhdDurOff, mvhdDurSize;
        int mehdDurOff, mehdDurSize;
        int reserveOff, reserveLen, maxRefs;
        final List<Track> tracks = new ArrayList<>();
        Track ref;
    }

    // ---- byte helpers -------------------------------------------------------

    static long u32(byte[] b, int off) {
        return ((b[off] & 0xffL) << 24) | ((b[off + 1] & 0xffL) << 16) | ((b[off + 2] & 0xffL) << 8) | (b[off + 3] & 0xffL);
    }

    static long u64(byte[] b, int off) {
        return (u32(b, off) << 32) | u32(b, off + 4);
    }

    static void put32(byte[] b, int off, long v) {
        b[off] = (byte) (v >>> 24);
        b[off + 1] = (byte) (v >>> 16);
        b[off + 2] = (byte) (v >>> 8);
        b[off + 3] = (byte) v;
    }

    static void put64(byte[] b, int off, long v) {
        put32(b, off, v >>> 32);
        put32(b, off + 4, v);
    }

    static String type(byte[] b, int off) {
        return new String(b, off, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
    }

    static byte[] field(long v, int size) {
        byte[] out = new byte[size];
        if (size == 8) put64(out, 0, v);
        else put32(out, 0, v);
        return out;
    }

    /** A box inside {@code b[from..to)}: start, header length, total size, type. */
    static final class Box {
        final int start, hdr;
        final long size;
        final String type;

        Box(int start, int hdr, long size, String type) {
            this.start = start;
            this.hdr = hdr;
            this.size = size;
            this.type = type;
        }

        int body() { return start + hdr; }
        int end() { return (int) (start + size); }
    }

    /**
     * Most boxes one container (or part 0 before its first moof) may hold
     * before it counts as malformed. A real one holds a handful — a moof is an
     * mfhd and one traf per track — while a hostile one can pack a million
     * 8-byte boxes into 8 MB, at ~80 bytes of heap each to list.
     */
    static final int MAX_CHILDREN = 1024;

    /** The boxes in {@code b[from..to)}; null if one is malformed or overruns,
     *  or there are more than {@link #MAX_CHILDREN}. */
    static List<Box> children(byte[] b, int from, int to) {
        List<Box> out = new ArrayList<>();
        int off = from;
        while (off < to) {
            if (off + 8 > to || out.size() >= MAX_CHILDREN) return null;
            long size = u32(b, off);
            int hdr = 8;
            if (size == 1) {
                if (off + 16 > to) return null;
                size = u64(b, off + 8);
                hdr = 16;
            } else if (size == 0) {
                return null; // "to the end of the file": not inside an init or a moof
            }
            if (size < hdr || off + size > to) return null;
            out.add(new Box(off, hdr, size, type(b, off + 4)));
            off += (int) size;
        }
        return out;
    }

    static Box find(List<Box> boxes, String type) {
        for (Box x : boxes) if (x.type.equals(type)) return x;
        return null;
    }

    // ---- the init -----------------------------------------------------------

    /** Room for this many sidx references is reserved per clip second (4 = a
     *  fragment every 250 ms; the muxer cuts at most one per second). */
    static final int REFS_PER_SECOND = 4;
    static final int SIDX_FIXED = 40;   // v1 header through reference_count
    static final int SIDX_PER_REF = 12;

    /**
     * Prepare the init segment of a clip: {@code part0[0..len)} is the first
     * decrypted part. null = do not touch this file (it is saved as sealed).
     */
    static Plan prepareInit(byte[] part0, int len, long durationHintMs) {
        List<Box> top = topLevelBeforeMoof(part0, len);
        if (top == null) return null;
        int initEnd = top.isEmpty() ? 0 : top.get(top.size() - 1).end();
        Box moov = find(top, "moov");
        if (moov == null || moov.hdr != 8) return null;
        List<Box> mk = children(part0, moov.body(), moov.end());
        if (mk == null) return null;
        Box mvhd = find(mk, "mvhd");
        Box mvex = find(mk, "mvex");
        if (mvhd == null || mvex == null || mvex.hdr != 8) return null;
        List<Box> xk = children(part0, mvex.body(), mvex.end());
        if (xk == null || find(xk, "mehd") != null) return null;

        Plan p = new Plan();
        int mvhdVer = part0[mvhd.start + 8] & 0xff;
        if (mvhdVer > 1 || mvhd.size < (mvhdVer == 1 ? 40 : 28)) return null;
        p.movieTimescale = u32(part0, mvhd.start + (mvhdVer == 1 ? 28 : 20));
        if (p.movieTimescale == 0) return null;
        p.mvhdDurSize = mvhdVer == 1 ? 8 : 4;
        int mvhdDurIn = mvhd.start + (mvhdVer == 1 ? 32 : 24);

        // mehd goes first in mvex; everything at or after this input offset moves.
        int insertAt = mvex.body();
        int mehdLen = mvhdVer == 1 ? 20 : 16;
        p.mvhdDurOff = out(mvhdDurIn, insertAt, mehdLen);

        Map<Long, Track> byId = new HashMap<>();
        for (Box t : mk) {
            if (!t.type.equals("trak")) continue;
            Track tr = parseTrak(part0, t, insertAt, mehdLen);
            if (tr == null) return null;
            p.tracks.add(tr);
            byId.put((long) tr.id, tr);
        }
        if (p.tracks.isEmpty()) return null;
        for (Box x : xk) {
            if (!x.type.equals("trex") || x.size < 32) continue;
            Track tr = byId.get(u32(part0, x.start + 12));
            if (tr == null) continue;
            tr.trexDefaultDuration = u32(part0, x.start + 20);
            tr.trexDefaultFlags = u32(part0, x.start + 28);
        }
        for (Track tr : p.tracks) if (tr.video) { p.ref = tr; break; }
        if (p.ref == null) p.ref = p.tracks.get(0);

        long seconds = Math.max(0, (durationHintMs + 999) / 1000);
        long maxRefs = seconds * REFS_PER_SECOND + 8;
        p.maxRefs = (int) Math.max(16, Math.min(0xffff, maxRefs));
        p.reserveLen = 8 + SIDX_FIXED + SIDX_PER_REF * p.maxRefs;

        byte[] mehd = new byte[mehdLen];
        put32(mehd, 0, mehdLen);
        mehd[4] = 'm'; mehd[5] = 'e'; mehd[6] = 'h'; mehd[7] = 'd';
        mehd[8] = (byte) mvhdVer;

        int outLen = initEnd + mehdLen + p.reserveLen;
        byte[] init = new byte[outLen];
        System.arraycopy(part0, 0, init, 0, insertAt);
        System.arraycopy(mehd, 0, init, insertAt, mehdLen);
        System.arraycopy(part0, insertAt, init, insertAt + mehdLen, initEnd - insertAt);
        // moov and mvex both contain the insertion point.
        put32(init, moov.start, moov.size + mehdLen);
        put32(init, out(mvex.start, insertAt, mehdLen), mvex.size + mehdLen);
        p.mehdDurOff = insertAt + 12;
        p.mehdDurSize = mvhdVer == 1 ? 8 : 4;
        p.reserveOff = initEnd + mehdLen;
        put32(init, p.reserveOff, p.reserveLen);
        init[p.reserveOff + 4] = 'f'; init[p.reserveOff + 5] = 'r'; init[p.reserveOff + 6] = 'e'; init[p.reserveOff + 7] = 'e';

        p.init = init;
        p.consumed = initEnd;
        p.shift = mehdLen + p.reserveLen;
        return p;
    }

    /** Output offset of input offset {@code in} inside the init. */
    private static int out(int in, int insertAt, int mehdLen) {
        return in >= insertAt ? in + mehdLen : in;
    }

    /** Top-level boxes of part 0 up to (not including) the first moof; null
     *  when one before it is malformed or does not end inside part 0, or there
     *  are more than {@link #MAX_CHILDREN}. */
    private static List<Box> topLevelBeforeMoof(byte[] b, int len) {
        List<Box> out = new ArrayList<>();
        int off = 0;
        while (off < len) {
            if (off + 8 > len || out.size() >= MAX_CHILDREN) return null;
            String t = type(b, off + 4);
            if (t.equals("moof")) break;
            long size = u32(b, off);
            int hdr = 8;
            if (size == 1) {
                if (off + 16 > len) return null;
                size = u64(b, off + 8);
                hdr = 16;
            }
            if (size < hdr || off + size > len) return null;
            out.add(new Box(off, hdr, size, t));
            off += (int) size;
        }
        return out;
    }

    private static Track parseTrak(byte[] b, Box trak, int insertAt, int mehdLen) {
        List<Box> tk = children(b, trak.body(), trak.end());
        if (tk == null) return null;
        Box tkhd = find(tk, "tkhd");
        Box mdia = find(tk, "mdia");
        if (tkhd == null || mdia == null) return null;
        Track tr = new Track();
        int tv = b[tkhd.start + 8] & 0xff;
        if (tv > 1 || tkhd.size < (tv == 1 ? 44 : 32)) return null;
        tr.id = (int) u32(b, tkhd.start + (tv == 1 ? 28 : 20));
        tr.tkhdDurSize = tv == 1 ? 8 : 4;
        tr.tkhdDurOff = out(tkhd.start + (tv == 1 ? 36 : 28), insertAt, mehdLen);
        List<Box> md = children(b, mdia.body(), mdia.end());
        if (md == null) return null;
        Box mdhd = find(md, "mdhd");
        Box hdlr = find(md, "hdlr");
        Box minf = find(md, "minf");
        if (mdhd == null || hdlr == null || hdlr.size < 20) return null;
        int mv = b[mdhd.start + 8] & 0xff;
        if (mv > 1 || mdhd.size < (mv == 1 ? 44 : 32)) return null;
        tr.timescale = u32(b, mdhd.start + (mv == 1 ? 28 : 20));
        if (tr.timescale == 0) return null;
        tr.mdhdDurSize = mv == 1 ? 8 : 4;
        tr.mdhdDurOff = out(mdhd.start + (mv == 1 ? 32 : 24), insertAt, mehdLen);
        tr.video = type(b, hdlr.start + 16).equals("vide");
        // A fragmented init carries no samples and no chunk offsets. If this
        // one does, its offsets would need moving too: leave the file alone.
        if (minf != null) {
            List<Box> mi = children(b, minf.body(), minf.end());
            if (mi == null) return null;
            Box stbl = find(mi, "stbl");
            if (stbl != null) {
                List<Box> st = children(b, stbl.body(), stbl.end());
                if (st == null) return null;
                for (Box s : st) {
                    if ((s.type.equals("stco") || s.type.equals("co64")) && (s.size < 16 || u32(b, s.start + 12) != 0)) return null;
                    if (s.type.equals("stsz") && (s.size < 20 || u32(b, s.start + 16) != 0)) return null;
                }
            }
        }
        return tr;
    }

    // ---- the media parts ----------------------------------------------------

    /** Reads the media as it streams past (output order, absolute output
     *  offsets) and works out the index and the patches. */
    static final class Scanner {
        private static final int CAPTURE_MAX = 8 * 1024 * 1024;
        /** Fragment starts kept to check the mfra against. A clip cuts a moof
         *  every GOP or so (both tracks in one; 2 s in a measured 2:00 clip),
         *  so this is many hours of clip. */
        static final int MAX_MOOFS = 1 << 16;
        /** Patches gathered while the parts stream past (tfhd base offsets,
         *  tfra entries, neutralised mfra boxes). A real clip has one tfra
         *  entry per fragment and no base offsets. */
        static final int MAX_PATCHES = 1 << 16;
        /** Samples one trun may declare; a fragment is about a second. */
        static final long MAX_TRUN_SAMPLES = 1 << 20;

        private final Plan plan;
        private final BooleanSupplier cancelled;
        private long pos;
        private final byte[] hdr = new byte[16];
        private int hdrHave;
        private int hdrNeed = 8;
        private boolean inBody;
        private long boxStart, remaining;
        private String boxType;
        private ByteArrayOutputStream capture;
        /** Top-level framing broke, or a budget above ran out: stop reading
         *  boxes (see finish). */
        private boolean framingLost;
        /** A fragment said something this pass does not understand: no sidx,
         *  durations from the manifest. Framing (and so the mfra) still holds. */
        private boolean analysisFailed;
        private final byte[] tail = new byte[16];
        private long tailFill;

        /** Every moof start, ascending (the stream only moves forward). */
        private long[] moofStarts = new long[64];
        private int moofCount;
        /** {moofStart, tfdt, sap}; at most maxRefs + 1 (one more = "too many"). */
        private final List<long[]> refFrags = new ArrayList<>();
        private long firstMoofStart = -1;
        private long lastMediaEnd = -1;
        private final Map<Long, Long> trackEnd = new HashMap<>();
        private final List<Patch> patches = new ArrayList<>();
        /** Output end of the last mfra this pass rewrote or neutralised. */
        private long mfraDoneEnd = -1;

        Scanner(Plan plan, long startOffset) {
            this(plan, startOffset, null);
        }

        /** @param cancelled polled once per box; true throws CancellationException */
        Scanner(Plan plan, long startOffset, BooleanSupplier cancelled) {
            this.plan = plan;
            this.pos = startOffset;
            this.cancelled = cancelled;
        }

        boolean analysisOk() { return !framingLost && !analysisFailed; }

        /** What the scanner holds per fragment (tests: it must stay bounded). */
        int records() { return moofCount + refFrags.size() + patches.size(); }

        private void checkCancelled() {
            if (cancelled != null && cancelled.getAsBoolean()) throw new CancellationException("download cancelled");
        }

        /** A budget ran out: keep nothing more, read no more boxes. The last
         *  mfra is then found through the trailing mfro (see finish). */
        private void giveUp() {
            framingLost = true;
        }

        private boolean addPatch(Patch p) {
            if (patches.size() >= MAX_PATCHES) {
                giveUp();
                return false;
            }
            patches.add(p);
            return true;
        }

        private boolean sawMoofAt(long offset) {
            return Arrays.binarySearch(moofStarts, 0, moofCount, offset) >= 0;
        }

        void feed(ByteBuffer buf) {
            ByteBuffer b = buf.duplicate();
            while (b.hasRemaining()) {
                int avail = b.remaining();
                if (!inBody && hdrHave == 0) checkCancelled();
                // the last 16 bytes of the stream (an mfro, if framing is lost)
                if (framingLost) {
                    int take = avail;
                    for (int i = Math.max(0, take - 16); i < take; i++) pushTail(b.get(b.position() + i));
                    b.position(b.position() + take);
                    pos += take;
                    continue;
                }
                if (!inBody) {
                    byte x = b.get();
                    pushTail(x);
                    pos++;
                    hdr[hdrHave++] = x;
                    if (hdrHave == 8) {
                        long size = u32(hdr, 0);
                        if (size == 1) { hdrNeed = 16; continue; }
                        startBox(size, 8);
                    } else if (hdrHave == 16 && hdrNeed == 16) {
                        startBox(u64(hdr, 8), 16);
                    }
                    continue;
                }
                int take = (int) Math.min(remaining, avail);
                if (capture != null) {
                    byte[] tmp = new byte[take];
                    b.get(tmp);
                    capture.write(tmp, 0, take);
                    for (int i = Math.max(0, take - 16); i < take; i++) pushTail(tmp[i]);
                } else {
                    for (int i = Math.max(0, take - 16); i < take; i++) pushTail(b.get(b.position() + i));
                    b.position(b.position() + take);
                }
                pos += take;
                remaining -= take;
                if (remaining == 0) endBox();
            }
        }

        private void pushTail(byte x) {
            System.arraycopy(tail, 1, tail, 0, 15);
            tail[15] = x;
            tailFill++;
        }

        private void startBox(long size, int h) {
            String t = type(hdr, 4);
            if (size < h) { framingLost = true; return; }
            boxType = t;
            boxStart = pos - h;
            remaining = size - h;
            inBody = true;
            if (t.equals("moof")) {
                if (moofCount >= MAX_MOOFS) {
                    giveUp();
                    return;
                }
                if (moofCount == moofStarts.length) moofStarts = Arrays.copyOf(moofStarts, Math.min(MAX_MOOFS, moofCount * 2));
                moofStarts[moofCount++] = boxStart;
                if (firstMoofStart < 0) firstMoofStart = boxStart;
            }
            if ((t.equals("moof") || t.equals("mfra")) && size <= CAPTURE_MAX) {
                capture = new ByteArrayOutputStream((int) size);
                capture.write(hdr, 0, h);
            } else {
                capture = null;
                if (t.equals("moof")) analysisFailed = true;
                if (t.equals("mfra")) neutralizeMfra(boxStart);
            }
            if (remaining == 0) endBox();
        }

        private void endBox() {
            long end = pos;
            if (capture != null) {
                byte[] box = capture.toByteArray();
                capture = null;
                if (boxType.equals("moof")) parseMoof(box, boxStart);
                else if (boxType.equals("mfra")) parseMfra(box, boxStart);
            }
            if (boxType.equals("mfra") && !framingLost) mfraDoneEnd = end;
            if (boxType.equals("moof") || boxType.equals("mdat")) lastMediaEnd = end;
            capture = null;
            inBody = false;
            hdrHave = 0;
            hdrNeed = 8;
        }

        private void parseMoof(byte[] m, long moofStart) {
            List<Box> kids = children(m, 8, m.length);
            if (kids == null) { analysisFailed = true; return; }
            try {
                parseTrafs(m, kids, moofStart);
            } catch (ArithmeticException e) {
                analysisFailed = true; // a duration past 2^63 ticks is not a duration
            }
        }

        private void parseTrafs(byte[] m, List<Box> kids, long moofStart) {
            for (Box traf : kids) {
                if (!traf.type.equals("traf")) continue;
                checkCancelled();
                List<Box> tk = children(m, traf.body(), traf.end());
                Box tfhd = tk == null ? null : find(tk, "tfhd");
                Box tfdt = tk == null ? null : find(tk, "tfdt");
                if (tfhd == null || tfdt == null || tfhd.size < 16 || tfdt.size < 16) { analysisFailed = true; return; }
                long tfFlags = u32(m, tfhd.start + 8) & 0xffffff;
                long trackId = u32(m, tfhd.start + 12);
                int o = tfhd.start + 16;
                long defDur = -1, defFlags = -1;
                if ((tfFlags & 0x1) != 0) {
                    if (o + 8 > tfhd.end()) { analysisFailed = true; return; }
                    // An absolute offset: it moves with everything else. (Past
                    // MAX_PATCHES the scanner gives up and later ones stay
                    // unmoved: only a hostile clip has that many.)
                    if (!addPatch(new Patch(moofStart + o, field(u64(m, o) + plan.shift, 8)))) return;
                    o += 8;
                }
                if ((tfFlags & 0x2) != 0) o += 4;
                if ((tfFlags & 0x8) != 0) { if (o + 4 > tfhd.end()) { analysisFailed = true; return; } defDur = u32(m, o); o += 4; }
                if ((tfFlags & 0x10) != 0) o += 4;
                if ((tfFlags & 0x20) != 0) { if (o + 4 > tfhd.end()) { analysisFailed = true; return; } defFlags = u32(m, o); }
                Track tr = null;
                for (Track t : plan.tracks) if (t.id == trackId) tr = t;
                if (tr == null) { analysisFailed = true; return; }
                if (defDur < 0) defDur = tr.trexDefaultDuration;
                if (defFlags < 0) defFlags = tr.trexDefaultFlags;
                int tv = m[tfdt.start + 8] & 0xff;
                long base = tv == 1 ? (tfdt.size >= 20 ? u64(m, tfdt.start + 12) : -1) : u32(m, tfdt.start + 12);
                if (base < 0) { analysisFailed = true; return; }
                long dur = 0;
                long firstFlags = defFlags;
                boolean firstSeen = false;
                for (Box trun : tk) {
                    if (!trun.type.equals("trun")) continue;
                    if (trun.size < 16) { analysisFailed = true; return; }
                    long fl = u32(m, trun.start + 8) & 0xffffff;
                    long count = u32(m, trun.start + 12);
                    int q = trun.start + 16;
                    if ((fl & 0x1) != 0) q += 4;
                    long fsf = -1;
                    if ((fl & 0x4) != 0) { if (q + 4 > trun.end()) { analysisFailed = true; return; } fsf = u32(m, q); q += 4; }
                    int per = (((fl & 0x100) != 0) ? 4 : 0) + (((fl & 0x200) != 0) ? 4 : 0) + (((fl & 0x400) != 0) ? 4 : 0) + (((fl & 0x800) != 0) ? 4 : 0);
                    if (count > MAX_TRUN_SAMPLES || q + count * per > trun.end()) { analysisFailed = true; return; }
                    if (count == 0) continue;
                    if (per == 0) {
                        // No per-sample fields: every sample takes the defaults,
                        // so the run lasts count x the default. No loop — a
                        // declared count costs nothing that its bytes did not.
                        if (!firstSeen) { firstFlags = fsf >= 0 ? fsf : defFlags; firstSeen = true; }
                        dur = Math.addExact(dur, Math.multiplyExact(count, defDur));
                        continue;
                    }
                    for (long s = 0; s < count; s++) {
                        int r = q;
                        long sd = defDur;
                        if ((fl & 0x100) != 0) { sd = u32(m, r); r += 4; }
                        if ((fl & 0x200) != 0) r += 4;
                        long sf = (s == 0 && fsf >= 0) ? fsf : defFlags;
                        if ((fl & 0x400) != 0) { sf = (s == 0 && fsf >= 0) ? fsf : u32(m, r); }
                        if (!firstSeen) { firstFlags = sf; firstSeen = true; }
                        dur = Math.addExact(dur, sd);
                        q += per;
                    }
                }
                long end = Math.addExact(base, dur);
                Long prev = trackEnd.get(trackId);
                if (prev == null || end > prev) trackEnd.put(trackId, end);
                // One reference past maxRefs is enough to know the sidx will not fit.
                if (tr == plan.ref && refFrags.size() <= plan.maxRefs) {
                    // sample_is_non_sync_sample is bit 16 of the sample flags.
                    long sap = (firstFlags >= 0 && (firstFlags & 0x10000) == 0) ? 1 : 0;
                    refFrags.add(new long[] { moofStart, base, sap });
                }
            }
        }

        private void parseMfra(byte[] m, long mfraStart) {
            List<Box> kids = children(m, 8, m.length);
            if (kids == null) { neutralizeMfra(mfraStart); return; }
            // Twice over the entries: first check every one points at a moof
            // this pass saw and that they all fit the patch budget, then
            // rewrite them — so a bad index costs no memory before it is
            // refused, and is refused whole.
            for (int pass = 0; pass < 2; pass++) {
                long entries = 0;
                for (Box t : kids) {
                    if (!t.type.equals("tfra")) continue;
                    checkCancelled();
                    if (t.size < 24) { neutralizeMfra(mfraStart); return; }
                    int v = m[t.start + 8] & 0xff;
                    long sizes = u32(m, t.start + 16);
                    long n = u32(m, t.start + 20);
                    int lt = (int) ((sizes >> 4) & 3) + 1, lr = (int) ((sizes >> 2) & 3) + 1, ls = (int) (sizes & 3) + 1;
                    int w = v == 1 ? 8 : 4;
                    int entry = w + w + lt + lr + ls;
                    int q = t.start + 24;
                    if (q + n * entry > t.end()) { neutralizeMfra(mfraStart); return; }
                    entries += n;
                    if (pass == 0 && patches.size() + entries > MAX_PATCHES) { neutralizeMfra(mfraStart); return; }
                    for (long i = 0; i < n; i++) {
                        int offAt = q + w;
                        long was = w == 8 ? u64(m, offAt) : u32(m, offAt);
                        long now = was + plan.shift;
                        if (pass == 0 && (!sawMoofAt(now) || (w == 4 && now > 0xffffffffL))) { neutralizeMfra(mfraStart); return; }
                        if (pass == 1) addPatch(new Patch(mfraStart + offAt, field(now, w)));
                        q += entry;
                    }
                }
            }
        }

        /** No index rather than a wrong one: rename the box so no reader uses it. */
        private void neutralizeMfra(long mfraStart) {
            addPatch(new Patch(mfraStart + 4, new byte[] { 'f', 'r', 'e', 'e' }));
        }

        /** Every patch, once the last byte went past. */
        List<Patch> finish(long durationHintMs) {
            List<Patch> out = new ArrayList<>(patches);
            // Reading stopped before the last mfra was dealt with: find it from the
            // trailing mfro and retire it, since its offsets no longer hold.
            if (framingLost && mfraDoneEnd != pos && tailFill >= 16 && type(tail, 4).equals("mfro")) {
                long mfraSize = u32(tail, 12);
                if (mfraSize >= 16 && mfraSize <= pos) out.add(new Patch(pos - mfraSize + 4, new byte[] { 'f', 'r', 'e', 'e' }));
            }
            boolean ok = analysisOk() && !inBody && hdrHave == 0;
            // durations: the fragments' own, or the manifest's when they could not be read
            long movieDur = 0;
            for (Track t : plan.tracks) {
                Long endTs = ok ? trackEnd.get((long) t.id) : null;
                long trackDur = endTs != null ? endTs : (durationHintMs * t.timescale + 500) / 1000;
                long inMovie = (trackDur * plan.movieTimescale + t.timescale / 2) / t.timescale;
                movieDur = Math.max(movieDur, inMovie);
                if (fits(trackDur, t.mdhdDurSize)) out.add(new Patch(t.mdhdDurOff, field(trackDur, t.mdhdDurSize)));
                if (fits(inMovie, t.tkhdDurSize)) out.add(new Patch(t.tkhdDurOff, field(inMovie, t.tkhdDurSize)));
            }
            if (fits(movieDur, plan.mvhdDurSize)) out.add(new Patch(plan.mvhdDurOff, field(movieDur, plan.mvhdDurSize)));
            if (fits(movieDur, plan.mehdDurSize)) out.add(new Patch(plan.mehdDurOff, field(movieDur, plan.mehdDurSize)));
            byte[] sidx = ok ? sidx() : null;
            if (sidx != null) {
                byte[] region = new byte[plan.reserveLen];
                int freeLen = plan.reserveLen - sidx.length;
                put32(region, 0, freeLen);
                region[4] = 'f'; region[5] = 'r'; region[6] = 'e'; region[7] = 'e';
                System.arraycopy(sidx, 0, region, freeLen, sidx.length);
                out.add(new Patch(plan.reserveOff, region));
            }
            return out;
        }

        /** Did {@link #finish} write a sidx? (For the save's log line.) */
        boolean sidxReady() {
            return analysisOk() && !inBody && hdrHave == 0 && sidx() != null;
        }

        private static boolean fits(long v, int size) {
            return v >= 0 && (size == 8 || v <= 0xffffffffL);
        }

        /** v1 sidx over the reference track's fragments, or null when it does not fit. */
        private byte[] sidx() {
            int n = refFrags.size();
            if (n == 0 || n > plan.maxRefs || lastMediaEnd < 0) return null;
            long sidxEnd = plan.reserveOff + plan.reserveLen;
            if (firstMoofStart < sidxEnd) return null;
            Long refEnd = trackEnd.get((long) plan.ref.id);
            if (refEnd == null) return null;
            int len = SIDX_FIXED + SIDX_PER_REF * n;
            if (plan.reserveLen - len < 8) return null;
            byte[] s = new byte[len];
            put32(s, 0, len);
            s[4] = 's'; s[5] = 'i'; s[6] = 'd'; s[7] = 'x';
            s[8] = 1; // version 1: 64-bit earliest_presentation_time and first_offset
            put32(s, 12, plan.ref.id);
            put32(s, 16, plan.ref.timescale);
            put64(s, 20, refFrags.get(0)[1]);
            put64(s, 28, firstMoofStart - sidxEnd);
            s[36] = 0; s[37] = 0;
            s[38] = (byte) (n >>> 8); s[39] = (byte) n;
            int o = SIDX_FIXED;
            for (int i = 0; i < n; i++) {
                long start = i == 0 ? firstMoofStart : refFrags.get(i)[0];
                long end = i + 1 < n ? refFrags.get(i + 1)[0] : lastMediaEnd;
                long t0 = refFrags.get(i)[1];
                long t1 = i + 1 < n ? refFrags.get(i + 1)[1] : refEnd;
                long size = end - start, dur = t1 - t0;
                if (size <= 0 || size > 0x7fffffffL || dur < 0 || dur > 0xffffffffL) return null;
                put32(s, o, size);              // reference_type 0 (media) | referenced_size
                put32(s, o + 4, dur);
                long sap = refFrags.get(i)[2] == 1 ? (1L << 31) | (1L << 28) : 0; // starts_with_SAP, SAP_type 1
                put32(s, o + 8, sap);
                o += SIDX_PER_REF;
            }
            return s;
        }
    }
}
