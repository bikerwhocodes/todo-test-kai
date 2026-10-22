import { describe, expect, it } from "vitest";
import {
  blockerInput,
  createProjectInput,
  createTaskInput,
  renameProjectInput,
  updateSubtaskInput,
  updateTaskInput,
} from "@/lib/validation";

const ID = "0b8f5f3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

describe("createTaskInput", () => {
  it("trims the title", () => {
    expect(createTaskInput.parse({ title: "  Buy milk  " })).toEqual({ title: "Buy milk" });
  });

  it.each(["", "   ", undefined, 42])("rejects title %j", (title) => {
    expect(createTaskInput.safeParse({ title }).success).toBe(false);
  });

  it("accepts 500 characters (after trimming) and rejects 501", () => {
    expect(createTaskInput.safeParse({ title: ` ${"a".repeat(500)} ` }).success).toBe(true);
    expect(createTaskInput.safeParse({ title: "a".repeat(501) }).success).toBe(false);
  });

  it("treats projectId as optional and nullable (Inbox)", () => {
    expect(createTaskInput.parse({ title: "t" }).projectId).toBeUndefined();
    expect(createTaskInput.parse({ title: "t", projectId: null }).projectId).toBeNull();
    expect(createTaskInput.parse({ title: "t", projectId: ID }).projectId).toBe(ID);
  });

  it("rejects a non-uuid projectId", () => {
    expect(createTaskInput.safeParse({ title: "t", projectId: "inbox" }).success).toBe(false);
  });
});

describe("updateTaskInput", () => {
  it("requires a uuid id", () => {
    expect(updateTaskInput.safeParse({}).success).toBe(false);
    expect(updateTaskInput.safeParse({ id: "123" }).success).toBe(false);
  });

  it("leaves omitted fields undefined", () => {
    const parsed = updateTaskInput.parse({ id: ID });
    expect(parsed).toEqual({ id: ID });
    for (const key of ["title", "description", "priority", "deadline", "estimateMin", "projectId"] as const) {
      expect(parsed[key]).toBeUndefined();
    }
  });

  it.each([
    ["description", "Some notes", "Some notes"],
    ["priority", 1, 1],
    ["deadline", "2026-11-05", "2026-11-05"],
    ["estimateMin", 45, 45],
    ["projectId", ID, ID],
  ] as const)("accepts a value for %s", (key, value, expected) => {
    expect(updateTaskInput.parse({ id: ID, [key]: value })[key]).toBe(expected);
  });

  it.each(["description", "priority", "deadline", "estimateMin", "projectId"] as const)(
    "accepts null for %s (clear)",
    (key) => {
      const parsed = updateTaskInput.parse({ id: ID, [key]: null });
      expect(parsed[key]).toBeNull();
    },
  );

  it("does not accept null for title", () => {
    expect(updateTaskInput.safeParse({ id: ID, title: null }).success).toBe(false);
    expect(updateTaskInput.safeParse({ id: ID, title: "  " }).success).toBe(false);
    expect(updateTaskInput.parse({ id: ID, title: " New " }).title).toBe("New");
  });

  it.each(["", "   ", "\n\t"])("stores a blank description %j as null", (description) => {
    expect(updateTaskInput.parse({ id: ID, description }).description).toBeNull();
  });

  it("rejects a description over 10,000 characters", () => {
    expect(updateTaskInput.safeParse({ id: ID, description: "a".repeat(10_001) }).success).toBe(false);
  });

  it.each(["2026-02-30", "2026-1-5", "tomorrow", "2026-13-01", "2026-11-05T00:00:00Z"])(
    "rejects deadline %j",
    (deadline) => {
      expect(updateTaskInput.safeParse({ id: ID, deadline }).success).toBe(false);
    },
  );

  it("accepts a leap day deadline", () => {
    expect(updateTaskInput.parse({ id: ID, deadline: "2028-02-29" }).deadline).toBe("2028-02-29");
  });

  it.each([0, 1441, 1.5, -5])("rejects estimateMin %j", (estimateMin) => {
    expect(updateTaskInput.safeParse({ id: ID, estimateMin }).success).toBe(false);
  });

  it("accepts estimateMin bounds 1 and 1440", () => {
    expect(updateTaskInput.safeParse({ id: ID, estimateMin: 1 }).success).toBe(true);
    expect(updateTaskInput.safeParse({ id: ID, estimateMin: 1440 }).success).toBe(true);
  });

  it.each([0, 5, 2.5, "1"])("rejects priority %j", (priority) => {
    expect(updateTaskInput.safeParse({ id: ID, priority }).success).toBe(false);
  });

  it("rejects a non-uuid projectId", () => {
    expect(updateTaskInput.safeParse({ id: ID, projectId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("updateSubtaskInput", () => {
  it("accepts a title and/or done flag", () => {
    expect(updateSubtaskInput.parse({ id: ID, title: " x ", done: true })).toEqual({ id: ID, title: "x", done: true });
    expect(updateSubtaskInput.parse({ id: ID })).toEqual({ id: ID });
  });

  it("rejects a blank title", () => {
    expect(updateSubtaskInput.safeParse({ id: ID, title: " " }).success).toBe(false);
  });
});

describe("blockerInput", () => {
  const OTHER = "1c9e6a4f-5b6c-4d7e-9f0a-1b2c3d4e5f60";

  it("takes two task ids and drops anything else", () => {
    expect(blockerInput.parse({ taskId: ID, blockedByTaskId: OTHER, userId: "u" })).toEqual({
      taskId: ID,
      blockedByTaskId: OTHER,
    });
  });

  it("lets a self-link through so the server can answer with the loop message", () => {
    expect(blockerInput.safeParse({ taskId: ID, blockedByTaskId: ID }).success).toBe(true);
  });

  it("rejects missing or non-uuid ids", () => {
    expect(blockerInput.safeParse({ taskId: ID }).success).toBe(false);
    expect(blockerInput.safeParse({ taskId: "nope", blockedByTaskId: OTHER }).success).toBe(false);
  });
});

describe("project names", () => {
  it("trims the name", () => {
    expect(createProjectInput.parse({ name: "  Home  " })).toEqual({ name: "Home" });
    expect(renameProjectInput.parse({ id: ID, name: " Work " })).toEqual({ id: ID, name: "Work" });
  });

  it.each(["", "   "])("rejects blank name %j", (name) => {
    expect(createProjectInput.safeParse({ name }).success).toBe(false);
    expect(renameProjectInput.safeParse({ id: ID, name }).success).toBe(false);
  });

  it("accepts 100 characters and rejects 101", () => {
    expect(createProjectInput.safeParse({ name: "a".repeat(100) }).success).toBe(true);
    expect(createProjectInput.safeParse({ name: "a".repeat(101) }).success).toBe(false);
  });

  it("rejects a non-uuid id on rename", () => {
    expect(renameProjectInput.safeParse({ id: "1", name: "x" }).success).toBe(false);
  });
});
