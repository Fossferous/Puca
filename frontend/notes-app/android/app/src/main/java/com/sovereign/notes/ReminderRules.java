package com.sovereign.notes;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Three small decisions the background side makes, kept pure (no android.*)
 * so each runs under plain JUnit (ReminderRulesTest):
 *
 *  - what an HTTP status from GET /task-reminders means for the session;
 *  - which entries an alarm that is firing RIGHT NOW still announces when its
 *    pre-fire check finds the session dead;
 *  - whether Púca Notes can honestly tell Púca "I own due-item reminders on
 *    this phone" (ReminderOwnerProvider), so Púca stays quiet only when one
 *    alert per item is actually going to happen.
 */
public final class ReminderRules {

    private ReminderRules() {}

    public static final int OK = 0;
    public static final int AUTH_DEAD = 1;
    public static final int FAILED = 2;

    /**
     * 401 and only 401 is a dead session: the auth middleware answers 401 for
     * a bad, expired or revoked token and nothing else (src/auth.rs). A 403 is
     * a permission answer, and a 5xx or a proxy's error page is the server
     * having a bad minute — both are FAILED, retried next period, never a
     * reason to drop the token and stop the job for good.
     */
    public static int refreshOutcome(int httpStatus) {
        if (httpStatus == 200) return OK;
        if (httpStatus == 401) return AUTH_DEAD;
        return FAILED;
    }

    /**
     * The entries an alarm plans its notification from after its pre-fire
     * check. Normally what the store holds now (the check may have dropped an
     * item completed elsewhere). But a DEAD session drops every passed entry
     * unchecked, and that includes the one this alarm woke up to announce: the
     * user asked to be reminded, and a lost session is not a reason to stay
     * silent about it. So on AUTH_DEAD the entries that were due at `now`
     * BEFORE the check are put back for this one firing (the store itself
     * keeps them dropped — they fire once, here, and are never re-armed).
     */
    public static List<ReminderPlan.Entry> entriesToFire(
            List<ReminderPlan.Entry> before, List<ReminderPlan.Entry> after, int outcome, long now) {
        if (outcome != AUTH_DEAD) return after;
        List<ReminderPlan.Entry> out = new ArrayList<>(after);
        Set<Long> have = new HashSet<>();
        for (ReminderPlan.Entry e : after) have.add(e.id);
        for (ReminderPlan.Entry e : before) {
            if (e.atMs <= now && !have.contains(e.id)) out.add(e);
        }
        return out;
    }

    /** How recently the reminder feed must have been read (the hourly job, or
     *  the open page's own poll) for Notes to claim it is keeping up. Three
     *  periods of the ~hourly job: one late run is normal, three is not. */
    public static final long OWNERSHIP_FRESH_MS = 3L * 60 * 60_000L;
    /** A last-sync stamp this far in the FUTURE is a clock that moved back;
     *  a little is NTP noise, more is not trusted. */
    public static final long CLOCK_SKEW_MS = 5L * 60_000L;

    /** What Notes knows about itself when Púca asks. */
    public static final class OwnerState {
        public final boolean hasToken;
        public final String account;
        public final long lastSyncMs;
        public final boolean notificationsAllowed;
        public final boolean alarmNeeded;
        public final boolean alarmPresent;

        public OwnerState(boolean hasToken, String account, long lastSyncMs,
                          boolean notificationsAllowed, boolean alarmNeeded, boolean alarmPresent) {
            this.hasToken = hasToken;
            this.account = account;
            this.lastSyncMs = lastSyncMs;
            this.notificationsAllowed = notificationsAllowed;
            this.alarmNeeded = alarmNeeded;
            this.alarmPresent = alarmPresent;
        }
    }

    /**
     * Does Púca Notes own due-item reminders for `askingAccount` right now?
     * EVERY condition must hold; anything unknown is "no", because "no" costs
     * at worst a second notification and a wrong "yes" costs the only one:
     *
     *  - a live session token (signed out, or the job saw a 401: no);
     *  - the SAME account Púca is signed in to (another account's reminders
     *    are not this user's; an absent account from Púca: no);
     *  - the feed read successfully within {@link #OWNERSHIP_FRESH_MS}
     *    (a job Android has not run for hours, a force-stopped app whose job
     *    was cancelled: no);
     *  - notifications allowed (permission, app switch and Reminders channel);
     *  - the alarm actually set whenever something is owed (a force-stop
     *    cancels it; a store with nothing owed needs none).
     */
    public static boolean ownsDueReminders(OwnerState s, String askingAccount, long now) {
        if (s == null || !s.hasToken) return false;
        if (askingAccount == null || askingAccount.isEmpty() || !askingAccount.equals(s.account)) return false;
        if (s.lastSyncMs <= 0) return false;
        long age = now - s.lastSyncMs;
        if (age > OWNERSHIP_FRESH_MS || age < -CLOCK_SKEW_MS) return false;
        if (!s.notificationsAllowed) return false;
        return !s.alarmNeeded || s.alarmPresent;
    }
}
