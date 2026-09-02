/**
 * The create-a-server wizard's choices are acted on (api/serverTemplates.ts).
 *
 * Until 0.9.2 Chat's handleWizardComplete ignored the template and audience
 * and never received the icon. Positive control: the icon test below asserts
 * updateServerSettings is called with an icon id — nothing in the old code
 * path called it at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Channel } from '../api/servers';

const calls = vi.hoisted(() => ({
    log: [] as Array<[string, unknown]>,
    channels: [] as Channel[],
    failUpload: false,
}));
vi.mock('../api/servers', async (orig) => ({
    ...(await orig<typeof import('../api/servers')>()),
    listChannels: vi.fn(async () => calls.channels),
    createChannel: vi.fn(async (serverId: string, name: string, type: number) => { calls.log.push(['create', { serverId, name, type }]); return { id: 99, name, channel_type: type, server_id: serverId }; }),
    updateChannel: vi.fn(async (id: number, updates: unknown) => { calls.log.push(['update', { id, updates }]); }),
    updateServerSettings: vi.fn(async (serverId: string, settings: unknown) => { calls.log.push(['settings', { serverId, settings }]); }),
}));
vi.mock('../api/uploads', () => ({
    uploadFile: vi.fn(async () => { if (calls.failUpload) throw new Error('413'); return { id: 'icon-file-1' }; }),
}));

const { planTemplateChannels, finishServerCreation, SERVER_TEMPLATES } = await import('../api/serverTemplates');

const stock = (): Channel[] => [
    { id: 1, name: 'default', channel_type: 0, server_id: 's1' },
    { id: 2, name: 'default', channel_type: 1, server_id: 's1' },
    { id: 3, name: 'AFK', channel_type: 1, server_id: 's1', is_afk: true },
];

beforeEach(() => { calls.log.length = 0; calls.channels = stock(); calls.failUpload = false; });

describe('planTemplateChannels', () => {
    it('renames the stock channels to the template\'s first names and creates the rest, never touching AFK', () => {
        const ops = planTemplateChannels('gaming', stock());
        expect(ops).toEqual([
            { kind: 'rename', channelId: 1, name: 'general' },
            { kind: 'create', name: 'looking-for-group', channelType: 0 },
            { kind: 'create', name: 'clips', channelType: 0 },
            { kind: 'rename', channelId: 2, name: 'Lobby' },
            { kind: 'create', name: 'Squad 1', channelType: 1 },
            { kind: 'create', name: 'Squad 2', channelType: 1 },
        ]);
    });
    it('custom keeps the stock set; an unknown id does nothing', () => {
        expect(planTemplateChannels('custom', stock())).toEqual([]);
        expect(planTemplateChannels('nope', stock())).toEqual([]);
    });
    it('creates instead of renaming when the stock channel is not there', () => {
        const ops = planTemplateChannels('creative', [stock()[2]]);
        expect(ops[0]).toEqual({ kind: 'create', name: 'general', channelType: 0 });
    });
    it('every template has at least one text channel so the creator lands somewhere', () => {
        for (const [id, t] of Object.entries(SERVER_TEMPLATES)) {
            if (id === 'custom') continue;
            expect(t.text.length, id).toBeGreaterThan(0);
        }
    });
});

describe('finishServerCreation', () => {
    it('uploads the icon and attaches it; lists publicly only when asked', async () => {
        const file = new File([new Uint8Array([1, 2, 3])], 'icon.png', { type: 'image/png' });
        const warnings = await finishServerCreation('s1', { template: 'custom', iconFile: file, isPublic: false });
        expect(warnings).toEqual([]);
        expect(calls.log).toEqual([['settings', { serverId: 's1', settings: { icon_file_id: 'icon-file-1' } }]]);
    });

    it('public listing is an explicit flag', async () => {
        await finishServerCreation('s1', { template: 'custom', iconFile: null, isPublic: true });
        expect(calls.log).toEqual([['settings', { serverId: 's1', settings: { is_public: true } }]]);
    });

    it('applies the template in order, sequentially', async () => {
        await finishServerCreation('s1', { template: 'school', iconFile: null, isPublic: false });
        expect(calls.log).toEqual([
            ['update', { id: 1, updates: { name: 'announcements' } }],
            ['create', { serverId: 's1', name: 'general', type: 0 }],
            ['create', { serverId: 's1', name: 'homework-help', type: 0 }],
            ['update', { id: 2, updates: { name: 'Study Room' } }],
            ['create', { serverId: 's1', name: 'Office Hours', type: 1 }],
        ]);
    });

    it('a failed icon upload is a warning, and the rest still happens', async () => {
        calls.failUpload = true;
        const file = new File([new Uint8Array([1])], 'icon.png', { type: 'image/png' });
        const warnings = await finishServerCreation('s1', { template: 'creative', iconFile: file, isPublic: false });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/icon/i);
        expect(calls.log.some(([k]) => k === 'update')).toBe(true);
        expect(calls.log.some(([k]) => k === 'settings')).toBe(false);
    });
});
