/**
 * The nav words the Android side sends and the page routes on, compared
 * against the REAL Java source.
 *
 * They are matched by string across two languages: a launcher shortcut in
 * shortcuts.xml, a quick-settings tile, a widget cell and NotesNotifier all
 * put a word in an intent extra, and routeNativeTarget looks it up. A typo on
 * either side fails SILENTLY — the shortcut opens the app on the notes list
 * and nothing says why — which is exactly the class of bug this repo has been
 * bitten by before. So this reads the files, like notesNativeMin.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPOSE_TARGETS, composeModeFor } from '../notes/model/composeIntent';

const JAVA = join(process.cwd(), 'notes-app', 'android', 'app', 'src', 'main', 'java', 'com', 'sovereign', 'notes');
const RES = join(process.cwd(), 'notes-app', 'android', 'app', 'src', 'main', 'res');
const notifier = readFileSync(join(JAVA, 'NotesNotifier.java'), 'utf8');
const shortcuts = readFileSync(join(RES, 'xml', 'shortcuts.xml'), 'utf8');

/** Every NAV_COMPOSE_* constant's value, as Java declares it. */
function javaComposeTargets(): string[] {
    return [...notifier.matchAll(/NAV_COMPOSE_[A-Z_]+\s*=\s*"([^"]+)"/g)].map(m => m[1]).sort();
}

describe('the compose nav vocabulary', () => {
    it('is exactly the same on both sides', () => {
        const java = javaComposeTargets();
        expect(java.length).toBe(4);
        expect(Object.keys(COMPOSE_TARGETS).sort()).toEqual(java);
    });

    it('the widget wires every one of them, with DISTINCT request codes', () => {
        const widget = readFileSync(join(JAVA, 'NotesWidgetProvider.java'), 'utf8');
        const cells = [...widget.matchAll(/NotesNotifier\.(NAV_COMPOSE_[A-Z_]+)/g)].map(m => m[1]);
        expect(cells).toHaveLength(4);
        expect(new Set(cells).size).toBe(4);
        const codes = (/REQUEST_CODES\s*=\s*\{([^}]+)\}/.exec(widget)?.[1] ?? '')
            .split(',').map(s => s.trim()).filter(Boolean);
        expect(codes).toHaveLength(4);
        // Equal request codes collapse into one PendingIntent and every cell
        // would open the LAST target.
        expect(new Set(codes).size).toBe(4);
    });

    it('every launcher shortcut names a word the page actually routes', () => {
        const values = [...shortcuts.matchAll(/<extra android:name="notes_nav" android:value="([^"]+)"/g)].map(m => m[1]);
        expect(values.length).toBeGreaterThan(0);
        const routed = new Set([...Object.keys(COMPOSE_TARGETS), 'reminders', 'signin']);
        for (const v of values) expect(routed.has(v)).toBe(true);
    });

    it('the extra name matches NotesNotifier.EXTRA_NAV', () => {
        const extra = /EXTRA_NAV\s*=\s*"([^"]+)"/.exec(notifier)?.[1];
        expect(extra).toBe('notes_nav');
        expect(shortcuts).toContain(`android:name="${extra}"`);
    });

    it('the tile uses a compose word too, and no shortcut carries anything but a word', () => {
        const tile = readFileSync(join(JAVA, 'NotesTileService.java'), 'utf8');
        expect(tile).toMatch(/NotesNotifier\.NAV_COMPOSE_NOTE/);
        // No shortcut may smuggle an id or a title into the launcher.
        const extras = [...shortcuts.matchAll(/<extra android:name="([^"]+)"/g)].map(m => m[1]);
        expect(new Set(extras)).toEqual(new Set(['notes_nav']));
    });
});

describe('composeModeFor', () => {
    const full = { text: true, pictures: true, camera: true };
    it('honours what the server can store (positive control)', () => {
        expect(composeModeFor('text', full)).toBe('text');
        expect(composeModeFor('draw', full)).toBe('draw');
        expect(composeModeFor('photo', full)).toBe('photo');
        expect(composeModeFor('list', full)).toBe('list');
    });
    it('a server with no note body falls back to a checklist, not a dead textarea', () => {
        expect(composeModeFor('text', { text: false, pictures: true })).toBe('list');
    });
    it('a server with no attachments falls back rather than opening a drawing it cannot keep', () => {
        expect(composeModeFor('draw', { text: true, pictures: false })).toBe('list');
        expect(composeModeFor('photo', { text: true, pictures: false })).toBe('list');
    });
    it('unknown capabilities are a checklist, which every server has', () => {
        expect(composeModeFor('draw', undefined)).toBe('list');
    });
});
