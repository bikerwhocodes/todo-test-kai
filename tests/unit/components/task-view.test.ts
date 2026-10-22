import { describe, expect, it } from "vitest";
import { toTaskView } from "@/components/tasks/types";
import type { TaskStatus } from "@/server/db/schema";
import type { TaskWithSubtasks } from "@/server/repo/tasks";

const NOW = new Date("2026-10-01T12:00:00Z");

function task(blockers: { id: string; title: string; status: TaskStatus }[]): TaskWithSubtasks {
  return {
    id: "t",
    userId: "u",
    projectId: null,
    title: "Paint the room",
    description: null,
    priority: 4,
    deadline: null,
    estimateMin: null,
    status: "open",
    completedAt: null,
    seriesId: null,
    occurrenceDate: null,
    sort: 0,
    createdAt: NOW,
    updatedAt: NOW,
    subtasks: [],
    blockers,
  };
}

describe("toTaskView blocked-ness (derived from blocker status)", () => {
  it("is not blocked without blockers", () => {
    expect(toTaskView(task([]))).toMatchObject({ blocked: false, blockers: [] });
  });

  it("is blocked while any direct blocker is open", () => {
    const view = toTaskView(
      task([
        { id: "a", title: "Buy paint", status: "done" },
        { id: "b", title: "Tape edges", status: "open" },
      ]),
    );
    expect(view.blocked).toBe(true);
    expect(view.blockers).toEqual([
      { id: "a", title: "Buy paint", open: false },
      { id: "b", title: "Tape edges", open: true },
    ]);
  });

  it("is unblocked once every blocker is completed or skipped", () => {
    const view = toTaskView(
      task([
        { id: "a", title: "Buy paint", status: "done" },
        { id: "b", title: "Tape edges", status: "skipped" },
      ]),
    );
    expect(view.blocked).toBe(false);
  });
});
