/**
 * Server Settings › Overview's icon preview, now that a preview's fetch can
 * take a minute (api/authedMedia tries a passing failure again). The icon the
 * modal opened with must not land over a new pick's preview, and Change must
 * not stay "..." while the new pick's preview is fetched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    /** fetchFileUrl's answer for each id, given when the test says. */
    answers: new Map<string, (url: string | null) => void>(),
}));
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    updateServerSettings: async () => {},
    listChannels: async () => [],
}));
vi.mock('../api/uploads', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/uploads')>()),
    uploadFile: async () => ({ id: 'new-icon' }),
    discardUpload: () => {},
}));
vi.mock('../api/authedMedia', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/authedMedia')>()),
    fetchFileUrl: (id: string) => new Promise<string | null>((resolve) => { h.answers.set(id, resolve); }),
}));

const { ServerSettingsModal } = await import('../components/ServerSettingsModal');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    h.answers.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const preview = () => container.querySelector('.icon-preview-lg img')?.getAttribute('src') ?? null;
const changeLabel = () => container.querySelector('.upload-btn-sm')?.textContent?.trim();
const answer = async (id: string, url: string | null) => { await act(async () => { h.answers.get(id)!(url); }); };

async function pickNewIcon() {
    const input = container.querySelector<HTMLInputElement>('.upload-btn-sm input[type="file"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], 'icon.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('ServerSettingsModal — the icon preview', () => {
    it('the icon it opened with, landing late, does not replace a new pick', async () => {
        await act(async () => {
            root.render(<ServerSettingsModal isOpen onClose={() => {}} serverId="s1" serverName="Test Server" isOwner initialIconFileId="old-icon" />);
        });
        expect(h.answers.has('old-icon')).toBe(true);
        await pickNewIcon();
        expect(changeLabel(), 'the upload is done: not "..." while its preview is fetched').toBe('Change');
        await answer('new-icon', 'data:image/png;base64,TkVX');
        expect(preview()).toBe('data:image/png;base64,TkVX');
        await answer('old-icon', 'data:image/png;base64,T0xE');
        expect(preview(), 'still the new pick').toBe('data:image/png;base64,TkVX');
    });

    it('and the old one giving up does not blank it either', async () => {
        await act(async () => {
            root.render(<ServerSettingsModal isOpen onClose={() => {}} serverId="s1" serverName="Test Server" isOwner initialIconFileId="old-icon" />);
        });
        await pickNewIcon();
        await answer('new-icon', 'data:image/png;base64,TkVX');
        await answer('old-icon', null);
        expect(preview()).toBe('data:image/png;base64,TkVX');
    });

    it('control: the icon it opened with is shown when it lands and nothing replaced it', async () => {
        await act(async () => {
            root.render(<ServerSettingsModal isOpen onClose={() => {}} serverId="s1" serverName="Test Server" isOwner initialIconFileId="old-icon" />);
        });
        expect(preview()).toBeNull();
        await answer('old-icon', 'data:image/png;base64,T0xE');
        expect(preview()).toBe('data:image/png;base64,T0xE');
    });
});
