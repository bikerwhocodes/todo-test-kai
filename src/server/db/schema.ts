import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Keep in sync with src/server/db/migrations/*.sql (migrations are hand-written SQL).

// Core user table in the shape Better Auth expects; M0 auth owns sessions/accounts.
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite FKs that pin child rows to the same user.
    unique("projects_user_id_id_key").on(t.userId, t.id),
    check("projects_name_not_blank", sql`length(btrim(${t.name})) > 0`),
  ],
);

export const TASK_STATUSES = ["open", "done", "skipped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    title: text("title").notNull(),
    description: text("description"),
    priority: smallint("priority").notNull().default(4),
    deadline: date("deadline"),
    estimateMin: integer("estimate_min"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    seriesId: uuid("series_id"),
    occurrenceDate: date("occurrence_date"),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tasks_user_id_id_key").on(t.userId, t.id),
    // A task can only point at a project owned by the same user.
    foreignKey({
      name: "tasks_user_project_fk",
      columns: [t.userId, t.projectId],
      foreignColumns: [projects.userId, projects.id],
    }),
    unique("tasks_series_occurrence_key").on(t.userId, t.seriesId, t.occurrenceDate),
    uniqueIndex("tasks_one_open_per_series")
      .on(t.userId, t.seriesId)
      .where(sql`${t.status} = 'open'`),
    index("tasks_user_project_idx").on(t.userId, t.projectId),
    check("tasks_title_not_blank", sql`length(btrim(${t.title})) > 0`),
    check("tasks_priority_range", sql`${t.priority} between 1 and 4`),
    check("tasks_estimate_positive", sql`${t.estimateMin} > 0`),
    check("tasks_status_valid", sql`${t.status} in ('open', 'done', 'skipped')`),
    check(
      "tasks_completed_at_matches_status",
      sql`(${t.status} = 'open') = (${t.completedAt} is null)`,
    ),
    check(
      "tasks_series_has_occurrence",
      sql`(${t.seriesId} is null) = (${t.occurrenceDate} is null)`,
    ),
  ],
);

export const subtasks = pgTable(
  "subtasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A subtask can only belong to a task owned by the same user.
    foreignKey({
      name: "subtasks_user_task_fk",
      columns: [t.userId, t.taskId],
      foreignColumns: [tasks.userId, tasks.id],
    }).onDelete("cascade"),
    index("subtasks_user_task_idx").on(t.userId, t.taskId),
    check("subtasks_title_not_blank", sql`length(btrim(${t.title})) > 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Subtask = typeof subtasks.$inferSelect;
