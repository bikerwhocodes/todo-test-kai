import { describe, expect, it } from "vitest";
import {
  blockedSet,
  wouldCreateCycle,
  type DependencyEdge,
  type GraphTask,
} from "../../../src/core/graph/index.js";

/** "a<b" reads "a is blocked by b". */
const e = (spec: string): DependencyEdge => {
  const [taskId, blockedById] = spec.split("<") as [string, string];
  return { taskId, blockedById };
};
const edges = (...specs: string[]) => specs.map(e);

describe("wouldCreateCycle", () => {
  const cases: Array<{
    name: string;
    existing: string[];
    add: string;
    expected: boolean;
  }> = [
    { name: "self-edge on empty graph", existing: [], add: "a<a", expected: true },
    { name: "self-edge on busy graph", existing: ["a<b", "b<c"], add: "b<b", expected: true },
    { name: "direct 2-cycle", existing: ["a<b"], add: "b<a", expected: true },
    { name: "3-cycle", existing: ["a<b", "b<c"], add: "c<a", expected: true },
    { name: "4-cycle", existing: ["a<b", "b<c", "c<d"], add: "d<a", expected: true },
    {
      name: "cycle through a branch",
      existing: ["a<b", "a<x", "x<y", "y<z"],
      add: "z<a",
      expected: true,
    },
    {
      name: "cycle via diamond",
      existing: ["a<b", "a<c", "b<d", "c<d"],
      add: "d<a",
      expected: true,
    },
    { name: "first edge", existing: [], add: "a<b", expected: false },
    { name: "extending a chain", existing: ["a<b", "b<c"], add: "c<d", expected: false },
    { name: "shortcut in same direction", existing: ["a<b", "b<c"], add: "a<c", expected: false },
    { name: "duplicate edge", existing: ["a<b"], add: "a<b", expected: false },
    { name: "closing a diamond (not a cycle)", existing: ["a<b", "a<c", "b<d"], add: "c<d", expected: false },
    { name: "unrelated components", existing: ["a<b", "c<d"], add: "b<c", expected: false },
    { name: "reverse direction across components", existing: ["a<b", "c<d"], add: "d<a", expected: false },
    { name: "existing cycle elsewhere does not hang", existing: ["x<y", "y<x"], add: "a<x", expected: false },
  ];

  it.each(cases)("$name: $add → $expected", ({ existing, add, expected }) => {
    const { taskId, blockedById } = e(add);
    expect(wouldCreateCycle(edges(...existing), taskId, blockedById)).toBe(expected);
  });

  it("does not mutate the input edges", () => {
    const input = Object.freeze(edges("a<b", "b<c").map((x) => Object.freeze(x)));
    expect(() => wouldCreateCycle(input, "c", "a")).not.toThrow();
    expect(input).toEqual(edges("a<b", "b<c"));
  });
});

describe("blockedSet", () => {
  const t = (id: string, open = true): GraphTask => ({ id, open });

  const cases: Array<{
    name: string;
    tasks: GraphTask[];
    edges: string[];
    expected: string[];
  }> = [
    { name: "no edges", tasks: [t("a"), t("b")], edges: [], expected: [] },
    { name: "open blocker blocks", tasks: [t("a"), t("b")], edges: ["a<b"], expected: ["a"] },
    { name: "done blocker does not block", tasks: [t("a"), t("b", false)], edges: ["a<b"], expected: [] },
    {
      name: "any open blocker blocks",
      tasks: [t("a"), t("b", false), t("c")],
      edges: ["a<b", "a<c"],
      expected: ["a"],
    },
    {
      name: "all blockers done unblocks",
      tasks: [t("a"), t("b", false), t("c", false)],
      edges: ["a<b", "a<c"],
      expected: [],
    },
    {
      name: "not transitive: only direct blockers count",
      tasks: [t("a"), t("b", false), t("c")],
      edges: ["a<b", "b<c"],
      expected: ["b"],
    },
    {
      name: "chain of open tasks",
      tasks: [t("a"), t("b"), t("c")],
      edges: ["a<b", "b<c"],
      expected: ["a", "b"],
    },
    { name: "missing blocker does not block", tasks: [t("a")], edges: ["a<ghost"], expected: [] },
    {
      name: "completed task with open blocker is still reported",
      tasks: [t("a", false), t("b")],
      edges: ["a<b"],
      expected: ["a"],
    },
    {
      name: "one blocker, many dependents",
      tasks: [t("a"), t("b"), t("c"), t("x")],
      edges: ["a<x", "b<x", "c<x"],
      expected: ["a", "b", "c"],
    },
  ];

  it.each(cases)("$name", ({ tasks, edges: specs, expected }) => {
    expect([...blockedSet(tasks, edges(...specs))].sort()).toEqual([...expected].sort());
  });
});

