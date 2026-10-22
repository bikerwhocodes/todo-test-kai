import type { Db } from "../db/client";
import { projectsRepo } from "./projects";
import { subtasksRepo } from "./subtasks";
import { tasksRepo } from "./tasks";

export { NotFoundError } from "./errors";

/**
 * Data access for user-owned rows. Every method takes userId first and scopes
 * every query by it; there are no lookups by bare id.
 */
export function createRepo(db: Db) {
  return {
    projects: projectsRepo(db),
    tasks: tasksRepo(db),
    subtasks: subtasksRepo(db),
  };
}

export type Repo = ReturnType<typeof createRepo>;
