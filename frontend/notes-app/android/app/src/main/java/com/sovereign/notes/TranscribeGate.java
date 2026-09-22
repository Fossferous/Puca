package com.sovereign.notes;

/**
 * Whether this phone may write down a voice note AT ALL — the one decision
 * that keeps a recording from being sent anywhere.
 *
 * Deliberately pure Java (no android.*, no org.json) so it runs under plain
 * JUnit on the JVM, like GeofenceEngine and ReminderRules: the rest of the
 * native layer is untestable off-device, and this is the part where a
 * well-meaning "fall back to the normal recogniser" would quietly turn a
 * private feature into a cloud one.
 *
 * THE RULES, and why each is a refusal rather than a fallback:
 *
 *  - Android's DEFAULT SpeechRecognizer is a network service on most phones.
 *    RecognizerIntent.EXTRA_PREFER_OFFLINE is a HINT the service may ignore,
 *    so it is not a guarantee and is never used as one. The only transcriber
 *    allowed is SpeechRecognizer.createOnDeviceSpeechRecognizer, and only
 *    when SpeechRecognizer.isOnDeviceRecognitionAvailable says yes — that is
 *    {@code onDeviceAvailable} here.
 *  - Feeding a RECORDED clip to the recogniser needs
 *    RecognizerIntent.EXTRA_AUDIO_SOURCE, which landed in API 33. Below that
 *    the recogniser can only listen to a live microphone, which would mean
 *    holding the mic a second time while the WebView records — so API 33 is
 *    a floor, not a preference.
 *
 * There is NO input to this class that returns ALLOW without
 * {@code onDeviceAvailable}. A test sweeps every combination to keep it that way.
 *
 * {@link #watchdogMs} lives here for the same reason: pure arithmetic is the
 * only part of the native transcriber a JUnit run can see, and how long a
 * recognition session may hang decides how long the plaintext PCM stays in
 * the cache.
 */
public final class TranscribeGate {

    /** RecognizerIntent.EXTRA_AUDIO_SOURCE and friends: Android 13. */
    public static final int MIN_SDK = 33;

    /** No transcriber on this phone, and no reason to pretend otherwise. */
    public static final String REASON_SDK = "sdk";
    public static final String REASON_NO_MODEL = "no-on-device-model";

    public static final class Decision {
        /** True only when an ON-DEVICE recogniser may be built and used. */
        public final boolean allowed;
        /** Why not, for the page to turn into a sentence. Empty when allowed. */
        public final String reason;

        Decision(boolean allowed, String reason) {
            this.allowed = allowed;
            this.reason = reason;
        }
    }

    private TranscribeGate() {}

    /**
     * @param sdkInt            Build.VERSION.SDK_INT of this phone
     * @param onDeviceAvailable SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)
     */
    public static Decision decide(int sdkInt, boolean onDeviceAvailable) {
        if (sdkInt < MIN_SDK) return new Decision(false, REASON_SDK);
        if (!onDeviceAvailable) return new Decision(false, REASON_NO_MODEL);
        return new Decision(true, "");
    }

    /** The floor and ceiling of {@link #watchdogMs}, mirrored by
     *  notes/model/audioNote.ts's {@code transcribeBudgetMs}. */
    public static final long WATCHDOG_MIN_MS = 20_000L;
    public static final long WATCHDOG_MAX_MS = 60_000L;

    /**
     * How long to let a recognition session run before giving up on it.
     *
     * A session that is started but never calls back -- the recogniser
     * service is killed, the model is swapped out mid-session -- would
     * otherwise leave the PluginCall unanswered for ever. That is not only a
     * hung promise: the page's {@code finally} deletes the plaintext PCM from
     * the app's cache when the call RETURNS, so a session that never answers
     * leaves the one unsealed copy of the recording on disk indefinitely.
     *
     * The budget is measured from the clip itself, which arrives as raw
     * 16-bit mono PCM, so its length is exactly {@code bytes / (rate * 2)}
     * seconds. Half again as long plus fifteen seconds is far more than
     * on-device recognition of a file needs, and it is clamped so a zero-byte
     * or absurd file still gets a sane bound.
     *
     * @param pcmBytes   size of the cache file, or 0 when it cannot be read
     * @param sampleRate the rate the page wrote it at
     */
    public static long watchdogMs(long pcmBytes, int sampleRate) {
        long clipMs = 0L;
        if (pcmBytes > 0L && sampleRate > 0) clipMs = (pcmBytes * 1000L) / ((long) sampleRate * 2L);
        long budget = clipMs + clipMs / 2L + 15_000L;
        if (budget < WATCHDOG_MIN_MS) return WATCHDOG_MIN_MS;
        if (budget > WATCHDOG_MAX_MS) return WATCHDOG_MAX_MS;
        return budget;
    }
}
