# migrations/ — read this before you touch anything in here

Migrations run **automatically at startup** (`sqlx::migrate!`, `src/main.rs`), and
sqlx checksums each file's **bytes** and compares them against the
`_sqlx_migrations` table. So:

**An applied migration is frozen. Editing one — including its comments, including
its line endings — changes its sha384 and crash-loops the backend on
`VersionMismatch` at boot.** `.gitattributes` carries `migrations/*.sql -text` for
exactly this reason: git stores and checks these files out verbatim so a fresh
clone on any platform reproduces the bytes production recorded. That is also why
some of these files still say "Sovereign": a rebrand pass rewrote comments in
four applied migrations and a trigger-function name in a fifth, which blocks
startup just as surely as a line ending does. To change one you rewrite
production's `_sqlx_migrations` rows in the same controlled step, which is a data
migration, not a rename.

A **new** migration must be:

- **numbered above every existing one**, and
- **idempotent** — `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP NOT NULL`
  (a no-op on an already-nullable column), an `OR` of a bit that may already be
  set. A migration that fails aborts boot.

`CREATE INDEX CONCURRENTLY` is **not** available inside the automatic migration
transaction. A plain `CREATE INDEX` briefly locks writes on that table.

Take a database dump before shipping any of them.

This file is not a migration and sqlx ignores it: the resolver skips any name
that does not parse as `<version>_<description>.sql`.

---

## Known landmines in already-applied migrations

Both are **dormant**, both are **unfixable in place** (see the freezing rule
above), and both will look like bugs to the next person who reads the file. They
are recorded here instead.

### 009's `server_emojis` definition is dead text — the live shape comes from 004

`009_reactions_emojis.sql` declares

```sql
file_id TEXT NOT NULL REFERENCES uploaded_files(id)
```

which is wrong twice over: `uploaded_files` is not created until
`010_uploaded_files.sql` (a forward reference), and its `id` is `UUID`, not
`TEXT`, so the foreign key is type-incompatible as well.

It has never fired because `server_emojis` is **already created by
`004_add_missing_tables.sql`**, without that column constraint — so 009's
`CREATE TABLE IF NOT EXISTS` is a no-op and Postgres never evaluates its body.

**The consequence to remember: the live schema for `server_emojis` is 004's, not
the one 009 appears to document.** Never drop `server_emojis` expecting 009 to
recreate it correctly — it would be recreated from 004 on a fresh install and not
at all on an existing one. If the stricter shape is ever wanted, add a NEW
migration that does the `ALTER` properly against the actual `UUID` column,
idempotently.

### 008 lowercases every username unconditionally

`008_case_insensitive_login.sql` runs

```sql
UPDATE users SET username = LOWER(username);
```

with no guard. Against a database that contains both `alice` and `Alice` this
violates `001_init.sql`'s case-sensitive `UNIQUE` on `users.username`, the
migration fails, and — because migrations run at boot — the backend crash-loops.

`053_username_case_unique.sql` handles the same hazard properly: it detects
duplicates and `RAISE WARNING`s instead of failing. 008 predates that discipline.

**This cannot bite an existing deployment**, because 008 is already recorded in
its `_sqlx_migrations` and will never re-run. It can only bite where 008 runs
against pre-existing data — i.e. a dump restored into a database whose
`_sqlx_migrations` did *not* come with it, so every migration replays over
restored rows. `deploy/ops/restore-drill.sh` asserts both halves of that: that
the restored dump brought its `_sqlx_migrations` with it, and that no two
usernames collide case-insensitively.

Fresh installs are proven fine — `.github/workflows/tests.yml` boots the server
against a clean `postgres:16` on every push.
