/**
 * Every `target="_blank"` anchor in the app is covered by the link router
 * (api/linkRouter.ts) — and the next one is too, or this fails.
 *
 * `target="_blank"` is a silent no-op in the desktop shell and in the
 * Capacitor apps (api/openExternal.ts). Eleven such anchors existed when the
 * router was written, in ten files, and none of them had ever been wired up
 * on the phone; the desktop's old interceptor sent even invite links to this
 * server off to a browser tab. So:
 *
 *  - an INVENTORY of every such anchor, file by file, each marked either
 *    `router` (an absolute address the router opens in the shells) or
 *    `web` (rendered only off the shells, with the guard that says so) — a
 *    new anchor fails the count until someone has checked it and said which;
 *  - no such anchor opens ITSELF (an onClick with openExternalUrl,
 *    window.open or preventDefault): the router has already opened it in the
 *    capture phase, so that would open it twice in the shells and skip the
 *    invite routing everywhere;
 *  - window.open (also a no-op in both shells) only where it is web-only;
 *  - every page that renders these installs the router at boot;
 *  - and the anchors in the shells, CLICKED in their real components: each
 *    opens exactly once through the desktop shell's open_external, and an
 *    invite link in a message opens the join flow instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({
    tauri: true,
    invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
    get: vi.fn<(path: string) => Promise<unknown>>(),
}));
vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
    isMobile: () => false,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args) }));
vi.mock('../api/client', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/client')>()),
    apiClient: { get: (p: string) => h.get(p) },
}));

import { installLinkRouter, setInviteOpener } from '../api/linkRouter';
import { isExternalHref } from '../api/openExternal';
import { MessageContent } from '../components/MessageContent';
import { LinkPreview } from '../components/LinkPreview';
import { NoteLinkText } from '../components/NoteLinkText';
import { PrivacyDisclosure } from '../components/PrivacyDisclosure';
import { privacyDocUrl, safeRepositoryUrl } from '../components/privacyDisclosure.utils';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f: string) => relative(SRC, f).split(sep).join('/');

function sources(dir = SRC, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'tests') continue;
            sources(p, out);
        } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

/**
 * Every JSX `<a …>` opening tag in `text`, whole: braces are tracked so an
 * arrow function's `=>` inside an attribute does not end the tag.
 */
function anchorTags(text: string): string[] {
    const tags: string[] = [];
    const open = /<a(?=[\s>])/g;
    let m: RegExpExecArray | null;
    while ((m = open.exec(text))) {
        let depth = 0;
        let quote: string | null = null;
        let i = m.index + 2;
        for (; i < text.length; i++) {
            const c = text[i];
            if (quote) { if (c === quote) quote = null; continue; }
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (depth === 0 && (c === '"' || c === "'")) quote = c;
            else if (depth === 0 && c === '>') break;
        }
        tags.push(text.slice(m.index, i + 1));
    }
    return tags;
}
/** Source without its comments: a comment may describe window.open; only code calls it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const isBlank = (tag: string) => /\btarget\s*=\s*(?:"_blank"|'_blank'|\{\s*['"`]_blank['"`]\s*\})/.test(tag);

type Covered =
    /** An absolute address: the router opens it in the shells. */
    | { file: string; count: number; how: 'router' }
    /** Never rendered in a shell; `guard` (in `guardFile`, default the same file) is why. */
    | { file: string; count: number; how: 'web'; guard: string; guardFile?: string };

const INVENTORY: Covered[] = [
    { file: 'components/LinkPreview.tsx', count: 1, how: 'router' },
    { file: 'components/MessageContent.tsx', count: 2, how: 'router' },
    { file: 'components/NoteLinkText.tsx', count: 1, how: 'router' },
    { file: 'components/PrivacyDisclosure.tsx', count: 1, how: 'router' },
    { file: 'components/SettingsModal.tsx', count: 1, how: 'router' },
    { file: 'components/Login.tsx', count: 1, how: 'web', guard: '{!isTauri() && !isMobile() && (' },
    { file: 'components/TasksView.tsx', count: 1, how: 'web', guard: "if (typeof window === 'undefined' || isTauri() || isMobile()) return null;" },
    { file: 'notes/components/AccountMenu.tsx', count: 1, how: 'web', guard: '{!NATIVE && !inPuca && <a' },
    { file: 'notes/components/NotesRail.tsx', count: 1, how: 'web', guard: '{!NATIVE && !inPuca && (' },
    { file: 'notes/components/NoteEditor.tsx', count: 1, how: 'web', guard: 'const pucaHref = isMobile() || isEmbedded ? null :', guardFile: 'notes/components/NotesShell.tsx' },
];

