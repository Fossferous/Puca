/**
 * Server Settings › Overview › Clips — the owner's per-server switch
 * (docs/CLIPS.md).
 *
 * Three things here are load-bearing and none of them are visible from the
 * types:
 *
 *  - The channel picker must list TEXT channels only. `listChannels` returns
 *    voice channels in the same array, and posting a clip to a voice channel
 *    is a 400 the owner would only discover when someone tries to clip.
 *  - Clips-enabled REQUIRES a pinned channel: "let the clipper choose" is
 *    gone (the approval prompt names where a clip lands, and a per-clip
 *    choice let the clipper change that after approval). Saving clips-on
 *    with no channel is blocked with the reason; an unchosen channel still
 *    saves as `clip_channel_id: 0` when clips are OFF — 0 is what tells the
 *    server to CLEAR a pin, and omitting the key leaves the old one in place.
 *  - On a server that predates clips, no clip_* key may be sent at all.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are: @testing-library/react is not a dependency here (only
 * @testing-library/jest-dom, which the setup file loads).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel } from '../api/servers';

const updateServerSettings = vi.fn(async () => {});
const listChannels = vi.fn(async () => channels);

// Keep every other export real — the modal's Roles/Emoji tabs import their own
// names from this module, and a hand-written mock object would break on the
// next one somebody adds. Nothing in here touches the network until called.
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    updateServerSettings: (...a: unknown[]) => updateServerSettings(...(a as [])),
    listChannels: (...a: unknown[]) => listChannels(...(a as [])),
}));
// The icon preview is an authenticated fetch; no icon is set in these tests,
// but stub it so a stray call can never become a real request.
vi.mock('../api/authedMedia', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/authedMedia')>()),
    fetchFileUrl: async () => null,
}));

const { ServerSettingsModal } = await import('../components/ServerSettingsModal');

function chan(over: Partial<Channel> = {}): Channel {
    return { id: 1, name: 'general', channel_type: 0, server_id: 's1', ...over };
}
let channels: Channel[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    channels = [chan({ id: 11, name: 'general' }), chan({ id: 22, name: 'Lounge', channel_type: 1 })];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

type Props = Parameters<typeof ServerSettingsModal>[0];

async function open(over: Partial<Props> = {}) {
    await act(async () => {
        root.render(
            <ServerSettingsModal
                isOpen
                onClose={() => {}}
                serverId="s1"
                serverName="Test Server"
                isOwner
                clipsSupported
                {...over}
            />,
        );
    });
}

/** The `<label>` whose text contains `text` (the toggle rows wrap their input). */
function labelWith(text: string): HTMLLabelElement | undefined {
    return [...container.querySelectorAll('label')].find(l => l.textContent?.includes(text));
}

/** The control a `<label for=...>` points at — proves the labelling, not just
 *  that two elements happen to sit near each other. */
function selectLabelled(text: string): HTMLSelectElement | null {
    const label = labelWith(text);
    if (!label?.htmlFor) return null;
    return container.querySelector<HTMLSelectElement>(`#${label.htmlFor}`);
}

function button(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
}

/** React de-dupes change events with a value tracker installed on the node, so
 *  assigning `el.value` directly updates the tracker and the handler never
 *  fires. Go through the prototype setter to leave the tracker stale. */
