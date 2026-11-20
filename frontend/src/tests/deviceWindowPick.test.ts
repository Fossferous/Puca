/**
 * ONE WINDOW (windowPick.ts): the checks every list from the peer goes
 * through, the icon frames that keep a sealed signal under the relay's cap,
 * the consent filter, the search and the sentences — and the EXACT frames
 * hostAgent.ts writes to the agent, whose twins are pinned in
 * crates/puca-agent/src/protocol.rs
 * (`list_windows_and_set_window_parse_from_the_frames_the_app_writes`).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    chunkIcons, matchWindows, sanitizeIcons, sanitizeShown, sanitizeWindowList, windowEndWords,
    windowFailedWords, windowsWithinConsent, ICON_FRAME_BUDGET, MAX_WINDOWS, type RemoteWindow,
} from '../api/devices/windowPick';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
import { agentHostBackend, windowStatusFields } from '../api/devices/hostAgent';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAY';

const win = (over: Partial<RemoteWindow> = {}): RemoteWindow => ({
    hwnd: 66_000, pid: 4, title: 'notes.txt - Notepad', app: 'Notepad', ...over,
});

describe('a window list from the peer is checked before anything shows it', () => {
    test('a well-formed entry is kept as it came', () => {
        expect(sanitizeWindowList([{ ...win(), icon: 'ia1', minimized: true, elevated: true, monitor: 1 }]))
            .toEqual([{ ...win(), icon: 'ia1', minimized: true, elevated: true, monitor: 1 }]);
    });

    test('anything malformed is dropped whole, never half-kept', () => {
        const bad = [
            { ...win(), hwnd: '66000' },          // a handle as a string
            { ...win(), hwnd: -1 },
            { ...win(), pid: 0 },
            { ...win(), hwnd: 2 ** 60 },          // not a safe integer
            { ...win(), title: '' },
            { ...win(), title: '\u0007\n' },      // nothing left once cleaned
            { ...win(), title: 7 },
            null, 'x', [],
        ];
        expect(sanitizeWindowList(bad)).toEqual([]);
        expect(sanitizeWindowList('not a list')).toEqual([]);
    });

    test('a title is cleaned of control characters and bounded', () => {
        const [w] = sanitizeWindowList([win({ title: `a\u0000b\nc${'x'.repeat(500)}` })]);
        expect(w.title.startsWith('abc')).toBe(true);
        expect([...w.title]).toHaveLength(160);
    });

    test('an odd icon key, monitor or flag is left off, the window kept', () => {
        const [w] = sanitizeWindowList([{ ...win(), icon: '../x', monitor: 255, minimized: 'yes', elevated: 1 }]);
        expect(w).toEqual(win());
    });

    test('a window listed twice is listed once, and the list is bounded', () => {
        expect(sanitizeWindowList([win(), win()])).toHaveLength(1);
        const many = Array.from({ length: 200 }, (_, i) => win({ hwnd: i + 1 }));
        expect(sanitizeWindowList(many)).toHaveLength(MAX_WINDOWS);
    });

    test('an icon is only ever a PNG data URL: a URL that loads is refused', () => {
        const icons = sanitizeIcons({
            ok: PNG,
            web: 'https://example.invalid/x.png',
            js: 'javascript:alert(1)',
            svg: 'data:image/svg+xml;base64,PHN2Zz4=',
            trail: `${PNG}"onerror="x`,
            big: `data:image/png;base64,${'A'.repeat(20_000)}`,
            'bad key': PNG,
        });
        expect(icons).toEqual({ ok: PNG });
        expect(sanitizeIcons([PNG])).toEqual({});
    });

    test('the shown window needs its size; without it the frame is not believed', () => {
        expect(sanitizeShown({ ...win(), width: 900, height: 1300 }))
            .toEqual({ hwnd: 66_000, pid: 4, title: 'notes.txt - Notepad', app: 'Notepad', width: 900, height: 1300 });
        expect(sanitizeShown(win())).toBeNull();
        expect(sanitizeShown({ ...win(), width: 0, height: 10 })).toBeNull();
        expect(sanitizeShown({ ...win(), width: 99_999, height: 10 })).toBeNull();
    });
});

describe('the host sends its icons in frames the relay accepts', () => {
    test('every frame is within the budget, nothing is lost, the order is kept', () => {
        const icons: Record<string, string> = {};
        for (let i = 0; i < 40; i++) icons[`i${i}`] = `data:image/png;base64,${'A'.repeat(3200)}`;
        const frames = chunkIcons(icons);
        expect(frames.length).toBeGreaterThan(1);
        for (const f of frames) {
            const bytes = Object.entries(f).reduce((n, [k, v]) => n + k.length + v.length + 8, 0);
            expect(bytes).toBeLessThanOrEqual(ICON_FRAME_BUDGET);
            // What actually goes in the sealed signal: JSON, base64 when
            // sealed (4/3), under the server's 64 KB device-signal cap.
            const frame = JSON.stringify({ kind: 'window-icons', rid: 'wl0123456789abcdef', icons: f });
            expect(Math.ceil(frame.length * 4 / 3) + 200).toBeLessThan(64 * 1024);
        }
        expect(frames.flatMap(f => Object.keys(f))).toEqual(Object.keys(icons));
    });

    test('no icons, no frames', () => {
        expect(chunkIcons({})).toEqual([]);
    });
});

describe('the consent bounds the list', () => {
    const list = [win({ hwnd: 1, monitor: 0 }), win({ hwnd: 2, monitor: 1 }), win({ hwnd: 3 })];
    test('every screen shared, or nobody asked: every window', () => {
        expect(windowsWithinConsent(list, null, 255)).toHaveLength(3);
        expect(windowsWithinConsent(list, 255, 255)).toHaveLength(3);
    });
    test('one screen shared: only its windows, never one whose screen is unknown', () => {
        expect(windowsWithinConsent(list, 1, 255).map(w => w.hwnd)).toEqual([2]);
    });
});

describe('the search', () => {
    const list = [
        win({ hwnd: 1, title: 'Quarterly report.docx - Word', app: 'Microsoft Word' }),
        win({ hwnd: 2, title: 'Café menu', app: 'Notepad' }),
        win({ hwnd: 3, title: 'Inbox', app: 'Mail' }),
    ];
    test('every word must match, title or program, case and accents ignored', () => {
        expect(matchWindows(list, '  ').map(w => w.hwnd)).toEqual([1, 2, 3]);
        expect(matchWindows(list, 'word').map(w => w.hwnd)).toEqual([1]);
        expect(matchWindows(list, 'CAFE').map(w => w.hwnd)).toEqual([2]);
        expect(matchWindows(list, 'menu notepad').map(w => w.hwnd)).toEqual([2]);
        expect(matchWindows(list, 'menu mail')).toEqual([]);
    });
});

describe('what the viewer is told', () => {
    test('each way back to the whole screen has its sentence; one the viewer asked for has none', () => {
        expect(windowEndWords('closed', 'Notepad')).toBe('“Notepad” was closed. Showing the whole screen.');
        expect(windowEndWords('minimized', 'Notepad')).toMatch(/was minimised\. Showing the whole screen\. Choose it again/);
        expect(windowEndWords('offscreen', null)).toMatch(/^That window moved to another screen/);
        expect(windowEndWords('unshared', 'X')).toMatch(/a screen that was not shared/);
        expect(windowEndWords('screen', 'X')).toMatch(/screens on that computer changed/);
        expect(windowEndWords('asked', 'X')).toBeNull();
        expect(windowEndWords('closed', 'y'.repeat(100))).toContain('…”');
    });
    test('a refusal says the host\'s reason, cleaned', () => {
        expect(windowFailedWords('that window has closed')).toBe('Could not show that window: that window has closed.');
        expect(windowFailedWords(42)).toBe('Could not show that window.');
    });
});

describe('the frames hostAgent.ts writes to the agent', () => {
    beforeEach(() => { invokeMock.mockReset(); });

    test('list_windows: EXACTLY the frame the Rust agent parses, and a reply checked', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({
            ok: 'windows',
            windows: [{ ...win(), exe: 'notepad.exe', icon: 'ia' }, { hwnd: 'bad' }],
            icons: { ia: PNG, ib: 'https://x.invalid/' },
        }));
        const list = await agentHostBackend().listWindows!();
        expect(invokeMock).toHaveBeenCalledWith('agent_request', { request: JSON.stringify({ cmd: 'list_windows' }) });
        expect(list).toEqual({ windows: [{ ...win(), icon: 'ia' }], icons: { ia: PNG } });
    });

    test('set_window with a window, and without one (the whole screen)', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'window_shown', width: 800, height: 600, front: false }));
        expect(await agentHostBackend().setWindow!('s1', { hwnd: 66_000, pid: 4 }))
            .toEqual({ width: 800, height: 600, front: false });
        expect(invokeMock).toHaveBeenLastCalledWith('agent_request', {
            request: JSON.stringify({ cmd: 'set_window', session_id: 's1', hwnd: 66_000, pid: 4 }),
        });
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'ok' }));
        expect(await agentHostBackend().setWindow!('s1', null)).toBeNull();
        expect(invokeMock).toHaveBeenLastCalledWith('agent_request', {
            request: JSON.stringify({ cmd: 'set_window', session_id: 's1' }),
        });
    });

    test('a refusal rejects with the agent\'s words; a reply without a size is not believed', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'error', message: 'that window has closed' }));
        await expect(agentHostBackend().setWindow!('s1', { hwnd: 1, pid: 1 })).rejects.toThrow('that window has closed');
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'ok' }));
        await expect(agentHostBackend().setWindow!('s1', { hwnd: 1, pid: 1 })).rejects.toThrow();
    });

    test('capabilities: only an explicit true offers the choice (an older agent writes nothing)', async () => {
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'capabilities', capture: true, unattended: true, input: true, elevated: false, monitors: 1 }));
        expect((await agentHostBackend().capabilities()).windows).toBe(false);
        invokeMock.mockResolvedValue(JSON.stringify({ ok: 'capabilities', capture: true, unattended: true, input: true, elevated: false, monitors: 1, windows: true }));
        expect((await agentHostBackend().capabilities()).windows).toBe(true);
    });

    test('the status poll\'s window fields, read only when well-formed', () => {
        expect(windowStatusFields({ window: 66_000, window_front: false, window_monitor: 1 } as never))
            .toEqual({ window: 66_000, windowFront: false, windowMonitor: 1 });
        expect(windowStatusFields({ window: 66_000 } as never)).toEqual({ window: 66_000, windowFront: true });
        expect(windowStatusFields({ window_end: 'offscreen', window_end_monitor: 2 } as never))
            .toEqual({ windowEnd: 'offscreen', windowEndMonitor: 2 });
        // An older agent, and nonsense: nothing at all.
        expect(windowStatusFields({} as never)).toEqual({});
        expect(windowStatusFields({ window: '66000', window_end: 'exploded', window_end_monitor: -1 } as never)).toEqual({});
    });
});
