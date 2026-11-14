/**
 * One notification per conversation, updated in place, instead of one per
 * message (docs/USER_GUIDE.md, Message notifications on a computer).
 *
 * The owner's report: "windows notifications are spammed if theres a
 * conversation happening". Every message raised its own Windows toast, because
 * the desktop app's notifications carried no tag Windows could replace by
 * (src-tauri/src/toasts.rs says how that was measured), and the web app's tag
 * was the title, "alice sent a message", which differs per author. So a lively
 * channel stacked a pop-up and a notification-centre entry for every message.
 *
 * This module is the DECISION, pure and clock-injected so every rule is
 * testable: for each message it says whether the conversation's toast should
 * POP (appear on screen) or only UPDATE where it is (no pop-up, no sound), and
 * what the toast now says. desktopNotify.ts carries that out: the desktop app
 * through toasts.rs, the web app through a Notification tagged by the
 * conversation.
 *
 * The rules:
 *  - a conversation's first message pops;
 *  - further messages less than QUIET_WINDOW_MS after the one before update
 *    quietly: a conversation going on is one toast that keeps count;
 *  - a lull of QUIET_WINDOW_MS ends the burst, and the next message pops again
 *    (still the same toast, replaced: never a second one);
 *  - an IMPORTANT message (a DM, an @mention of you) pops when it is the first
 *    important one of its burst, and again at most once per
 *    IMPORTANT_REPOP_MS: a mention in a busy channel is not lost in the chatter,
 *    and a DM exchange does not pop on every line;
 *  - coming back to the window ends every burst (endBursts): you were here,
 *    so the first message after you leave again pops, whatever the clock says;
 *  - the count, and the names, run until the conversation is SEEN (opened in
 *    the app with the window focused, or its toast clicked): the toast says
 *    what arrived while you were away, not only in the last minute. Messages
 *    that arrive while you are using Púca are not counted: the app shows them.
 *
 * Content-free like everything in desktopNotify.ts: names (which the old
 * titles carried already), a channel or server name, and a count. Never a
 * word of a message, and not whether one mentioned you: that is a fact about
 * its words, and a toast is drawn by the OS, kept in its notification centre
 * and shown on the lock screen.
 */

/** A lull this long ends a burst: the next message pops again. */
export const QUIET_WINDOW_MS = 60_000;

/** An important message pops again at most this often per conversation. */
export const IMPORTANT_REPOP_MS = 60_000;

/** Names kept per conversation (the toast shows one or two and a count of
 *  the rest, which stops growing here). */
const MAX_AUTHORS = 50;
/** Message ids kept per conversation, to recognise one counted already. */
const MAX_IDS = 50;
/** Conversations kept at once; the least recently active goes first. */
const MAX_GROUPS = 200;

export type GroupKind = 'channel' | 'dm' | 'join';

export interface GroupMessage {
    /** One toast per key: 'chan:<server>:<channel>', 'dm:<conversation>', 'join:<server>'. */
    key: string;
    kind: GroupKind;
    /** What the toast is titled by: '#general · Server', a person's name, a server's name. */
    where: string;
    /** Who sent it (or joined). */
    author: string;
    /** The message's id, when it has one: the same message reported twice
     *  (the cross-channel frame and the open channel's own) counts once. */
    messageId?: string;
    /** An @mention of you. DMs are important by kind. */
    important?: boolean;
}

export interface GroupState {
    key: string;
    kind: GroupKind;
    where: string;
    count: number;
    /** Distinct, most recent LAST. */
    authors: string[];
    /** More people wrote than `authors` keeps (MAX_AUTHORS): the toast
     *  cannot say exactly how many, so it says "more than". */
    moreAuthors: boolean;
    ids: string[];
    importantIds: string[];
    /** When the last message was counted. */
    lastAt: number;
    /** When the toast last popped. */
    lastPopAt: number;
    /** The message whose arrival last popped it, when it had an id. */
    lastPopId: string | null;
    /** When an important message last popped it, in this burst (null: none yet). */
    importantPopAt: number | null;
}

