/**
 * core/graph — task dependency graph (pure, no I/O).
 *
 * Edge semantics: `{ taskId, blockedById }` means "taskId is blocked by
 * blockedById", i.e. taskId cannot proceed until blockedById is done.
 * Following edges from a task to its blockers walks "depends on" links.
 *
 * Spec §6, Plan §M2. Called by server actions before inserting an edge
 * (wouldCreateCycle) and when rendering the blocked badge (blockedSet).
 */

export type TaskId = string;

export interface DependencyEdge {
  /** The task that is blocked. */
  readonly taskId: TaskId;
  /** The task that must be done first. */
  readonly blockedById: TaskId;
}

export interface GraphTask {
  readonly id: TaskId;
  /** True while the task is not completed. Only open tasks block others. */
  readonly open: boolean;
}

/**
 * Returns true if adding the edge "taskId is blocked by blockedById" to
 * `edges` would create a dependency cycle.
 *
 * Rejects self-edges (taskId === blockedById) and any edge that closes a
 * loop of length 2 or more, i.e. when blockedById already depends,
 * directly or transitively, on taskId. Re-adding an existing edge is not
 * a cycle and returns false (duplicates are the caller's concern).
 *
 * O(V + E) per call; `edges` is not mutated.
 */
export function wouldCreateCycle(
  edges: ReadonlyArray<DependencyEdge>,
  taskId: TaskId,
  blockedById: TaskId,
): boolean {
  if (taskId === blockedById) return true;

  const blockersOf = blockersIndex(edges);

  // Iterative DFS from blockedById along "depends on" links; reaching
  // taskId means the new edge would close a loop.
  const seen = new Set<TaskId>([blockedById]);
  const stack: TaskId[] = [blockedById];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const next = blockersOf.get(current);
    if (!next) continue;
    for (const id of next) {
      if (id === taskId) return true;
      if (!seen.has(id)) {
        seen.add(id);
        stack.push(id);
      }
    }
  }
  return false;
}

/**
 * The loop that adding "taskId is blocked by blockedById" would close, for
 * explaining a rejection: `[taskId, blockedById, ..., taskId]`, each task
 * waiting on the next (shortest such loop). A self-edge is `[taskId, taskId]`.
 * Returns null when the edge would not create a cycle, i.e. exactly when
 * wouldCreateCycle returns false.
 *
 * O(V + E); `edges` is not mutated.
 */
export function cyclePath(
  edges: ReadonlyArray<DependencyEdge>,
  taskId: TaskId,
  blockedById: TaskId,
): TaskId[] | null {
  if (taskId === blockedById) return [taskId, taskId];

  const blockersOf = blockersIndex(edges);
  // BFS from blockedById along "depends on" links, remembering how each
  // task was reached so the path back to blockedById can be rebuilt.
  const via = new Map<TaskId, TaskId | null>([[blockedById, null]]);
  const queue: TaskId[] = [blockedById];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const id of blockersOf.get(current) ?? []) {
      if (id === taskId) {
        const path: TaskId[] = [taskId];
        for (let at: TaskId | null = current; at !== null; at = via.get(at)!) path.push(at);
        // path is [taskId, current, ..., blockedById]; flip the tail.
        return [taskId, ...path.slice(1).reverse(), taskId];
      }
      if (!via.has(id)) {
        via.set(id, current);
        queue.push(id);
      }
    }
  }
  return null;
}

function blockersIndex(edges: ReadonlyArray<DependencyEdge>): Map<TaskId, TaskId[]> {
  const blockersOf = new Map<TaskId, TaskId[]>();
  for (const e of edges) {
    const list = blockersOf.get(e.taskId);
    if (list) list.push(e.blockedById);
    else blockersOf.set(e.taskId, [e.blockedById]);
  }
  return blockersOf;
}

/**
 * Returns the ids of tasks that are blocked: a task is blocked iff at least
 * one of its direct blockers is open. Blockedness is not transitive — if
 * A is blocked by B and B by C, B being open blocks A regardless of C.
 *
 * Blockers missing from `tasks` (e.g. deleted or not loaded) are treated as
 * not open and do not block. The task's own status is not considered, so a
 * completed task with an open blocker is still reported; callers filter if
 * they only badge open tasks.
 *
 * O(V + E).
 */
export function blockedSet(
  tasks: ReadonlyArray<GraphTask>,
  edges: ReadonlyArray<DependencyEdge>,
): Set<TaskId> {
  const openIds = new Set<TaskId>();
  for (const t of tasks) if (t.open) openIds.add(t.id);

  const blocked = new Set<TaskId>();
  for (const e of edges) {
    if (openIds.has(e.blockedById)) blocked.add(e.taskId);
  }
  return blocked;
}
