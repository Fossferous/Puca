import { describe, it, expect } from 'vitest';
import {
    IMPORTANT_REPOP_MS, NotifyGroups, QUIET_WINDOW_MS, channelGroupKey, channelWhere, dmGroupKey, groupText,
    joinGroupKey, navForGroupKey, whoPhrase, type GroupMessage,
} from '../api/notifyGroups';

/**
 * The owner's report: "windows notifications are spammed if theres a
 * conversation happening - they should be more seamless". These pin the
 * DECISION that replaces one notification per message with one per
 * conversation (api/notifyGroups.ts): what pops, what only updates in place,
 * what the notification says, and when its count starts again. The clock is
 * injected, so every window is exact.
 */

function harness() {
    let now = 1_000_000;
    const groups = new NotifyGroups(() => now);
    return {
        groups,
        at: (ms: number) => { now = ms; },
        advance: (ms: number) => { now += ms; },
    };
}

const chan = (author: string, id?: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
    key: 'chan:s1:7', kind: 'channel', where: '#general · Lads', author, messageId: id, ...extra,
});

describe('one notification per conversation', () => {
    it('pops for the first message and only updates for the rest of a burst', () => {
        const { groups, advance } = harness();
        const pops: boolean[] = [];
        for (let i = 0; i < 20; i++) {
            pops.push(groups.record(chan(['alice', 'bob', 'carol'][i % 3], `m${i}`))!.pop);
            advance(5_000);
        }
        expect(pops[0]).toBe(true);
        expect(pops.slice(1).every(p => !p)).toBe(true);
        expect(groups.get('chan:s1:7')?.count).toBe(20);
    });

    it('says who and how many, never what', () => {
        const { groups, advance } = harness();
        let step = groups.record(chan('alice', 'a'))!;
        expect(step).toMatchObject({ title: '#general · Lads', body: 'alice sent a message' });
        advance(1_000);
        step = groups.record(chan('alice', 'b'))!;
        expect(step.body).toBe('alice: 2 new messages');
        advance(1_000);
        step = groups.record(chan('bob', 'c'))!;
        expect(step.body).toBe('bob and alice: 3 new messages');
        advance(1_000);
        groups.record(chan('carol', 'd'));
        advance(1_000);
        step = groups.record(chan('dave', 'e'))!;
        expect(step.body).toBe('dave and 3 others: 5 new messages');
    });

    it('pops the same conversation again after a quiet minute, still counting', () => {
        const { groups, advance } = harness();
        expect(groups.record(chan('alice', 'a'))!.pop).toBe(true);
        advance(QUIET_WINDOW_MS - 1);
        expect(groups.record(chan('bob', 'b'))!.pop).toBe(false);
        advance(QUIET_WINDOW_MS);
        const again = groups.record(chan('alice', 'c'))!;
        expect(again.pop).toBe(true);
        // The count is what is waiting, not what arrived this minute.
        expect(again.state.count).toBe(3);
    });

    it('measures the quiet minute from the last message, so a conversation going on never pops twice', () => {
        const { groups, advance } = harness();
        groups.record(chan('alice', 'm0'));
        for (let i = 1; i <= 60; i++) {
            advance(30_000); // a message every 30 s for half an hour
            expect(groups.record(chan('bob', `m${i}`))!.pop).toBe(false);
        }
    });

    it('keeps conversations apart', () => {
        const { groups } = harness();
        expect(groups.record(chan('alice', 'a'))!.pop).toBe(true);
        expect(groups.record({ ...chan('alice', 'b'), key: 'chan:s1:8', where: '#random · Lads' })!.pop).toBe(true);
        expect(groups.record({ key: 'dm:c1', kind: 'dm', where: 'Alice', author: 'Alice', messageId: 'd1' })!.pop).toBe(true);
        expect(groups.keys()).toEqual(['chan:s1:7', 'chan:s1:8', 'dm:c1']);
    });

    it('starts again once the conversation is seen', () => {
        const { groups, advance } = harness();
        groups.record(chan('alice', 'a'));
        advance(1_000);
        groups.record(chan('bob', 'b'));
        expect(groups.seen('chan:s1:7')).toBe(true);
        advance(1_000);
        const next = groups.record(chan('carol', 'c'))!;
        expect(next.pop).toBe(true);
        expect(next.body).toBe('carol sent a message');
        expect(groups.seen('chan:s1:404')).toBe(false);
    });
});

