// Where a clicked due-item notification lands. The Tasks view is usually not
// mounted when the request is made — opening Tasks is what mounts it — so the
// tab is handed over in a one-slot module rather than an event that would be
// dispatched into an empty room. It must be a ONE-shot: a second open of Tasks
// belongs on the board, not back on Reminders.
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeTasksTab, requestTasksTab } from '../api/tasksViewIntent';

beforeEach(() => { consumeTasksTab(); });

describe('the Tasks view tab handover', () => {
    it('hands over the requested tab exactly once', () => {
        requestTasksTab('reminders');
        expect(consumeTasksTab()).toBe('reminders');
        expect(consumeTasksTab()).toBeNull();
    });

    it('is null when nobody asked — Tasks opens on its board', () => {
        expect(consumeTasksTab()).toBeNull();
    });
});
