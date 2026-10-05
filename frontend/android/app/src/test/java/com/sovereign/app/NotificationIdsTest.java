package com.sovereign.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/**
 * Every untagged notification id the app posts is its own. Two services that
 * call startForeground with the same id share ONE notification: the native
 * download's progress once replaced the keep-alive's, and stayed there as
 * "Downloading <name>" after the download ended (emulator, 2026-10-05).
 */
public class NotificationIdsTest {

    @Test
    public void untaggedNotificationIdsNeverCollide() {
        Set<Integer> ids = new HashSet<>();
        int[] fixed = {
            TransferService.NOTIFICATION_ID,
            KeepAliveService.NOTIFICATION_ID,
            KeepAliveService.NOTIFICATION_ID + 1, // its "Notifications are paused" notice
            DownloadService.NOTIFICATION_ID,
        };
        for (int id : fixed) ids.add(id);
        assertEquals("fixed ids are distinct", fixed.length, ids.size());
        // the download result notifications occupy a range of their own
        for (int id : fixed) {
            boolean inResultRange = id >= DownloadService.RESULT_ID_BASE
                    && id <= DownloadService.RESULT_ID_BASE + DownloadService.RESULT_ID_MASK;
            assertEquals("id " + id + " is outside the result range", false, inResultRange);
        }
    }
}