describe('mentions and DMs', () => {
    it('a mention pops mid-burst, once a minute at most', () => {
        const { groups, advance } = harness();
        groups.record(chan('alice', 'a'));
        advance(5_000);
        expect(groups.record(chan('bob', 'b'))!.pop).toBe(false);
        advance(5_000);
        expect(groups.record(chan('bob', 'c', { important: true }))!.pop).toBe(true);
        advance(5_000);
        expect(groups.record(chan('bob', 'd', { important: true }))!.pop).toBe(false);
        // The conversation goes on (a message every 10 s, never a quiet
        // minute), so what pops next is the once-a-minute rule, not the lull.
        for (let t = 10_000; t < IMPORTANT_REPOP_MS; t += 10_000) {
            advance(10_000);
            expect(groups.record(chan('alice', `x${t}`))!.pop).toBe(false);
        }
        advance(5_000); // exactly a minute after the last important pop
        expect(groups.record(chan('carol', 'e', { important: true }))!.pop).toBe(true);
        // A plain message right after it is quiet again: not a lull.
        advance(1_000);
        expect(groups.record(chan('alice', 'f'))!.pop).toBe(false);
    });

    it('a DM pops for its first message, then at most once a minute, not on every line', () => {
        const { groups, advance } = harness();
        const dm = (id: string): GroupMessage => ({ key: 'dm:c1', kind: 'dm', where: 'Alice', author: 'Alice', messageId: id });
        const pops: boolean[] = [];
        for (let i = 0; i < 13; i++) {
            pops.push(groups.record(dm(`d${i}`))!.pop);
            advance(10_000);
        }
        // 0 s pops; 10..50 s update; 60 s pops again; 120 s again.
        expect(pops).toEqual([true, false, false, false, false, false, true, false, false, false, false, false, true]);
        expect(groups.get('dm:c1')?.count).toBe(13);
    });

    it('the same message reported twice counts once; a second report that it mentions you pops it', () => {
        const { groups, advance } = harness();
        groups.record(chan('alice', 'a'));
        advance(2_000);
        // The cross-channel frame: plain, mid-burst.
        expect(groups.record(chan('bob', 'm1'))!.pop).toBe(false);
        // The same frame again (a re-broadcast): nothing.
        expect(groups.record(chan('bob', 'm1'))).toBeNull();
        // The open channel decrypted it and found your name.
        const up = groups.record(chan('bob', 'm1', { important: true }))!;
        expect(up.pop).toBe(true);
        expect(up.state.count).toBe(2);
        // And says so only once.
        expect(groups.record(chan('bob', 'm1', { important: true }))).toBeNull();
    });

    it('a mention that STARTS a burst pops once, whichever report lands first', () => {
        // The cross-channel frame is handled at once; the open channel's
        // report waits for decryption, so the plain copy usually wins.
        const { groups, advance } = harness();
        expect(groups.record(chan('bob', 'm1'))!.pop).toBe(true);
        advance(40); // decrypting
        const up = groups.record(chan('bob', 'm1', { important: true }))!;
        expect(up.pop).toBe(false);
        expect(up.state.count).toBe(1);
        // It was the burst's important pop: the next mention within a minute is quiet.
        advance(5_000);
        expect(groups.record(chan('carol', 'm2', { important: true }))!.pop).toBe(false);
        for (let t = 10_000; t < IMPORTANT_REPOP_MS; t += 10_000) {
            advance(10_000);
            expect(groups.record(chan('alice', `x${t}`))!.pop).toBe(false);
        }
        advance(10_000);
        expect(groups.record(chan('carol', 'm3', { important: true }))!.pop).toBe(true);
    });

    it('coming back to the window ends every burst, so the next message after you leave pops', () => {
        // The reviewer's case: a DM pops, you look in on another channel,
        // you go back to the game, the same person writes again 40 s on.
        const { groups, advance } = harness();
        const dm = (id: string): GroupMessage => ({ key: 'dm:c1', kind: 'dm', where: 'Bob', author: 'Bob', messageId: id });
        expect(groups.record(dm('d1'))!.pop).toBe(true);
        expect(groups.record(chan('alice', 'a'))!.pop).toBe(true);
        advance(15_000);
        groups.endBursts();       // back in Púca, reading something else
        advance(25_000);
        const again = groups.record(dm('d2'))!;
        expect(again.pop).toBe(true);
        expect(again.body).toBe('2 new messages');   // still what is waiting
        expect(groups.record(chan('bob', 'b'))!.pop).toBe(true);
        // CONTROL: without coming back, the same timing is one quiet burst.
        const c = harness();
        c.groups.record(dm('d1'));
        c.advance(40_000);
        expect(c.groups.record(dm('d2'))!.pop).toBe(false);
    });

    it('a mention reported before its plain copy is not counted twice either', () => {
        const { groups } = harness();
        expect(groups.record(chan('bob', 'm1', { important: true }))!.pop).toBe(true);
        expect(groups.record(chan('bob', 'm1'))).toBeNull();
        expect(groups.get('chan:s1:7')?.count).toBe(1);
    });

    it('never says a message mentioned you: that is a fact about its words', () => {
        const { groups } = harness();
        const step = groups.record(chan('bob', 'm1', { important: true }))!;
        expect(`${step.title} ${step.body}`).not.toMatch(/mention/i);
    });
});

