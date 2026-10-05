package com.sovereign.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;

import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

/**
 * The native download engine: fetch an encrypted attachment or every part of
 * a Púca Clip from the user's OWN server, open it here, and stream it into a
 * MediaStore file — so the bytes never cross the WebView bridge.
 *
 * <p>WHY. The page used to fetch, decrypt and then push every byte through
 * the Capacitor bridge as base64 (saveToDevice.ts): ~4/3 of the file as JSON
 * strings parsed on the UI thread, the plugin media-scanning a {@code .part}
 * after every 3 MiB slice, and a {@code rename} that left MediaStore with no
 * duration, width or height, and the saved file sat in Documents/Puca where
 * galleries do not look. Measured on the emulator (2026-10-05, same 129 MB
 * clip, same link, interleaved runs): 22.3–23.9 s that way, 16.7–17.0 s
 * here, of which the network is all but ~0.2 s.
 *
 * <p>MEMORY is two direct buffers of one part each (~25 MiB + ~25 MiB),
 * reused for every part and dropped when the queue empties: a 1 GB clip
 * needs no more than a 1 MB one. GCM verifies a whole part before releasing a
 * byte, which is why a part (and no more) is held. Measured peak during the
 * 129 MB clip: app 220 MB + WebView renderer 165 MB PSS, against 196 + 401 MB
 * on the old path.
 *
 * <p>CREDENTIALS go to one place: {@code <apiBase>/files/<uuid>}, where
 * apiBase is the API origin this APK was BUILT for (capacitor.config's
 * {@code plugins.SovereignDownloads.apiBase}, checked by the plugin) and the
 * id was validated as a UUID. Redirects are refused, so neither the token nor
 * a file capability can be carried to another host. Nothing here logs a
 * token, a key, a file id or a file name.
 *
 * <p>LIVENESS: jobs run on one background thread, under {@link DownloadService}
 * (a dataSync foreground service with a wake lock and a progress
 * notification), so a locked screen or a backgrounded app does not stop a
 * long clip. The job does not need the WebView: swiping the app away leaves
 * the download running and the notification says when it is saved.
 *
 * <p>A FAILURE OR A CANCEL deletes the pending MediaStore row: nothing
 * half-written is ever visible, and no {@code .part} file exists to leak.
 * Rows a killed process left pending are swept on the next start
 * ({@link #sweepStalePending}); MediaStore also expires them on its own.
 */
final class NativeDownloads {

    private static final String TAG = "PucaDownloads";

