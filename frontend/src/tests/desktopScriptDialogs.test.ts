/**
 * The desktop app keeps the browser's own window.confirm and window.alert.
 *
 * tauri-plugin-dialog was added in 0.8.134 for one thing, the Save As dialog, and
 * its init() also registers an init script in every webview on every desktop
 * platform. That script is below, verbatim. Nothing in the app imports it and no
 * test of any component can see it, because it only exists inside the desktop
 * shell: on the desktop, for two months, every `if (!confirm(x)) return` went
 * ahead as a yes (Disband Server, delete channel, kick, ban, Delete forever in
 * Notes, sign-out with unsent edits) and every alert() showed nothing.
 *
 * The first describe fails if the plugin comes back, by any of the ways in. The
 * second shows why it must not. The Save As dialog is the shell's own command
 * now (src-tauri/src/save_dialog.rs); the third keeps the two ends of that
 * stringly typed call agreeing, which no compiler does.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...path: string[]) => readFileSync(join(FRONTEND, ...path), 'utf8');

/** A manifest with its comments gone: they say why the plugin is not there. */
const tomlCode = (text: string) => text.split(/\r?\n/).filter(l => !l.trimStart().startsWith('#')).join('\n');
const rustCode = (text: string) => text.split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');

const rustSources = () => readdirSync(join(FRONTEND, 'src-tauri', 'src'), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.rs'))
    .map(f => ({ file: f, code: rustCode(read('src-tauri', 'src', f)) }));

const capabilityPermissions = () => readdirSync(join(FRONTEND, 'src-tauri', 'capabilities'))
    .filter(f => f.endsWith('.json'))
    .flatMap(f => JSON.parse(read('src-tauri', 'capabilities', f)).permissions as string[]);

describe('nothing brings tauri-plugin-dialog back', () => {
    it('not the shell\'s manifest', () => {
        const manifest = tomlCode(read('src-tauri', 'Cargo.toml'));
        expect(manifest).not.toMatch(/tauri-plugin-dialog/);
        // CONTROL: the same reader sees a plugin that IS there.
        expect(manifest).toMatch(/tauri-plugin-notification/);
    });

    it('not the shell\'s lockfile, which also catches another crate pulling it in', () => {
        const lock = read('src-tauri', 'Cargo.lock');
        expect(lock).not.toMatch(/name = "tauri-plugin-dialog"/);
        expect(lock).toMatch(/name = "tauri-plugin-notification"/);
    });

    it('not the shell\'s code', () => {
        const sources = rustSources();
        expect(sources.filter(s => /tauri_plugin_dialog/.test(s.code)).map(s => s.file)).toEqual([]);
        expect(sources.filter(s => /tauri_plugin_notification/.test(s.code)).map(s => s.file)).toEqual(['lib.rs']);
    });

    it('not a capability', () => {
        const permissions = capabilityPermissions();
        expect(permissions.filter(p => p.startsWith('dialog:') || p === 'dialog')).toEqual([]);
        expect(permissions).toContain('notification:default');
    });

    it('not the page\'s packages', () => {
        const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
        expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('@tauri-apps/plugin-dialog');
        expect(Object.keys(pkg.dependencies)).toContain('@tauri-apps/plugin-notification');
        expect(read('package-lock.json')).not.toMatch(/@tauri-apps\/plugin-dialog/);
    });

    it('and the shell\'s own code replaces neither function', () => {
        // A window.confirm in a Rust string is an init script doing the same thing.
        expect(rustSources().filter(s => /window\.(confirm|alert)/.test(s.code)).map(s => s.file)).toEqual([]);
    });
});

/** tauri-plugin-dialog 2.7.3, src/init-iife.js, whole. */
const PLUGIN_INIT_SCRIPT = '!function(){"use strict";async function n(n,i={},o){return window.__TAURI_INTERNALS__.invoke(n,i,o)}"function"==typeof SuppressedError&&SuppressedError,window.alert=function(i){n("plugin:dialog|message",{message:i.toString()})},window.confirm=async function(i){return await n("plugin:dialog|confirm",{message:i.toString()})}}();';

type FakeWindow = {
    alert: (m: string) => unknown;
    confirm: (m: string) => unknown;
    __TAURI_INTERNALS__: { invoke: ReturnType<typeof vi.fn> };
};

/**
 * The desktop page as it was. In the app every one of these calls was refused,
 * which added an unhandled rejection to the console and nothing else: this app
 * granted the plugin only its Save As, and the plugin registers no `confirm`
 * command at all. (So granting `dialog:allow-message` would not have helped:
 * confirm has no handler to reach, and the Promise would still be truthy.) This
 * stand-in simply answers, because the answer is not what does the damage.
 */
function pageWithThePlugin() {
    const invoke = vi.fn(async () => undefined);
    const page: FakeWindow = {
        alert: () => { throw new Error('the native alert must not be reached'); },
        confirm: () => { throw new Error('the native confirm must not be reached'); },
        __TAURI_INTERNALS__: { invoke },
    };
    new Function('window', PLUGIN_INIT_SCRIPT)(page);
    return page;
}

/** Every destructive handler in the app has this shape. */
function disband(page: Pick<FakeWindow, 'confirm'>, doIt: () => void) {
    if (!page.confirm('PERMANENTLY DELETE this server?')) return;
    doIt();
}

describe('why: what the plugin\'s script does to the page', () => {
    it('confirm answers with a Promise, which is truthy, so a destructive action goes ahead unasked', () => {
        const page = pageWithThePlugin();
        expect(page.confirm('x')).toBeInstanceOf(Promise);
        expect(page.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('plugin:dialog|confirm', { message: 'x' }, undefined);

        const deleted = vi.fn();
        disband(page, deleted);
        expect(deleted, 'nobody was asked, and it happened').toHaveBeenCalledTimes(1);
    });

    it('alert only asks a command this app never granted, so nothing appears', () => {
        const page = pageWithThePlugin();
        expect(page.alert('Could not delete the channel.')).toBeUndefined();
        expect(page.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith('plugin:dialog|message', { message: 'Could not delete the channel.' }, undefined);
    });

    it('CONTROL: the browser\'s own confirm answers with a boolean, and No stops the same handler', () => {
        const deleted = vi.fn();
        disband({ confirm: () => false }, deleted);
        expect(deleted).not.toHaveBeenCalled();
        disband({ confirm: () => true }, deleted);
        expect(deleted).toHaveBeenCalledTimes(1);
    });
});

describe('the shell\'s Save As, as the page calls it', () => {
    const asked = read('src', 'api', 'savePath.ts').match(/invoke<string \| null>\('(\w+)', \{ (\w+) \}\)/);

    it('is the call this describe reads (or the checks below prove nothing)', () => {
        expect(asked?.[1]).toBe('choose_save_path');
        expect(asked?.[2]).toBe('suggestedName');
    });

    it('is a command the shell registers, with the argument it reads', () => {
        const lib = rustCode(read('src-tauri', 'src', 'lib.rs'));
        expect(lib).toMatch(/generate_handler!\[[\s\S]*\bsave_dialog::choose_save_path\b/);
        // Tauri maps the page's camelCase to the Rust parameter's snake_case.
        expect(rustCode(read('src-tauri', 'src', 'save_dialog.rs')))
            .toMatch(/pub async fn choose_save_path\([^)]*\bsuggested_name: String\b/);
    });

    it('is a command the fake desktop shell answers: one it does not know fails notes-desktop-embed.mjs', () => {
        const fake = read('e2e', 'notes-desktop-embed.mjs');
        expect(fake).toMatch(/'choose_save_path': \(args\) =>/);
        expect(fake).not.toMatch(/plugin:dialog/);
    });
});
