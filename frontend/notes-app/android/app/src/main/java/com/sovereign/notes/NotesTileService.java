package com.sovereign.notes;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * The quick-settings tile: "New note", straight from the notification shade.
 *
 * CONTENT-FREE, like NotesNotifier. The shade renders above a locked screen on
 * several launchers, so the label is a compile-time constant and the tile
 * makes no query of any kind — no due count, no note title, nothing that a
 * glance at a locked phone could read. A JUnit test pins {@link #LABEL} so a
 * later change that derives it from data breaks a test instead of leaking
 * into the shade.
 *
 * It carries one constant nav string into MainActivity, which is singleTask,
 * so the tap re-uses a running app through onNewIntent exactly as a
 * notification tap does (NotesNativePlugin.takeNav).
 */
public class NotesTileService extends TileService {

    /** The tile's label in the shade. A CONSTANT, deliberately. */
    public static final String LABEL = "New note";

    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setLabel(LABEL);
        // Nothing here is "on": it is a button, so it never looks active.
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        Intent open = NotesNotifier.openIntent(this, NotesNotifier.NAV_COMPOSE_NOTE, -1L);
        // A locked phone unlocks FIRST. The composer belongs to a signed-in
        // shell that can show decrypted content the moment it mounts, and it
        // must never appear over the lock screen.
        if (isLocked()) {
            unlockAndRun(() -> launch(open));
        } else {
            launch(open);
        }
    }

    private void launch(Intent open) {
        if (Build.VERSION.SDK_INT >= 34) {
            // startActivityAndCollapse(Intent) THROWS UnsupportedOperationException
            // on targetSdk 34+ (this app targets 36); the PendingIntent
            // overload is the only one that works there, and it does not
            // exist below 34. A single-path implementation is dead on every
            // modern phone, which is the worst kind of bug to find by hand.
            startActivityAndCollapse(PendingIntent.getActivity(this, NotesNotifier.RC_TILE, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        } else {
            //noinspection deprecation
            startActivityAndCollapse(open);
        }
    }
}
