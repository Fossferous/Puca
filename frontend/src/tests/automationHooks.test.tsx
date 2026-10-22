/**
 * The automation contract: docs/AUTOMATION.md promises a set of stable
 * `data-testid` attributes that a headless browser drives (select a server,
 * open a voice channel, join, share, stop, leave) plus the setup controls of
 * the stream-only bundle. This pins, in both directions:
 *
 *  - every id the doc lists is on the element it names, with the handler that
 *    makes it do what the doc says (a hook moved to another button is as
 *    broken as a deleted one);
 *  - every id of the contract's families (`server-`, `voice-`, `share-`,
 *    `role-`, `settings-`, `create-`) that the client renders is listed in
 *    the doc, so a new one is documented or renamed out of the family.
 *
 * Each source check is run against mutated copies too (the attribute or the
 * handler removed, applied to a string here, never to the file). One hook is
 * also exercised for real: the server rail, rendered, clicked by its id.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(here, '..');
const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const DOC = readFileSync(join(SRC_ROOT, '..', '..', 'docs', 'AUTOMATION.md'), 'utf8');

/** The `data-testid` names in the doc's tables (first cell, backticked; the
 *  header row's own `data-testid` is not one). */
const documented = new Set(
    DOC.split('\n')
        .map((l) => /^\| `([a-z0-9-]+)` \|/.exec(l)?.[1])
        .filter((x): x is string => !!x && x !== 'data-testid'),
);

/**
 * The opening tag of the JSX element whose attributes include the text at
 * `at`: back to its `<Tag`, forward to the `>` that closes it, braces
 * balanced (an arrow's `=>` inside `{...}` does not end the tag).
 */
function openingTag(code: string, at: number): string | null {
    const endsAtDepth0 = (s: string) => {
        let depth = 0;
        for (const ch of s) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            else if (ch === '>' && depth === 0) return true;
        }
        return false;
    };
    let start = at;
    for (;;) {
        start = code.lastIndexOf('<', start - 1);
        if (start < 0) return null;
        if (!/[A-Za-z]/.test(code[start + 1] ?? '')) continue;
        if (endsAtDepth0(code.slice(start + 1, at))) continue;
        break;
    }
    let depth = 0;
    for (let i = at; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0) return code.slice(start, i + 1);
    }
    return null;
}

/** Every opening tag carrying `attr` (exact text), in source order. */
function tagsWith(code: string, attr: string): string[] {
    const out: string[] = [];
    for (let i = code.indexOf(attr); i !== -1; i = code.indexOf(attr, i + 1)) {
        const t = openingTag(code, i);
        if (t) out.push(t);
    }
    return out;
}

interface Hook {
    /** The ids this element answers to. */
    ids: string[];
    file: string;
    /** The attribute as written in the source. */
    attr: string;
    /** How many elements carry it. */
    count?: number;
    /** What each such element must also carry. */
    needs: Array<string | RegExp>;
}

