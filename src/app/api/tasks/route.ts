import { requireUser } from "../../../../lib/session.ts";
import { handle, invalid } from "../../../../lib/http.ts";
import { createTask, listTasks, type NewTask } from "../../../../lib/repo.ts";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = (req: Request): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    // Here `projectId` is a FILTER over a collection, not a row address, so a
    // malformed value is a genuine request-validation error rather than a
    // missing row. It leaks nothing: a well-formed id belonging to someone
    // else returns an empty list, exactly as an owned-but-empty project does.
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (projectId !== null && !UUID.test(projectId)) {
      throw invalid("projectId must be a UUID.", { path: ["projectId"] });
    }
    return Response.json({ tasks: await listTasks(userId, projectId ?? undefined) });
  });

export const POST = (req: Request): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const title = typeof b?.title === "string" ? b.title.trim() : "";
    if (!title) throw invalid("title is required.", { path: ["title"] });

    const t: NewTask = { title };
    // `projectId` / `parentTaskId` are row ADDRESSES, so they are deliberately
    // NOT validated into a 422 here. The repository guards them and answers
    // 404 — the same answer a foreign or nonexistent id gets, which keeps
    // malformed, foreign and missing indistinguishable (A3). A 422 would leak
    // that an id was at least well-formed.
    for (const key of ["projectId", "parentTaskId"] as const) {
      const v = b?.[key];
      if (v == null) continue;
      if (typeof v !== "string") throw invalid(`${key} must be a string UUID.`, { path: [key] });
      t[key] = v;
    }
    for (const key of ["deadline", "startDate"] as const) {
      const v = b?.[key];
      if (v == null) continue;
      if (typeof v !== "string" || !DATE.test(v)) {
        // A calendar date is never a timestamp (P4), so an instant is refused
        // here rather than silently truncated to a day.
        throw invalid(`${key} must be a YYYY-MM-DD calendar date.`, { path: [key] });
      }
      t[key] = v;
    }
    if (b?.priority != null) {
      const p = b.priority;
      if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 4) {
        throw invalid("priority must be an integer 1-4.", { path: ["priority"] });
      }
      t.priority = p;
    }
    if (b?.estimateMinutes != null) {
      const m = b.estimateMinutes;
      if (typeof m !== "number" || !Number.isInteger(m) || m <= 0) {
        throw invalid("estimateMinutes must be a positive integer.", { path: ["estimateMinutes"] });
      }
      t.estimateMinutes = m;
    }
    if (typeof b?.notes === "string") t.notes = b.notes;

    return Response.json({ task: await createTask(userId, t) }, { status: 201 });
  });
