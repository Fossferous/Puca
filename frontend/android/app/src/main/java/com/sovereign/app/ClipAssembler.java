package com.sovereign.app;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * Writes a clip's decrypted parts, in order, into one file — with the
 * {@link Fmp4SaveFix} applied when the clip is an MP4 it understands. Pure
 * Java: the app gives it a MediaStore file, the JUnit suite an in-memory one,
 * and both run exactly this code.
 *
 * <p>The parts concatenate to the muxer's original output (fmp4Split.ts cuts
 * only at box boundaries), so without the fix this is a plain concatenation;
 * with it, the init grows by an mehd and a reserved region and {@link #finish}
 * writes the patches at their absolute offsets.
 */
final class ClipAssembler {

    /** Where the bytes go: in order, plus positional rewrites at the end. */
    interface Sink {
        void write(ByteBuffer bytes) throws IOException;

        void writeAt(long position, ByteBuffer bytes) throws IOException;
    }

    private final Sink sink;
    private final long durationHintMs;
    private final boolean fix;
    private final BooleanSupplier cancelled;
    private Fmp4SaveFix.Plan plan;
    private Fmp4SaveFix.Scanner scanner;
    private int nextIndex;
    private long written;
    private String outcome = "not started";

    /**
     * @param fix  false = a plain concatenation (a clip whose bytes are not an
     *             MP4 at all is still saved, just not touched)
     */
    ClipAssembler(Sink sink, long durationHintMs, boolean fix) {
        this(sink, durationHintMs, fix, null);
    }

    /**
     * @param cancelled polled before every part and once per box while a part
     *                  is read; true throws {@link CancellationException}, so
     *                  a Cancel stops a long or hostile part where it is
     */
    ClipAssembler(Sink sink, long durationHintMs, boolean fix, BooleanSupplier cancelled) {
        this.sink = sink;
        this.durationHintMs = durationHintMs;
        this.fix = fix;
        this.cancelled = cancelled;
    }

    /** Part {@code index}'s plaintext, position to limit; parts arrive in order. */
    void part(int index, ByteBuffer plain) throws IOException {
        if (index != nextIndex) throw new IllegalStateException("part " + index + " out of order (expected " + nextIndex + ")");
        if (cancelled != null && cancelled.getAsBoolean()) throw new CancellationException("download cancelled");
        nextIndex++;
        if (index == 0) {
            int len = plain.remaining();
            byte[] init = new byte[len];
            plain.duplicate().get(init);
            plan = fix ? Fmp4SaveFix.prepareInit(init, len, durationHintMs) : null;
            if (plan == null) {
                outcome = fix ? "saved as sealed (init not recognised)" : "saved as sealed";
                put(plain);
                return;
            }
            put(ByteBuffer.wrap(plan.init));
            scanner = new Fmp4SaveFix.Scanner(plan, plan.init.length, cancelled);
            if (plan.consumed < len) {
                ByteBuffer rest = plain.duplicate();
                rest.position(rest.position() + plan.consumed);
                scanner.feed(rest);
                put(rest);
            }
            return;
        }
        if (scanner != null) scanner.feed(plain);
        put(plain);
    }

    /** Applies the patches; returns the file's final length. */
    long finish() throws IOException {
        if (scanner != null) {
            boolean sidx = scanner.sidxReady();
            List<Fmp4SaveFix.Patch> patches = scanner.finish(durationHintMs);
            for (Fmp4SaveFix.Patch p : patches) sink.writeAt(p.offset, ByteBuffer.wrap(p.bytes));
            outcome = sidx ? "duration and seek index added" : "duration added (no seek index: " + (scanner.analysisOk() ? "too many fragments" : "fragments not understood") + ")";
        }
        return written;
    }

    /** What happened to the container, for the log line. Never names content. */
    String outcome() {
        return outcome;
    }

    private void put(ByteBuffer b) throws IOException {
        int n = b.remaining();
        sink.write(b.duplicate());
        written += n;
    }
}
