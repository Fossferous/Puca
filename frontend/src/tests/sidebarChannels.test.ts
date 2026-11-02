import { describe, expect, it } from 'vitest';
import {
    deleteChannelQuestion,
    drawnUnderCollection,
    keptByHideMuted,
    reorderedChannelIds,
    withoutDeletedChannel,
} from '../components/sidebarChannels';

const TEXT = 0;
const VOICE = 1;
const COLLECTION = 2;

// In the order the server lists them. Positions overlap across kinds and parents on a
// real server; the list's order is what a drag works from.
const channels = [
    { id: 1, name: 'lobby', channel_type: TEXT, parent_id: null },
    { id: 2, name: 'Town', channel_type: VOICE, parent_id: null },
    { id: 3, name: 'Rooms', channel_type: COLLECTION, parent_id: null },
    { id: 4, name: 'Attic', channel_type: VOICE, parent_id: 3 },
    { id: 5, name: 'Cellar', channel_type: VOICE, parent_id: 3 },
    { id: 6, name: 'Mixed', channel_type: COLLECTION, parent_id: null },
    { id: 7, name: 'notes', channel_type: TEXT, parent_id: 6 },
    { id: 8, name: 'todo', channel_type: TEXT, parent_id: 6 },
    { id: 9, name: 'Den', channel_type: VOICE, parent_id: 6 },
    { id: 10, name: 'AFK', channel_type: VOICE, parent_id: null, is_afk: true },
];

describe('what a collection draws', () => {
    it('draws its text channels and leaves a voice channel to the Voice Channels section', () => {
        const under = channels.filter(c => c.parent_id === 6).filter(drawnUnderCollection).map(c => c.name);
        expect(under).toEqual(['notes', 'todo']);
    });

    it('draws nothing for a collection of voice rooms', () => {
        expect(channels.filter(c => c.parent_id === 3).filter(drawnUnderCollection)).toEqual([]);
    });
});

describe('Hide Muted Channels', () => {
    const mutedIds = (...ids: number[]) => (id: number) => ids.includes(id);
    const row = (id: number) => channels.find(c => c.id === id)!;

    it('keeps what is not muted, and hides a muted row with nothing to hold it', () => {
        expect(keptByHideMuted(row(1), channels, mutedIds(), undefined)).toBe(true);
        expect(keptByHideMuted(row(1), channels, mutedIds(1), undefined)).toBe(false);
    });

    it('hides a muted collection of voice rooms: nothing is drawn under its header', () => {
        expect(keptByHideMuted(row(3), channels, mutedIds(3), undefined)).toBe(false);
    });

    it('keeps a muted collection while it is open, voice rooms or not', () => {
        expect(keptByHideMuted(row(3), channels, mutedIds(3), 3)).toBe(true);
        expect(keptByHideMuted(row(6), channels, mutedIds(6, 7, 8), 6)).toBe(true);
    });

    it('keeps a muted collection as the header of a text channel still drawn under it', () => {
        expect(keptByHideMuted(row(6), channels, mutedIds(6, 7), undefined)).toBe(true);
    });

    it('hides a muted collection whose text channels are all muted, its voice room not counting', () => {
        expect(keptByHideMuted(row(6), channels, mutedIds(6, 7, 8), undefined)).toBe(false);
    });

    it('keeps it as the header of the muted text channel that is open', () => {
        expect(keptByHideMuted(row(6), channels, mutedIds(6, 7, 8), 7)).toBe(true);
    });
});

describe('reorderedChannelIds', () => {
    it('numbers the whole voice list, so a room moved inside its collection keeps the rest in place', () => {
        // Attic onto Cellar. Numbering only the two would restart at 0 and put them above Town.
        expect(reorderedChannelIds(channels, 4, 5)).toEqual([2, 5, 4, 9]);
    });

    it('moves a voice room across collections, its collection unchanged being the caller\'s business', () => {
        expect(reorderedChannelIds(channels, 9, 2)).toEqual([9, 2, 4, 5]);
    });

    it('leaves the AFK channel out, and refuses it as a target', () => {
        expect(reorderedChannelIds(channels, 2, 4)).not.toContain(10);
        expect(reorderedChannelIds(channels, 2, 10)).toBeNull();
    });

    it('moves a text subchannel among its siblings only', () => {
        expect(reorderedChannelIds(channels, 7, 8)).toEqual([8, 7]);
    });

    it('moves a collection among the top-level text rows, whatever it holds', () => {
        expect(reorderedChannelIds(channels, 6, 3)).toEqual([1, 6, 3]);
    });

    it('moves nothing between a subchannel and a row outside its collection', () => {
        expect(reorderedChannelIds(channels, 7, 1)).toBeNull();
    });

    it('moves nothing between a text row and a voice row, or a row onto itself', () => {
        expect(reorderedChannelIds(channels, 1, 2)).toBeNull();
        expect(reorderedChannelIds(channels, 2, 1)).toBeNull();
        expect(reorderedChannelIds(channels, 4, 4)).toBeNull();
    });

    it('moves nothing for a row it no longer knows', () => {
        expect(reorderedChannelIds(channels, 99, 2)).toBeNull();
        expect(reorderedChannelIds(channels, 2, 99)).toBeNull();
    });
});

describe('deleting a collection', () => {
    it('names what goes with it, voice rooms included', () => {
        const question = deleteChannelQuestion(channels, 6);
        expect(question).toContain('Mixed');
        expect(question).toContain('#notes');
        expect(question).toContain('Den');
    });

    it('asks the plain question for a channel with nothing in it', () => {
        expect(deleteChannelQuestion(channels, 1)).toBe('Are you sure you want to delete this channel?');
    });

    it('loses its rooms from the list too, and nobody else\'s', () => {
        const left = withoutDeletedChannel(channels, 3).map(c => c.id);
        expect(left).toEqual([1, 2, 6, 7, 8, 9, 10]);
    });

    // A collection inside a collection: the foreign key cascades through every level.
    const nested = [
        { id: 1, name: 'Top', channel_type: COLLECTION, parent_id: null },
        { id: 2, name: 'Nested', channel_type: COLLECTION, parent_id: 1 },
        { id: 3, name: 'Deep room', channel_type: VOICE, parent_id: 2 },
        { id: 4, name: 'deep-notes', channel_type: TEXT, parent_id: 2 },
        { id: 5, name: 'Elsewhere', channel_type: VOICE, parent_id: null },
    ];

    it('names every level of what goes with it, with # only on a text channel', () => {
        expect(deleteChannelQuestion(nested, 1)).toBe('Delete Top? Everything in it is deleted too: Nested, Deep room, #deep-notes.');
    });

    it('loses every level from the list', () => {
        expect(withoutDeletedChannel(nested, 1).map(c => c.id)).toEqual([5]);
    });

    it('leaves the parent of a nested collection it deletes', () => {
        expect(withoutDeletedChannel(nested, 2).map(c => c.id)).toEqual([1, 5]);
    });

    it('survives two rows naming each other as parent', () => {
        const loop = [
            { id: 1, name: 'One', channel_type: COLLECTION, parent_id: 2 },
            { id: 2, name: 'Two', channel_type: COLLECTION, parent_id: 1 },
        ];
        expect(deleteChannelQuestion(loop, 1)).toBe('Delete One? Everything in it is deleted too: Two.');
        expect(withoutDeletedChannel(loop, 1)).toEqual([]);
    });
});
