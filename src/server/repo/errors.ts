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
