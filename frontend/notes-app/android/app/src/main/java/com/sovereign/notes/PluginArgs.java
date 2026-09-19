package com.sovereign.notes;

/**
 * Reading plugin-call arguments that the bridge's typed getters get wrong.
 *
 * An epoch-milliseconds value from JS (about 1.8e12) is too big for an int,
 * so the bridge's JSON parser hands it over as a Long — and
 * PluginCall.getDouble() answers null for a Long (it checks Double, Integer
 * and Float only). Found on the emulator: every addToPhoneCalendar call said
 * "beginMs is required". The Object form is pure Java (PluginArgsTest); the
 * PluginCall form runs on a device against Android's own org.json
 * (PluginArgsBridgeTest), which is where the defect lived.
 */
final class PluginArgs {

    private PluginArgs() {}

    /** The call's `key` argument as whole milliseconds (see {@link #millis(Object)}).
     *  What the plugin methods use; instrumented-tested against a PluginCall
     *  built the way Capacitor's MessageHandler builds one
     *  (androidTest/PluginArgsBridgeTest). */
    static Long millis(com.getcapacitor.PluginCall call, String key) {
        return call == null || call.getData() == null ? null : millis(call.getData().opt(key));
    }

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
