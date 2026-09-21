package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/**
 * The words that cross from the launcher, the shade and the home screen into
 * the page — and the fact that none of them is ever derived from a note.
 *
 * They are matched by string on the other side (routeNativeTarget in
 * frontend/src/notes/native/useNativeReminders.ts, whose own half is pinned
 * by src/tests/notesComposeTargets.test.ts). A drift fails silently: the
 * shortcut just opens the notes list and nothing says why.
 */
public class NotesNavTargetsTest {

    @Test
    public void theTileLabelIsAConstant() {
        // The shade is reachable over a locked screen on some phones. A later
        // change that derives this from a due count breaks a test instead.
        assertEquals("New note", NotesTileService.LABEL);
    }

    @Test
    public void theWireNamesAreWhatThePageRoutesOn() {
        assertEquals("notes_nav", NotesNotifier.EXTRA_NAV);
        assertEquals("notes_item", NotesNotifier.EXTRA_ITEM);
        assertEquals("reminders", NotesNotifier.NAV_REMINDERS);
        assertEquals("signin", NotesNotifier.NAV_SIGNIN);
        assertEquals("compose-list", NotesNotifier.NAV_COMPOSE_LIST);
        assertEquals("compose-note", NotesNotifier.NAV_COMPOSE_NOTE);
        assertEquals("compose-draw", NotesNotifier.NAV_COMPOSE_DRAW);
        assertEquals("compose-photo", NotesNotifier.NAV_COMPOSE_PHOTO);
    }

    @Test
    public void theWidgetWiresFourDistinctTargets() {
        assertEquals(4, NotesWidgetProvider.TARGETS.length);
        Set<String> seen = new HashSet<>();
        for (String t : NotesWidgetProvider.TARGETS) {
            assertTrue("a widget cell repeats a target: " + t, seen.add(t));
        }
    }

    @Test
    public void everyWidgetCellHasItsOwnRequestCode() {
        // Equal request codes collapse into ONE PendingIntent, and then every
        // button on the widget opens whichever target was attached last.
        assertEquals(NotesWidgetProvider.TARGETS.length, NotesWidgetProvider.REQUEST_CODES.length);
        Set<Integer> seen = new HashSet<>();
        for (int c : NotesWidgetProvider.REQUEST_CODES) {
            assertTrue("two widget cells share request code " + c, seen.add(c));
        }
        // And clear of the notification codes, which would collapse the other way.
        for (int c : NotesWidgetProvider.REQUEST_CODES) {
            assertFalse(c == NotesNotifier.ID_DUE || c == NotesNotifier.ID_STALE
                    || c == NotesNotifier.ID_PLACE || c == NotesNotifier.ID_LOCATION_ONGOING
                    || c == NotesNotifier.ID_PLACES_PAUSED || c == NotesNotifier.RC_TILE);
        }
    }

    @Test
    public void nothingOnThoseSurfacesCouldCarryANote() {
        // A crude but real guard: a target with a format placeholder or a
        // digit is one somebody has started building out of data.
        for (String t : NotesWidgetProvider.TARGETS) {
            assertFalse("a widget target carries a placeholder: " + t, t.contains("%"));
            assertTrue("a widget target is not a constant word: " + t, t.matches("[a-z-]+"));
        }
        assertTrue(NotesTileService.LABEL.matches("[A-Za-z ]+"));
    }
}
