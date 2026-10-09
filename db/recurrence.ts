import type pg from "pg";

/**
 * Materializes a recurrence occurrence idempotently.
 *
 * The ON CONFLICT clause RESTATES the predicate of the partial unique index
 * tasks_unique_occurrence. This is not redundant: conflict inference cannot
 * see a partial index unless the predicate is restated, and omitting it fails
 * at runtime with "there is no unique or exclusion constraint matching the
 * ON CONFLICT specification" — verified, on the first call.
 *
 * Returns the occurrence's task id, whether it was newly created or already
 * existed, which is what makes concurrent generators safe.
 */
export async function materializeOccurrence(
  client: pg.PoolClient,
  input: {
    userId: string;
    recurrenceRuleId: string;
    occurrenceDate: string; // ISO calendar date, YYYY-MM-DD — never a timestamp
    title: string;
    projectId?: string | null;
    estimateMinutes?: number | null;
  },
): Promise<{ taskId: string; created: boolean }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO tasks
       (user_id, recurrence_rule_id, occurrence_date, title, project_id, estimate_minutes, deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $3)
     ON CONFLICT (recurrence_rule_id, occurrence_date)
       WHERE recurrence_rule_id IS NOT NULL AND occurrence_date IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      input.userId, input.recurrenceRuleId, input.occurrenceDate, input.title,
      input.projectId ?? null, input.estimateMinutes ?? null,
    ],
  );

  const inserted = rows[0];
  if (inserted) return { taskId: inserted.id, created: true };

  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE user_id = $1 AND recurrence_rule_id = $2 AND occurrence_date = $3`,
    [input.userId, input.recurrenceRuleId, input.occurrenceDate],
  );
  const found = existing[0];
  if (!found) throw new Error("occurrence neither inserted nor found");
  return { taskId: found.id, created: false };
}

/** The user's current calendar date, derived server-side from their IANA zone. */
export async function todayFor(client: pg.PoolClient, userId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE u.timezone)::date, 'YYYY-MM-DD') AS today
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no user ${userId}`);
  return row.today;
}
