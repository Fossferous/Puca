package com.sovereign.app.control;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/** The native Allow that must come before any session (Consent). */
public class ConsentTest {

    private final List<String> answers = new ArrayList<>();
    private final Consent.Answer record = (allowed, why) -> answers.add(allowed ? "allowed" : why);

    @Test
    public void allowCountsOnlyOnceArmed() {
        Consent c = new Consent();
        assertTrue(c.ask(false, 1000, record));
        assertFalse("a press under a finger already moving", c.allow(1000 + Consent.ARM_MS - 1));
        assertTrue(c.open());
        assertTrue(answers.isEmpty());
        assertTrue(c.allow(1000 + Consent.ARM_MS));
        assertEquals(List.of("allowed"), answers);
        assertFalse(c.open());
    }

    @Test
    public void noSecondQuestionWhileOneIsOpenOrASessionLasts() {
        Consent c = new Consent();
        assertFalse("not while someone is in control", c.ask(true, 0, record));
        assertFalse(c.open());
        assertTrue(c.ask(false, 0, record));
        assertFalse("one at a time", c.ask(false, 1, (a, w) -> answers.add("second")));
        c.decline();
        assertEquals(List.of(Consent.DECLINED), answers);
    }

    @Test
    public void unansweredIsANoAfterTheTimeout() {
        Consent c = new Consent();
        c.ask(false, 0, record);
        assertFalse(c.expire(Consent.TIMEOUT_MS - 1));
        assertTrue(c.expire(Consent.TIMEOUT_MS));
        assertEquals(List.of(Consent.NOT_CONFIRMED), answers);
        assertFalse("closed: a late Allow does nothing", c.allow(Consent.TIMEOUT_MS + 5000));
        assertEquals(1, answers.size());
    }

    @Test
    public void answeredOnceWhateverComesAfter() {
        Consent c = new Consent();
        c.ask(false, 0, record);
        c.withdraw();
        c.decline();
        c.withdraw();
        assertFalse(c.allow(10_000));
        assertFalse(c.expire(100_000));
        assertEquals(List.of(Consent.WITHDRAWN), answers);
        // And a new question can be asked after.
        assertTrue(c.ask(false, 0, record));
    }

    @Test
    public void nothingToAnswerWithNoQuestion() {
        Consent c = new Consent();
        assertFalse(c.allow(10_000));
        assertFalse(c.armed(10_000));
        c.decline();
        c.withdraw();
        assertTrue(answers.isEmpty());
    }
}
