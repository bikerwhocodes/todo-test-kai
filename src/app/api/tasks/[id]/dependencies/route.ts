import { requireUser } from "../../../../../../lib/session.ts";
import { ApiError, handle, invalid } from "../../../../../../lib/http.ts";
import { linkDependency, listDependencies } from "../../../../../../lib/repo.ts";
import { DependencyCycleError } from "../../../../../../db/dependencies.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = (req: Request, ctx: Ctx): Promise<Response> =>
  handle(async () => {
    const userId = await requireUser(req);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { dependsOnId?: unknown } | null;
    const dependsOnId = body?.dependsOnId;
    if (typeof dependsOnId !== "string" || !UUID.test(dependsOnId)) {
      throw invalid("dependsOnId must be a UUID.", { path: ["dependsOnId"] });
    }
    try {
      await linkDependency(userId, id, dependsOnId);
    } catch (err) {
      if (err instanceof DependencyCycleError) {
        // The chain is named so the user can see WHICH loop they just closed
        // (spec §5.4). It contains only the caller's own task ids.
        throw new ApiError("DEPENDENCY_CYCLE", err.message, { path: err.path });
      }
      throw err;
    }
    return Response.json({ dependsOn: await listDependencies(userId, id) }, { status: 201 });
  });
