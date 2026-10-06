/**
 * The Android launcher shows the LAUNCHER ACTIVITY's label when it has one,
 * not the application's. 0.9.834 shipped with MainActivity labelled by a
 * hard-coded "Puca" string, so the phone showed "Puca" (no fada) for both the
 * full and the Lite app, while app_name — set per variant by build.gradle's
 * resValue to "Púca" / "Púca Lite" — went unused on the home screen.
 *
 * Every activity label must therefore come from @string/app_name, and no
 * user-visible string resource may spell the name without its fada.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const androidMain = resolve(__dirname, '../../android/app/src/main');
const manifest = readFileSync(resolve(androidMain, 'AndroidManifest.xml'), 'utf8');
const strings = readFileSync(resolve(androidMain, 'res/values/strings.xml'), 'utf8');

/** Every `<activity …>` start tag's android:label value (undefined = inherits the app's). */
function activityLabels(xml: string): (string | undefined)[] {
    return [...xml.matchAll(/<activity\b[^>]*>/g)].map((m) => /android:label="([^"]*)"/.exec(m[0])?.[1]);
}

describe('the Android launcher label', () => {
    it('every activity is labelled by app_name, so the launcher says Púca / Púca Lite', () => {
        const labels = activityLabels(manifest);
        expect(labels.length).toBeGreaterThan(0);
        for (const label of labels) {
            if (label !== undefined) expect(label).toBe('@string/app_name');
        }
    });

    it('no string resource spells the app name without its fada', () => {
        const values = [...strings.matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)]
            .filter(([, name]) => !['package_name', 'custom_url_scheme'].includes(name))
            .map(([, , value]) => value);
        for (const v of values) expect(v).not.toMatch(/\bPuca\b/);
    });

    it('control: the check catches the 0.9.834 manifest', () => {
        const old = '<activity android:name=".MainActivity" android:label="@string/title_activity_main">';
        expect(activityLabels(old)).toEqual(['@string/title_activity_main']);
        expect('<string name="title_activity_main">Puca</string>').toMatch(/\bPuca\b/);
    });
});
