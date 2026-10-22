export class NotFoundError extends Error {
  constructor(readonly entity: string) {
    super(`${entity} not found`);
    this.name = "NotFoundError";
  }
}

// Drizzle wraps driver errors; the pg error (with .code/.constraint) may be the cause.
function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ("code" in e && typeof (e as { code: unknown }).code === "string") {
      return e as { code?: string; constraint?: string };
    }
  }
  return undefined;
}

/**
 * Re-throws a violation of one of `constraints` (FK, 23503) as NotFoundError.
 * Another user's row and a missing row look the same to the caller.
 */
export function rethrowForeignKey(err: unknown, constraints: Record<string, string>): never {
  const pg = pgError(err);
  if (pg?.code === "23503" && pg.constraint && pg.constraint in constraints) {
    throw new NotFoundError(constraints[pg.constraint]!);
  }
  throw err;
}

/** Copies only `keys` that are present, so untyped input can't set userId/id. */
export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
