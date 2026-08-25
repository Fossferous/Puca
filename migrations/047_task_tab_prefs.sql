-- Per-user Tasks-view tab preferences: one row per tab (a personal list or a
-- channel checklist) holding its bar position and favourite flag. The Tasks
-- dashboard shows both kinds in ONE draggable bar, so the order lives in one
-- table keyed by (kind, ref_id) rather than as columns on task_lists (which
-- could never order channel tabs). Rows are pure UI state scoped to their
-- owner: a stale ref_id (deleted list, left server) is simply ignored at
-- merge time client-side.
CREATE TABLE task_tab_prefs (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('list', 'channel')),
    ref_id BIGINT NOT NULL,
    position BIGINT NOT NULL,
    is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, kind, ref_id)
);