const HOOKS: Hook[] = [
    { ids: ['server-icon'], file: 'components/ServerList.tsx', attr: 'data-testid="server-icon"', needs: ['data-server-id={server.id}', 'onSelectServer(server)'] },
    { ids: ['voice-channel'], file: 'components/Chat.tsx', attr: 'data-testid="voice-channel"', needs: ['data-channel-id={channel.id}', 'onClick={() => handleChannelClick(channel)}'] },
    { ids: ['voice-join'], file: 'components/VoicePanel.tsx', attr: 'data-testid="voice-join"', needs: ['onClick={joinVoice}'] },
    { ids: ['voice-connected'], file: 'components/VoicePanel.tsx', attr: 'data-testid="voice-connected"', needs: ['className="voice-connection-info"'] },
    {
        ids: ['voice-share-screen', 'voice-stop-share'],
        file: 'components/VoicePanel.tsx',
        attr: "data-testid={isScreenSharing ? 'voice-stop-share' : 'voice-share-screen'}",
        // The ONE share button: stop when sharing, otherwise the quick launch.
        needs: ['vp-screenshare', /if \(isScreenSharing\) \{[\s\S]*webrtcManager\.stopScreenShare\(\);[\s\S]*setShareLaunch\('quick'\)/],
    },
    { ids: ['share-go-live'], file: 'components/ScreenShareModal.tsx', attr: 'data-testid="share-go-live"', count: 2, needs: [/onClick=\{(handleSelectScreen|handleMixerGoLive)\}/] },
    { ids: ['voice-leave'], file: 'components/VoicePanel.tsx', attr: 'data-testid="voice-leave"', needs: ['leaveVoice();'] },
    { ids: ['settings-join-without-mic'], file: 'components/SettingsModal.tsx', attr: 'data-testid="settings-join-without-mic"', needs: ["updateSetting('joinWithoutMic', e.target.checked)", 'checked={settings.joinWithoutMic}'] },
    { ids: ['settings-auto-watch-stream-only'], file: 'components/SettingsModal.tsx', attr: 'data-testid="settings-auto-watch-stream-only"', needs: ["updateSetting('autoWatchStreamOnly', e.target.checked)", 'checked={settings.autoWatchStreamOnly}'] },
    { ids: ['create-stream-only-role'], file: 'components/RoleSettingsModal.tsx', attr: 'data-testid="create-stream-only-role"', needs: ['onClick={handleCreateStreamOnlyRole}'] },
    { ids: ['role-automated-streaming'], file: 'components/StreamOnlyRoleSection.tsx', attr: 'data-testid="role-automated-streaming"', needs: ['stream-only-section'] },
    { ids: ['role-stream-only'], file: 'components/StreamOnlyRoleSection.tsx', attr: 'data-testid="role-stream-only"', needs: ["onToggle('STREAM_ONLY')", 'checked={has(PERMISSIONS.STREAM_ONLY)}'] },
    { ids: ['role-no-receive'], file: 'components/StreamOnlyRoleSection.tsx', attr: 'data-testid="role-no-receive"', needs: ["onToggle('NO_RECEIVE')", 'checked={has(PERMISSIONS.NO_RECEIVE)}'] },
    { ids: ['role-stream-channel'], file: 'components/StreamOnlyRoleSection.tsx', attr: 'data-testid="role-stream-channel"', needs: ['data-channel-id={row.channel.id}', 'toggleChannel(row)'] },
];

/** The share button's handler lives in its onClick, inside the tag. */
function holds(hook: Hook, code: string): boolean {
    const tags = tagsWith(code, hook.attr);
    if (tags.length !== (hook.count ?? 1)) return false;
    return tags.every((t) => hook.needs.every((n) => (typeof n === 'string' ? t.includes(n) : n.test(t))));
}

describe('docs/AUTOMATION.md lists exactly the contract this test pins', () => {
    it('every documented id is pinned, and every pinned id is documented', () => {
        const pinned = new Set(HOOKS.flatMap((h) => h.ids));
        expect([...documented].sort()).toEqual([...pinned].sort());
        expect(documented.size, 'the doc table was found and read').toBeGreaterThanOrEqual(14);
    });

    it("every id of the contract's families that the client renders is documented", () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) {
                    if (name !== 'tests' && name !== 'node_modules') walk(p);
                } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) files.push(p);
            }
        };
        walk(SRC_ROOT);
        const family = /^(server|voice|share|role|settings|create)-/;
        const rendered = new Set<string>();
        for (const f of files) {
            const code = stripComments(readFileSync(f, 'utf8'));
            for (const m of code.matchAll(/data-testid=(?:"([^"]+)"|\{([^}]+)\})/g)) {
                const literal = m[1] ? [m[1]] : [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
                for (const id of literal) if (family.test(id)) rendered.add(`${id} (${relative(SRC_ROOT, f)})`);
            }
        }
        const undocumented = [...rendered].filter((r) => !documented.has(r.split(' ')[0]));
        expect(undocumented).toEqual([]);
        expect(rendered.size, 'the scan found the hooks').toBeGreaterThanOrEqual(14);
    });
});

describe.each(HOOKS)('$ids', (hook) => {
    const code = stripComments(read(hook.file));
    it(`sits on its control in ${hook.file}`, () => {
        expect(holds(hook, code)).toBe(true);
    });
    it('goes red when the attribute is removed', () => {
        const mutated = code.split(hook.attr).join('');
        expect(mutated).not.toBe(code);
        expect(holds(hook, mutated)).toBe(false);
    });
    it('goes red when the control loses what makes it work', () => {
        const need = hook.needs[hook.needs.length - 1];
        const mutated = typeof need === 'string' ? code.split(need).join('') : code.replace(new RegExp(need.source, 'g'), '');
        expect(mutated).not.toBe(code);
        expect(holds(hook, mutated)).toBe(false);
    });
});

// --- One hook for real: the server rail ---

vi.mock('../hooks/queries', () => ({
    useServers: () => ({
        data: [
            { id: 's1', name: 'Mine', owner_id: 9, created_at: '' },
            { id: 's2', name: 'Other', owner_id: 9, created_at: '' },
        ],
        isLoading: false,
    }),
}));
vi.mock('../api/authedMedia', () => ({ fetchFileUrl: async () => '' }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('server-icon, rendered', () => {
    it('selects the server its data-server-id names', async () => {
        const { ServerList } = await import('../components/ServerList');
        const picked: string[] = [];
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(
                <ServerList
                    currentServerId="s1"
                    onSelectServer={(s) => picked.push(s.id)}
                    onCreateServer={() => {}}
                    onJoinServer={() => {}}
                    onInviteToServer={() => {}}
                    currentUserId={1}
                />,
            );
        });
        const icons = container.querySelectorAll('[data-testid="server-icon"]');
        expect(icons).toHaveLength(2);
        const other = container.querySelector<HTMLElement>('[data-testid="server-icon"][data-server-id="s2"]');
        expect(other).not.toBeNull();
        await act(async () => { other!.click(); });
        expect(picked).toEqual(['s2']);
    });
});
