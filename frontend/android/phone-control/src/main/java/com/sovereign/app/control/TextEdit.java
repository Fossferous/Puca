package com.sovereign.app.control;

/**
 * A key or some text typed by a viewer, applied to the focused field's text.
 * Pure (TextEditTest); the service reads the field and writes the answer back
 * with ACTION_SET_TEXT and ACTION_SET_SELECTION.
 *
 * An AccessibilityService cannot type: it can only set a field's whole text.
 * So typing is "the text as it is, with this put in at the cursor" (or the
 * selection replaced), and Backspace / Delete take ONE character (a whole
 * code point, so an emoji or another astral character is never cut in half)
 * before or after the cursor, or the selection.
 */
final class TextEdit {

    private TextEdit() {}

    /** The field's new text and where the cursor goes. */
    static final class Result {
        final String text;
        final int caret;

        Result(String text, int caret) {
            this.text = text;
            this.caret = caret;
        }
    }

    private static boolean splits(String s, int i) {
        return i > 0 && i < s.length() && Character.isLowSurrogate(s.charAt(i)) && Character.isHighSurrogate(s.charAt(i - 1));
    }

    /**
     * {@code action} is TouchPlanner.TEXT (with {@code typed}), BACKSPACE or
     * DELETE. A selection the field reports nonsense for (negative, past the
     * end) is the cursor at the end. Null when nothing changes (Backspace at
     * the start, Delete at the end) or the action is not an edit.
     */
    static Result apply(String current, int selStart, int selEnd, String action, String typed) {
        String s = current == null ? "" : current;
        int a = selStart;
        int b = selEnd;
        if (a < 0 || b < 0 || a > s.length() || b > s.length()) {
            a = s.length();
            b = s.length();
        }
        if (a > b) {
            int t = a;
            a = b;
            b = t;
        }
        // Never between the halves of a surrogate pair: a cursor there goes
        // before the character, a selection grows to take all of it.
        boolean collapsed = a == b;
        if (splits(s, a)) a--;
        if (collapsed) b = a;
        else if (splits(s, b)) b++;
        if (TouchPlanner.TEXT.equals(action)) {
            if (typed == null || typed.isEmpty()) return null;
            return new Result(s.substring(0, a) + typed + s.substring(b), a + typed.length());
        }
        if (TouchPlanner.BACKSPACE.equals(action)) {
            if (a != b) return new Result(s.substring(0, a) + s.substring(b), a);
            if (a == 0) return null;
            int from = s.offsetByCodePoints(a, -1);
            return new Result(s.substring(0, from) + s.substring(a), from);
        }
        if (TouchPlanner.DELETE.equals(action)) {
            if (a != b) return new Result(s.substring(0, a) + s.substring(b), a);
            if (b >= s.length()) return null;
            int to = s.offsetByCodePoints(b, 1);
            return new Result(s.substring(0, a) + s.substring(to), a);
        }
        return null;
    }
}
