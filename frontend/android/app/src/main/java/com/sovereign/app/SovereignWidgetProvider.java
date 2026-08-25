package com.sovereign.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * Home-screen shortcuts: one tap straight to Friends, Tasks, My Devices or
 * Settings. Each button launches {@link MainActivity} with a
 * {@link SovereignAppPlugin#EXTRA_NAV} extra; the plugin carries it into the
 * WebView (cold start via consumeLaunchNav, warm via onNewIntent — the
 * activity is singleTask, so a tap while the app runs re-uses it).
 *
 * Static content, so updatePeriodMillis is 0 and onUpdate only ever runs when
 * the widget is placed, resized, or the APK updated.
 */
public class SovereignWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.puca_widget);
            views.setOnClickPendingIntent(R.id.widget_friends, navIntent(context, "friends", 101));
            views.setOnClickPendingIntent(R.id.widget_tasks, navIntent(context, "tasks", 102));
            views.setOnClickPendingIntent(R.id.widget_devices, navIntent(context, "devices", 103));
            views.setOnClickPendingIntent(R.id.widget_settings, navIntent(context, "settings", 104));
            manager.updateAppWidget(id, views);
        }
    }

    private PendingIntent navIntent(Context context, String target, int requestCode) {
        Intent i = new Intent(context, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra(SovereignAppPlugin.EXTRA_NAV, target);
        // Distinct requestCode per target — equal ones collapse to a single
        // PendingIntent and every button would open the LAST target.
        return PendingIntent.getActivity(context, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
