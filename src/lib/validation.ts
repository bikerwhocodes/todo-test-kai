import { z } from "zod";
import { isValidTimeZone } from "@/core/time-zone";
import { DESCRIPTION_MAX, ESTIMATE_MAX_MIN, PROJECT_NAME_MAX, TITLE_MAX } from "./limits";

// Input schemas for server actions. Optional task fields accept null, which clears
// them; omitting a key leaves the stored value unchanged.

export * from "./limits";

const id = z.uuid("Invalid id");

const title = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(TITLE_MAX, `Title must be at most ${TITLE_MAX} characters`);

const projectName = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(PROJECT_NAME_MAX, `Name must be at most ${PROJECT_NAME_MAX} characters`);

/** Blank descriptions are stored as null so "cleared" has one representation. */
const description = z
  .string()
  .max(DESCRIPTION_MAX, `Description must be at most ${DESCRIPTION_MAX} characters`)
  .transform((s) => (s.trim() === "" ? null : s))
  .nullable();

export const createTaskInput = z.object({
  title,
  // Omitted or null: the task lands in the Inbox.
  projectId: id.nullish(),
});

export const updateTaskInput = z.object({
  id,
  title: title.optional(),
  description: description.optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  deadline: z.iso.date("Deadline must be a date (YYYY-MM-DD)").nullable().optional(),
  estimateMin: z
    .number()
    .int("Estimate must be whole minutes")
    .min(1, "Estimate must be at least 1 minute")
    .max(ESTIMATE_MAX_MIN, "Estimate must be at most 24 hours")
    .nullable()
    .optional(),
  projectId: id.nullable().optional(),
});

export const setTaskCompletedInput = z.object({ id, completed: z.boolean() });
export const taskIdInput = z.object({ id });

export const addSubtaskInput = z.object({ taskId: id, title });
export const updateSubtaskInput = z.object({
  id,
  title: title.optional(),
  done: z.boolean().optional(),
});
export const subtaskIdInput = z.object({ id });

/** "taskId is blocked by blockedByTaskId"; used to add and to remove the link. */
export const blockerInput = z.object({ taskId: id, blockedByTaskId: id });

export const createProjectInput = z.object({ name: projectName });
export const renameProjectInput = z.object({ id, name: projectName });
export const setProjectArchivedInput = z.object({ id, archived: z.boolean() });

export type CreateTaskInput = z.input<typeof createTaskInput>;
export type UpdateTaskInput = z.input<typeof updateTaskInput>;
export type TaskPatch = Omit<z.output<typeof updateTaskInput>, "id">;
export type UpdateSubtaskInput = z.input<typeof updateSubtaskInput>;

// Recurring series (spec §7). The rule fields mirror core/recurrence's RecurrenceRule.

const isoDate = (label: string) => z.iso.date(`${label} must be a date (YYYY-MM-DD)`);

const seriesRule = z
  .object({
    kind: z.enum(["daily", "weekly"]),
    interval: z
      .number()
      .int("Repeat interval must be a whole number")
      .min(1, "Repeat interval must be at least 1")
      .max(365, "Repeat interval must be at most 365"),
    // Weekly only: 0 = Sunday … 6 = Saturday.
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
    startDate: isoDate("Start date"),
    endDate: isoDate("End date").nullish(),
  })
  .superRefine((r, ctx) => {
    if (r.kind === "weekly" && (!r.weekdays || r.weekdays.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Pick at least one weekday" });
    }
    if (r.endDate && r.endDate < r.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date" });
    }
  })
  .transform((r) => ({
    ...r,
    // Stored sorted and de-duplicated; null for daily rules.
    weekdays: r.kind === "weekly" ? [...new Set(r.weekdays)].sort((a, b) => a - b) : null,
    endDate: r.endDate ?? null,
  }));

const estimateMin = z
  .number()
  .int("Estimate must be whole minutes")
  .min(1, "Estimate must be at least 1 minute")
  .max(ESTIMATE_MAX_MIN, "Estimate must be at most 24 hours")
  .nullable();

const seriesTemplate = {
  title,
  description: description.optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  estimateMin: estimateMin.optional(),
  projectId: id.nullish(),
};

export const createSeriesInput = z.object({ ...seriesTemplate, rule: seriesRule });

/** Omitted keys are left unchanged; `rule`, when given, replaces the whole rule. */
export const updateSeriesInput = z.object({
  id,
  title: title.optional(),
  description: description.optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  estimateMin: estimateMin.optional(),
  projectId: id.nullable().optional(),
  rule: seriesRule.optional(),
});

export const seriesIdInput = z.object({ id });

export type SeriesRuleInput = z.input<typeof seriesRule>;
export type SeriesRule = z.output<typeof seriesRule>;
export type CreateSeriesInput = z.input<typeof createSeriesInput>;
export type UpdateSeriesInput = z.input<typeof updateSeriesInput>;
export type SeriesPatch = Omit<z.output<typeof updateSeriesInput>, "id">;

// Settings (spec §7). Omitted keys are left unchanged, so the mismatch banner can
// switch only the zone.

export const updateSettingsInput = z
  .object({
    timeZone: z.string().refine(isValidTimeZone, "Choose a time zone from the list").optional(),
    defaultEstimateMin: z
      .number()
      .int("Default estimate must be whole minutes")
      .min(1, "Default estimate must be at least 1 minute")
      .max(ESTIMATE_MAX_MIN, "Default estimate must be at most 24 hours")
      .optional(),
  })
  .refine((v) => v.timeZone !== undefined || v.defaultEstimateMin !== undefined, "Nothing to update");

export type UpdateSettingsInput = z.input<typeof updateSettingsInput>;
export type SettingsPatch = z.output<typeof updateSettingsInput>;