async function pick(el: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

async function save() {
    await act(async () => {
        button('Save Changes')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

describe('ServerSettingsModal — Clips', () => {
    it('renders the toggle unchecked when the server has clips off', async () => {
        await open({ initialClipsEnabled: false });
        const toggle = labelWith('Allow clips')?.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(toggle).toBeTruthy();
        expect(toggle!.checked).toBe(false);
        expect(toggle!.disabled).toBe(false);
        // Collapsed: no policy pickers until it is on.
        expect(selectLabelled('Longest clip')).toBeNull();
    });

    it('shows both pickers when enabled, at the server’s length, listing TEXT channels only', async () => {
        await open({ initialClipsEnabled: true, initialClipMaxSeconds: 120 });

        const length = selectLabelled('Longest clip');
        expect(length).toBeTruthy();
        expect(length!.value).toBe('120');
        expect(length!.selectedOptions[0].textContent).toBe('2 minutes');

        const target = selectLabelled('Post clips to');
        expect(target).toBeTruthy();
        const options = [...target!.options].map(o => [o.value, o.textContent]);
        expect(options).toEqual([['0', 'Choose a channel…'], ['11', '#general']]);
        // The voice channel came back from listChannels and must not be offered.
        expect(target!.textContent).not.toContain('Lounge');
        expect(listChannels).toHaveBeenCalledWith('s1');
    });

    it('REFUSES to save clips-on with no channel, and says why', async () => {
        await open({ initialClipsEnabled: true, initialClipMaxSeconds: 120, initialClipChannelId: null });

        await save();
        expect(updateServerSettings, 'the broken state must never reach the wire').not.toHaveBeenCalled();
        expect(container.textContent).toContain('Choose a clips channel before turning clips on');
    });

    it('POSITIVE CONTROL: the same save goes through once a channel is picked', async () => {
        await open({ initialClipsEnabled: true, initialClipMaxSeconds: 120, initialClipChannelId: null });

        await pick(selectLabelled('Longest clip')!, '300');
        await pick(selectLabelled('Post clips to')!, '11');
        await save();
        expect(updateServerSettings).toHaveBeenCalledTimes(1);
        const [serverId, body] = updateServerSettings.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(serverId).toBe('s1');
        expect(body).toMatchObject({ clips_enabled: true, clip_max_seconds: 300, clip_channel_id: 11 });
    });

    it('clips OFF with no channel still saves — 0 clears the pin (an unpin must not silently no-op)', async () => {
        await open({ initialClipsEnabled: false, initialClipChannelId: null });
        await save();
        const [, body] = updateServerSettings.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(body).toMatchObject({ clips_enabled: false, clip_channel_id: 0 });
    });

    it('saves a pinned channel by id', async () => {
        await open({ initialClipsEnabled: true });
        await pick(selectLabelled('Post clips to')!, '11');
        await save();
        const [, body] = updateServerSettings.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(body.clip_channel_id).toBe(11);
    });

    it('an older server gets the note, a dead toggle, no fetch and no clip_* keys', async () => {
        await open({ clipsSupported: false, initialClipsEnabled: false });

        expect(container.textContent).toContain('This server runs an older version without clips.');
        const toggle = labelWith('Allow clips')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        expect(toggle.disabled).toBe(true);
        expect(listChannels).not.toHaveBeenCalled();

        await save();
        const [, body] = updateServerSettings.mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(Object.keys(body).filter(k => k.startsWith('clip'))).toEqual([]);
        // Positive control: the rest of the Overview payload still went.
        expect(body).toHaveProperty('is_public');
    });

    it('a non-owner cannot touch any of it', async () => {
        await open({ isOwner: false, initialClipsEnabled: true });

        const toggle = labelWith('Allow clips')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        expect(toggle.disabled).toBe(true);
        expect(selectLabelled('Longest clip')!.disabled).toBe(true);
        expect(selectLabelled('Post clips to')!.disabled).toBe(true);
        // ...and there is no Save button at all for them.
        expect(button('Save Changes')).toBeUndefined();
    });

    it('reopening on another server shows THAT server’s policy, not the last one', async () => {
        await open({ initialClipsEnabled: true, initialClipMaxSeconds: 120, initialClipChannelId: null });
        await act(async () => {
            root.render(<ServerSettingsModal isOpen={false} onClose={() => {}} serverId="s1" serverName="Test Server" isOwner clipsSupported />);
        });
        await open({ initialClipsEnabled: true, initialClipMaxSeconds: 600, initialClipChannelId: 11 });

        expect(selectLabelled('Longest clip')!.value).toBe('600');
        expect(selectLabelled('Post clips to')!.value).toBe('11');
    });

    it('keeps a server-set length that is not one of the presets', async () => {
        await open({ initialClipsEnabled: true, initialClipMaxSeconds: 240 });
        const length = selectLabelled('Longest clip')!;
        expect(length.value).toBe('240');
        expect([...length.options].map(o => o.value)).toEqual(['60', '120', '180', '240', '300', '600']);
    });
});

describe('ServerSettingsModal — save → refresh handoff (the "toggle reverts on reopen" bug)', () => {
    it('awaits onSave; a failed refresh says so instead of "Failed to save" (the PATCH already landed)', async () => {
        const onSave = vi.fn(async () => { throw new Error('GET /servers offline'); });
        // A pinned channel, so turning clips ON passes the required-pin gate —
        // this test is about the save→refresh handoff, not the gate.
        await open({ initialClipsEnabled: false, initialClipChannelId: 11, onSave });
        const toggle = labelWith('Allow clips')!.querySelector('input')!;
        await act(async () => { toggle.click(); });
        await save();
        expect(updateServerSettings).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledTimes(1);
        const text = container.textContent ?? '';
        expect(text).toContain('Settings saved!');
        expect(text).toContain('could not refresh');
        expect(text).not.toContain('Failed to save settings');
    });

    it('a prop change while OPEN does not clobber in-progress edits (the reset runs on the open transition only)', async () => {
        await open({ initialClipsEnabled: false });
        const toggle = labelWith('Allow clips')!.querySelector('input')!;
        await act(async () => { toggle.click(); });
        expect(toggle.checked).toBe(true);
        // The parent re-seats currentServer after a background refetch: same
        // server, props change, modal still open — the user's edit must survive
        // and the active tab must not be yanked.
        await open({ initialClipsEnabled: false, serverName: 'Renamed Elsewhere' });
        expect((labelWith('Allow clips')!.querySelector('input') as HTMLInputElement).checked).toBe(true);
    });

    it('(positive control) closing and reopening DOES reload from the props', async () => {
        await open({ initialClipsEnabled: false });
        const toggle = labelWith('Allow clips')!.querySelector('input')!;
        await act(async () => { toggle.click(); });
        expect(toggle.checked).toBe(true);
        await act(async () => {
            root.render(<ServerSettingsModal isOpen={false} onClose={() => {}} serverId="s1" serverName="Test Server" isOwner clipsSupported initialClipsEnabled={false} />);
        });
        await open({ initialClipsEnabled: false });
        expect((labelWith('Allow clips')!.querySelector('input') as HTMLInputElement).checked).toBe(false);
    });
});
