-- 005_maintain_updated_at.sql — make `updated_at` tell the truth.
--
-- THE DEFECT. Five tables declare `updated_at timestamptz NOT NULL DEFAULT
-- now()`, but nothing ever advanced it: there was no trigger, and no
-- application code set it. So `updated_at` was really "created_at under a
-- second name" — it changed only when a row was inserted, or in the one place
-- that happened to set it by hand (detach_recurrence_occurrences in 001).
--
-- Reproduced on PostgreSQL 17.11 before writing this:
--
--     INSERT INTO tasks ... RETURNING updated_at  -> 2026-10-08T15:46:08.159Z
--     UPDATE tasks SET notes='changed', title='edited'
--     SELECT updated_at                           -> 2026-10-08T15:46:08.159Z
--
-- WHY THIS IS WORSE THAN A WRONG TIMESTAMP. tests/plan-separation.test.ts
-- asserts, for release criterion R8 / AT-1-F(c):
--
--     "every task's deadline and updated_at is untouched by the entire plan
--      lifecycle"
--
-- The `updated_at` half of that assertion could not fail. A column that never
-- moves is trivially "untouched", so the test certified a guarantee it was not
-- actually checking. The same vacuity was waiting for NEXT-3 and NEXT-4, whose
-- test notes both say to assert `updated_at` is untouched while unblocking a
-- task. Fixing the column is what makes those assertions load-bearing.
--
-- WHY A TRIGGER RATHER THAN APPLICATION CODE. Setting `updated_at` in every
-- repository function is precisely the approach that produced this bug — one
-- call site forgetting is invisible until someone reads a timestamp and
-- believes it. A trigger cannot be forgotten by a new route, a later
-- migration, or a manual `psql` fix, and it keeps the guarantee in the same
-- place as the rest of the data model's integrity rules.
--
-- `WHEN (OLD.* IS DISTINCT FROM NEW.*)` is deliberate: `UPDATE tasks SET
-- title = title` changes nothing, so it must not register as a change.
-- `updated_at` then means "last actually changed", not "last written to".

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- now() is transaction start, matching detach_recurrence_occurrences in 001:
  -- every row changed by one transaction shares one timestamp.
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DO $$
DECLARE t text;
BEGIN
  -- Exactly the tables that declare updated_at. A table without the column
  -- would raise here rather than silently skip, which is the behaviour we
  -- want if this list and the schema ever disagree.
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'accounts', 'verifications', 'tasks'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW '
      'WHEN (OLD.* IS DISTINCT FROM NEW.*) '
      'EXECUTE FUNCTION touch_updated_at()', t || '_touch_updated_at', t);
  END LOOP;
END $$;

-- The runtime and auth roles need no privilege to fire a trigger: it runs as
-- part of their UPDATE, and the function is not called directly. No grant.
