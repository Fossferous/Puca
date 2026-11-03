/**
 * A push-to-talk on Space or Enter must not press what has the focus. hotkeys.ts
 * keeps the key from the browser (e2e/user-menu-move-to-real-browser.mjs reads
 * that in three engines), but it cannot stop a control whose own handler presses
 * it on the key: only that handler can, by asking e.defaultPrevented. Every one
 * is here, the real component with a real registered hold, and each case has its
 * control: with no hold bound the same key does press it.
 *
 * Not here: Notes' PlaceReminders (Android's Notes app, where nothing registers a
 * hold) and the fields whose Enter commits what is typed (that is typing).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({
    wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} },
}));

import { registerHold, resetHotkeysForTest } from '../api/hotkeys';
import { groupReminderSources } from '../api/reminderGroups';
import type { CalendarSource } from '../api/taskCalendar';
import type { Task } from '../api/tasks';
import { Calendar, type CalendarProps } from '../components/calendar/Calendar';
import { RemindersList } from '../components/reminders/RemindersList';
import { VideoPlayer } from '../components/VideoPlayer';
import { NoteCard } from '../notes/components/NoteCard';
import { buildNoteCards } from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import type { NoteActions } from '../notes/model/notesQueries';

const SPACE = 32;
const ENTER = 13;
const KEY_OF: Record<number, string> = { [SPACE]: ' ', [ENTER]: 'Enter' };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    resetHotkeysForTest();
});

function mount(ui: React.ReactNode): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(ui));
    return host;
}

function bindHold(keyCode: number) {
    const hold = { down: 0, up: 0 };
    registerHold('test.hold', () => ({ keyCode, ctrl: false, alt: false, shift: false, label: '' }), {
        onDown: () => { hold.down++; },
        onUp: () => { hold.up++; },
    });
    return hold;
}

/** The key's whole press, as a browser sends it to what has the focus. */
function pressKey(target: Element, keyCode: number) {
    for (const type of ['keydown', 'keyup'] as const) {
        const e = new KeyboardEvent(type, { key: KEY_OF[keyCode], bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { value: keyCode });
        act(() => { target.dispatchEvent(e); });
    }
}

const NOW = Date.parse('2030-10-07T08:00:00.000Z');
const task = (id: number): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `Item ${id}`, is_completed: false, position: id,
    created_at: '2030-09-01T00:00:00Z', created_by: 7, attachments: null, due_at: '2030-10-07T09:00:00.000Z',
});
const source = (id: number): CalendarSource => ({ task: task(id), noteKey: 'list:1', noteTitle: 'Errands', canEdit: true });

function mountCalendar(onNavigate = vi.fn()) {
    const props: CalendarProps = {
        sources: [source(1)], view: 'month', date: '2030-10-07', onNavigate, showCompleted: false, showPlain: true,
        onToggleCompleted: () => {}, onTogglePlain: () => {}, weekStart: 1, now: NOW, coarse: false,
        onOpen: () => {}, onMove: () => {}, onAdd: () => {}, onToggleDone: () => {},
    };
    const el = mount(<Calendar {...props} />);
    return { el, onNavigate };
}

/** Each control: how to mount it, and how to read whether it was pressed. */
const CASES: { name: string; keys: number[]; setup: () => { target: Element; pressed: () => boolean } }[] = [
    {
        name: 'a note card',
        keys: [SPACE, ENTER],
        setup: () => {
            const onOpen = vi.fn();
            const card = buildNoteCards([{ ref: { kind: 'list', id: 7 }, title: 'Song', noteAttachments: null }], new Map([['list:7', []]]), [], EMPTY_KEEP_PREFS)[0];
            const el = mount(
                <NoteCard
                    card={card} actions={{ togglePin: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions} now={NOW} compactTools={false}
                    onOpen={onOpen} onMenu={() => {}} onPickColor={() => {}} onPickLabels={() => {}}
                    onLabelClick={() => {}} onArchive={() => {}} registerEl={() => {}}
                />,
            );
            return { target: el.querySelector('[role="button"]')!, pressed: () => onOpen.mock.calls.length > 0 };
        },
    },
    {
        name: "a note card's label",
        keys: [ENTER],
        setup: () => {
            const onLabelClick = vi.fn();
            const card = { ...buildNoteCards([{ ref: { kind: 'list', id: 7 }, title: 'Song', noteAttachments: null }], new Map([['list:7', []]]), [], EMPTY_KEEP_PREFS)[0], labels: ['home'] };
            const el = mount(
                <NoteCard
                    card={card} actions={{ togglePin: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions} now={NOW} compactTools={false}
                    onOpen={() => {}} onMenu={() => {}} onPickColor={() => {}} onPickLabels={() => {}}
                    onLabelClick={onLabelClick} onArchive={() => {}} registerEl={() => {}}
                />,
            );
            return { target: el.querySelector('.notes-chip.clickable')!, pressed: () => onLabelClick.mock.calls.length > 0 };
        },
    },
    {
        name: 'a reminder row',
        keys: [ENTER],
        setup: () => {
            const onOpen = vi.fn();
            const el = mount(
                <RemindersList groups={groupReminderSources([source(1)], NOW)} now={NOW} currentUserId={7} onOpen={onOpen} onToggle={vi.fn()} empty={null} />,
            );
            return { target: el.querySelector('.notes-reminder-row')!, pressed: () => onOpen.mock.calls.length > 0 };
        },
    },
    {
        name: "a calendar's day",
        keys: [SPACE, ENTER],
        setup: () => {
            const { el, onNavigate } = mountCalendar();
            return { target: el.querySelector('[data-cal-day="2030-10-07"]')!, pressed: () => onNavigate.mock.calls.length > 0 };
        },
    },
    {
        name: "a calendar's entry",
        keys: [SPACE, ENTER],
        setup: () => {
            const { el } = mountCalendar();
            return { target: el.querySelector('[data-cal-entry]')!, pressed: () => document.querySelector('.cal-menu') !== null };
        },
    },
    {
        name: 'a video player',
        keys: [SPACE],
        setup: () => {
            const el = mount(<VideoPlayer src="blob:test-1" title="portrait.mp4" />);
            const play = vi.fn(() => Promise.resolve());
            el.querySelector('video')!.play = play;
            return { target: el.querySelector('.vpl')!, pressed: () => play.mock.calls.length > 0 };
        },
    },
];

describe.each(CASES)('$name', ({ keys, setup }) => {
    it.each(keys.map(k => [KEY_OF[k] === ' ' ? 'Space' : 'Enter', k] as const))('a hold on %s presses nothing, and still holds', (_name, keyCode) => {
        const hold = bindHold(keyCode);
        const { target, pressed } = setup();
        expect(target, 'the control is on the page').toBeTruthy();
        pressKey(target, keyCode);
        expect(pressed(), 'pressed by a hold').toBe(false);
        expect(hold).toEqual({ down: 1, up: 1 });
    });

    it.each(keys.map(k => [KEY_OF[k] === ' ' ? 'Space' : 'Enter', k] as const))('CONTROL: with no hold bound, %s does press it', (_name, keyCode) => {
        const { target, pressed } = setup();
        pressKey(target, keyCode);
        expect(pressed(), 'pressed with no hold').toBe(true);
    });
});
