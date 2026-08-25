package com.sovereign.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;

/**
 * The micro-plugin behind "browse this phone's files from the PC".
 *
 * Deliberately tiny: file I/O itself goes through @capacitor/filesystem
 * (whose native readFile supports offset+length). What that plugin cannot do
 * is exactly these four things:
 *
 *  - status():        does this app hold All-files access, and which SDK —
 *                     MANAGE_EXTERNAL_STORAGE has no runtime dialog, so the
 *                     JS side needs a way to ASK rather than find out from
 *                     an EACCES mid-browse.
 *  - requestAccess(): open this app's page of the system "All files access"
 *                     Settings screen. That screen is the entire grant flow.
 *  - roots():         the fixed list of shareable folders the consent prompt
 *                     offers. Fixed on purpose — a list cannot be talked into
 *                     an app-private path the way a typed path could.
 *  - canonicalize():  File.getCanonicalPath — gate 2 of the path jail. The
 *                     lexical gate lives in JS (fsJail.ts); this resolves
 *                     symlinks/../case through the real filesystem so a path
 *                     that LOOKS inside the granted folder but leads out of
 *                     it is refused. Shared storage cannot hold app-created
 *                     symlinks, so this is belt-and-braces — but it is five
 *                     lines, and it closes the class.
 */
@CapacitorPlugin(name = "SovereignFiles")
public class SovereignFilesPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        boolean has = Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager();
        JSObject ret = new JSObject();
        ret.put("hasAllFilesAccess", has);
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30) {
            call.reject("All-files access needs Android 11 or newer");
            return;
        }
        try {
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            // Some OEM builds hide the per-app screen; fall back to the list.
            try {
                getActivity().startActivity(
                        new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                call.resolve();
            } catch (Exception e2) {
                call.reject("could not open the Settings screen: " + e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void roots(PluginCall call) {
        JSArray roots = new JSArray();
        addRoot(roots, "Downloads", Environment.DIRECTORY_DOWNLOADS);
        addRoot(roots, "Documents", Environment.DIRECTORY_DOCUMENTS);
        addRoot(roots, "Pictures", Environment.DIRECTORY_PICTURES);
        addRoot(roots, "Camera (DCIM)", Environment.DIRECTORY_DCIM);
        addRoot(roots, "Music", Environment.DIRECTORY_MUSIC);
        addRoot(roots, "Movies", Environment.DIRECTORY_MOVIES);
        File all = Environment.getExternalStorageDirectory();
        if (all != null && all.isDirectory()) {
            JSObject o = new JSObject();
            o.put("label", "Entire storage");
            o.put("path", all.getAbsolutePath());
            roots.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("roots", roots);
        call.resolve(ret);
    }

    private void addRoot(JSArray roots, String label, String which) {
        File dir = Environment.getExternalStoragePublicDirectory(which);
        if (dir == null || !dir.isDirectory()) return;
        JSObject o = new JSObject();
        o.put("label", label);
        o.put("path", dir.getAbsolutePath());
        roots.put(o);
    }

    @PluginMethod
    public void canonicalize(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("a path is required");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("path", new File(path).getCanonicalPath());
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("cannot resolve path: " + e.getMessage());
        }
    }
}
