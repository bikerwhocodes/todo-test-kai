import { requireUser } from "../../../../../lib/session.ts";
import { handle, invalid } from "../../../../../lib/http.ts";
import { deleteTask, getTask, listDependencies, updateTask } from "../../../../../lib/repo.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EDITABLE = ["title", "notes", "priority", "projectId", "estimateMinutes", "deadline", "startDate"] as const;

export const GET = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    const task = await getTask(userId, id);
    return Response.json({ task, dependsOn: await listDependencies(userId, id) });
  });

export const PATCH = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") throw invalid("a JSON object body is required.");

    const patch: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      if (!(k in b)) continue;
      const v = b[k];
      if ((k === "deadline" || k === "startDate") && v != null && (typeof v !== "string" || !DATE.test(v))) {
        throw invalid(`${k} must be a YYYY-MM-DD calendar date.`, { path: [k] });
      }
      if (k === "title" && (typeof v !== "string" || v.trim() === "")) {
        throw invalid("title cannot be empty.", { path: ["title"] });
      }
      patch[k] = k === "title" ? (v as string).trim() : v;
    }
    if (Object.keys(patch).length === 0) throw invalid("no editable field supplied.");
    return Response.json({ task: await updateTask(userId, id, patch) });
  });

export const DELETE = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    await deleteTask(userId, id);
    return new Response(null, { status: 204 });
  });
