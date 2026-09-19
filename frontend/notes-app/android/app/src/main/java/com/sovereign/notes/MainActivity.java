package com.sovereign.notes;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate — Capacitor collects registered plugins there.
        registerPlugin(NotesNativePlugin.class);
        registerPlugin(NotesLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Keep getIntent() honest; super forwards to every plugin's
        // handleOnNewIntent (singleTask: a notification tap while Notes runs
        // lands here, and NotesNativePlugin routes it to the Reminders view).
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
