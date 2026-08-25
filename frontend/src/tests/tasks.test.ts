// Unit tests for the task helpers shared by ChecklistPanel and TasksView:
// grouping into parent/subtask nodes, the Google Keep style completion
// cascade, and the encrypt-to-self envelope used for personal lists.
import { describe, it, expect, beforeAll } from 'vitest';
import {
    buildTaskTree, applyToggle, applyMove, applyReorder, collectSubtreeIds, planDropTarget,
    parseTaskAttachments, serializeTaskAttachments, canEditTask, MAX_TASK_ATTACHMENTS,
    orderTaskTabs, isFavoriteTab, buildPrefsForOrder, toggleFavoritePrefs, taskTabKey,
    dueToLocalInput, localInputToIso, isTaskOverdue, formatDueShort,
    type Task, type TaskAttachmentRef, type TaskTabPref, type TaskTabRef,
} from '../api/tasks';
import { planReminders, type ReminderPlan } from '../api/taskReminders';
import { PERM } from '../api/permissionBits';
import {
    encryptSelf,
    decryptSelf,
    serializeEnvelope,
    parseEnvelope,
    isEncrypted,
} from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

function task(id: number, overrides: Partial<Task> = {}): Task {
    return {
        id,
        channel_id: null,
        list_id: 1,
        parent_id: null,
        description: `task ${id}`,
        is_completed: false,
        position: id,
        created_at: '2026-07-15',
        created_by: 1,
        attachments: null,
        due_at: null,
        ...overrides,
    };
}

describe('buildTaskTree', () => {
    it('returns top-level tasks with no children as leaf nodes', () => {
        const tree = buildTaskTree([task(1), task(2)]);
        expect(tree).toHaveLength(2);
        expect(tree[0].task.id).toBe(1);
        expect(tree[0].children).toEqual([]);
    });

    it('attaches subtasks to their parent in order', () => {
        const tasks = [task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 1 }), task(4)];
        const tree = buildTaskTree(tasks);
        expect(tree).toHaveLength(2);
        expect(tree[0].children.map(c => c.task.id)).toEqual([2, 3]);
        expect(tree[1].task.id).toBe(4);
    });

    it('nests sub-subtasks recursively', () => {
        const tasks = [
            task(1),
            task(2, { parent_id: 1 }),
            task(3, { parent_id: 2 }),
            task(4, { parent_id: 3 }),
        ];
        const tree = buildTaskTree(tasks);
        expect(tree).toHaveLength(1);
        expect(tree[0].children[0].task.id).toBe(2);
        expect(tree[0].children[0].children[0].task.id).toBe(3);
        expect(tree[0].children[0].children[0].children[0].task.id).toBe(4);
    });

    it('drops orphaned subtasks from top level (they are not roots)', () => {
        const tree = buildTaskTree([task(2, { parent_id: 99 })]);
        expect(tree).toHaveLength(0);
    });

    it('orders by position, not id', () => {
        const tree = buildTaskTree([task(1, { position: 5 }), task(2, { position: 3 }), task(3, { position: 4 })]);
        expect(tree.map(n => n.task.id)).toEqual([2, 3, 1]);
    });
});

describe('applyMove (one-slot reorder)', () => {
    it('moving up swaps positions with the previous sibling', () => {
        const next = applyMove([task(1), task(2), task(3)], task(2), 'up');
        expect(next.find(t => t.id === 2)!.position).toBe(1);
        expect(next.find(t => t.id === 1)!.position).toBe(2);
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([2, 1, 3]);
    });

    it('moving down swaps positions with the next sibling', () => {
        const next = applyMove([task(1), task(2), task(3)], task(2), 'down');
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([1, 3, 2]);
    });

    it('is a no-op at the edges (returns the same array)', () => {
        const tasks = [task(1), task(2)];
        expect(applyMove(tasks, tasks[0], 'up')).toBe(tasks);
        expect(applyMove(tasks, tasks[1], 'down')).toBe(tasks);
    });

    it('subtasks reorder among their own siblings only', () => {
        const tasks = [task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 1 }), task(4)];
        const next = applyMove(tasks, tasks[2], 'up');
        expect(buildTaskTree(next)[0].children.map(c => c.task.id)).toEqual([3, 2]);
        // Top-level order untouched.
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([1, 4]);
    });

    it('skips over siblings in the other completion section', () => {
        // Active 1 and 3 with a completed 2 between them: moving 3 up must
        // swap with 1 (its visible neighbor), not with the completed 2.
        const tasks = [task(1), task(2, { is_completed: true }), task(3)];
        const next = applyMove(tasks, tasks[2], 'up');
        expect(next.find(t => t.id === 3)!.position).toBe(1);
        expect(next.find(t => t.id === 1)!.position).toBe(3);
        expect(next.find(t => t.id === 2)!.position).toBe(2);
    });
});

