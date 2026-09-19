package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * On a device, against Android's OWN org.json and Capacitor's real
 * PluginCall — the pair the JVM PluginArgsTest cannot reach (it runs on the
 * Maven org.json). The call is built exactly as Capacitor's MessageHandler
 * builds one from the bridge's JSON string: parse the message, take its
 * "options" object, wrap it in a PluginCall.
 *
 * Run: cd frontend/notes-app/android && ./gradlew connectedDebugAndroidTest
 * (a headless emulator: -no-window -no-audio).
 */
@RunWith(AndroidJUnit4.class)
public class PluginArgsBridgeTest {

    private static PluginCall bridgeCall(String optionsJson) throws Exception {
        String message = "{\"callbackId\":\"1\",\"pluginId\":\"NotesNative\",\"methodName\":\"addToPhoneCalendar\","
                + "\"options\":" + optionsJson + "}";
        JSObject postData = new JSObject(message);
        JSObject options = postData.getJSObject("options", new JSObject());
        return new PluginCall(null, "NotesNative", "1", "addToPhoneCalendar", options);
    }

    @Test
    public void anEpochMillisecondBeginArrivesAndIsRead() throws Exception {
        PluginCall call = bridgeCall("{\"title\":\"x\",\"beginMs\":1789816183000,\"endMs\":1789819783000}");
        // Why PluginArgs exists: the typed getter answers null for this value
        // on a real device. If this ever stops being null, the workaround is
        // no longer needed — not wrong.
        assertNull(call.getDouble("beginMs"));
        assertEquals(Long.valueOf(1789816183000L), PluginArgs.millis(call, "beginMs"));
        assertEquals(Long.valueOf(1789819783000L), PluginArgs.millis(call, "endMs"));
    }

    @Test
    public void aFractionalOrSmallNumberIsReadAndAMissingOneIsAbsent() throws Exception {
        PluginCall call = bridgeCall("{\"beginMs\":1789816183000.5,\"endMs\":7}");
        assertEquals(Long.valueOf(1789816183000L), PluginArgs.millis(call, "beginMs"));
        assertEquals(Long.valueOf(7L), PluginArgs.millis(call, "endMs"));
        assertNull(PluginArgs.millis(bridgeCall("{}"), "beginMs"));
        assertNull(PluginArgs.millis(bridgeCall("{\"beginMs\":\"1789816183000\"}"), "beginMs"));
    }
}
