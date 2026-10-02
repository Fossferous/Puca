/**
 * Settings › Clips — what a clip COSTS and what the servers ALLOW, said
 * where the choice is made.
 *
 * Before: the buffer options were priced in RAM only, a 5:00 buffer sat next
 * to "S 2:00" with no word that three minutes of it could never be posted,
 * nothing said how big a saved clip is or how many fit in the member's clip
 * storage, and the auto-arm hint claimed a bigger monitor "keeps less" when
 * native capture actually records it at FEWER FRAMES (the 720p60 preset
 * records 24 fps on a 1080p monitor) — and sometimes keeps more.
 *
 * Raw react-dom/client + act, as the repo's other component tests.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Server } from '../api/servers';

let tauri = true;
let servers: Partial<Server>[] = [];
let usage: { usedBytes: number; quotaBytes: number; retentionDays: number | null } | null = null;
vi.mock('../api/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/platform')>()), isTauri: () => tauri, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('../hooks/queries', () => ({ useServers: () => ({ data: servers }) }));
vi.mock('../api/clips/clipUpload', () => ({ getClipUsage: async () => usage }));
vi.mock('../api/auth', () => ({ getToken: () => 'tok' }));
vi.mock('../api/clips/replayBuffer', () => ({ setClipMicGain: () => { } }));

const { ClipSettings } = await import('../components/ClipSettings');
const { defaultSettings } = await import('../components/settingsStore');
type Settings = typeof defaultSettings;

let container: HTMLDivElement;
let root: Root;
const setScreen = (w: number, h: number, dpr = 1) => {
    Object.defineProperty(window.screen, 'width', { configurable: true, get: () => w });
    Object.defineProperty(window.screen, 'height', { configurable: true, get: () => h });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => dpr });
};

beforeEach(() => {
    tauri = true;
    servers = [{ id: 's1', name: 'S', clips_enabled: true, clip_max_seconds: 120 }];
    usage = { usedBytes: 0, quotaBytes: 2 * 1024 ** 3, retentionDays: 0 };
    setScreen(1920, 1080);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function render(over: Partial<Settings> = {}) {
    const settings = { ...defaultSettings, ...over } as Settings;
    await act(async () => {
        root.render(<ClipSettings settings={settings} updateSetting={() => { }} bindControl={null} />);
    });
    // getClipUsage resolves in an effect.
    await act(async () => { await Promise.resolve(); });
    return container;
}
const text = () => container.textContent ?? '';
const bufferOptions = () => [...container.querySelectorAll<HTMLOptionElement>('select option')]
    .filter(o => /second|minute/.test(o.textContent ?? '') && !/fps/.test(o.textContent ?? ''));

describe('ClipSettings — sizes, server caps and the auto-arm truth', () => {
    it('says how big a saved clip of the server maximum is, and how many fit in clip storage', async () => {
        await render({ clipBufferSeconds: 300, clipQuality: '1080p30' });
        // 1080p30 × 2:00 ≈ 88 MB; 2 GB / 88 MB ≈ 23.
        expect(text()).toMatch(/longest your servers allow \(2:00\) is about 88 MB at 1080p30/);
        expect(text()).toMatch(/holds about 23 of them/);
    });

    it('says the buffer is clamped to what the servers allow, when it is longer', async () => {
        await render({ clipBufferSeconds: 300 });
        expect(text()).toMatch(/longer than any of your servers allow/);
        expect(text()).toMatch(/never holds more than 2:02/);
    });

    it('positive control: a buffer within the cap gets no clamp warning', async () => {
        await render({ clipBufferSeconds: 60 });
        expect(text()).not.toMatch(/longer than any of your servers allow/);
    });

    it('marks every buffer option above every server cap, and no other', async () => {
        servers = [{ id: 's1', name: 'S', clips_enabled: true, clip_max_seconds: 120 }, { id: 's2', name: 'T', clips_enabled: true, clip_max_seconds: 180 }];
        await render();
        const marked = bufferOptions().filter(o => o.textContent!.includes('(longer than your servers allow)')).map(o => Number(o.value));
        expect(marked).toEqual([300, 600, 900]);
    });

    it('marks nothing when no server has clips on (no cap is known)', async () => {
        servers = [{ id: 's1', name: 'S', clips_enabled: false, clip_max_seconds: 120 }];
        await render();
        expect(bufferOptions().length).toBe(7);
        expect(text()).not.toMatch(/longer than your servers allow/);
        expect(text()).not.toMatch(/longest your servers allow/);
    });

    it('warns when the longest allowed clip is too big to download or trim in the app', async () => {
        servers = [{ id: 's1', name: 'S', clips_enabled: true, clip_max_seconds: 600 }];
        await render({ clipQuality: '2160p30', clipBufferSeconds: 600 });
        expect(text()).toMatch(/cannot be downloaded or trimmed in the app/);
    });

    it('tells the truth about automatic arming: 720p60 records 24 fps on a 1080p monitor', async () => {
        setScreen(1920, 1080);
        await render({ clipQuality: '720p60' });
        expect(text()).toMatch(/1920×1080 monitor/);
        expect(text()).toMatch(/24 fps at about 4\.5 Mbps/);
        // The stale claim is gone.
        expect(text()).not.toMatch(/keeps less than the estimate/);
    });

    it('positive control: a preset that fits the monitor records what it says', async () => {
        setScreen(1920, 1080);
        await render({ clipQuality: '1080p60' });
        expect(text()).toMatch(/60 fps at about 9\.0 Mbps/);
    });

    it('uses physical pixels (screen × devicePixelRatio)', async () => {
        setScreen(1280, 720, 2); // a 2560×1440 panel at 200 %
        await render({ clipQuality: '720p30' });
        expect(text()).toMatch(/2560×1440 monitor/);
        expect(text()).toMatch(/24 fps at about 11\.2 Mbps/);
    });

    it('offers the 480p preset, prices it, and is honest that automatic arming records the whole monitor', async () => {
        setScreen(1920, 1080);
        await render({ clipQuality: '480p30', clipBufferSeconds: 60 });
        const quality = [...container.querySelectorAll<HTMLOptionElement>('select option')].filter(o => /fps/.test(o.textContent ?? ''));
        expect(quality[0].textContent).toBe('480p 30 fps — about 2 Mbps');
        // A saved 2:00 clip at 480p30 ≈ 30 MB (hand arming records this preset).
        expect(text()).toMatch(/longest your servers allow \(2:00\) is about 30 MB at 480p30/);
        // Native capture never scales frames: on a 1080p monitor it records
        // 1920×1080 at 24 fps, about 8.1 Mbps — more than the label.
        expect(text()).toMatch(/24 fps at about 8\.1 Mbps/);
    });

    it('with automatic arming on, every Quality option says what it records HERE (480p is no saving on 1080p)', async () => {
        // Native capture records the whole monitor: on 1920×1080 the 480p
        // preset records 24 fps at 8.1 Mbps — more bits than the 1080p30
        // default's 30 fps at 6.0 Mbps. A label that only says "about 2 Mbps"
        // is a trap for anyone picking it to save memory.
        setScreen(1920, 1080);
        await render({ clipQuality: '1080p30', clipArmOnJoin: 'auto' });
        const quality = [...container.querySelectorAll<HTMLOptionElement>('select option')].filter(o => /fps/.test(o.textContent ?? ''));
        const byId = (id: string) => quality.find(o => o.value === id)!.textContent;
        expect(byId('480p30')).toBe('480p 30 fps — about 2 Mbps · automatic here: 24 fps, 8.1 Mbps');
        expect(byId('1080p30')).toBe('1080p 30 fps — about 6 Mbps · automatic here: 30 fps, 6.0 Mbps');
        expect(byId('720p60')).toBe('720p 60 fps — about 5 Mbps · automatic here: 24 fps, 4.5 Mbps');
    });

    it('positive control: armed by hand, the Quality options are the presets as labelled', async () => {
        setScreen(1920, 1080);
        await render({ clipQuality: '1080p30', clipArmOnJoin: 'prompt' });
        const quality = [...container.querySelectorAll<HTMLOptionElement>('select option')].filter(o => /fps/.test(o.textContent ?? ''));
        expect(quality.every(o => !/automatic here/.test(o.textContent ?? ''))).toBe(true);
    });

    it('web and mobile get the one honest line, plus the servers’ longest clip', async () => {
        tauri = false;
        await render();
        expect(text()).toMatch(/Clips are recorded on the desktop app/);
        expect(text()).toMatch(/up to 2:00 long/);
        expect(container.querySelector('select')).toBeNull();
    });
});