describe('applyReorder (drag-drop, mirrors the server renumber)', () => {
    it('drops after a given sibling; fresh positions stay scope-unique', () => {
        const next = applyReorder([task(1), task(2), task(3)], task(1), 2);
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([2, 1, 3]);
        // Like the server: the group gets fresh values ABOVE the scope max
        // (position uniqueness is what keeps a later completion toggle —
        // which moves a task between groups WITHOUT renumbering — safe).
        const positions = next.map(t => t.position);
        expect(new Set(positions).size).toBe(positions.length);
        expect(Math.min(...positions)).toBeGreaterThan(3);
    });

    it('afterId null moves to the front of the group', () => {
        const next = applyReorder([task(1), task(2), task(3)], task(3), null);
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([3, 1, 2]);
    });

    it('can jump multiple slots at once (unlike applyMove)', () => {
        const next = applyReorder([task(1), task(2), task(3), task(4)], task(1), 4);
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([2, 3, 4, 1]);
    });

    it('returns the input unchanged for an afterId outside the group', () => {
        const tasks = [task(1), task(2), task(3, { parent_id: 1 })];
        // 3 is a subtask — not a sibling of root task 2.
        expect(applyReorder(tasks, tasks[1], 3)).toBe(tasks);
        // A completed task is not a visible sibling of an active one.
        const mixed = [task(1), task(2, { is_completed: true }), task(3)];
        expect(applyReorder(mixed, mixed[2], 2)).toBe(mixed);
        // The task itself is never its own anchor.
        expect(applyReorder(tasks, tasks[0], 1)).toBe(tasks);
    });

    it('reorders subtasks within their own sibling group only', () => {
        const tasks = [task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 1 }), task(4)];
        const next = applyReorder(tasks, tasks[2], null);
        expect(buildTaskTree(next)[0].children.map(c => c.task.id)).toEqual([3, 2]);
        expect(buildTaskTree(next).map(n => n.task.id)).toEqual([1, 4]);
    });

    it('leaves completed siblings positions untouched — and never collides with them', () => {
        const tasks = [task(1), task(2, { is_completed: true }), task(3)];
        const next = applyReorder(tasks, tasks[2], null);
        expect(next.find(t => t.id === 2)!.position).toBe(2);
        expect(buildTaskTree(next).filter(n => !n.task.is_completed).map(n => n.task.id)).toEqual([3, 1]);
        // Scope-wide uniqueness survives the renumber.
        const positions = next.map(t => t.position);
        expect(new Set(positions).size).toBe(positions.length);
    });
});

