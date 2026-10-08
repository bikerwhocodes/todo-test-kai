-- 001_schema.sql — NextUp core data model.
--
-- Design rules enforced here (PRD 1.0.0 §4.1):
--   * Calendar dates are `date`. Audit instants are `timestamptz`. A calendar
--     date is NEVER a local-midnight timestamptz: verified to shift by a day
--     across a timezone change.
--   * Every user-scoped row carries user_id NOT NULL.
--   * Owner safety is STRUCTURAL, not advisory: child rows reference a parent
--     by (parent_id, user_id) against a UNIQUE (id, user_id) key, so a row
--     belonging to another user cannot be referenced at all. The extra
--     UNIQUE (id, user_id) key per table is the deliberate cost of this.
--   * Plan membership exists ONLY in day_plan_items. `tasks` has no plan_date
--     and no planned_for_today column, so no plan operation can touch a
--     deadline.

-- ---------------------------------------------------------------------------
-- Identity. Field names and shapes match Better Auth's core models (user,
-- session, account, verification) under plural table naming, so that NEXT-2
-- configures the library against this schema rather than rebuilding it.
-- Types are tightened past Better Auth's defaults to meet the PRD: uuid ids
-- (A4, never sequential) and timestamptz instants (P4, never naive).
-- NEXT-2 must set `advanced.database.generateId` to emit UUIDs.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  email          text        NOT NULL UNIQUE,
  email_verified boolean     NOT NULL DEFAULT false,
  image          text,
  -- IANA zone identifier, never a fixed UTC offset (P5). "Today" is derived
  -- server-side from this. Validated against the server tz database by trigger.
  timezone       text        NOT NULL DEFAULT 'UTC',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_timezone_not_an_offset
    CHECK (timezone !~ '^[+-]?[0-9]{1,2}(:[0-9]{2})?$' AND timezone !~* '^(utc|gmt)[+-]')
);

CREATE FUNCTION assert_known_timezone() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown IANA timezone: %', NEW.timezone
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER users_timezone_known
  BEFORE INSERT OR UPDATE OF timezone ON users
  FOR EACH ROW EXECUTE FUNCTION assert_known_timezone();

CREATE TABLE sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token      text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE accounts (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id               text        NOT NULL,
  provider_id              text        NOT NULL,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_provider_account_key UNIQUE (provider_id, account_id)
);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE verifications (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text        NOT NULL,
  value      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_id_user_key UNIQUE (id, user_id)
);
CREATE INDEX projects_user_id_idx ON projects (user_id);

-- ---------------------------------------------------------------------------
-- Recurrence rules
-- ---------------------------------------------------------------------------

CREATE TABLE recurrence_rules (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  freq           text        NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly')),
  interval_count integer     NOT NULL DEFAULT 1 CHECK (interval_count >= 1),
  -- ISO weekday numbers 1=Monday .. 7=Sunday, matching extract(isodow).
  byweekday      smallint[],
  until_date     date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurrence_rules_id_user_key UNIQUE (id, user_id),
  CONSTRAINT recurrence_rules_byweekday_valid
    CHECK (byweekday IS NULL
           OR (array_length(byweekday, 1) > 0
               AND byweekday <@ ARRAY[1,2,3,4,5,6,7]::smallint[]))
);
CREATE INDEX recurrence_rules_user_id_idx ON recurrence_rules (user_id);

-- ---------------------------------------------------------------------------
-- Tasks (including subtasks and materialized recurrence occurrences)
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id         uuid,
  parent_task_id     uuid,
  recurrence_rule_id uuid,
  occurrence_date    date,
  title              text        NOT NULL CHECK (length(btrim(title)) > 0),
  notes              text,
  priority           smallint    NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  estimate_minutes   integer     CHECK (estimate_minutes IS NULL OR estimate_minutes > 0),
  deadline           date,
  start_date         date,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tasks_id_user_key UNIQUE (id, user_id),

  -- Owner-safe references. MATCH SIMPLE means a NULL child column skips the
  -- check, which is what "no project" / "no parent" should mean; because
  -- user_id is NOT NULL, any non-null reference is fully checked against the
  -- owner's own rows.
  CONSTRAINT tasks_project_owner_fk FOREIGN KEY (project_id, user_id)
    REFERENCES projects (id, user_id) ON DELETE SET NULL (project_id),
  CONSTRAINT tasks_parent_owner_fk FOREIGN KEY (parent_task_id, user_id)
    REFERENCES tasks (id, user_id) ON DELETE CASCADE,
  CONSTRAINT tasks_recurrence_owner_fk FOREIGN KEY (recurrence_rule_id, user_id)
    REFERENCES recurrence_rules (id, user_id) ON DELETE SET NULL (recurrence_rule_id),

  CONSTRAINT tasks_not_own_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  -- The recurrence identifier pair is populated together or not at all (P7).
  CONSTRAINT recurrence_pair_complete
    CHECK ((recurrence_rule_id IS NULL) = (occurrence_date IS NULL)),
  CONSTRAINT tasks_start_before_deadline
    CHECK (start_date IS NULL OR deadline IS NULL OR start_date <= deadline)
);

