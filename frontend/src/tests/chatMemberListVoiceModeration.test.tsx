/**
 * The right-hand member list's user menu offers "Move to" / "Disconnect" for a
 * member sitting in ANY voice channel of this server, when the viewer holds
 * MOVE_MEMBERS — whether or not the viewer is in a call. Driven through the
 * real Chat, the real member list and the real UserContextMenu.
 *
 * The defect: the member list decided "is this member in voice?" by looking
 * only in the VIEWER's own call, and that one flag gated both the local
 * listener controls and voice moderation. A moderator who was not in voice got
 * no "Move to" for someone visibly sitting in a voice channel.
 *
 * The split pinned here: moderation follows where the MEMBER is; the local
 * listener controls (per-user volume, mute) still need the viewer to share the
 * call, because they act on what this device hears.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const ME = 7;
const BOB = 42;

const h = vi.hoisted(() => ({
    servers: [] as unknown[],
    channels: [] as unknown[],
    members: [] as unknown[],
    voiceUsers: [] as unknown[],
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    decryptChannelContent: async (_channel: number, content: string) => content,
    decryptChannelMessages: async () => [],
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = /\/servers$/.test(u) ? h.servers
        : /\/servers\/[^/]+\/channels$/.test(u) ? h.channels
        : /\/servers\/[^/]+\/members-with-roles$/.test(u) ? h.members
        : /\/servers\/[^/]+\/voice-users$/.test(u) ? { voice_users: h.voiceUsers }
        : /\/servers\/[^/]+\/unread$/.test(u) ? { channels: [] }
        : /\/dms$/.test(u) ? []
        : /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
}));

const { Chat } = await import('../components/Chat');

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = `${b64url({ alg: 'HS256' })}.${b64url({ sub: ME, username: 'me', exp: 4102444800 })}.sig`;

const member = (id: number, username: string) => ({
    id, username, display_name: null, server_nickname: null, is_online: true,
    roles: [], top_role_color: '', is_owner: id === ME, custom_sounds_disabled: false,
});
const voiceChannel = (id: number, name: string) => ({
    id, server_id: 's1', name, channel_type: 1, position: id, is_afk: false,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    // Server list, then channels / members / the voice roster for it.
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 25)); });
}

async function openMenuOn(el: Element | null | undefined) {
    expect(el).toBeTruthy();
    await act(async () => {
        el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return document.querySelector<HTMLElement>('.user-context-menu');
}
const memberRow = (name: string) => [...host!.querySelectorAll('.member-sidebar .member-item')]
    .find(li => li.textContent?.includes(name));
const items = (menu: HTMLElement | null) =>
    [...(menu?.querySelectorAll('.context-item') ?? [])].map(b => b.textContent?.trim() ?? '');

// setup.ts replaces localStorage with bare vi.fn()s that store nothing; the
// signed-in user (and so "do I own this server?") comes from the stored token.
const store = new Map<string, string>();
beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, v); });
    vi.mocked(localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
    store.clear();
    store.set('auth_token', token);
    h.servers = [{ id: 's1', name: 'Alpha', owner_id: ME, icon_file_id: null }];
    h.channels = [
        { id: 1, server_id: 's1', name: 'general', channel_type: 0, position: 0 },
        voiceChannel(2, 'Lounge'),
        voiceChannel(3, 'Gaming'),
    ];
    h.members = [member(ME, 'me'), member(BOB, 'bob')];
    // Bob sits in Gaming; the viewer is in no call at all.
    h.voiceUsers = [{ user_id: BOB, username: 'bob', room_id: 'voice_3' }];
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    store.clear();
});

describe('member list user menu: voice moderation from outside the call', () => {
    it('viewer in NO call, member in a voice channel, viewer holds MOVE_MEMBERS: Move to + Disconnect, no listener controls', async () => {
        await mountChat();
        const menu = await openMenuOn(memberRow('bob'));
        expect(menu).not.toBeNull();
        const labels = items(menu);
        expect(labels.some(l => l.startsWith('Move to'))).toBe(true);
        expect(labels.some(l => /disconnect/i.test(l))).toBe(true);
        // Local listener controls stay gated on sharing the call.
        expect(menu!.querySelector('.volume-control')).toBeNull();

        // Move to lists the OTHER voice channel of this server, not Gaming.
        const toggle = [...menu!.querySelectorAll<HTMLButtonElement>('.ucm-toggle')]
            .find(b => b.textContent?.includes('Move to'))!;
        await act(async () => { toggle.click(); });
        const group = menu!.querySelector('[role="group"][aria-label="Move to"]');
        expect([...(group?.querySelectorAll('.context-item') ?? [])].map(b => b.textContent?.trim()))
            .toEqual(['Lounge']);
    });

    it('member in no voice channel: neither Move to nor Disconnect', async () => {
        h.voiceUsers = [];
        await mountChat();
        const menu = await openMenuOn(memberRow('bob'));
        expect(menu).not.toBeNull();
        const labels = items(menu);
        expect(labels.some(l => l.startsWith('Move to'))).toBe(false);
        expect(labels.some(l => /disconnect/i.test(l))).toBe(false);
    });

    it('viewer WITHOUT MOVE_MEMBERS: not offered, even though the member is in voice', async () => {
        h.servers = [{ id: 's1', name: 'Alpha', owner_id: 99, icon_file_id: null }];
        await mountChat();
        const menu = await openMenuOn(memberRow('bob'));
        expect(menu).not.toBeNull();
        const labels = items(menu);
        // Positive control: the menu itself rendered with its usual rows.
        expect(labels).toContain('Message');
        expect(labels.some(l => l.startsWith('Move to'))).toBe(false);
        expect(labels.some(l => /disconnect/i.test(l))).toBe(false);
    });

    it('the sidebar voice row still offers moderation (unchanged surface)', async () => {
        await mountChat();
        const row = [...host!.querySelectorAll('.voice-users-list .voice-user-item')]
            .find(el => el.textContent?.includes('bob'));
        const menu = await openMenuOn(row);
        expect(menu).not.toBeNull();
        expect(items(menu).some(l => l.startsWith('Move to'))).toBe(true);
        expect(items(menu).some(l => /disconnect/i.test(l))).toBe(true);
    });
});
