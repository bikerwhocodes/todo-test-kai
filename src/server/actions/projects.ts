"use server";

import { revalidatePath } from "next/cache";
import type { Project } from "@/server/db/schema";
import * as projectsRepo from "@/server/repo/projects";
import { requireUser } from "@/server/session";
import { createProjectInput, renameProjectInput, setProjectArchivedInput } from "@/lib/validation";
import { runAction, type ActionResult } from "./result";

function refresh() {
  revalidatePath("/", "layout");
}

export async function createProjectAction(input: unknown): Promise<ActionResult<Project>> {
  const user = await requireUser();
  return runAction(createProjectInput, input, async ({ name }) => {
    const project = await projectsRepo.createProject(user.id, { name });
    refresh();
    return project;
  });
}

export async function renameProjectAction(input: unknown): Promise<ActionResult<Project>> {
  const user = await requireUser();
  return runAction(renameProjectInput, input, async ({ id, name }) => {
    const project = await projectsRepo.renameProject(user.id, id, name);
    refresh();
    return project;
  });
}

export async function setProjectArchivedAction(input: unknown): Promise<ActionResult<Project>> {
  const user = await requireUser();
  return runAction(setProjectArchivedInput, input, async ({ id, archived }) => {
    const project = await projectsRepo.setProjectArchived(user.id, id, archived);
    refresh();
    return project;
  });
}
