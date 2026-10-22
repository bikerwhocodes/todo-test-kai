import { z } from "zod";

// Input schemas shared by server actions and forms. Optional task fields accept
// null, which clears them; omitting a key leaves the stored value unchanged.

export const TITLE_MAX = 500;
export const PROJECT_NAME_MAX = 100;
export const DESCRIPTION_MAX = 10_000;
export const ESTIMATE_MAX_MIN = 24 * 60;
/** Priority 4 means "no priority"; clearing the field sets it back to 4. */
export const NO_PRIORITY = 4;

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

export const createProjectInput = z.object({ name: projectName });
export const renameProjectInput = z.object({ id, name: projectName });
export const setProjectArchivedInput = z.object({ id, archived: z.boolean() });

export type CreateTaskInput = z.input<typeof createTaskInput>;
export type UpdateTaskInput = z.input<typeof updateTaskInput>;
export type TaskPatch = Omit<z.output<typeof updateTaskInput>, "id">;
export type UpdateSubtaskInput = z.input<typeof updateSubtaskInput>;
