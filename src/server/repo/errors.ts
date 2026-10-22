/**
 * Thrown by repo writes when a row doesn't exist for this user. Another user's
 * rows are indistinguishable from missing ones, so callers can't probe ids.
 */
export class NotFoundError extends Error {
  constructor(readonly entity: "task" | "project" | "subtask" | "series") {
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

/**
 * Thrown when the row exists and belongs to the user but the change isn't allowed
 * in its current state (e.g. reopening an old occurrence). The message is shown as is.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
