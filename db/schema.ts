// Drizzle schema — the TYPED QUERY LAYER, mirroring db/migrations/*.sql.
//
// Migrations are hand-written SQL (see db/migrate.ts for why), so this file is
// not the migration source and drizzle-kit generate is not used to produce it.
// tests/schema-drift.test.ts asserts this file and the live database agree on
// table and column names, so the two cannot drift apart unnoticed.
import { relations, sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, foreignKey, index, integer, pgTable, smallint,
  text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt,
  updatedAt,
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt,
  updatedAt,
}, (t) => [index("sessions_user_id_idx").on(t.userId)]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt,
  updatedAt,
}, (t) => [
  unique("accounts_provider_account_key").on(t.providerId, t.accountId),
  index("accounts_user_id_idx").on(t.userId),
]);

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
}, (t) => [index("verifications_identifier_idx").on(t.identifier)]);

// Better Auth's rate-limit store (`rateLimit: { storage: "database" }`). Keyed
// by the library; `lastRequest` is epoch milliseconds, not an instant, so it
// is bigint rather than timestamptz. No user_id and no RLS: see
// db/migrations/004_auth_role.sql.
export const rateLimits = pgTable("rate_limits", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  count: integer("count").notNull().default(0),
  lastRequest: bigint("last_request", { mode: "number" }).notNull().default(0),
});

// Relations exist only so Better Auth's drizzle adapter can resolve its
// session-with-user join through db.query. Without them the adapter logs an
// error and silently falls back to separate queries — correct, but noisy and
// misleading in logs.
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt,
}, (t) => [
  unique("projects_id_user_key").on(t.id, t.userId),
  index("projects_user_id_idx").on(t.userId),
]);

export const recurrenceRules = pgTable("recurrence_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  freq: text("freq").notNull(),
  intervalCount: integer("interval_count").notNull().default(1),
  byweekday: smallint("byweekday").array(),
  untilDate: date("until_date", { mode: "string" }),
  createdAt,
}, (t) => [
  unique("recurrence_rules_id_user_key").on(t.id, t.userId),
  index("recurrence_rules_user_id_idx").on(t.userId),
  check("recurrence_rules_freq_valid", sql`${t.freq} IN ('daily','weekly','monthly')`),
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: uuid("project_id"),
  parentTaskId: uuid("parent_task_id"),
  recurrenceRuleId: uuid("recurrence_rule_id"),
  // Calendar dates, never local-midnight timestamps.
  occurrenceDate: date("occurrence_date", { mode: "string" }),
  title: text("title").notNull(),
  notes: text("notes"),
  priority: smallint("priority").notNull().default(3),
  estimateMinutes: integer("estimate_minutes"),
  deadline: date("deadline", { mode: "string" }),
  startDate: date("start_date", { mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (t) => [
  unique("tasks_id_user_key").on(t.id, t.userId),
  // Owner-safe composite references.
  foreignKey({
    name: "tasks_project_owner_fk",
    columns: [t.projectId, t.userId],
    foreignColumns: [projects.id, projects.userId],
  }),
  foreignKey({
    name: "tasks_parent_owner_fk",
    columns: [t.parentTaskId, t.userId],
    foreignColumns: [t.id, t.userId],
  }).onDelete("cascade"),
  foreignKey({
    name: "tasks_recurrence_owner_fk",
    columns: [t.recurrenceRuleId, t.userId],
    foreignColumns: [recurrenceRules.id, recurrenceRules.userId],
  }),
  check("recurrence_pair_complete",
    sql`(${t.recurrenceRuleId} IS NULL) = (${t.occurrenceDate} IS NULL)`),
  uniqueIndex("tasks_unique_occurrence")
    .on(t.recurrenceRuleId, t.occurrenceDate)
    .where(sql`${t.recurrenceRuleId} IS NOT NULL AND ${t.occurrenceDate} IS NOT NULL`),
  index("tasks_user_id_idx").on(t.userId),
]);

export const taskDependencies = pgTable("task_dependencies", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull(),
  dependsOnId: uuid("depends_on_id").notNull(),
  createdAt,
}, (t) => [
  foreignKey({
    name: "task_dependencies_task_owner_fk",
    columns: [t.taskId, t.userId],
    foreignColumns: [tasks.id, tasks.userId],
  }).onDelete("cascade"),
  foreignKey({
    name: "task_dependencies_depends_on_owner_fk",
    columns: [t.dependsOnId, t.userId],
    foreignColumns: [tasks.id, tasks.userId],
  }).onDelete("cascade"),
  check("task_dependencies_no_self", sql`${t.taskId} <> ${t.dependsOnId}`),
]);

export const dayPlans = pgTable("day_plans", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planDate: date("plan_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("draft"),
  availableMinutes: integer("available_minutes"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt,
}, (t) => [
  unique("day_plans_id_user_key").on(t.id, t.userId),
  check("day_plans_status_valid", sql`${t.status} IN ('draft','accepted')`),
  check("day_plans_accepted_at_pair",
    sql`(${t.status} = 'accepted') = (${t.acceptedAt} IS NOT NULL)`),
  uniqueIndex("day_plans_one_accepted_per_day")
    .on(t.userId, t.planDate)
    .where(sql`${t.status} = 'accepted'`),
]);

// Plan membership lives here and ONLY here. There is deliberately no plan_date
// or planned_for_today column on `tasks`, so planning a task for today cannot
// write its deadline.
export const dayPlanItems = pgTable("day_plan_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  dayPlanId: uuid("day_plan_id").notNull(),
  taskId: uuid("task_id").notNull(),
  sortOrder: integer("sort_order").notNull(),
  plannedMinutes: integer("planned_minutes"),
  createdAt,
}, (t) => [
  foreignKey({
    name: "day_plan_items_plan_owner_fk",
    columns: [t.dayPlanId, t.userId],
    foreignColumns: [dayPlans.id, dayPlans.userId],
  }).onDelete("cascade"),
  foreignKey({
    name: "day_plan_items_task_owner_fk",
    columns: [t.taskId, t.userId],
    foreignColumns: [tasks.id, tasks.userId],
  }).onDelete("cascade"),
  unique("day_plan_items_unique_task").on(t.dayPlanId, t.taskId),
  index("day_plan_items_plan_idx").on(t.dayPlanId),
]);
