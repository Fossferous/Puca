package com.sovereign.notes;

/**
 * Reading plugin-call arguments that the bridge's typed getters get wrong.
 *
 * An epoch-milliseconds value from JS (about 1.8e12) is too big for an int,
 * so the bridge's JSON parser hands it over as a Long — and
 * PluginCall.getDouble() answers null for a Long (it checks Double, Integer
 * and Float only). Found on the emulator: every addToPhoneCalendar call said
 * "beginMs is required". Pure Java, JUnit-tested (PluginArgsTest).
 */
final class PluginArgs {

    private PluginArgs() {}

    /** A whole number of milliseconds from any JSON number, or null for
     *  anything else (absent, null, a string, NaN or infinite). */
    static Long millis(Object v) {
        if (!(v instanceof Number)) return null;
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return null;
            return (long) d;
        }
        return ((Number) v).longValue();
    }
}
