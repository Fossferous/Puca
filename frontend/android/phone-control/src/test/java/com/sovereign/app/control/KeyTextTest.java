package com.sovereign.app.control;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** A viewer's key codes as a phone understands them. */
public class KeyTextTest {

    @Test
    public void lettersDigitsAndShift() {
        assertEquals("a", KeyText.charFor("KeyA", false));
        assertEquals("Z", KeyText.charFor("KeyZ", true));
        assertEquals("7", KeyText.charFor("Digit7", false));
        assertEquals("&", KeyText.charFor("Digit7", true));
        assertEquals(")", KeyText.charFor("Digit0", true));
        assertEquals(" ", KeyText.charFor("Space", true));
        assertEquals("?", KeyText.charFor("Slash", true));
        assertEquals("\"", KeyText.charFor("Quote", true));
        // The numpad types digits with or without shift.
        assertEquals("4", KeyText.charFor("Numpad4", true));
    }

    @Test
    public void keysWithNoCharacterTypeNothing() {
        assertNull(KeyText.charFor("F5", false));
        assertNull(KeyText.charFor("ControlLeft", false));
        assertNull(KeyText.charFor("Escape", false));
        assertNull(KeyText.charFor(null, false));
    }

    @Test
    public void escapeIsBackAndEditingKeysEdit() {
        assertEquals(TouchPlanner.BACK, KeyText.actionFor("Escape"));
        assertEquals(TouchPlanner.ENTER, KeyText.actionFor("Enter"));
        assertEquals(TouchPlanner.ENTER, KeyText.actionFor("NumpadEnter"));
        assertEquals(TouchPlanner.BACKSPACE, KeyText.actionFor("Backspace"));
        assertEquals(TouchPlanner.DELETE, KeyText.actionFor("Delete"));
        // A keyboard's Home is not the phone's Home button.
        assertNull(KeyText.actionFor("Home"));
        assertNull(KeyText.actionFor("KeyA"));
    }
}
