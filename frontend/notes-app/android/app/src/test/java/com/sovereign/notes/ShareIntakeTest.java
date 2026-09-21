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
    public void acceptsTextAndPictures() {
        assertTrue(ShareIntake.acceptsMime("text/plain"));
        assertTrue(ShareIntake.acceptsMime("image/png"));
        assertTrue(ShareIntake.acceptsMime("image/jpeg"));
        assertTrue("a charset tail must not change the answer", ShareIntake.acceptsMime("text/plain; charset=utf-8"));
        assertTrue("and neither must case", ShareIntake.acceptsMime("IMAGE/PNG"));
    }

    @Test
    public void refusesEverythingElse() {
        assertFalse(ShareIntake.acceptsMime("application/pdf"));
        assertFalse("a clipping is not a note", ShareIntake.acceptsMime("text/html"));
        assertFalse(ShareIntake.acceptsMime("video/mp4"));
        assertFalse("a provider that would not say: refuse", ShareIntake.acceptsMime(null));
        assertFalse(ShareIntake.acceptsMime(""));
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
    public void namesWhatTheSenderWouldNot() {
        assertEquals("shared-0.png", ShareIntake.safeName(null, 0, "image/png"));
        assertEquals("shared-2.jpg", ShareIntake.safeName("   ", 2, "image/jpeg"));
        assertEquals("an extension comes from the mime WE resolved", "photo.png", ShareIntake.safeName("photo", 0, "image/png"));
        assertEquals("shared-0.txt", ShareIntake.safeName(null, 0, "text/plain"));
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
