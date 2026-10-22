import "server-only";
import type { IsoDate } from "@/core/dates";
import type { RecurringSeries, Task } from "@/server/db/schema";
import type { SeriesPatch, SeriesRule } from "@/lib/validation";

// Recurring series (spec §7). Every function takes userId first and scopes every
// query by it. `today` is the caller's localToday(settings.timeZone, now).

export type SeriesWithOpen = RecurringSeries & { open: Task | null };

export type SeriesDetail = SeriesWithOpen & {
  /** Closed occurrences (done and skipped), latest occurrence_date first. */
  history: Task[];
};

/** What a task row shows for an occurrence: the series and the "missed N days" label. */
export type OccurrenceBadge = {
  seriesId: string;
  kind: RecurringSeries["kind"];
  occurrenceDate: IsoDate;
  /** e.g. "Missed 5 days"; null unless the open occurrence is overdue. */
  missedLabel: string | null;
};

export type SeriesTemplate = {
  title: string;
  description?: string | null;
  priority?: number | null;
  estimateMin?: number | null;
  projectId?: string | null;
};

export async function createSeries(
  userId: string,
  input: SeriesTemplate & { rule: SeriesRule },
  today: IsoDate,
): Promise<{ series: RecurringSeries; occurrence: Task | null }> {
  void [userId, input, today];
  throw new Error("TODO(M3)");
}

export async function updateSeries(
  userId: string,
  id: string,
  patch: SeriesPatch,
  today: IsoDate,
): Promise<RecurringSeries> {
  void [userId, id, patch, today];
  throw new Error("TODO(M3)");
}

export async function deleteSeries(userId: string, id: string): Promise<void> {
  void [userId, id];
  throw new Error("TODO(M3)");
}

export async function listSeries(userId: string): Promise<SeriesWithOpen[]> {
  void userId;
  throw new Error("TODO(M3)");
}

export async function getSeriesDetail(userId: string, id: string): Promise<SeriesDetail | null> {
  void [userId, id];
  throw new Error("TODO(M3)");
}

/** Badges for the series occurrences among `tasks` (one-off tasks are absent from the map). */
export async function occurrenceBadges(
  userId: string,
  tasks: Pick<Task, "id" | "seriesId" | "occurrenceDate" | "status">[],
  today: IsoDate,
): Promise<Map<string, OccurrenceBadge>> {
  void [userId, tasks, today];
  throw new Error("TODO(M3)");
}

/** Open occurrences due on or before `today`, oldest first (for the Today view). */
export async function listDueOccurrences(userId: string, today: IsoDate): Promise<Task[]> {
  void [userId, today];
  throw new Error("TODO(M3)");
}
