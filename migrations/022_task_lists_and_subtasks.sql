-- Personal task lists (Google Keep style) + subtask support for all checklists.

-- Named, user-owned lists for the personal Tasks view.
CREATE TABLE task_lists (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_task_lists_owner_id ON task_lists(owner_id);

-- Generalize channel_tasks: a task now belongs to EITHER a channel checklist
-- OR a personal list, and may nest one level under a parent task.
ALTER TABLE channel_tasks ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE channel_tasks ADD COLUMN list_id BIGINT REFERENCES task_lists(id) ON DELETE CASCADE;
ALTER TABLE channel_tasks ADD COLUMN parent_id BIGINT REFERENCES channel_tasks(id) ON DELETE CASCADE;
ALTER TABLE channel_tasks ADD CONSTRAINT chk_task_scope
    CHECK ((channel_id IS NOT NULL) != (list_id IS NOT NULL));

CREATE INDEX idx_channel_tasks_list_id ON channel_tasks(list_id) WHERE list_id IS NOT NULL;
CREATE INDEX idx_channel_tasks_parent_id ON channel_tasks(parent_id) WHERE parent_id IS NOT NULL;
