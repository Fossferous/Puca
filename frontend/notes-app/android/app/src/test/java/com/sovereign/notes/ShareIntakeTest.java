package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The decisions behind "share into Puca Notes". The payload comes from an
 * arbitrary other app, so every one of these is a cap or a refusal.
 */
public class ShareIntakeTest {

    // --- what a note can take ------------------------------------------------

    @Test
    public void copiesPicturesAndOnlyPictures() {
        assertTrue(ShareIntake.acceptsPicture("image/png"));
        assertTrue(ShareIntake.acceptsPicture("image/jpeg"));
        assertTrue("case must not change the answer", ShareIntake.acceptsPicture("IMAGE/PNG"));
        assertFalse("the page can only put a file in the picture list, so a .txt"
                + " copied here would be sealed and stored as a photo",
                ShareIntake.acceptsPicture("text/plain"));
        assertFalse(ShareIntake.acceptsPicture("text/plain; charset=utf-8"));
    }

    @Test
    public void aSharedTextFileIsWordsNotAnAttachment() {
        assertTrue(ShareIntake.isSharedText("text/plain"));
        assertTrue("a charset tail must not change the answer", ShareIntake.isSharedText("text/plain; charset=utf-8"));
        assertTrue(ShareIntake.isSharedText("TEXT/PLAIN"));
        assertFalse("a clipping is not plain text", ShareIntake.isSharedText("text/html"));
        assertFalse(ShareIntake.isSharedText("image/png"));
        // And the body it fills has a ceiling: a "text/plain" that is really
        // a 50 MB log must not be read into memory.
        assertTrue(ShareIntake.MAX_TEXT_BYTES > 0);
        assertTrue(ShareIntake.MAX_TEXT_BYTES <= 1024 * 1024);
    }

    @Test
    public void refusesEverythingElse() {
        assertFalse(ShareIntake.acceptsPicture("application/pdf"));
        assertFalse(ShareIntake.isSharedText("application/pdf"));
        assertFalse("a clipping is not a note", ShareIntake.acceptsPicture("text/html"));
        assertFalse(ShareIntake.acceptsPicture("video/mp4"));
        assertFalse("a provider that would not say: refuse", ShareIntake.acceptsPicture(null));
        assertFalse(ShareIntake.isSharedText(null));
        assertFalse(ShareIntake.acceptsPicture(""));
    }

    @Test
    public void aShareIsAGrantNotAPath() {
        assertTrue(ShareIntake.acceptsScheme("content"));
        assertTrue("schemes are case-insensitive", ShareIntake.acceptsScheme("CONTENT"));
        // file:// would be opened with THIS app's uid: another app could name
        // a path inside Púca Notes' own sandbox and have Notes read it.
        assertFalse(ShareIntake.acceptsScheme("file"));
        assertFalse(ShareIntake.acceptsScheme("http"));
        assertFalse(ShareIntake.acceptsScheme("android.resource"));
        assertFalse(ShareIntake.acceptsScheme(null));
        assertFalse(ShareIntake.acceptsScheme(""));
    }

    // --- the title -----------------------------------------------------------

    @Test
    public void prefersTheSendersSubject() {
        assertEquals("Recipe", ShareIntake.titleFrom("Recipe", "Flour\nEggs"));
        assertEquals("the whole text is body when a subject named the note",
                "Flour\nEggs", ShareIntake.bodyFrom("Recipe", "Flour\nEggs"));
    }

    @Test
    public void borrowsTheFirstLineAndDoesNotRepeatIt() {
        assertEquals("Errand", ShareIntake.titleFrom(null, "Errand\nMilk\nBread"));
        assertEquals("Milk\nBread", ShareIntake.bodyFrom(null, "Errand\nMilk\nBread"));
    }

    @Test
    public void aSingleLineIsTheTitleAndLeavesNoBody() {
        assertEquals("Milk and bread", ShareIntake.titleFrom(null, "Milk and bread"));
        assertEquals("", ShareIntake.bodyFrom(null, "Milk and bread"));
    }