describe('tasks-bar tab ordering + favourites', () => {
    const tab = (kind: 'list' | 'channel', id: number): TaskTabRef => ({ kind, id });
    const pref = (kind: 'list' | 'channel', ref_id: number, is_favorite = false): TaskTabPref =>
        ({ kind, ref_id, is_favorite });

    it('orders by saved prefs, appending tabs the prefs never saw', () => {
        const tabs = [tab('list', 1), tab('list', 2), tab('channel', 10), tab('channel', 11)];
        const prefs = [pref('channel', 10), pref('list', 2)];
        expect(orderTaskTabs(tabs, prefs).map(taskTabKey))
            .toEqual(['channel:10', 'list:2', 'list:1', 'channel:11']);
    });

    it('skips prefs whose tab no longer exists (deleted list, left server)', () => {
        const tabs = [tab('list', 1)];
        const prefs = [pref('list', 99), pref('list', 1)];
        expect(orderTaskTabs(tabs, prefs).map(taskTabKey)).toEqual(['list:1']);
    });

    it('does not confuse a list and a channel with the same id', () => {
        const tabs = [tab('list', 7), tab('channel', 7)];
        const prefs = [pref('channel', 7)];
        expect(orderTaskTabs(tabs, prefs).map(taskTabKey)).toEqual(['channel:7', 'list:7']);
        expect(isFavoriteTab([pref('channel', 7, true)], tab('list', 7))).toBe(false);
    });

    it('buildPrefsForOrder carries favourite flags from the old prefs', () => {
        const order = [tab('list', 1), tab('channel', 10)];
        const old = [pref('channel', 10, true)];
        expect(buildPrefsForOrder(order, old)).toEqual([
            { kind: 'list', ref_id: 1, is_favorite: false },
            { kind: 'channel', ref_id: 10, is_favorite: true },
        ]);
    });

    it('buildPrefsForOrder preserves prefs for tabs not currently visible', () => {
        // Channel queries still loading (or failed): the visible set is a
        // SUBSET of the saved one. A drag/favourite PUT built from it must
        // not delete the unseen tabs' saved order + favourites.
        const visible = [tab('list', 1)];
        const old = [pref('channel', 10, true), pref('channel', 11), pref('list', 1)];
        expect(buildPrefsForOrder(visible, old)).toEqual([
            { kind: 'list', ref_id: 1, is_favorite: false },
            { kind: 'channel', ref_id: 10, is_favorite: true },
            { kind: 'channel', ref_id: 11, is_favorite: false },
        ]);
    });

    it('favouriting while some tabs are unloaded keeps their prefs too', () => {
        const visible = [tab('list', 1), tab('list', 2)];
        const old = [pref('channel', 10, true)];
        const next = toggleFavoritePrefs(visible, old, tab('list', 2));
        expect(next.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['list:2', 'list:1', 'channel:10']);
        expect(isFavoriteTab(next, tab('channel', 10))).toBe(true);
    });

    it('favouriting pulls the tab to the front and sets the flag', () => {
        const order = [tab('list', 1), tab('list', 2), tab('channel', 10)];
        const next = toggleFavoritePrefs(order, [], tab('channel', 10));
        expect(next.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['channel:10', 'list:1', 'list:2']);
        expect(next[0].is_favorite).toBe(true);
        expect(isFavoriteTab(next, tab('channel', 10))).toBe(true);
    });

    it('unfavouriting clears the flag but keeps the position', () => {
        const order = [tab('channel', 10), tab('list', 1)];
        const favd = [pref('channel', 10, true), pref('list', 1)];
        const next = toggleFavoritePrefs(order, favd, tab('channel', 10));
        expect(next.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['channel:10', 'list:1']);
        expect(next[0].is_favorite).toBe(false);
    });
});

describe('due-time helpers', () => {
    it('datetime-local round-trips through ISO', () => {
        const iso = localInputToIso('2026-08-15T14:30');
        expect(iso).not.toBeNull();
        expect(dueToLocalInput(iso)).toBe('2026-08-15T14:30');
    });

    it('empty and invalid input mean "no due time"', () => {
        expect(localInputToIso('')).toBeNull();
        expect(localInputToIso('nonsense')).toBeNull();
        expect(dueToLocalInput(null)).toBe('');
    });

    it('overdue only when open and past due', () => {
        const now = Date.parse('2026-08-13T12:00:00Z');
        expect(isTaskOverdue({ due_at: '2026-08-13T11:00:00Z', is_completed: false }, now)).toBe(true);
        expect(isTaskOverdue({ due_at: '2026-08-13T13:00:00Z', is_completed: false }, now)).toBe(false);
        expect(isTaskOverdue({ due_at: '2026-08-13T11:00:00Z', is_completed: true }, now)).toBe(false);
        expect(isTaskOverdue({ due_at: null, is_completed: false }, now)).toBe(false);
    });

    it('chip label shows time-only for same-day deadlines', () => {
        // Build both stamps in LOCAL time so the test passes in any zone.
        const base = new Date(2026, 7, 13, 9, 0);
        const sameDay = new Date(2026, 7, 13, 14, 30);
        const label = formatDueShort(sameDay.toISOString(), base.getTime());
        expect(label).toBe('14:30');
        const otherDay = new Date(2026, 7, 20, 14, 30);
        expect(formatDueShort(otherDay.toISOString(), base.getTime())).toContain('14:30');
        expect(formatDueShort(otherDay.toISOString(), base.getTime())).not.toBe('14:30');
    });
});

