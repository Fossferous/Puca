/**
 * Nothing in the desktop app answers a question for the person.
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
 *
 * The fourth holds the rule that replaced the sites' own calls: every question is
 * awaited, because a Promise is truthy, and nothing but api/appDialogs.ts calls the
 * page's blocking functions, because on the desktop one of them stops the JavaScript
 * that closes a push-to-talk microphone and carries relayed input
 * (scripts/check-dialog-calls.mjs, which `npm run lint` runs).
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('every question is awaited, and nothing else stops the page', () => {
    const SCRIPT = join(FRONTEND, 'scripts', 'check-dialog-calls.mjs');
    const check = (dir?: string) => spawnSync(process.execPath, dir ? [SCRIPT, dir] : [SCRIPT], { cwd: FRONTEND, encoding: 'utf8' });

    /** The check run over these files; which of them it named, and how often. */
    function flagged(files: Record<string, string>): { named: Record<string, number>; status: number | null; output: string } {
        const dir = mkdtempSync(join(tmpdir(), 'puca-dialog-calls-'));
        try {
            for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
            const run = check(dir);
            const named: Record<string, number> = {};
            for (const line of run.stderr.split(/\r?\n/)) {
                const file = line.match(/^([^:]+\.tsx?):\d+:\d+ /)?.[1];
                if (file) named[file] = (named[file] ?? 0) + 1;
            }
            return { named, status: run.status, output: run.stdout + run.stderr };
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    it('the app passes', () => {
        const run = check();
        expect(run.stdout + run.stderr).toMatch(/every question awaited, no native dialog/);
        expect(run.status).toBe(0);
    }, 60_000);

    it('every shape of the bug fails', () => {
        const bad: Record<string, string> = {
            // The bug, as every destructive handler had it.
            'not.ts': 'export async function f() { if (!askConfirm("x")) return; go(); }',
            'truthy.ts': 'export function f() { if (askConfirm("x")) go(); }',
            'or.ts': 'export function f(a: boolean) { if (a || askConfirm("x")) go(); }',
            'kept.ts': 'export function f() { const ok = askConfirm("x"); if (ok) go(); }',
            'then.ts': 'export function f() { void askText("x").then(go); }',
            'returned.ts': 'export function f() { return askConfirm("x"); }',
            'passed.ts': 'export function f() { return g(askConfirm); }',
            'renamed.ts': 'const ask = askConfirm; export const f = () => ask("x");',
            'wait.ts': 'export function f() { tellUserAndWait("x"); }',
            'jsx.tsx': 'export const F = () => <button onClick={() => { if (!askConfirm("x")) return; go(); }} />;',
            // What stops the page.
            'bare.ts': 'export function f() { if (confirm("x")) go(); }',
            'alert.ts': 'export function f() { alert("x"); }',
            'prompt.ts': 'export function f() { return prompt("x"); }',
            'window.ts': 'export function f() { window.confirm("x"); }',
            'global.ts': 'export const f = globalThis.alert;',
            'indexed.ts': 'export function f() { window["prompt"]("x"); }',
            'taken.ts': 'const { confirm } = window; export const f = confirm;',
        };
        const { named, status, output } = flagged(bad);
        expect(status, output).toBe(1);
        expect(Object.keys(bad).filter(file => !named[file]), output).toEqual([]);
    }, 60_000);

    it('CONTROL: what is right passes, or the failures above prove nothing', () => {
        const { named, status, output } = flagged({
            'awaited.ts': 'import { askConfirm } from "./a"; export async function f() { if (!await askConfirm("x")) return; go(); }',
            'or.ts': 'export async function f(a: boolean) { if (a || await askConfirm("x")) go(); }',
            'brackets.ts': 'export async function f() { return await (askText("x")); }',
            'jsx.tsx': 'export const F = () => <button onClick={async () => { if (await askConfirm("x")) go(); }} />;',
            // An install prompt's own method, a comment and a string are nobody's dialog.
            'install.ts': 'export function f(e: { prompt(): void }) { e.prompt(); }',
            'words.ts': '// alert("x") and if (!askConfirm("x"))\nexport const a = "javascript:alert(1)";',
        });
        expect(named, output).toEqual({});
        expect(status, output).toBe(0);
    }, 60_000);

    it('taking the await off ANY real site fails, at that site: all of them', () => {
        const sources = readdirSync(join(FRONTEND, 'src'), { recursive: true, encoding: 'utf8' })
            .map(f => f.replaceAll('\\', '/'))
            .filter(f => /\.tsx?$/.test(f) && !f.startsWith('tests/') && !/\.(test|spec)\./.test(f) && f !== 'api/appDialogs.ts');
        const mutated: Record<string, string> = {};
        for (const file of sources) {
            const text = read('src', ...file.split('/'));
            for (const site of text.matchAll(/await (askConfirm|askText|tellUserAndWait)\(/g)) {
                const name = `${file.replace(/[/.]/g, '_')}_${site.index}${file.endsWith('x') ? '.tsx' : '.ts'}`;
                mutated[name] = text.slice(0, site.index) + text.slice(site.index + 'await '.length);
            }
        }
        // CONTROL: this found the sites. Every destructive action in the app is one.
        expect(Object.keys(mutated).length).toBeGreaterThan(45);
        const { named, status, output } = flagged(mutated);
        expect(status).toBe(1);
        expect(Object.keys(mutated).filter(file => named[file] !== 1), output.slice(0, 2000)).toEqual([]);
    }, 60_000);
});