    @Test
    public void aFirstLineTooLongToBeATitleStaysInTheBody() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 140; i++) sb.append('x');
        String text = sb + "\nmore";
        assertEquals("", ShareIntake.titleFrom(null, text));
        assertEquals("nothing is lost: the long line is still the body", text, ShareIntake.bodyFrom(null, text));
    }

    @Test
    public void truncatesASubjectAtTheComposersOwnLimit() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 140; i++) sb.append('y');
        assertEquals(ShareIntake.MAX_TITLE, ShareIntake.titleFrom(sb.toString(), "body").length());
    }

    @Test
    public void nothingSharedShapesToNothing() {
        assertEquals("", ShareIntake.titleFrom(null, null));
        assertEquals("", ShareIntake.bodyFrom(null, null));
        assertEquals("", ShareIntake.titleFrom("   ", "   "));
    }

    // --- how many, and what they are called ----------------------------------

    @Test
    public void capsTheFileCountAtWhatANoteCanHold() {
        assertEquals(12, ShareIntake.MAX_FILES);
        assertEquals(12, ShareIntake.cap(20));
        assertEquals("under the cap, everything is taken (positive control)", 3, ShareIntake.cap(3));
        assertEquals(0, ShareIntake.cap(0));
        assertEquals(0, ShareIntake.cap(-4));
    }

    @Test
    public void aNameFromAnotherAppHasNoPathInIt() {
        String climbed = ShareIntake.safeName("../../etc/passwd.png", 0, "image/png");
        assertFalse("a separator would let the copy land outside the share directory", climbed.contains("/"));
        assertFalse(climbed.contains("\\"));
        assertFalse("a leading dot would hide the file", climbed.startsWith("."));
        assertEquals("a_b.jpg", ShareIntake.safeName("a\\b.jpg", 1, "image/jpeg"));
        assertFalse("no control characters survive", ShareIntake.safeName("bad\u0007name.png", 0, "image/png").contains("\u0007"));
        assertFalse(ShareIntake.safeName("...hidden.png", 0, "image/png").startsWith("."));
    }

    @Test
    public void aNameTheUrlCouldNotSurviveIsReplaced() {
        // The page fetches the copy back by URL, built by concatenation: a
        // '#' would start a fragment and a '%' an escape, and the picture
        // would be dropped with no message at all.
        String hash = ShareIntake.safeName("party #2.jpg", 0, "image/jpeg");
        assertFalse(hash, hash.contains("#"));
        assertEquals("party _2.jpg", hash);
        String pct = ShareIntake.safeName("100%.png", 0, "image/png");
        assertFalse(pct, pct.contains("%"));
        assertEquals("the rest of the name is left alone (positive control)",
                "holiday.png", ShareIntake.safeName("holiday.png", 0, "image/png"));
    }

    @Test
    public void namesWhatTheSenderWouldNot() {
        assertEquals("shared-0.png", ShareIntake.safeName(null, 0, "image/png"));
        assertEquals("shared-2.jpg", ShareIntake.safeName("   ", 2, "image/jpeg"));
        assertEquals("an extension comes from the mime WE resolved", "photo.png", ShareIntake.safeName("photo", 0, "image/png"));
        assertEquals("shared-1.webp", ShareIntake.safeName(null, 1, "image/webp"));
    }

    @Test
    public void aRidiculousNameIsCutShort() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 400; i++) sb.append('n');
        sb.append(".png");
        String cut = ShareIntake.safeName(sb.toString(), 0, "image/png");
        assertTrue(cut.length() <= ShareIntake.MAX_NAME);
        assertTrue("the extension survives the cut", cut.endsWith(".png"));
    }

    @Test
    public void theSharedSanitiserIsTheOneTheShareSheetAlreadyUsed() {
        // NotesNativePlugin.safeFileName delegates here; its contract must not
        // have moved when the two became one implementation.
        assertEquals("notes.txt", ShareIntake.clean(null, "notes.txt"));
        assertEquals("notes.txt", ShareIntake.clean("   ", "notes.txt"));
        assertEquals("nothing but separators still leaves no separator", "_", ShareIntake.clean("///", "notes.txt"));
        assertEquals("Groceries.md", ShareIntake.clean("Groceries.md", "notes.txt"));
    }

    @Test
    public void aFileSizeCeilingExists() {
        // A 200 MB "image/*" from another app must not land on disk before
        // anyone looks at it.
        assertTrue(ShareIntake.MAX_FILE_BYTES > 0);
        assertTrue(ShareIntake.MAX_FILE_BYTES <= 64L * 1024 * 1024);
    }
}