describe('planReminders (client-side due scheduler)', () => {
    const rem = (id: number, due_at: string) => ({ id, channel_id: null, list_id: 1, due_at });
    const now = Date.parse('2026-08-13T12:00:00Z');

    it('fires a newly-overdue reminder exactly once', () => {
        const plan: ReminderPlan = planReminders([rem(1, '2026-08-13T11:00:00Z')], {}, now);
        expect(plan.toFire.map(r => r.id)).toEqual([1]);
        // A second pass against the returned marker map stays quiet.
        const again = planReminders([rem(1, '2026-08-13T11:00:00Z')], plan.prunedFired, now);
        expect(again.toFire).toEqual([]);
    });

    it('re-fires when the due time was edited to a new deadline', () => {
        const fired = { '1': '2026-08-13T09:00:00Z' };
        const plan = planReminders([rem(1, '2026-08-13T11:00:00Z')], fired, now);
        expect(plan.toFire.map(r => r.id)).toEqual([1]);
    });

    it('future reminders schedule instead of firing; earliest wins', () => {
        const plan = planReminders(
            [rem(1, '2026-08-13T15:00:00Z'), rem(2, '2026-08-13T13:00:00Z')], {}, now);
        expect(plan.toFire).toEqual([]);
        expect(plan.nextDueAt).toBe(Date.parse('2026-08-13T13:00:00Z'));
    });

    it('prunes fired markers for tasks gone from the feed (completed/deleted)', () => {
        const fired = { '9': '2026-08-01T00:00:00Z', '1': '2026-08-13T11:00:00Z' };
        const plan = planReminders([rem(1, '2026-08-13T11:00:00Z')], fired, now);
        expect(plan.prunedFired).toEqual({ '1': '2026-08-13T11:00:00Z' });
        expect(plan.toFire).toEqual([]);
    });
});

describe('applyToggle (Keep-style cascade)', () => {
    const parent = task(1);
    const childA = task(2, { parent_id: 1 });
    const childB = task(3, { parent_id: 1 });
    const other = task(4);

    it('completing a parent completes its subtasks', () => {
        const next = applyToggle([parent, childA, childB, other], parent, true);
        expect(next.find(t => t.id === 1)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 2)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 3)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 4)!.is_completed).toBe(false);
    });

    it('re-activating a parent leaves subtasks checked', () => {
        const done = [parent, childA, childB].map(t => ({ ...t, is_completed: true }));
        const next = applyToggle(done, done[0], false);
        expect(next.find(t => t.id === 1)!.is_completed).toBe(false);
        expect(next.find(t => t.id === 2)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 3)!.is_completed).toBe(true);
    });

    it('completing a subtask does not touch the parent or siblings', () => {
        const next = applyToggle([parent, childA, childB], childA, true);
        expect(next.find(t => t.id === 1)!.is_completed).toBe(false);
        expect(next.find(t => t.id === 2)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 3)!.is_completed).toBe(false);
    });

    it('re-activating a subtask re-activates its parent', () => {
        const done = [parent, childA, childB].map(t => ({ ...t, is_completed: true }));
        const next = applyToggle(done, done[1], false);
        expect(next.find(t => t.id === 1)!.is_completed).toBe(false);
        expect(next.find(t => t.id === 2)!.is_completed).toBe(false);
        expect(next.find(t => t.id === 3)!.is_completed).toBe(true);
    });

    it('completing a task sweeps the whole subtree, not just direct children', () => {
        const deep = [task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 2 }), task(4)];
        const next = applyToggle(deep, deep[0], true);
        expect(next.find(t => t.id === 2)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 3)!.is_completed).toBe(true);
        expect(next.find(t => t.id === 4)!.is_completed).toBe(false);
    });

    it('re-activating a deep subtask re-activates every ancestor', () => {
        const deep = [task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 2 })]
            .map(t => ({ ...t, is_completed: true }));
        const next = applyToggle(deep, deep[2], false);
        expect(next.find(t => t.id === 1)!.is_completed).toBe(false);
        expect(next.find(t => t.id === 2)!.is_completed).toBe(false);
        expect(next.find(t => t.id === 3)!.is_completed).toBe(false);
    });
});

