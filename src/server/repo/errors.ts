/**
 * Thrown by repo writes when a row doesn't exist for this user. Another user's
 * rows are indistinguishable from missing ones, so callers can't probe ids.
 */
export class NotFoundError extends Error {
  constructor(readonly entity: "task" | "project" | "subtask") {
    super(`${entity} not found`);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a new "blocked by" link would close a dependency loop. The message
 * names the tasks in the loop (all the caller's own) and is shown to the user.
 */
export class DependencyCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyCycleError";
  }
}