const files = sources();
const blankAnchors = files.flatMap(f => anchorTags(readFileSync(f, 'utf8')).filter(isBlank).map(tag => ({ file: rel(f), tag })));

describe('the inventory: every target="_blank" anchor, and why the router covers it', () => {
    it('the tag reader finds anchors whose attributes hold arrow functions (a control for everything below)', () => {
        const tags = anchorTags('<p><a href={u} onClick={e => { go(e); }} target="_blank">x</a> <abbr>y</abbr> <a\n  href="/">z</a></p>');
        expect(tags).toHaveLength(2);
        expect(tags[0]).toContain('target="_blank"');
        expect(tags[0].endsWith('target="_blank">')).toBe(true);
    });

    it('matches the source exactly — a new one must be checked and added here', () => {
        const found: Record<string, number> = {};
        for (const a of blankAnchors) found[a.file] = (found[a.file] ?? 0) + 1;
        const listed = Object.fromEntries(INVENTORY.map(c => [c.file, c.count]));
        expect(found).toEqual(listed);
        expect(blankAnchors).toHaveLength(11);
    });

    it('no anchor opens itself: the router already has, in the capture phase', () => {
        for (const a of blankAnchors) {
            expect(a.tag, a.file).not.toMatch(/openExternalUrl|window\.open|preventDefault|invoke\(/);
        }
    });

    it('a `router` anchor never carries a relative address, which the router leaves alone', () => {
        for (const c of INVENTORY.filter(c => c.how === 'router')) {
            for (const a of blankAnchors.filter(a => a.file === c.file)) {
                expect(a.tag, c.file).not.toMatch(/\bhref\s*=\s*["'][/#.]/);
            }
        }
    });

    it('a `web` anchor is behind the guard that keeps it out of both shells', () => {
        for (const c of INVENTORY) {
            if (c.how !== 'web') continue;
            const text = readFileSync(join(SRC, c.guardFile ?? c.file), 'utf8');
            expect(text.includes(c.guard), `${c.file}: ${c.guard}`).toBe(true);
        }
    });

    it('the Settings anchor\'s address is absolute whatever the server says (safeRepositoryUrl)', () => {
        for (const repo of [null, '', 'not a url', 'javascript:alert(1)', 'https://example.org/fork.git', 'http://git.example.net/puca/']) {
            expect(isExternalHref(safeRepositoryUrl(repo)), String(repo)).toBe(true);
            expect(isExternalHref(privacyDocUrl(repo)), String(repo)).toBe(true);
        }
    });

    it('window.open — a no-op in both shells — only where it cannot run in one', () => {
        const callers = files.filter(f => /\bwindow\.open\(/.test(code(readFileSync(f, 'utf8')))).map(rel).sort();
        // openExternal.ts: its web branch. NotesShell.tsx: "Open in Púca",
        // offered only when pucaHref is set, which it never is in a shell.
        expect(callers).toEqual(['api/openExternal.ts', 'notes/components/NotesShell.tsx']);
        expect(readFileSync(join(SRC, 'notes/components/NotesShell.tsx'), 'utf8')).toMatch(/if \(pucaHref\) \{\s+items\.push\(\{ id: 'puca'[^\n]*window\.open\(pucaHref/);
    });

    it('every page installs the router at boot, and no other page exists', () => {
        for (const entry of ['main.tsx', 'notes/main.tsx']) {
            expect(readFileSync(join(SRC, entry), 'utf8'), entry).toMatch(/^installLinkRouter\(\)$/m);
        }
        // A new createRoot is a new page — or a new React root in one of these
        // pages' documents (NotesDesktopView's lives in main.tsx's). Either
        // way, look before adding it here.
        const roots = files.filter(f => /\bcreateRoot\(/.test(readFileSync(f, 'utf8'))).map(rel).sort();
        expect(roots).toEqual(['components/NotesDesktopView.tsx', 'main.tsx', 'notes/main.tsx']);
    });
});

// ---------------------------------------------------------------------------
// The anchors that DO render in a shell, clicked in their real components.

let root: Root;
let host: HTMLDivElement;
let uninstall: () => void;
let unregister: () => void;
let invites: string[];
const flush = () => new Promise(r => setTimeout(r, 0));
const opened = () => h.invoke.mock.calls.filter(c => c[0] === 'open_external').map(c => (c[1] as { url: string }).url);

async function mount(el: React.ReactElement) {
    await act(async () => { root.render(el); });
    await act(async () => { await flush(); });
}
/** Click every match; returns defaultPrevented as each click reached the
 *  window — i.e. what the page's own default would have seen. */
async function clickEach(sel: string): Promise<boolean[]> {
    const from = seen.length;
    for (const a of [...host.querySelectorAll<HTMLAnchorElement>(sel)]) {
        await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await flush(); });
    }
    return seen.slice(from);
}

beforeEach(() => {
    h.tauri = true;
    h.invoke.mockReset();
    h.invoke.mockResolvedValue(null);
    h.get.mockReset();
    h.get.mockResolvedValue({ repository: 'https://example.org/puca-fork', commit: 'abc', license: 'AGPL-3.0-or-later' });
    invites = [];
    seen = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // Stop jsdom's own navigation, after everything else has run.
    window.addEventListener('click', stop);
    uninstall = installLinkRouter();
    unregister = setInviteOpener(code => { invites.push(code); });
});
let seen: boolean[] = [];
const stop = (e: Event) => { seen.push(e.defaultPrevented); e.preventDefault(); };
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    unregister();
    uninstall();
    window.removeEventListener('click', stop);
});

describe('in the desktop app, each shell-rendered anchor opens once through open_external', () => {
    it('MessageContent: a Markdown link and a bare address', async () => {
        await mount(<MessageContent content="see [the docs](https://example.org/docs) or https://example.org/raw" members={[]} />);
        expect(await clickEach('a.message-link')).toEqual([true, true]);
        expect(opened()).toEqual(['https://example.org/docs', 'https://example.org/raw']);
        expect(invites).toEqual([]);
    });

    it('MessageContent: an invite link to this server opens the join flow, not the browser', async () => {
        await mount(<MessageContent content={`join us: ${window.location.origin}/invite/aBc123Xy and [here](${window.location.origin}/invite/dEf456Zw)`} members={[]} />);
        expect(await clickEach('a.message-link')).toEqual([true, true]);
        expect(invites).toEqual(['aBc123Xy', 'dEf456Zw']);
        expect(opened()).toEqual([]);
    });

    it('LinkPreview: the card', async () => {
        await mount(<LinkPreview content="https://example.org/article" />);
        expect(host.querySelectorAll('a.link-preview-card')).toHaveLength(1);
        await clickEach('a.link-preview-card');
        expect(opened()).toEqual(['https://example.org/article']);
    });

    it('NoteLinkText: once — not once by the router and again by itself — and not the row', async () => {
        const row = vi.fn();
        await mount(<div onClick={row}><NoteLinkText text="read https://example.org/n" /></div>);
        await clickEach('a.note-link');
        expect(opened()).toEqual(['https://example.org/n']);
        expect(row).not.toHaveBeenCalled();
    });

    it('PrivacyDisclosure: the statement in the source repository', async () => {
        await mount(<PrivacyDisclosure />);
        const links = [...host.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')];
        expect(links).toHaveLength(1);
        await clickEach('a[target="_blank"]');
        expect(opened()).toEqual([privacyDocUrl('https://example.org/puca-fork')]);
    });

    it('CONTROL: with the router uninstalled the same clicks open nothing (the no-op the shells gave)', async () => {
        uninstall();
        await mount(<MessageContent content="see https://example.org/raw" members={[]} />);
        expect(await clickEach('a.message-link')).toEqual([false]);
        expect(opened()).toEqual([]);
    });
});

describe('in the web app, the same anchors keep the browser\'s own behaviour', () => {
    beforeEach(() => { h.tauri = false; });

    it('an ordinary link is left alone; an invite link to this server still opens the join flow', async () => {
        await mount(<MessageContent content={`https://example.org/raw ${window.location.origin}/invite/aBc123Xy`} members={[]} />);
        expect(await clickEach('a.message-link')).toEqual([false, true]);
        expect(invites).toEqual(['aBc123Xy']);
        expect(opened()).toEqual([]);
    });
});