CREATE INDEX tasks_user_id_idx ON tasks (user_id);
CREATE INDEX tasks_user_deadline_idx ON tasks (user_id, deadline) WHERE completed_at IS NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;

-- One materialized occurrence per (rule, date). A plain UNIQUE over these
-- nullable columns would permit unlimited duplicates, so the index is partial.
-- Callers using ON CONFLICT MUST restate this predicate — conflict inference
-- cannot see a partial index otherwise. See db/recurrence.ts.
CREATE UNIQUE INDEX tasks_unique_occurrence
  ON tasks (recurrence_rule_id, occurrence_date)
  WHERE recurrence_rule_id IS NOT NULL AND occurrence_date IS NOT NULL;

-- Deleting a rule must retain completed history and must never cascade to the
-- task rows. The FK's ON DELETE SET NULL cannot do this alone: a SET NULL
-- column list may only name foreign-key columns, so occurrence_date cannot be
-- included, and clearing recurrence_rule_id while occurrence_date remains set
-- violates recurrence_pair_complete and aborts the DELETE outright. Clearing
-- both columns together is what keeps both guarantees.
CREATE FUNCTION detach_recurrence_occurrences() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE tasks
     SET recurrence_rule_id = NULL,
         occurrence_date    = NULL,
         updated_at         = now()
   WHERE recurrence_rule_id = OLD.id
     AND user_id            = OLD.user_id;
  RETURN OLD;
END;
$fn$;

CREATE TRIGGER recurrence_rules_detach_before_delete
  BEFORE DELETE ON recurrence_rules
  FOR EACH ROW EXECUTE FUNCTION detach_recurrence_occurrences();

-- ---------------------------------------------------------------------------
-- Task dependencies
-- ---------------------------------------------------------------------------

CREATE TABLE task_dependencies (
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  task_id       uuid        NOT NULL,
  depends_on_id uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (task_id, depends_on_id),
  CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_id),
  CONSTRAINT task_dependencies_task_owner_fk FOREIGN KEY (task_id, user_id)
    REFERENCES tasks (id, user_id) ON DELETE CASCADE,
  CONSTRAINT task_dependencies_depends_on_owner_fk FOREIGN KEY (depends_on_id, user_id)
    REFERENCES tasks (id, user_id) ON DELETE CASCADE
);
CREATE INDEX task_dependencies_user_task_idx ON task_dependencies (user_id, task_id);
CREATE INDEX task_dependencies_depends_on_idx ON task_dependencies (user_id, depends_on_id);

-- ---------------------------------------------------------------------------
-- Day plans. Plan membership lives here and ONLY here (P9).
-- ---------------------------------------------------------------------------

CREATE TABLE day_plans (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_date         date        NOT NULL,
  status            text        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'accepted')),
  available_minutes integer     CHECK (available_minutes IS NULL OR available_minutes >= 0),
  accepted_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT day_plans_id_user_key UNIQUE (id, user_id),
  CONSTRAINT day_plans_accepted_at_pair
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);

-- At most one ACCEPTED plan per user per day; drafts stay unconstrained.
CREATE UNIQUE INDEX day_plans_one_accepted_per_day
  ON day_plans (user_id, plan_date)
  WHERE status = 'accepted';

CREATE TABLE day_plan_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day_plan_id     uuid        NOT NULL,
  task_id         uuid        NOT NULL,
  sort_order      integer     NOT NULL,
  planned_minutes integer     CHECK (planned_minutes IS NULL OR planned_minutes > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT day_plan_items_plan_owner_fk FOREIGN KEY (day_plan_id, user_id)
    REFERENCES day_plans (id, user_id) ON DELETE CASCADE,
  CONSTRAINT day_plan_items_task_owner_fk FOREIGN KEY (task_id, user_id)
    REFERENCES tasks (id, user_id) ON DELETE CASCADE,
  CONSTRAINT day_plan_items_unique_task UNIQUE (day_plan_id, task_id)
);
CREATE INDEX day_plan_items_plan_idx ON day_plan_items (day_plan_id);
