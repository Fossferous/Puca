package com.sovereign.app;

/**
 * The one screen share the page is waiting on, and which share every native
 * event belongs to. Pure Java, so JUnit drives it (as {@link ScreenShareFrames}).
 *
 * <p>Every start gets a new id, and the id rides the service intent, so a
 * share's events carry it back. That is what keeps an OLD share's end from
 * answering a NEW start. Without it, a Share right after a reload went wrong:
 * the new start stopped the share the old page had left running, that share's
 * end rejected the new start while Android's dialog was still open, and the
 * capture the person then allowed found nobody waiting and stopped itself.
 *
 * <p>Thread-safe: plugin methods, the activity result, the service and the
 * WebView's page events all reach it from different threads.
 *
 * @param <C> the waiting call (a Capacitor PluginCall in the app)
 */
final class ScreenShareSlot<C> {

    /** A start waiting for Android's consent and then for the capture. */
    static final class Pending<C> {
        final long id;
        final C call;
        final String callId;
        final String nonce;
        final int width;
        final int height;
        final int fps;

        Pending(long id, C call, String callId, String nonce, int width, int height, int fps) {
            this.id = id;
            this.call = call;
            this.callId = callId;
            this.nonce = nonce;
            this.width = width;
            this.height = height;
            this.fps = fps;
        }
    }

    private long nextId = 1;
    private Pending<C> pending;

    /** A new start. Any earlier one still waiting is handed back, to refuse. */
    synchronized Pending<C> begin(C call, String callId, String nonce, int width, int height, int fps) {
        pending = new Pending<>(nextId++, call, callId, nonce, width, height, fps);
        return pending;
    }

    synchronized boolean busy() {
        return pending != null;
    }

    /** The waiting start, if it is the one this call (by its id) made. */
    synchronized Pending<C> forCall(String callId) {
        return pending != null && pending.callId != null && pending.callId.equals(callId) ? pending : null;
    }

    /** The waiting start, if share {@code id} is its share. */
    synchronized Pending<C> peek(long id) {
        return pending != null && pending.id == id ? pending : null;
    }

    /** Takes the waiting start out, if share {@code id} is its share; null otherwise. */
    synchronized Pending<C> take(long id) {
        if (pending == null || pending.id != id) return null;
        Pending<C> p = pending;
        pending = null;
        return p;
    }

    /** Takes whatever start is waiting out (the page that made it is gone). */
    synchronized Pending<C> takeAny() {
        Pending<C> p = pending;
        pending = null;
        return p;
    }
}
