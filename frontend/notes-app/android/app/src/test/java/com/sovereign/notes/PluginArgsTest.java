package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

public class PluginArgsTest {

    @Test
    public void anEpochMillisecondValueArrivesAsALongAndIsRead() throws Exception {
        // What the bridge does with a JS Date.now()-sized number.
        Object v = new JSONObject("{\"beginMs\": 1789816183000}").get("beginMs");
        assertEquals(Long.class, v.getClass());
        assertEquals(Long.valueOf(1789816183000L), PluginArgs.millis(v));
    }

    @Test
    public void smallIntegersAndFractionsAreReadToo() throws Exception {
        JSONObject o = new JSONObject("{\"a\": 5, \"b\": 1789816183000.7}");
        assertEquals(Long.valueOf(5L), PluginArgs.millis(o.get("a")));
        assertEquals(Long.valueOf(1789816183000L), PluginArgs.millis(o.get("b")));
    }

    @Test
    public void anythingElseIsAbsent() throws Exception {
        assertNull(PluginArgs.millis(null));
        assertNull(PluginArgs.millis(JSONObject.NULL));
        assertNull(PluginArgs.millis("1789816183000"));
        assertNull(PluginArgs.millis(Double.NaN));
        assertNull(PluginArgs.millis(Double.POSITIVE_INFINITY));
    }
}