describe('collectSubtreeIds', () => {
    it('collects the task and every descendant', () => {
        const tasks = [
            task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 2 }),
            task(4, { parent_id: 1 }), task(5),
        ];
        expect([...collectSubtreeIds(tasks, 1)].sort()).toEqual([1, 2, 3, 4]);
        expect([...collectSubtreeIds(tasks, 2)].sort()).toEqual([2, 3]);
        expect([...collectSubtreeIds(tasks, 5)]).toEqual([5]);
    });
});

describe('task attachment sidecar (parse/serialize)', () => {
    const ref = (n: number): TaskAttachmentRef => ({
        href: `sovereign-enc:file${n}?k=AAAA&m=image%2Fpng`,
        name: `photo${n}.png`,
    });

    it('round-trips refs through serialize + parse', () => {
        const refs = [ref(1), ref(2), ref(3)];
        expect(parseTaskAttachments(serializeTaskAttachments(refs))).toEqual(refs);
    });

    it('serializes an empty list to an empty JSON array', () => {
        expect(serializeTaskAttachments([])).toBe('[]');
        expect(parseTaskAttachments('[]')).toEqual([]);
    });

    it('enforces the per-task cap on serialize', () => {
        const atCap = Array.from({ length: MAX_TASK_ATTACHMENTS }, (_, i) => ref(i));
        expect(() => serializeTaskAttachments(atCap)).not.toThrow();
        expect(() => serializeTaskAttachments([...atCap, ref(99)])).toThrow();
    });

    it('caps oversized stored arrays on parse', () => {
        const over = JSON.stringify(Array.from({ length: MAX_TASK_ATTACHMENTS + 3 }, (_, i) => ref(i)));
        expect(parseTaskAttachments(over)).toHaveLength(MAX_TASK_ATTACHMENTS);
    });

    it('degrades malformed input to an empty array', () => {
        expect(parseTaskAttachments(null)).toEqual([]);
        expect(parseTaskAttachments('')).toEqual([]);
        expect(parseTaskAttachments('not json {')).toEqual([]);
        expect(parseTaskAttachments('"a string"')).toEqual([]);
        expect(parseTaskAttachments('{"href":"x","name":"y"}')).toEqual([]); // object, not array
    });

    it('drops entries without string href/name, keeps the valid ones', () => {
        const mixed = JSON.stringify([ref(1), { href: 42, name: 'bad' }, { name: 'no href' }, null, ref(2)]);
        expect(parseTaskAttachments(mixed)).toEqual([ref(1), ref(2)]);
    });

    it('strips unknown extra fields on parse (stored shape stays canonical)', () => {
        const noisy = JSON.stringify([{ ...ref(1), evil: '<script>' }]);
        expect(parseTaskAttachments(noisy)).toEqual([ref(1)]);
    });
});

describe('canEditTask (creator or MANAGE_TASKS)', () => {
    const theirs = task(1, { created_by: 7 });

    it('allows everything when perms are absent (personal lists / old backend)', () => {
        expect(canEditTask(theirs, 99, undefined)).toBe(true);
        expect(canEditTask(theirs, undefined, null)).toBe(true);
    });

    it('allows the creator even without MANAGE_TASKS', () => {
        expect(canEditTask(theirs, 7, PERM.VIEW_CHANNEL | PERM.CREATE_TASKS)).toBe(true);
        expect(canEditTask(theirs, 7, 0)).toBe(true);
    });

    it('denies non-creators without MANAGE_TASKS', () => {
        expect(canEditTask(theirs, 8, PERM.VIEW_CHANNEL | PERM.CREATE_TASKS | PERM.COMPLETE_TASKS)).toBe(false);
        expect(canEditTask(theirs, 8, 0)).toBe(false);
    });

    it('allows non-creators with MANAGE_TASKS', () => {
        expect(canEditTask(theirs, 8, PERM.MANAGE_TASKS)).toBe(true);
    });

    it('ADMINISTRATOR implies MANAGE_TASKS', () => {
        expect(canEditTask(theirs, 8, PERM.ADMINISTRATOR)).toBe(true);
    });

    it('an undefined caller id can never match created_by', () => {
        expect(canEditTask(theirs, undefined, PERM.CREATE_TASKS)).toBe(false);
    });
});

