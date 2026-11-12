package com.sovereign.app.control;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Typing into the focused field, as whole-text replacements. */
public class TextEditTest {

    @Test
    public void typedTextGoesInAtTheCursor() {
        TextEdit.Result r = TextEdit.apply("helo", 3, 3, TouchPlanner.TEXT, "l");
        assertEquals("hello", r.text);
        assertEquals(4, r.caret);
    }

    @Test
    public void typedTextReplacesASelectionEitherWayRound() {
        TextEdit.Result r = TextEdit.apply("hello world", 6, 11, TouchPlanner.TEXT, "there");
        assertEquals("hello there", r.text);
        assertEquals(11, r.caret);
        TextEdit.Result back = TextEdit.apply("hello world", 11, 6, TouchPlanner.TEXT, "there");
        assertEquals("hello there", back.text);
    }

    @Test
    public void aFieldWithNoCursorTakesTextAtTheEnd() {
        // Fields report -1 when they have no selection.
        TextEdit.Result r = TextEdit.apply("abc", -1, -1, TouchPlanner.TEXT, "d");
        assertEquals("abcd", r.text);
        assertEquals(4, r.caret);
        assertEquals("x", TextEdit.apply(null, 0, 0, TouchPlanner.TEXT, "x").text);
    }

    @Test
    public void backspaceTakesOneWholeCharacter() {
        TextEdit.Result r = TextEdit.apply("abc", 3, 3, TouchPlanner.BACKSPACE, null);
        assertEquals("ab", r.text);
        assertEquals(2, r.caret);
        // An emoji is two chars in Java: both go, never half of it.
        String face = "a😀";
        TextEdit.Result e = TextEdit.apply(face, face.length(), face.length(), TouchPlanner.BACKSPACE, null);
        assertEquals("a", e.text);
        assertEquals(1, e.caret);
        assertNull(TextEdit.apply("abc", 0, 0, TouchPlanner.BACKSPACE, null));
    }

    @Test
    public void deleteTakesTheCharacterAfter() {
        TextEdit.Result r = TextEdit.apply("abc", 1, 1, TouchPlanner.DELETE, null);
        assertEquals("ac", r.text);
        assertEquals(1, r.caret);
        assertNull(TextEdit.apply("abc", 3, 3, TouchPlanner.DELETE, null));
        // With a selection, both keys take the selection.
        assertEquals("ad", TextEdit.apply("abcd", 1, 3, TouchPlanner.DELETE, null).text);
        assertEquals("ad", TextEdit.apply("abcd", 1, 3, TouchPlanner.BACKSPACE, null).text);
    }

    @Test
    public void aCursorInsideAnEmojiIsMovedOutOfIt() {
        String s = "😀b";
        // A field claiming the cursor sits between the halves: the text goes before the emoji.
        TextEdit.Result r = TextEdit.apply(s, 1, 1, TouchPlanner.TEXT, "x");
        assertEquals("x😀b", r.text);
    }

    @Test
    public void otherActionsAreNotEdits() {
        assertNull(TextEdit.apply("abc", 1, 1, TouchPlanner.BACK, null));
        assertNull(TextEdit.apply("abc", 1, 1, TouchPlanner.TEXT, ""));
    }
}
