import "server-only";
import { z } from "zod";
import { NotFoundError } from "@/server/repo/errors";

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Validates `input` with `schema`, runs `fn` and turns expected failures into a
 * result the form can show. Unexpected errors still throw.
 */
export async function runAction<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  fn: (data: z.output<S>) => Promise<T>,
): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const { formErrors, fieldErrors } = z.flattenError(parsed.error) as {
      formErrors: string[];
      fieldErrors: Record<string, string[]>;
    };
    return {
      ok: false,
      error: formErrors[0] ?? Object.values(fieldErrors).flat()[0] ?? "Invalid input",
      fieldErrors,
    };
  }
  try {
    return { ok: true, data: await fn(parsed.data) };
  } catch (error) {
    if (error instanceof NotFoundError) {
      const what = error.entity[0]!.toUpperCase() + error.entity.slice(1);
      return { ok: false, error: `${what} not found` };
    }
    throw error;
  }
}
