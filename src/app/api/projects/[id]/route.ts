import { requireUser } from "../../../../../lib/session.ts";
import { handle, invalid } from "../../../../../lib/http.ts";
import { deleteProject, getProject, renameProject } from "../../../../../lib/repo.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    return Response.json({ project: await getProject(userId, id) });
  });

export const PATCH = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) throw invalid("name is required.", { path: ["name"] });
    return Response.json({ project: await renameProject(userId, id, name) });
  });

export const DELETE = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    await deleteProject(userId, id);
    return new Response(null, { status: 204 });
  });
