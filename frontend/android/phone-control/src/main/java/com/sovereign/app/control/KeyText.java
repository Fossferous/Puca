package com.sovereign.app.control;

import java.util.HashMap;
import java.util.Map;

/**
 * A viewer's key ({@code KeyboardEvent.code}, the in-call wire's only key
 * vocabulary) as what it means on a phone. Pure (KeyTextTest).
 *
 * A phone has no scan codes to inject: a non-root AccessibilityService can
 * only change the focused field's text. So printable keys become characters,
 * read on a US layout (a code names a key's POSITION, and the wire carries
 * nothing else). A viewer that knows it controls a phone sends the characters
 * themselves instead ({@code {t:'text'}}, remoteControl.ts), which is how any
 * other layout and any other script reach the phone; this table is for
 * viewers that do not.
 */
final class KeyText {

    private KeyText() {}

    private static final Map<String, String[]> PRINTABLE = new HashMap<>();

    private static void put(String code, String plain, String shifted) {
        PRINTABLE.put(code, new String[] { plain, shifted });
    }

    static {
        for (char c = 'A'; c <= 'Z'; c++) {
            put("Key" + c, String.valueOf(Character.toLowerCase(c)), String.valueOf(c));
        }
        String shiftedDigits = ")!@#$%^&*(";
        for (int d = 0; d <= 9; d++) {
            put("Digit" + d, String.valueOf(d), String.valueOf(shiftedDigits.charAt(d)));
            put("Numpad" + d, String.valueOf(d), String.valueOf(d));
        }
        put("Space", " ", " ");
        put("Minus", "-", "_");
        put("Equal", "=", "+");
        put("BracketLeft", "[", "{");
        put("BracketRight", "]", "}");
        put("Backslash", "\\", "|");
        put("Semicolon", ";", ":");
        put("Quote", "'", "\"");
        put("Backquote", "`", "~");
        put("Comma", ",", "<");
        put("Period", ".", ">");
        put("Slash", "/", "?");
        put("NumpadDecimal", ".", ".");
        put("NumpadAdd", "+", "+");
        put("NumpadSubtract", "-", "-");
        put("NumpadMultiply", "*", "*");
        put("NumpadDivide", "/", "/");
    }

    /** The character a printable key types, or null for any other key. */
    static String charFor(String code, boolean shift) {
        String[] c = code == null ? null : PRINTABLE.get(code);
        return c == null ? null : c[shift ? 1 : 0];
    }

    /**
     * What a non-printable key does on a phone, or null when it does nothing
     * there. Escape is Back: the one key on a keyboard whose meaning a phone
     * has a button for.
     */
    static String actionFor(String code) {
        if (code == null) return null;
        switch (code) {
            case "Escape":
            case "BrowserBack":
                return TouchPlanner.BACK;
            case "Enter":
            case "NumpadEnter":
                return TouchPlanner.ENTER;
            case "Backspace":
                return TouchPlanner.BACKSPACE;
            case "Delete":
                return TouchPlanner.DELETE;
            default:
                return null;
        }
    }
}
