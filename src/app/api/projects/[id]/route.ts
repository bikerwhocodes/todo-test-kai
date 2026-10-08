// Access by id. This is the route that proves A3: another user's project is
// reported exactly as a nonexistent one, with no 403 and no difference in
// body, so the response cannot be used to discover that a resource exists.
import { deleteProject, getProject, renameProject } from "../../../../../db/projects.ts";
import { isUuid, notFound, readJson, requireText } from "../../../../../lib/http.ts";
import { requireUser } from "../../../../../lib/session.ts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const caller = await requireUser(request);
  if (!caller.ok) return caller.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound("project");

  const project = await getProject(caller.userId, id);
  return project ? Response.json({ project }) : notFound("project");
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const caller = await requireUser(request);
  if (!caller.ok) return caller.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound("project");

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const name = requireText(body.body.name, "name");
  if (!name.ok) return name.response;

  const project = await renameProject(caller.userId, id, name.value);
  return project ? Response.json({ project }) : notFound("project");
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const caller = await requireUser(request);
  if (!caller.ok) return caller.response;

  const { id } = await params;
  if (!isUuid(id)) return notFound("project");

  return (await deleteProject(caller.userId, id))
    ? new Response(null, { status: 204 })
    : notFound("project");
}
