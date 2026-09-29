package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The keyboard for a composer opened from outside the page, on a device: the
 * app's REAL activity and WebView, the page calling NotesNative.showKeyboard
 * through Capacitor's real bridge, and the keyboard read from the window's
 * insets.
 *
 * What it proves, each half against the other:
 *  - a field the PAGE focuses (no tap) gets no keyboard — the reason the
 *    method exists, and the negative control for the next line;
 *  - showKeyboard, called right after, brings it up and answers shown:true;
 *  - with no field focused it asks for nothing and answers shown:false.
 *
 * The page is whatever the synced bundle renders (the sign-in screen, on a
 * fresh install); the field is one the test adds outside React's root, so
 * nothing on the page competes for it.
 *
 * Run: cd frontend/notes-app/android && ./gradlew connectedDebugAndroidTest
 * (a headless emulator: -no-window -no-audio). A device whose keyboard is
 * turned off for a hardware keyboard fails the positive half, rightly.
 */
@RunWith(AndroidJUnit4.class)
public class NotesKeyboardTest {

    private static final long PAGE_MS = 30_000;
    private static final long KEYBOARD_MS = 4_000;

    private static WebView webView(ActivityScenario<MainActivity> scenario) {
        AtomicReference<WebView> out = new AtomicReference<>();
        long until = SystemClock.uptimeMillis() + PAGE_MS;
        while (out.get() == null && SystemClock.uptimeMillis() < until) {
            scenario.onActivity(a -> {
                if (a.getBridge() != null) out.set(a.getBridge().getWebView());
            });
            if (out.get() == null) SystemClock.sleep(100);
        }
        if (out.get() == null) throw new AssertionError("the bridge never made its WebView");
        return out.get();
    }

    /** Evaluate in the page and return the JSON-encoded result. */
    private static String js(WebView wv, String script) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> out = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                wv.evaluateJavascript(script, v -> { out.set(v); done.countDown(); }));
        if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("evaluateJavascript never answered: " + script);
        return out.get();
    }

    private static boolean imeVisible(WebView wv) {
        AtomicBoolean out = new AtomicBoolean();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> out.set(NotesKeyboard.imeVisible(wv)));
        return out.get();
    }

    private static boolean waitFor(long ms, java.util.function.BooleanSupplier cond) {
        long until = SystemClock.uptimeMillis() + ms;
        while (SystemClock.uptimeMillis() < until) {
            if (cond.getAsBoolean()) return true;
            SystemClock.sleep(50);
        }
        return cond.getAsBoolean();
    }

    private static void waitForPage(WebView wv) throws InterruptedException {
        long until = SystemClock.uptimeMillis() + PAGE_MS;
        while (SystemClock.uptimeMillis() < until) {
            String ready = js(wv, "document.readyState === 'complete' && !!document.body"
                    + " && !!(window.Capacitor && window.Capacitor.nativePromise)");
            if ("true".equals(ready)) return;
            SystemClock.sleep(200);
        }
        throw new AssertionError("the page never finished loading with Capacitor's bridge");
    }

    /** The page's own call, through Capacitor's bridge, as notesNative.ts makes it. */
    private static final String CALL = "window.__kbd = 'pending';"
            + "window.Capacitor.nativePromise('NotesNative', 'showKeyboard', {})"
            + ".then(r => { window.__kbd = String(r && r.shown); }, e => { window.__kbd = 'rejected: ' + e; });"
            + "true";

    private static String answer(WebView wv) throws InterruptedException {
        String v = "\"pending\"";
        long until = SystemClock.uptimeMillis() + KEYBOARD_MS;
        while ("\"pending\"".equals(v) && SystemClock.uptimeMillis() < until) {
            SystemClock.sleep(100);
            v = js(wv, "window.__kbd");
        }
        return v;
    }

    @Test
    public void aFieldThePageFocusesGetsNoKeyboardUntilShowKeyboardAsks() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView wv = webView(scenario);
            waitForPage(wv);
            assertEquals("true", js(wv, "(() => {"
                    + " const i = document.createElement('input'); i.id = 'kbd-probe';"
                    + " document.body.appendChild(i); i.focus();"
                    + " return document.activeElement === i; })()"));

            // NEGATIVE CONTROL: focus() alone, as the composer does it.
            assertFalse("a field the page focused must not have raised the keyboard by itself",
                    waitFor(1500, () -> imeVisible(wv)));

            assertEquals("true", js(wv, CALL));
            assertTrue("showKeyboard must bring the keyboard up for the focused field",
                    waitFor(KEYBOARD_MS, () -> imeVisible(wv)));
            assertEquals("\"true\"", answer(wv));
            assertEquals("the keyboard types into the page's field, which kept the focus",
                    "true", js(wv, "document.activeElement === document.getElementById('kbd-probe')"));
        }
    }

    @Test
    public void withNoFieldFocusedItAsksForNothing() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            WebView wv = webView(scenario);
            waitForPage(wv);
            js(wv, "(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return true; })()");
            assertEquals("true", js(wv, "document.activeElement === document.body"));
            assertFalse(imeVisible(wv));

            assertEquals("true", js(wv, CALL));
            assertEquals("no field: it gives up and says so", "\"false\"", answer(wv));
            assertFalse("and nothing came up", imeVisible(wv));
        }
    }
}