describe('encrypt-to-self (personal lists)', () => {
    const SALT = 'aa'.repeat(16);
    // One ~380ms PBKDF2 per test otherwise; these tests are about the envelope,
    // not the KDF.
    const ME = ['my-password', SALT] as const;
    const THEM = ['other-password', 'bb'.repeat(16)] as const;

    beforeAll(() => warmIdentities([ME, THEM]), WARM_TIMEOUT_MS);

    it('round-trips through the serialized envelope', async () => {
        const me = await testIdentity(...ME);
        const env = await encryptSelf(me, 'Buy oat milk 🥛');
        const stored = serializeEnvelope(env);

        expect(isEncrypted(stored)).toBe(true);
        expect(stored).not.toContain('oat milk');

        const parsed = parseEnvelope(stored)!;
        expect(parsed.t).toBe('self');
        expect(await decryptSelf(me, parsed)).toBe('Buy oat milk 🥛');
    });

    it('cannot be decrypted by a different identity', async () => {
        const me = await testIdentity(...ME);
        const them = await testIdentity(...THEM);
        const env = await encryptSelf(me, 'secret plans');
        expect(await decryptSelf(them, env)).toBeNull();
    });

    it('rejects tampered ciphertext (AES-GCM auth)', async () => {
        const me = await testIdentity(...ME);
        const env = await encryptSelf(me, 'integrity matters');
        const corrupted = { ...env, ct: env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
        expect(await decryptSelf(me, corrupted)).toBeNull();
    });

    it('produces unique ciphertexts for identical plaintext (fresh nonces)', async () => {
        const me = await testIdentity(...ME);
        const a = await encryptSelf(me, 'same text');
        const b = await encryptSelf(me, 'same text');
        expect(a.ct).not.toBe(b.ct);
    });
});

describe('planDropTarget — the indent gesture becomes a plan, or degrades to the plain drop', () => {
    // Fixture: A(1), B(2) top level; C(3) under A. `order` is the drag
    // hook's same-group visual order WITHOUT the moved task.
    const fixture = () => [task(1), task(2), task(3, { parent_id: 1 })];

    it('indent 0 is exactly the old plain plan', () => {
        expect(planDropTarget(fixture(), task(2), [1], 1, 0))
            .toEqual({ afterId: 1 });
        expect(planDropTarget(fixture(), task(2), [1], 0, 0))
            .toEqual({ afterId: null });
    });

    it('a SAME-SLOT drop whose indent degrades plans NOTHING — not a renumbering no-op', () => {
        // Review W4-F3/8: the same-slot commit exists only for a live indent;
        // when the indent degrades, the plain plan would renumber the whole
        // group and broadcast a change nobody made.
        expect(planDropTarget(fixture(), task(2), [1], 0, 1, true)).toBeNull();
        // POSITIVE CONTROL: the same drop with a WORKING indent still plans.
        expect(planDropTarget(fixture(), task(2), [1], 1, 1, true))
            .toEqual({ afterId: 3, reparent: { parentId: 1 } });
        // And a same-slot un-nest (the solo-child case) still plans too.
        expect(planDropTarget(fixture(), task(3, { parent_id: 1 }), [], 0, -1, true))
            .toEqual({ afterId: 1, reparent: { parentId: null } });
    });

    it('indent +1 nests under the row above, landing after its last active child', () => {
        // B dropped after A with an indent: nest under A, after C.
        expect(planDropTarget(fixture(), task(2), [1], 1, 1))
            .toEqual({ afterId: 3, reparent: { parentId: 1 } });
        // A childless target: first in the new group.
        expect(planDropTarget([task(1), task(2)], task(2), [1], 1, 1))
            .toEqual({ afterId: null, reparent: { parentId: 1 } });
        // A COMPLETED child of the target is not in the moving task's group
        // and must not be named as afterId (the server would 400).
        const withDone = [task(1), task(2), task(3, { parent_id: 1, is_completed: true })];
        expect(planDropTarget(withDone, task(2), [1], 1, 1))
            .toEqual({ afterId: null, reparent: { parentId: 1 } });
    });

    it('indent -1 un-nests to the grandparent, landing after the old parent', () => {
        // C (under A) dragged left: to top level, right after A.
        expect(planDropTarget(fixture(), task(3, { parent_id: 1 }), [], 0, -1))
            .toEqual({ afterId: 1, reparent: { parentId: null } });
        // Two levels: D under C under A → un-nest lands under A, after C.
        const deep = [task(1), task(3, { parent_id: 1 }), task(4, { parent_id: 3 })];
        expect(planDropTarget(deep, task(4, { parent_id: 3 }), [], 0, -1))
            .toEqual({ afterId: 3, reparent: { parentId: 1 } });
        // A COMPLETED old parent is not in the group: land first instead.
        const doneParent = [task(1, { is_completed: true }), task(3, { parent_id: 1 })];
        expect(planDropTarget(doneParent, task(3, { parent_id: 1 }), [], 0, -1))
            .toEqual({ afterId: null, reparent: { parentId: null } });
    });

    it('every impossible indent DEGRADES to the plain plan — never a dead drop', () => {
        // Nest at the top slot: nothing above.
        expect(planDropTarget(fixture(), task(2), [1], 0, 1))
            .toEqual({ afterId: null });
        // Nest under the task's CURRENT parent: means nothing. DEFENSIVE
        // ONLY — the drag path cannot produce this input (order holds
        // same-parent siblings, never the parent itself); the guard exists
        // for other callers and drifted data.
        const sibs = [task(1), task(3, { parent_id: 1 }), task(5, { parent_id: 1 })];
        expect(planDropTarget(sibs, task(5, { parent_id: 1 }), [1], 1, 1))
            .toEqual({ afterId: 1 });
        // Cycle: nesting A under its own subtask's slot.
        const cyc = [task(1), task(3, { parent_id: 1 })];
        expect(planDropTarget(cyc, task(1), [3], 1, 1))
            .toEqual({ afterId: 3 });
        // Depth: a 2-high subtree onto a depth-4 parent busts MAX_TASK_DEPTH.
        const chain = [
            task(1), task(2, { parent_id: 1 }), task(3, { parent_id: 2 }),
            task(4, { parent_id: 3 }), task(10), task(11, { parent_id: 10 }),
        ];
        // POSITIVE CONTROL first: the same subtree onto depth 3 is legal
        // (3+2=5), landing after 3's existing child 4.
        expect(planDropTarget(chain, task(10), [3], 1, 1))
            .toEqual({ afterId: 4, reparent: { parentId: 3 } });
        expect(planDropTarget(chain, task(10), [4], 1, 1))
            .toEqual({ afterId: 4 }); // depth-4 target: 4+2=6 > 5 → plain
        // Un-nest at top level: nowhere to go.
        expect(planDropTarget(fixture(), task(2), [1], 1, -1))
            .toEqual({ afterId: 1 });
    });
});

describe('applyReorder with a reparent — mirrors the server: parent moves, NEW group renumbers', () => {
    it('moves the task into the new group at the right slot with a fresh scope-max position', () => {
        const tasks = [task(1), task(2), task(3, { parent_id: 1 })];
        const next = applyReorder(tasks, task(2), 3, { parentId: 1 });
        const moved = next.find(t => t.id === 2)!;
        expect(moved.parent_id).toBe(1);
        // C(3) then B(2) under A, renumbered above the old max (3).
        const c = next.find(t => t.id === 3)!;
        expect(c.position).toBeLessThan(moved.position);
        expect(moved.position).toBeGreaterThan(3);
    });

    it('un-nest to top level after the old parent', () => {
        const tasks = [task(1), task(2), task(3, { parent_id: 1 })];
        const next = applyReorder(tasks, task(3, { parent_id: 1 }), 1, { parentId: null });
        const moved = next.find(t => t.id === 3)!;
        expect(moved.parent_id).toBeNull();
        const a = next.find(t => t.id === 1)!;
        const b = next.find(t => t.id === 2)!;
        expect(a.position).toBeLessThan(moved.position);
        expect(moved.position).toBeLessThan(b.position);
    });

    it('a stale afterId against the NEW group returns the input unchanged (the server would 400)', () => {
        const tasks = [task(1), task(2), task(3, { parent_id: 1 })];
        // 2 is not a child of 1 — not in the new group.
        expect(applyReorder(tasks, task(3, { parent_id: 1 }), 2, { parentId: 1 })).toBe(tasks);
    });

    it('POSITIVE CONTROL: without reparent the old behaviour is untouched', () => {
        const tasks = [task(1), task(2), task(3)];
        const next = applyReorder(tasks, task(1), 3);
        expect(next.find(t => t.id === 1)!.parent_id).toBeNull();
        const order = next.filter(t => t.parent_id === null).sort((a, b) => a.position - b.position).map(t => t.id);
        expect(order).toEqual([2, 3, 1]);
    });
});