describe('the words on it', () => {
    it('names the most recent first', () => {
        expect(whoPhrase([])).toBe('Someone');
        expect(whoPhrase(['alice'])).toBe('alice');
        expect(whoPhrase(['alice', 'bob'])).toBe('bob and alice');
        expect(whoPhrase(['alice', 'bob', 'carol'])).toBe('carol and 2 others');
    });

    it('a name speaking again moves to the front and is not counted twice', () => {
        const { groups, advance } = harness();
        groups.record(chan('alice', 'a'));
        advance(1);
        groups.record(chan('bob', 'b'));
        advance(1);
        const s = groups.record(chan('alice', 'c'))!;
        expect(s.state.authors).toEqual(['bob', 'alice']);
        expect(s.body).toBe('alice and bob: 3 new messages');
    });

    it('per kind', () => {
        expect(groupText({ kind: 'dm', where: 'Alice', count: 1, authors: ['Alice'] })).toEqual({ title: 'Alice', body: 'Sent you a message' });
        expect(groupText({ kind: 'dm', where: 'Alice', count: 4, authors: ['Alice'] })).toEqual({ title: 'Alice', body: '4 new messages' });
        expect(groupText({ kind: 'join', where: 'Lads', count: 1, authors: ['dave'] })).toEqual({ title: 'Lads', body: 'dave joined' });
        expect(groupText({ kind: 'join', where: 'Lads', count: 3, authors: ['a', 'b', 'c'] })).toEqual({ title: 'Lads', body: 'c and 2 others joined' });
    });

    it('a channel is titled by what is known of it', () => {
        expect(channelWhere('general', 'Lads')).toBe('#general · Lads');
        expect(channelWhere(undefined, 'Lads')).toBe('Lads');
        expect(channelWhere('general', undefined)).toBe('#general');
        expect(channelWhere(undefined, undefined)).toBe('A channel');
    });
});

describe('keys and where a click lands', () => {
    it('one spelling per conversation', () => {
        expect(channelGroupKey('s1', 7)).toBe('chan:s1:7');
        expect(dmGroupKey('c1')).toBe('dm:c1');
        expect(joinGroupKey('s1')).toBe('join:s1');
    });

    it('a key names the place Chat already knows how to open', () => {
        expect(navForGroupKey('chan:s1:7')).toBe('channel:s1:7');
        expect(navForGroupKey('dm:c1')).toBe('dm:c1');
        expect(navForGroupKey('join:s1')).toBe('server:s1');
        expect(navForGroupKey('chan:s1')).toBe('server:s1');
        expect(navForGroupKey('test')).toBeNull();
        expect(navForGroupKey('file:123')).toBeNull();
    });
});

describe('bounded', () => {
    it('forgets the least recently active conversation past two hundred', () => {
        const { groups, advance } = harness();
        for (let i = 0; i < 201; i++) {
            groups.record({ key: `dm:${i}`, kind: 'dm', where: 'x', author: 'x' });
            advance(1);
        }
        // dm:0 went first; touching dm:1 keeps it.
        expect(groups.get('dm:0')).toBeUndefined();
        expect(groups.keys()).toHaveLength(200);
        groups.record({ key: 'dm:1', kind: 'dm', where: 'x', author: 'x' });
        groups.record({ key: 'dm:new', kind: 'dm', where: 'x', author: 'x' });
        expect(groups.get('dm:1')).toBeDefined();
        expect(groups.get('dm:2')).toBeUndefined();
    });

    it('keeps a bounded set of ids and names per conversation', () => {
        const { groups, advance } = harness();
        for (let i = 0; i < 500; i++) {
            groups.record(chan(`user${i}`, `m${i}`));
            advance(10);
        }
        const s = groups.get('chan:s1:7')!;
        expect(s.count).toBe(500);
        expect(s.ids.length).toBeLessThanOrEqual(50);
        expect(s.authors.length).toBeLessThanOrEqual(50);
    });
});
