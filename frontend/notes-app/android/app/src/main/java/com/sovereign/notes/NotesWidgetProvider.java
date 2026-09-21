package com.sovereign.notes;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * Home-screen quick capture: four buttons — new list, new note, draw, photo —
 * that open Púca Notes straight on its composer.
 *
 * SHOWS NOTHING FROM A NOTE, and cannot: this class imports nothing from the
 * note store, makes no network call and asks no question. That is deliberate
 * and is the whole design. A widget's views are built here but inflated,
 * drawn and CACHED by the LAUNCHER process, and survive a reboot in the
 * launcher's own storage — so a note title, a snippet, or even a count of
 * what is due would be decrypted content sitting outside this app's sandbox,
 * on a home screen, in a process Notes does not control. Google Keep's widget
 * lists note titles; this one never will (docs/NOTES.md, "Not built").
 *
 * Static content, so updatePeriodMillis is 0 (notes_widget_info.xml) and
 * onUpdate only ever runs when the widget is placed, resized or the APK is
 * updated.
 */
public class NotesWidgetProvider extends AppWidgetProvider {

    /** The four nav targets, in the order the cells appear. Public and
     *  static so the JUnit test can compare them with the web side's list
     *  without reflection and without an Android runtime. */
    public static final String[] TARGETS = {
        NotesNotifier.NAV_COMPOSE_LIST,
        NotesNotifier.NAV_COMPOSE_NOTE,
        NotesNotifier.NAV_COMPOSE_DRAW,
        NotesNotifier.NAV_COMPOSE_PHOTO,
    };

    /**
     * One request code per cell, clear of the notification codes (7401-7406).
     * DISTINCT is load-bearing: equal request codes collapse into a single
     * PendingIntent and every button would open the LAST target. The test
     * asserts it, because the symptom is a widget that works when you tap the
     * cell you wrote last.
     */
    public static final int[] REQUEST_CODES = { 7411, 7412, 7413, 7414 };

    private static final int[] CELLS = {
        R.id.widget_list, R.id.widget_note, R.id.widget_draw, R.id.widget_photo,
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.notes_widget);
            for (int i = 0; i < CELLS.length; i++) {
                views.setOnClickPendingIntent(CELLS[i], cell(context, i));
            }
            manager.updateAppWidget(id, views);
        }
    }

    private PendingIntent cell(Context context, int i) {
        return NotesNotifier.openApp(context, REQUEST_CODES[i], TARGETS[i], -1L);
    }
}