    /** Largest body accepted: the server's 25 MiB file cap, plus slack. A
     *  clip part is 24 MiB + 35 bytes at most (clipCrypto.ts). */
    static final int WIRE_MAX = 25 * 1024 * 1024 + 4096;

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "puca-download");
        t.setDaemon(true);
        return t;
    });

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            // The only URL is the user's own /files/<id>. A redirect would
            // carry the Authorization and capability headers somewhere else.
            .followRedirects(false)
            .followSslRedirects(false)
            .build();

    private static final Map<String, Job> JOBS = new ConcurrentHashMap<>();
    private static int active;
    private static ByteBuffer inBuf, outBuf;

    private NativeDownloads() {}

    /** How a job reports back (the plugin; it may be gone by then). */
    interface Callback {
        void progress(long bytesDone, long totalBytes, int partsDone, int partsTotal);

        void saved(String where, String uri, long bytes, String container);

        void failed(String code, String message);
    }

    /** A download the page asked for. Everything in it was validated by the plugin. */
    static final class Job {
        final String id;
        final String apiBase;
        final String token;
        final String name;
        final Callback cb;
        // a clip
        byte[] key, noncePrefix, clipId;
        String[] parts;
        long totalBytes, durationMs;
        // an attachment
        String fileId, cap, senderMime;

        volatile boolean cancelled;
        volatile Call call;

        Job(String id, String apiBase, String token, String name, Callback cb) {
            this.id = id;
            this.apiBase = apiBase;
            this.token = token;
            this.name = name;
            this.cb = cb;
        }

        boolean isClip() {
            return parts != null;
        }
    }

    /** A failure the page can act on: a short code and a sentence for people. */
    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** Downloads queued or running. */
    static synchronized int activeCount() {
        return active;
    }

    static boolean has(String id) {
        return JOBS.containsKey(id);
    }

    static void enqueue(Context ctx, Job job) {
        Context app = ctx.getApplicationContext();
        JOBS.put(job.id, job);
        // Start and stop of the service happen under one lock, so a download
        // queued as the last one ends can never have its service stopped
        // under it.
        synchronized (NativeDownloads.class) {
            active++;
            DownloadService.begin(app, job.name);
        }
        EXEC.execute(() -> run(app, job));
    }

    /** Stop a download; it rejects with "cancelled" and leaves nothing behind. */
    static boolean cancel(String id) {
        Job j = JOBS.get(id);
        if (j == null) return false;
        j.cancelled = true;
        Call c = j.call;
        if (c != null) c.cancel();
        return true;
    }

    static void cancelAll() {
        for (String id : JOBS.keySet()) cancel(id);
    }

    private static void run(Context app, Job job) {
        long t0 = SystemClock.elapsedRealtime();
        // Owned HERE, not by runClip/runAttachment: a failure or a cancel after
        // the pending row was created must still reach the abandon() below.
        Result r = new Result();
        try {
            if (job.cancelled) throw new Failure("cancelled", "Download cancelled.");
            ensureBuffers();
            if (job.isClip()) runClip(app, job, r);
            else runAttachment(app, job, r);
            MediaStoreFile file = r.file;
            String where = file.publish();
            r.file = null; // published: nothing to abandon, whatever happens next
            long ms = SystemClock.elapsedRealtime() - t0;
            Log.i(TAG, (job.isClip() ? "clip" : "attachment") + " saved: " + r.bytes + " bytes in " + ms + " ms (fetch " + r.fetchMs
                    + ", decrypt " + r.openMs + ", write " + r.writeMs + "), " + r.container);
            DownloadService.finished(app, job, true, where, file.uri, file.mime);
            tell(() -> job.cb.saved(where, file.uri.toString(), r.bytes, r.container));
        } catch (Failure f) {
            String code = job.cancelled ? "cancelled" : f.code;
            Log.w(TAG, "download failed: " + code);
            if (!"cancelled".equals(code)) DownloadService.finished(app, job, false, null, null, null);
            tell(() -> job.cb.failed(code, "cancelled".equals(code) ? "Download cancelled." : f.getMessage()));
        } catch (Throwable t) {
            String code = job.cancelled ? "cancelled" : "write";
            Log.w(TAG, "download failed: " + code + " (" + t.getClass().getSimpleName() + ")");
            if (!"cancelled".equals(code)) DownloadService.finished(app, job, false, null, null, null);
            tell(() -> job.cb.failed(code, "cancelled".equals(code) ? "Download cancelled." : "Could not save the file on this phone."));
        } finally {
            if (r.file != null) r.file.abandon();
            JOBS.remove(job.id);
            synchronized (NativeDownloads.class) {
                if (--active == 0) {
                    inBuf = null;
                    outBuf = null;
                    DownloadService.end(app);
                }
            }
        }
    }

    /**
     * Tell the page. It may be gone (the app swiped away, the WebView torn
     * down) while the download carries on: a bridge that throws must not turn
     * a SAVED file into a failure, or a failure into a second one.
     */
    private static void tell(Runnable r) {
        try {
            r.run();
        } catch (RuntimeException e) {
            Log.w(TAG, "could not tell the page (" + e.getClass().getSimpleName() + ")");
        }
    }

    private static synchronized void ensureBuffers() {
        if (inBuf == null) inBuf = ByteBuffer.allocateDirect(WIRE_MAX);
        if (outBuf == null) outBuf = ByteBuffer.allocateDirect(WIRE_MAX);
    }

    /** What a run produced, before it is published. */
    private static final class Result {
        MediaStoreFile file;
        long bytes;
        String container = "";
        /** Where the time went (ms): network, decryption, writing. Logged, never content. */
        long fetchMs, openMs, writeMs;
    }

    // ---- an attachment: one part ----------------------------------------------

    private static void runAttachment(Context app, Job job, Result r) throws Failure, IOException {
        Progress p = new Progress(job, 1);
        long t = SystemClock.elapsedRealtime();
        fetch(job, job.fileId, job.cap, inBuf, p);
        r.fetchMs += SystemClock.elapsedRealtime() - t;
        t = SystemClock.elapsedRealtime();
        outBuf.clear();
        try {
            DownloadCrypto.openAttachment(job.key, inBuf, outBuf);
        } catch (DownloadCrypto.DecryptException e) {
            throw new Failure("decrypt", "This file could not be decrypted — it may have been damaged or replaced.");
        }
        outBuf.flip();
        r.openMs += SystemClock.elapsedRealtime() - t;
        if (job.cancelled) throw new Failure("cancelled", "Download cancelled.");
        SaveTarget target = target(outBuf, job.name, job.senderMime);
        t = SystemClock.elapsedRealtime();
        r.file = MediaStoreFile.create(app, target);
        r.bytes = outBuf.remaining();
        r.file.write(outBuf);
        r.writeMs += SystemClock.elapsedRealtime() - t;
        r.container = target.collection.name().toLowerCase(java.util.Locale.ROOT);
        p.partDone();
    }

    // ---- a clip: every part, in order --------------------------------------------

    private static void runClip(Context app, Job job, Result r) throws Failure, IOException {
        Progress p = new Progress(job, job.parts.length);
        ClipAssembler asm = null;
        for (int i = 0; i < job.parts.length; i++) {
            if (job.cancelled) throw new Failure("cancelled", "Download cancelled.");
            long t = SystemClock.elapsedRealtime();
            fetch(job, job.parts[i], null, inBuf, p);
            r.fetchMs += SystemClock.elapsedRealtime() - t;
            t = SystemClock.elapsedRealtime();
            outBuf.clear();
            try {
                DownloadCrypto.openClipPart(job.key, job.noncePrefix, job.clipId, i, inBuf, outBuf);
            } catch (DownloadCrypto.DecryptException e) {
                throw new Failure("decrypt", "Part " + (i + 1) + " of this clip could not be decrypted — it may have been damaged or replaced.");
            }
            outBuf.flip();
            r.openMs += SystemClock.elapsedRealtime() - t;
            t = SystemClock.elapsedRealtime();
            if (i == 0) {
                SaveTarget target = target(outBuf, job.name, "video/mp4");
                r.file = MediaStoreFile.create(app, target);
                // Only an MP4 gets the container fix; anything else is saved as sealed.
                // A Cancel reaches inside a part too (a CancellationException, which
                // run() reports as "cancelled"), not only between parts.
                boolean mp4 = target.mime.equals("video/mp4") || target.mime.equals("audio/mp4");
                asm = new ClipAssembler(r.file, job.durationMs, mp4, () -> job.cancelled);
            }
            asm.part(i, outBuf);
            r.writeMs += SystemClock.elapsedRealtime() - t;
            p.partDone();
        }
        if (job.cancelled) throw new Failure("cancelled", "Download cancelled.");
        long t = SystemClock.elapsedRealtime();
        r.bytes = asm.finish();
        r.writeMs += SystemClock.elapsedRealtime() - t;
        r.container = asm.outcome();
    }

    private static SaveTarget target(ByteBuffer plain, String name, String senderMime) {
        int n = Math.min(SaveTarget.SNIFF_BYTES, plain.remaining());
        byte[] head = new byte[n];
        plain.duplicate().get(head);
        return SaveTarget.decide(head, n, name, senderMime, ext -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext));
    }

    // ---- the network ----------------------------------------------------------------

    /** Progress, throttled for the bridge and the notification. */
    private static final class Progress {
        final Job job;
        final int total;
        int done;
        long committed, current;
        long lastSent;
        /** An attachment's size as the response announced it (Content-Length);
         *  0 = unknown, which is the usual case: GET /files streams its body. */
        long expected;

        Progress(Job job, int total) {
            this.job = job;
            this.total = total;
        }

        void add(long n) {
            current += n;
            maybeSend(false);
        }

        void restartPart() {
            current = 0;
            maybeSend(true);
        }

        void partDone() {
            committed += current;
            current = 0;
            done++;
            maybeSend(true);
        }

        private void maybeSend(boolean force) {
            long now = SystemClock.elapsedRealtime();
            if (!force && now - lastSent < 200) return;
            lastSent = now;
            long bytes = committed + current;
            // 0 = unknown: the page then shows the bytes alone, never a made-up percent.
            long totalBytes = job.isClip() ? Math.max(job.totalBytes, bytes) : (expected > 0 ? Math.max(expected, bytes) : 0);
            tell(() -> job.cb.progress(bytes, totalBytes, done, total));
            DownloadService.progress(job, bytes, totalBytes);
        }
    }

    /**
     * Waits before each retry of a dropped part, in ms: one per retry, so
     * ATTEMPTS = 1 + its length. ~14 s in all, long enough to ride out a
     * phone moving between Wi-Fi and mobile data (the part restarts from its
     * first byte: GET /files has no ranges). A Cancel cuts a wait short.
     */
    private static final long[] RETRY_WAIT_MS = { 1000, 3000, 10000 };
    private static final int ATTEMPTS = 1 + RETRY_WAIT_MS.length;

    /** GET <apiBase>/files/<id> into {@code in} (flipped). Retries a dropped connection. */
    private static void fetch(Job job, String fileId, String cap, ByteBuffer in, Progress p) throws Failure {
        if (!DownloadInputs.isUuid(fileId)) throw new Failure("bad-input", "This file reference is malformed.");
        HttpUrl base = HttpUrl.parse(job.apiBase);
        if (base == null) throw new Failure("origin", "This app is not set up for native downloads.");
        HttpUrl url = base.newBuilder().addPathSegment("files").addPathSegment(fileId).build();
        if (!url.host().equals(base.host()) || url.port() != base.port() || !url.scheme().equals(base.scheme())) {
            throw new Failure("origin", "Refusing to send credentials anywhere but your server.");
        }
        Request.Builder rb = new Request.Builder().url(url).get().header("Authorization", "Bearer " + job.token);
        if (cap != null) rb.header("X-Puca-File-Cap", cap);
        Request req = rb.build();
        for (int attempt = 1; ; attempt++) {
            if (job.cancelled) throw new Failure("cancelled", "Download cancelled.");
            in.clear();
            Call call = HTTP.newCall(req);
            job.call = call;
            if (job.cancelled) call.cancel();
            try (Response resp = call.execute()) {
                int code = resp.code();
                if (code == 404 || code == 410) throw new Failure("gone", "This file is no longer on the server.");
                if (code == 401 || code == 403) throw new Failure("denied", "The server refused this file (HTTP " + code + ").");
                if (code >= 500 && attempt < ATTEMPTS) throw new IOException("HTTP " + code);
                if (code != 200) throw new Failure("http", "The server answered HTTP " + code + ".");
                ResponseBody body = resp.body();
                if (body == null) throw new IOException("no body");
                if (!job.isClip()) p.expected = Math.max(0, body.contentLength());
                BufferedSource src = body.source();
                while (true) {
                    if (!in.hasRemaining()) {
                        if (src.exhausted()) break;
                        throw new Failure("too-large", "This file is larger than any Púca file can be.");
                    }
                    int n = src.read(in);
                    if (n < 0) break;
                    p.add(n);
                }
                in.flip();
                return;
            } catch (IOException e) {
                if (job.cancelled) throw new Failure("cancelled", "Download cancelled.");
                p.restartPart();
                if (attempt >= ATTEMPTS) throw new Failure("network", "The connection dropped and did not come back.");
                Log.i(TAG, "connection dropped (" + e.getClass().getSimpleName() + "); retrying, attempt " + (attempt + 1) + " of " + ATTEMPTS);
                long until = SystemClock.elapsedRealtime() + RETRY_WAIT_MS[attempt - 1];
                while (!job.cancelled && SystemClock.elapsedRealtime() < until) SystemClock.sleep(100);
            } finally {
                job.call = null;
            }
        }
    }

    // ---- MediaStore ------------------------------------------------------------------

    /** A pending MediaStore item, written through a read-write descriptor. */
    static final class MediaStoreFile implements ClipAssembler.Sink {
        final Context app;
        final Uri uri;
        final String mime;
        private ParcelFileDescriptor pfd;
        private FileChannel ch;

        private MediaStoreFile(Context app, Uri uri, String mime, ParcelFileDescriptor pfd) {
            this.app = app;
            this.uri = uri;
            this.mime = mime;
            this.pfd = pfd;
            this.ch = new FileOutputStream(pfd.getFileDescriptor()).getChannel();
        }

        static Uri collection(SaveTarget.Collection c) {
            String vol = MediaStore.VOLUME_EXTERNAL_PRIMARY;
            switch (c) {
                case VIDEO: return MediaStore.Video.Media.getContentUri(vol);
                case IMAGE: return MediaStore.Images.Media.getContentUri(vol);
                case AUDIO: return MediaStore.Audio.Media.getContentUri(vol);
                default: return MediaStore.Downloads.getContentUri(vol);
            }
        }

        static MediaStoreFile create(Context app, SaveTarget t) throws Failure {
            ContentResolver cr = app.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, t.displayName);
            v.put(MediaStore.MediaColumns.MIME_TYPE, t.mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, t.relativePath());
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri;
            try {
                uri = cr.insert(collection(t.collection), v);
            } catch (RuntimeException e) {
                uri = null;
            }
            if (uri == null) throw new Failure("write", "Could not create the file on this phone. Check you have free space.");
            try {
                ParcelFileDescriptor pfd = cr.openFileDescriptor(uri, "rw");
                if (pfd == null) throw new IOException("no descriptor");
                return new MediaStoreFile(app, uri, t.mime, pfd);
            } catch (IOException | RuntimeException e) {
                try { cr.delete(uri, null, null); } catch (RuntimeException ignored) { /* gone */ }
                throw new Failure("write", "Could not create the file on this phone. Check you have free space.");
            }
        }

        @Override
        public void write(ByteBuffer b) throws IOException {
            while (b.hasRemaining()) ch.write(b);
        }

        @Override
        public void writeAt(long position, ByteBuffer b) throws IOException {
            long pos = position;
            while (b.hasRemaining()) pos += ch.write(b, pos);
        }

        /** Close, clear IS_PENDING, and say where it is ("Movies/Puca/name.mp4"). */
        String publish() throws IOException {
            ch.force(false);
            ch.close();
            pfd.close();
            ch = null;
            pfd = null;
            ContentResolver cr = app.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            if (cr.update(uri, v, null, null) != 1) throw new IOException("could not publish");
            // Published: from here on nothing may throw, or the caller would
            // delete a file the user now has.
            String where = null;
            String data = null;
            Long duration = null;
            String[] cols = { MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DURATION };
            try (Cursor c = cr.query(uri, cols, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    where = c.getString(0) + c.getString(1);
                    data = c.getString(2);
                    duration = c.isNull(3) ? null : c.getLong(3);
                }
            } catch (RuntimeException ignored) {
                // DURATION is API 29+ on every collection; a query failure only costs the readout
            }
            // MediaStore fills duration/width/height when it scans the
            // published item; ask once more if that has not happened.
            boolean media = mime.startsWith("video/") || mime.startsWith("audio/");
            if (media && duration == null && data != null) {
                try {
                    MediaScannerConnection.scanFile(app, new String[] { data }, new String[] { mime }, null);
                } catch (RuntimeException ignored) {
                    // the file is saved; only its gallery details wait for the next scan
                }
            }
            return where != null ? where : "your phone's " + (mime.startsWith("video/") ? "Movies" : "Download") + " folder";
        }

        void abandon() {
            try { if (ch != null) ch.close(); } catch (IOException ignored) { /* closing */ }
            try { if (pfd != null) pfd.close(); } catch (IOException ignored) { /* closing */ }
            ch = null;
            pfd = null;
            try {
                app.getContentResolver().delete(uri, null, null);
            } catch (RuntimeException e) {
                Log.w(TAG, "could not delete an abandoned download (" + e.getClass().getSimpleName() + ")");
            }
        }
    }

    /**
     * Delete rows THIS app left pending in its own Puca folders — what a process
     * killed mid-download leaves (invisible to every app, but taking space until
     * MediaStore expires it). Never while a download of ours is running.
     */
    static void sweepStalePending(Context ctx) {
        if (Build.VERSION.SDK_INT < 30) return; // QUERY_ARG_MATCH_PENDING; 29 relies on MediaStore's own expiry
        Context app = ctx.getApplicationContext();
        EXEC.execute(() -> {
            synchronized (NativeDownloads.class) {
                if (active > 0) return;
            }
            int n = 0;
            for (SaveTarget.Collection c : SaveTarget.Collection.values()) {
                Uri coll = MediaStoreFile.collection(c);
                Bundle q = new Bundle();
                q.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_ONLY);
                q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?");
                q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] { app.getPackageName(), "%/" + SaveTarget.FOLDER + "/" });
                try (Cursor cur = app.getContentResolver().query(coll, new String[] { MediaStore.MediaColumns._ID }, q, null)) {
                    while (cur != null && cur.moveToNext()) {
                        Uri u = Uri.withAppendedPath(coll, String.valueOf(cur.getLong(0)));
                        n += app.getContentResolver().delete(u, null, null);
                    }
                } catch (RuntimeException e) {
                    Log.w(TAG, "pending sweep skipped (" + e.getClass().getSimpleName() + ")");
                }
            }
            if (n > 0) Log.i(TAG, "swept " + n + " abandoned pending download(s)");
        });
    }
}
