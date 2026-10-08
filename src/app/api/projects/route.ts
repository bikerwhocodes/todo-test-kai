import { requireUser } from "../../../../lib/session.ts";
import { handle, invalid } from "../../../../lib/http.ts";
import { createProject, listProjects } from "../../../../lib/repo.ts";

export const dynamic = "force-dynamic";

export const GET = (req: Request): Promise<Response> =>
  handle(async () => Response.json({ projects: await listProjects(await requireUser(req)) }));

export const POST = (req: Request): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) throw invalid("name is required.", { path: ["name"] });
    return Response.json({ project: await createProject(userId, name) }, { status: 201 });
  });