export interface GroupStep {
    /** Appear on screen (true) or change the toast where it is (false). */
    pop: boolean;
    title: string;
    body: string;
    state: GroupState;
}

function isImportant(m: GroupMessage): boolean {
    return m.kind === 'dm' || m.important === true;
}

function pushCapped<T>(list: T[], item: T, cap: number): T[] {
    const next = [...list.filter(x => x !== item), item];
    return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * The next state of one conversation's toast. Returns null when there is
 * nothing to do: the message was counted already and this report adds
 * nothing (a plain copy of one counted, or a second report of a mention).
 */
export function stepGroup(prev: GroupState | undefined, m: GroupMessage, now: number): GroupStep | null {
    const important = isImportant(m);
    const seenId = m.messageId !== undefined && prev?.ids.includes(m.messageId) === true;

    if (prev && seenId) {
        // Counted already. Only news if this report says it is important and
        // the first did not (the open channel saw the mention the
        // cross-channel frame could not).
        if (!important || prev.importantIds.includes(m.messageId!)) return null;
        const state: GroupState = { ...prev, where: m.where, importantIds: pushCapped(prev.importantIds, m.messageId!, MAX_IDS) };
        // This very message popped the toast already (it started the burst,
        // and the plain copy got here before the open channel had decrypted
        // it): it has had its pop. Popping again would only replay the
        // banner. It does count as the burst's important pop.
        if (prev.lastPopId === m.messageId) {
            return finish({ ...state, importantPopAt: prev.lastPopAt }, false, now);
        }
        return finish(state, mayPopImportant(prev, now), now, true, m.messageId);
    }

    // A new burst: no toast yet, or the conversation went quiet for a while.
    const newBurst = !prev || now - prev.lastAt >= QUIET_WINDOW_MS;
    const base: GroupState = prev ?? {
        key: m.key, kind: m.kind, where: m.where, count: 0, authors: [], moreAuthors: false, ids: [], importantIds: [],
        lastAt: now, lastPopAt: Number.NEGATIVE_INFINITY, lastPopId: null, importantPopAt: null,
    };
    const state: GroupState = {
        ...base,
        kind: m.kind,
        where: m.where,
        count: base.count + 1,
        authors: pushCapped(base.authors, m.author, MAX_AUTHORS),
        // A new name pushed the oldest off the kept list.
        moreAuthors: base.moreAuthors || (base.authors.length >= MAX_AUTHORS && !base.authors.includes(m.author)),
        ids: m.messageId !== undefined ? pushCapped(base.ids, m.messageId, MAX_IDS) : base.ids,
        importantIds: important && m.messageId !== undefined ? pushCapped(base.importantIds, m.messageId, MAX_IDS) : base.importantIds,
        lastAt: now,
        importantPopAt: newBurst ? null : base.importantPopAt,
    };
    const pop = newBurst || (important && mayPopImportant(state, now));
    return finish(state, pop, now, important, m.messageId);
}

/** An important message may pop: the first of its burst, or a while after the last. */
function mayPopImportant(s: GroupState, now: number): boolean {
    return s.importantPopAt === null || now - s.importantPopAt >= IMPORTANT_REPOP_MS;
}

function finish(state: GroupState, pop: boolean, now: number, important = true, messageId?: string): GroupStep {
    const next: GroupState = pop
        ? { ...state, lastPopAt: now, lastPopId: messageId ?? null, importantPopAt: important ? now : state.importantPopAt }
        : state;
    return { pop, ...groupText(next), state: next };
}

/** 'alice', 'bob and alice', 'carol and 2 others': the most recent first.
 *  `more`: more people than `authors` holds, so 'carol and more than 49 others'. */
export function whoPhrase(authors: string[], more = false): string {
    const recentFirst = [...authors].reverse();
    if (recentFirst.length <= 1 && !more) return recentFirst[0] ?? 'Someone';
    if (recentFirst.length === 2 && !more) return `${recentFirst[0]} and ${recentFirst[1]}`;
    const others = recentFirst.length - 1;
    return more ? `${recentFirst[0] ?? 'Someone'} and more than ${others} others` : `${recentFirst[0]} and ${others} others`;
}

/** What the conversation's toast says now. No message text, ever. */
export function groupText(s: Pick<GroupState, 'kind' | 'where' | 'count' | 'authors'> & { moreAuthors?: boolean }): { title: string; body: string } {
    const n = s.count;
    const latest = s.authors[s.authors.length - 1] ?? 'Someone';
    const who = whoPhrase(s.authors, s.moreAuthors === true);
    switch (s.kind) {
        case 'dm':
            return { title: s.where, body: n <= 1 ? 'Sent you a message' : `${n} new messages` };
        case 'join':
            return { title: s.where, body: n <= 1 ? `${latest} joined` : `${who} joined` };
        case 'channel':
        default:
            return { title: s.where, body: n <= 1 ? `${latest} sent a message` : `${who}: ${n} new messages` };
    }
}

/**
 * Every conversation's state, in one place, with the clock injectable for
 * tests. desktopNotify.ts owns the one instance the app uses.
 */
export class NotifyGroups {
    private groups = new Map<string, GroupState>();
    private readonly clock: () => number;

    constructor(clock: () => number = () => Date.now()) {
        this.clock = clock;
    }

    /** Count a message; null when it adds nothing (see stepGroup). */
    record(m: GroupMessage): GroupStep | null {
        const step = stepGroup(this.groups.get(m.key), m, this.clock());
        if (!step) return null;
        // Re-insert so the Map's order is least recently active first.
        this.groups.delete(m.key);
        this.groups.set(m.key, step.state);
        while (this.groups.size > MAX_GROUPS) {
            const oldest = this.groups.keys().next().value;
            if (oldest === undefined) break;
            this.groups.delete(oldest);
        }
        return step;
    }

    /** You came back to the window: every conversation's burst ends, so the
     *  next message pops; counts and names stay until each is seen. */
    endBursts(): void {
        for (const [key, s] of this.groups) {
            this.groups.set(key, { ...s, lastAt: Number.NEGATIVE_INFINITY, importantPopAt: null });
        }
    }

    /** The conversation was seen: its count starts again from nothing. */
    seen(key: string): boolean {
        return this.groups.delete(key);
    }

    clear(): void {
        this.groups.clear();
    }

    get(key: string): GroupState | undefined {
        return this.groups.get(key);
    }

    keys(): string[] {
        return [...this.groups.keys()];
    }
}

/** The keys, in one place: what counts a message and what sees its
 *  conversation must name it the same way. */
export const channelGroupKey = (serverId: string, channelId: number | string) => `chan:${serverId}:${channelId}`;
export const dmGroupKey = (conversationId: string) => `dm:${conversationId}`;
export const joinGroupKey = (serverId: string) => `join:${serverId}`;
/** The task reminder's notification: one, which each new one replaces (the
 *  same key on Android, the web and the desktop app's toasts). Not a
 *  conversation, so nothing counts under it; a click opens Reminders. */
export const TASKS_DUE_KEY = 'tasks-due';

/** A channel's toast title: '#general · Server', or what is known of it. */
export function channelWhere(channel: string | undefined, server: string | undefined): string {
    if (channel && server) return `#${channel} · ${server}`;
    if (channel) return `#${channel}`;
    return server || 'A channel';
}

/** Where a click on a conversation's toast lands, from its key alone: the
 *  'sovereign-navigate' target Chat already applies (Android taps use the same
 *  door). Null for a key that names no place. */
export function navForGroupKey(key: string): string | null {
    // The Tasks view's Reminders tab (Chat's 'reminders' target, the one an
    // Android tap on a due-item notification uses).
    if (key === TASKS_DUE_KEY) return 'reminders';
    if (key.startsWith('dm:')) return key;
    if (key.startsWith('join:')) return `server:${key.slice(5)}`;
    if (key.startsWith('chan:')) {
        const [, server, channel] = key.split(':');
        if (server && channel) return `channel:${server}:${channel}`;
        if (server) return `server:${server}`;
    }
    return null;
}
