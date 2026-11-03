import { describe, expect, it } from 'vitest';
import {
    deleteChannelQuestion,
    drawnAtTop,
    drawnUnderCollection,
    hiddenWithCollection,
    keptByHideMuted,
    parentChoices,
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

describe('the row every text channel and collection gets', () => {
    type Row = { id: number; name: string; channel_type: number; parent_id: number | null };
    const row = (id: number, channel_type: number, parent_id: number | null = null): Row => ({ id, name: `r${id}`, channel_type, parent_id });

    // As Chat.tsx's list draws them: each top-level row, then a collection's children.
    const drawnRows = (rows: Row[]) => rows
        .filter(c => c.channel_type !== VOICE && drawnAtTop(c, rows) && !hiddenWithCollection(c, rows))
        .flatMap(c => [c.id, ...(c.channel_type === COLLECTION
            ? rows.filter(sub => sub.parent_id === c.id && !drawnAtTop(sub, rows)).filter(drawnUnderCollection).map(sub => sub.id)
            : [])]);
    const everyRowOnce = (rows: Row[]) => {
        const expected = rows.filter(c => c.channel_type !== VOICE).map(c => c.id).sort((a, b) => a - b);
        expect(drawnRows(rows).sort((a, b) => a - b)).toEqual(expected);
    };

    it('draws a top-level row at the top, and a collection\'s child under it', () => {
        const rows = [row(1, TEXT), row(2, COLLECTION), row(3, TEXT, 2), row(4, VOICE, 2)];
        expect(drawnAtTop(rows[0], rows)).toBe(true);
        expect(drawnAtTop(rows[1], rows)).toBe(true);
        expect(drawnAtTop(rows[2], rows)).toBe(false);
        expect(drawnRows(rows)).toEqual([1, 2, 3]);
    });

    it('draws a channel under a collection inside a collection at the top: it has no other row', () => {
        const rows = [row(1, COLLECTION), row(2, COLLECTION, 1), row(3, TEXT, 2)];
        expect(drawnAtTop(rows[1], rows), 'the nested one keeps its row under its parent').toBe(false);
        expect(drawnAtTop(rows[2], rows)).toBe(true);
        expect(drawnRows(rows)).toEqual([1, 2, 3]);
    });

    it('draws nothing under a collection this reader cannot see: denying it is how it looks private', () => {
        expect(drawnRows([row(3, TEXT, 99)])).toEqual([]);
        expect(drawnRows([row(1, TEXT), row(3, TEXT, 99)])).toEqual([1]);
    });

    it('nor anything under a collection inside one, the row that has none other otherwise', () => {
        expect(drawnRows([row(2, COLLECTION, 99), row(3, TEXT, 2)])).toEqual([]);
    });

    it('CONTROL: the same rows, with that collection in the reader\'s list, are drawn', () => {
        expect(drawnRows([row(99, COLLECTION), row(3, TEXT, 99)])).toEqual([99, 3]);
        expect(drawnRows([row(99, COLLECTION), row(2, COLLECTION, 99), row(3, TEXT, 2)])).toEqual([99, 2, 3]);
    });

    it('leaves the Modes tab its voice rooms: it asks of one kind of row at a time, and their collection is not one', () => {
        const rooms = [row(3, VOICE, 99)];
        expect(drawnAtTop(rooms[0], rooms)).toBe(true);
    });

    it('draws a channel the raw API put under something that is no collection', () => {
        everyRowOnce([row(1, TEXT), row(2, TEXT, 1)]);
        everyRowOnce([row(1, VOICE), row(2, TEXT, 1)]);
    });

    it('draws a collection nested two levels down, and what is in it, once each', () => {
        everyRowOnce([row(1, COLLECTION), row(2, COLLECTION, 1), row(3, COLLECTION, 2), row(4, TEXT, 3)]);
    });

    it('draws every row of a loop once: it is no way out of the list, and no way into it twice', () => {
        everyRowOnce([row(1, COLLECTION, 1)]);
        everyRowOnce([row(1, TEXT, 1)]);
        everyRowOnce([row(1, COLLECTION, 2), row(2, COLLECTION, 1), row(3, TEXT, 2)]);
    });

    it('stops at a row with no parent, whatever spelling of none the server sent', () => {
        expect(drawnAtTop({ id: 1, name: 'a', channel_type: TEXT }, [])).toBe(true);
    });
});

describe('what Nest Under and Parent Collection offer', () => {
    const rows = [
        { id: 1, name: 'lobby', channel_type: TEXT, parent_id: null },
        { id: 2, name: 'Top', channel_type: COLLECTION, parent_id: null },
        { id: 3, name: 'Deeper', channel_type: COLLECTION, parent_id: 2 },
        { id: 4, name: 'Town', channel_type: VOICE, parent_id: null },
    ];
    const ids = (current?: number | null) => parentChoices(rows, current).map(c => c.id);

    it('offers a top-level collection, never a nested one: nothing would draw what went in it', () => {
        expect(ids()).toEqual([2]);
        expect(ids(null)).toEqual([2]);
    });

    it('keeps what the channel is under on offer, so the field shows it and leaving it is a change', () => {
        expect(ids(3)).toEqual([2, 3]);
        expect(ids(1), 'a parent the raw API set').toEqual([1, 2]);
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
