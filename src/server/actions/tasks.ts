"use server";

import { revalidatePath } from "next/cache";
import type { Subtask, Task } from "@/server/db/schema";
import * as dependenciesRepo from "@/server/repo/dependencies";
import * as subtasksRepo from "@/server/repo/subtasks";
import * as tasksRepo from "@/server/repo/tasks";
import { requireUser } from "@/server/session";
import {
  addSubtaskInput,
  blockerInput,
  createTaskInput,
  setTaskCompletedInput,
  subtaskIdInput,
  taskIdInput,
  updateSubtaskInput,
  updateTaskInput,
} from "@/lib/validation";
import { runAction, type ActionResult } from "./result";

// Inputs are `unknown`: server actions are public endpoints, so the zod schema is
// the contract, not the TypeScript signature.

function refresh() {
  revalidatePath("/", "layout");
}

export async function createTaskAction(input: unknown): Promise<ActionResult<Task>> {
  const user = await requireUser();
  return runAction(createTaskInput, input, async ({ title, projectId }) => {
    const task = await tasksRepo.createTask(user.id, { title, projectId });
    refresh();
    return task;
  });
}

export async function updateTaskAction(input: unknown): Promise<ActionResult<Task>> {
  const user = await requireUser();
  return runAction(updateTaskInput, input, async ({ id, ...patch }) => {
    const task = await tasksRepo.updateTask(user.id, id, patch);
    refresh();
    return task;
  });
}

export async function setTaskCompletedAction(input: unknown): Promise<ActionResult<Task>> {
  const user = await requireUser();
  return runAction(setTaskCompletedInput, input, async ({ id, completed }) => {
    const task = await tasksRepo.setTaskCompleted(user.id, id, completed);
    refresh();
    return task;
  });
}

export async function deleteTaskAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(taskIdInput, input, async ({ id }) => {
    await tasksRepo.deleteTask(user.id, id);
    refresh();
  });
}

export async function addSubtaskAction(input: unknown): Promise<ActionResult<Subtask>> {
  const user = await requireUser();
  return runAction(addSubtaskInput, input, async ({ taskId, title }) => {
    const subtask = await subtasksRepo.addSubtask(user.id, taskId, title);
    refresh();
    return subtask;
  });
}

export async function updateSubtaskAction(input: unknown): Promise<ActionResult<Subtask>> {
  const user = await requireUser();
  return runAction(updateSubtaskInput, input, async ({ id, ...patch }) => {
    const subtask = await subtasksRepo.updateSubtask(user.id, id, patch);
    refresh();
    return subtask;
  });
}

export async function deleteSubtaskAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(subtaskIdInput, input, async ({ id }) => {
    await subtasksRepo.deleteSubtask(user.id, id);
    refresh();
  });
}

/** Makes taskId wait on blockedByTaskId. Refuses, saving nothing, if that would close a loop. */
export async function addBlockerAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(blockerInput, input, async ({ taskId, blockedByTaskId }) => {
    await dependenciesRepo.addBlocker(user.id, taskId, blockedByTaskId);
    refresh();
  });
}

export async function removeBlockerAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(blockerInput, input, async ({ taskId, blockedByTaskId }) => {
    await dependenciesRepo.removeBlocker(user.id, taskId, blockedByTaskId);
    refresh();
  });
}
