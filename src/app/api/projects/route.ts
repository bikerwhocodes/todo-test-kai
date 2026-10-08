import { createProject, listProjects } from "../../../../db/projects.ts";
import { readJson, requireText } from "../../../../lib/http.ts";
import { requireUser } from "../../../../lib/session.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const caller = await requireUser(request);
  if (!caller.ok) return caller.response;
  return Response.json({ projects: await listProjects(caller.userId) });
}

export async function POST(request: Request): Promise<Response> {
  const caller = await requireUser(request);
  if (!caller.ok) return caller.response;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const name = requireText(body.body.name, "name");
  if (!name.ok) return name.response;

  const project = await createProject(caller.userId, name.value);
  return Response.json({ project }, { status: 201 });
}