describe("performance (1k-edge graph < 10 ms)", () => {
  /** Deterministic PRNG (mulberry32) so the random graph is stable across runs. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  /** Chain t0 < t1 < … < t1000: worst case, the cycle check walks every edge. */
  const chain: DependencyEdge[] = Array.from({ length: 1000 }, (_, i) => ({
    taskId: `t${i}`,
    blockedById: `t${i + 1}`,
  }));

  /** Random DAG: 1k edges over 300 tasks, always pointing to a higher index. */
  const dag: DependencyEdge[] = (() => {
    const next = rng(42);
    const out: DependencyEdge[] = [];
    const seen = new Set<string>();
    while (out.length < 1000) {
      const a = Math.floor(next() * 300);
      const b = Math.floor(next() * 300);
      if (a === b) continue;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const key = `${lo}<${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ taskId: `t${lo}`, blockedById: `t${hi}` });
    }
    return out;
  })();

  /** Median of several timed runs after a warm-up, to keep CI noise out. */
  const timeMs = (fn: () => void, runs = 7): number => {
    fn();
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      fn();
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    return samples[Math.floor(runs / 2)]!;
  };

  it("detects the cycle closing a 1k-edge chain", () => {
    let result = false;
    const ms = timeMs(() => {
      result = wouldCreateCycle(chain, "t1000", "t0");
    });
    expect(result).toBe(true);
    expect(ms).toBeLessThan(10);
  });

  it("accepts a non-cycle edge on a 1k-edge chain (full walk)", () => {
    let result = true;
    const ms = timeMs(() => {
      result = wouldCreateCycle(chain, "t0", "t1000");
    });
    expect(result).toBe(false);
    expect(ms).toBeLessThan(10);
  });

  it("checks both directions on a random 1k-edge DAG", () => {
    let forward = true;
    let backward = false;
    const ms = timeMs(() => {
      forward = wouldCreateCycle(dag, "t0", "t299");
      backward = wouldCreateCycle(dag, "t299", "t0");
    });
    expect(forward).toBe(false);
    // Whether t0 reaches t299 depends on the generated graph; assert it
    // against an independent reachability count instead of hard-coding.
    expect(backward).toBe(reaches(dag, "t0", "t299"));
    expect(ms).toBeLessThan(10);
  });

  it("computes blockedSet over a 1k-edge graph", () => {
    const next = rng(7);
    const tasks: GraphTask[] = Array.from({ length: 300 }, (_, i) => ({
      id: `t${i}`,
      open: next() < 0.5,
    }));
    let size = 0;
    const ms = timeMs(() => {
      size = blockedSet(tasks, dag).size;
    });
    const open = new Set(tasks.filter((t) => t.open).map((t) => t.id));
    expect(size).toBe(new Set(dag.filter((d) => open.has(d.blockedById)).map((d) => d.taskId)).size);
    expect(ms).toBeLessThan(10);
  });
});

/** Reference reachability (BFS) used only to cross-check the DAG test. */
function reaches(es: DependencyEdge[], from: string, to: string): boolean {
  const queue = [from];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const x of es) {
      if (x.taskId !== cur || seen.has(x.blockedById)) continue;
      if (x.blockedById === to) return true;
      seen.add(x.blockedById);
      queue.push(x.blockedById);
    }
  }
  return false;
}
