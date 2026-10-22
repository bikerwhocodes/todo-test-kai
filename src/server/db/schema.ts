import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Better Auth tables. Export names (`user`, `session`, ...) are the model keys the
// Better Auth Drizzle adapter looks up; property names are the fields it reads/writes.

export const user = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    // scrypt hash written by Better Auth; never the plain password.
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// Shared across app instances so the auth rate limit holds when scaled out.
export const rateLimit = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    // IANA zone, e.g. "Europe/London". All "today" calculations use it.
    timeZone: text("time_zone").notNull(),
    defaultEstimateMin: integer("default_estimate_min").notNull().default(30),
    lastAvailableMin: integer("last_available_min"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("user_settings_default_estimate_min_positive", sql`${t.defaultEstimateMin} > 0`),
    check("user_settings_last_available_min_nonnegative", sql`${t.lastAvailableMin} >= 0`),
  ],
);

export type UserSettings = typeof userSettings.$inferSelect;

// Every app table carries user_id. Child rows reference their parent through a
// composite (user_id, id) foreign key, so the database itself refuses a task that
// points at another user's project or a subtask under another user's task.

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("projects_user_id_id_unique").on(t.userId, t.id),
    index("projects_user_id_idx").on(t.userId),
    check("projects_name_not_blank", sql`length(btrim(${t.name})) between 1 and 100`),
  ],
);

export const RECURRENCE_KINDS = ["daily", "weekly"] as const;
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

/**
 * The template and rule of a recurring task (spec §7). Its occurrences are rows in
 * `tasks` with series_id + occurrence_date; at most one of them is open at a time.
 * Editing the series rewrites the template and the open occurrence, never closed ones.
 */
export const recurringSeries = pgTable(
  "recurring_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Template copied onto each new occurrence.
    projectId: uuid("project_id"),
    title: text("title").notNull(),
    description: text("description"),
    priority: smallint("priority").notNull().default(4),
    estimateMin: integer("estimate_min"),
    // Rule; see core/recurrence. Dates are floating, in the user's zone.
    kind: text("kind", { enum: RECURRENCE_KINDS }).notNull(),
    interval: integer("interval").notNull().default(1),
    // 0 = Sunday … 6 = Saturday; null for daily rules.
    weekdays: smallint("weekdays").array(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recurring_series_user_id_id_unique").on(t.userId, t.id),
    foreignKey({
      name: "recurring_series_user_project_fk",
      columns: [t.userId, t.projectId],
      foreignColumns: [projects.userId, projects.id],
    }),
    index("recurring_series_user_id_idx").on(t.userId),
    check("recurring_series_title_not_blank", sql`length(btrim(${t.title})) between 1 and 500`),
    check("recurring_series_priority_range", sql`${t.priority} between 1 and 4`),
    check("recurring_series_estimate_min_range", sql`${t.estimateMin} between 1 and 1440`),
    check("recurring_series_kind_valid", sql`${t.kind} in ('daily', 'weekly')`),
    check("recurring_series_interval_range", sql`${t.interval} between 1 and 365`),
    check(
      "recurring_series_weekdays_match_kind",
      sql`case when ${t.kind} = 'weekly'
        then cardinality(${t.weekdays}) between 1 and 7 and ${t.weekdays} <@ array[0,1,2,3,4,5,6]::smallint[]
        else ${t.weekdays} is null end`,
    ),
    check("recurring_series_end_after_start", sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
  ],
);

export type RecurringSeries = typeof recurringSeries.$inferSelect;

export const TASK_STATUSES = ["open", "done", "skipped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // null = Inbox.
    projectId: uuid("project_id"),
    title: text("title").notNull(),
    description: text("description"),
    // 1 = highest, 4 = none.
    priority: smallint("priority").notNull().default(4),
    // Floating calendar date in the user's zone; planning never writes to it.
    deadline: date("deadline", { mode: "string" }),
    estimateMin: integer("estimate_min"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Set together for an occurrence of a recurring series; null for one-off tasks.
    seriesId: uuid("series_id"),
    occurrenceDate: date("occurrence_date", { mode: "string" }),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tasks_user_id_id_unique").on(t.userId, t.id),
    foreignKey({
      name: "tasks_user_project_fk",
      columns: [t.userId, t.projectId],
      foreignColumns: [projects.userId, projects.id],
    }),
    foreignKey({
      name: "tasks_user_series_fk",
      columns: [t.userId, t.seriesId],
      foreignColumns: [recurringSeries.userId, recurringSeries.id],
    }).onDelete("cascade"),
    // One row per series date, and at most one open occurrence per series.
    unique("tasks_series_occurrence_unique").on(t.seriesId, t.occurrenceDate),
    uniqueIndex("tasks_one_open_per_series")
      .on(t.seriesId)
      .where(sql`${t.status} = 'open' and ${t.seriesId} is not null`),
    check("tasks_series_has_occurrence_date", sql`(${t.seriesId} is null) = (${t.occurrenceDate} is null)`),
    index("tasks_user_id_project_id_idx").on(t.userId, t.projectId),
    check("tasks_title_not_blank", sql`length(btrim(${t.title})) between 1 and 500`),
    check("tasks_priority_range", sql`${t.priority} between 1 and 4`),
    check("tasks_estimate_min_range", sql`${t.estimateMin} between 1 and 1440`),
    check("tasks_status_valid", sql`${t.status} in ('open', 'done', 'skipped')`),
    // completed_at is set exactly when the task is done; reopening must clear it.
    check("tasks_completed_at_matches_status", sql`(${t.status} = 'done') = (${t.completedAt} is not null)`),
  ],
);

export const subtasks = pgTable(
  "subtasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "subtasks_user_task_fk",
      columns: [t.userId, t.taskId],
      foreignColumns: [tasks.userId, tasks.id],
    }).onDelete("cascade"),
    index("subtasks_user_id_task_id_idx").on(t.userId, t.taskId),
    check("subtasks_title_not_blank", sql`length(btrim(${t.title})) between 1 and 500`),
  ],
);

// "task_id is blocked by blocked_by_task_id". Both ends go through composite
// (user_id, id) foreign keys, so an edge can only join two tasks of the same user,
// and deleting either task deletes the edge. Whether a task is blocked is derived
// from its blockers' status when read (see core/graph blockedSet), never stored.
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    blockedByTaskId: uuid("blocked_by_task_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.blockedByTaskId] }),
    foreignKey({
      name: "task_dependencies_user_task_fk",
      columns: [t.userId, t.taskId],
      foreignColumns: [tasks.userId, tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_dependencies_user_blocked_by_fk",
      columns: [t.userId, t.blockedByTaskId],
      foreignColumns: [tasks.userId, tasks.id],
    }).onDelete("cascade"),
    // The cycle check loads all of a user's edges; deletes cascade from the blocker side.
    index("task_dependencies_user_id_idx").on(t.userId),
    index("task_dependencies_blocked_by_task_id_idx").on(t.blockedByTaskId),
    check("task_dependencies_not_self", sql`${t.taskId} <> ${t.blockedByTaskId}`),
  ],
);

export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Subtask = typeof subtasks.$inferSelect;
export type TaskDependency = typeof taskDependencies.$inferSelect;
