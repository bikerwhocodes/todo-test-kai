import { describe, expect, it } from "vitest";
import {
  G_TIMEOUT_MS,
  INITIAL_SHORTCUT_STATE,
  acceptsShortcut,
  isTypingTarget,
  moveIndex,
  resolveShortcut,
  type ShortcutAction,
  type ShortcutKeyEvent,
  type ShortcutState,
  type ShortcutTarget,
} from "@/core/shortcuts";

const key = (k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const body: ShortcutTarget = { tagName: "BODY" };
const taskButton: ShortcutTarget = { tagName: "BUTTON", inTaskRow: true, onTaskButton: true };
const taskCheckbox: ShortcutTarget = { tagName: "INPUT", type: "checkbox", inTaskRow: true };
const editorButton: ShortcutTarget = { tagName: "BUTTON", inTaskRow: true };

const T0 = 10_000;

/** The action for one keydown from a fresh state. */
function action(event: ShortcutKeyEvent, target: ShortcutTarget | null = body, helpOpen = false): ShortcutAction | null {
  return resolveShortcut(INITIAL_SHORTCUT_STATE, event, target, { now: T0, helpOpen }).action;
}

/** Feeds keys in order (each `[key, msAfterStart]`) and returns the last result. */
function sequence(keys: [string | ShortcutKeyEvent, number][], target: ShortcutTarget | null = body) {
  let state: ShortcutState = INITIAL_SHORTCUT_STATE;
  let last: ShortcutAction | null = null;
  for (const [k, at] of keys) {
    const result = resolveShortcut(state, typeof k === "string" ? key(k) : k, target, { now: T0 + at });
    state = result.state;
    last = result.action;
  }
  return { state, action: last };
}

describe("isTypingTarget", () => {
  it.each<[ShortcutTarget, boolean]>([
    [{ tagName: "INPUT" }, true],
    [{ tagName: "INPUT", type: "text" }, true],
    [{ tagName: "INPUT", type: "search" }, true],
    [{ tagName: "INPUT", type: "number" }, true],
    [{ tagName: "INPUT", type: "date" }, true],
    [{ tagName: "INPUT", type: "email" }, true],
    [{ tagName: "INPUT", type: "TEXT" }, true],
    [{ tagName: "TEXTAREA" }, true],
    [{ tagName: "SELECT" }, true],
    [{ tagName: "DIV", isContentEditable: true }, true],
    [{ tagName: "INPUT", type: "checkbox" }, false],
    [{ tagName: "INPUT", type: "radio" }, false],
    [{ tagName: "INPUT", type: "submit" }, false],
    [{ tagName: "INPUT", type: "button" }, false],
    [{ tagName: "BUTTON" }, false],
    [{ tagName: "A" }, false],
    [{ tagName: "BODY" }, false],
  ])("%j -> %s", (target, typing) => {
    expect(isTypingTarget(target)).toBe(typing);
  });
});

describe("acceptsShortcut", () => {
  it("accepts a plain key outside fields and dialogs", () => {
    expect(acceptsShortcut(key("j"), body)).toBe(true);
    expect(acceptsShortcut(key("j"), null)).toBe(true);
    expect(acceptsShortcut(key("?", { shiftKey: true }), body)).toBe(true);
  });

  it.each<[string, Partial<ShortcutKeyEvent>]>([
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Alt", { altKey: true }],
    ["already handled", { defaultPrevented: true }],
    ["mid-composition", { isComposing: true }],
  ])("rejects %s", (_name, mods) => {
    expect(acceptsShortcut(key("j", mods), body)).toBe(false);
  });

  it("rejects typing targets and anything in a dialog", () => {
    expect(acceptsShortcut(key("j"), { tagName: "TEXTAREA" })).toBe(false);
    expect(acceptsShortcut(key("j"), { tagName: "BUTTON", inDialog: true })).toBe(false);
  });
});

describe("resolveShortcut: single keys", () => {
  it.each<[string, ShortcutTarget | null, ShortcutAction | null]>([
    ["j", body, { type: "move", delta: 1 }],
    ["k", body, { type: "move", delta: -1 }],
    ["j", null, { type: "move", delta: 1 }],
    ["j", taskButton, { type: "move", delta: 1 }],
    ["k", taskCheckbox, { type: "move", delta: -1 }],
    ["J", body, { type: "move", delta: 1 }], // Caps Lock
    ["q", body, { type: "quickAdd" }],
    ["n", body, { type: "quickAdd" }],
    ["N", body, { type: "quickAdd" }],
    ["?", body, { type: "toggleHelp" }],
    ["x", taskButton, { type: "toggleComplete" }],
    ["x", taskCheckbox, { type: "toggleComplete" }],
    ["x", editorButton, { type: "toggleComplete" }],
    ["X", taskButton, { type: "toggleComplete" }],
    ["e", taskButton, { type: "edit" }],
    ["e", taskCheckbox, { type: "edit" }],
    [" ", taskButton, { type: "toggleComplete" }],
    // Not on a task row: nothing to act on.
    ["x", body, null],
    ["e", body, null],
    ["x", null, null],
    ["x", { tagName: "A" }, null],
    // Space keeps its native meaning off the row's main button.
    [" ", body, null],
    [" ", taskCheckbox, null],
    [" ", editorButton, null],
    [" ", { tagName: "BUTTON" }, null],
    // Unmapped keys, and "/" (core/search handles it).
    ["/", body, null],
    ["a", body, null],
    ["Enter", taskButton, null],
    ["Escape", body, null],
    ["ArrowDown", body, null],
    ["i", body, null],
    ["t", body, null],
    ["g", body, null],
  ])("%j on %j -> %j", (k, target, expected) => {
    expect(action(key(k), target)).toEqual(expected);
  });

  it("ignores Shift with letters and Space, but not with ?", () => {
    expect(action(key("J", { shiftKey: true }))).toBeNull();
    expect(action(key("X", { shiftKey: true }), taskButton)).toBeNull();
    expect(action(key("N", { shiftKey: true }))).toBeNull();
    expect(action(key(" ", { shiftKey: true }), taskButton)).toBeNull();
    expect(action(key("?", { shiftKey: true }))).toEqual({ type: "toggleHelp" });
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Alt", { altKey: true }],
    ["already handled", { defaultPrevented: true }],
    ["mid-composition", { isComposing: true }],
  ] as const)("does nothing with %s", (_name, mods) => {
    for (const [k, target] of [
      ["j", body],
      ["k", body],
      ["x", taskButton],
      [" ", taskButton],
      ["e", taskButton],
      ["q", body],
      ["?", body],
      ["g", body],
    ] as const) {
      const result = resolveShortcut(INITIAL_SHORTCUT_STATE, key(k, mods), target, { now: T0 });
      expect(result, `${k} ${JSON.stringify(mods)}`).toEqual({ state: INITIAL_SHORTCUT_STATE, action: null });
    }
  });

  it("is off while typing in any kind of field", () => {
    const fields: ShortcutTarget[] = [
      { tagName: "INPUT" },
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT", type: "search" },
      { tagName: "INPUT", type: "number" },
      { tagName: "INPUT", type: "date" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
      // The editor's fields are inside a task row too.
      { tagName: "INPUT", type: "text", inTaskRow: true },
      { tagName: "TEXTAREA", inTaskRow: true },
    ];
    for (const target of fields) {
      for (const k of ["j", "k", "x", " ", "e", "q", "n", "?", "g"]) {
        expect(action(key(k), target), `${JSON.stringify(k)} in ${JSON.stringify(target)}`).toBeNull();
      }
    }
    expect(sequence([["g", 0]], { tagName: "INPUT" }).state.gAt).toBeNull();
  });

  it("is off inside a dialog other than the help", () => {
    const inDialog = { tagName: "BUTTON", inDialog: true };
    for (const k of ["j", "x", "e", "q", "?", "g"]) {
      expect(action(key(k), inDialog), k).toBeNull();
    }
  });

  it("only repeats j and k when a key is held", () => {
    expect(action(key("j", { repeat: true }))).toEqual({ type: "move", delta: 1 });
    expect(action(key("k", { repeat: true }))).toEqual({ type: "move", delta: -1 });
    expect(action(key("x", { repeat: true }), taskButton)).toBeNull();
    expect(action(key(" ", { repeat: true }), taskButton)).toBeNull();
    expect(action(key("e", { repeat: true }), taskButton)).toBeNull();
    expect(action(key("q", { repeat: true }))).toBeNull();
    expect(action(key("?", { repeat: true }))).toBeNull();
  });

  it("leaves state alone for a bare modifier press", () => {
    const pending: ShortcutState = { gAt: T0 };
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(resolveShortcut(pending, key(k), body, { now: T0 + 100 })).toEqual({ state: pending, action: null });
    }
  });
});

describe("resolveShortcut: the help dialog", () => {
  const inHelp: ShortcutTarget = { tagName: "BUTTON", inDialog: true };

  it("closes on ?, with or without Shift", () => {
    expect(action(key("?"), inHelp, true)).toEqual({ type: "toggleHelp" });
    expect(action(key("?", { shiftKey: true }), inHelp, true)).toEqual({ type: "toggleHelp" });
  });

  it("ignores every other shortcut while open (Escape is the dialog's own)", () => {
    for (const k of ["j", "k", "x", " ", "e", "q", "n", "g", "/", "Escape"]) {
      expect(action(key(k), inHelp, true), k).toBeNull();
      expect(action(key(k), taskButton, true), k).toBeNull();
    }
    expect(resolveShortcut({ gAt: T0 }, key("i"), inHelp, { now: T0 + 10, helpOpen: true }).action).toBeNull();
  });

  it("ignores ? with Ctrl/Meta/Alt or held down", () => {
    expect(action(key("?", { ctrlKey: true }), inHelp, true)).toBeNull();
    expect(action(key("?", { metaKey: true }), inHelp, true)).toBeNull();
    expect(action(key("?", { altKey: true }), inHelp, true)).toBeNull();
    expect(action(key("?", { repeat: true }), inHelp, true)).toBeNull();
  });
});

describe("resolveShortcut: g sequences", () => {
  it.each([
    ["i", "inbox"],
    ["t", "today"],
    ["u", "upcoming"],
    ["p", "projects"],
    ["I", "inbox"], // Caps Lock
  ] as const)("g then %s goes to %s", (second, to) => {
    expect(
      sequence([
        ["g", 0],
        [second, 300],
      ]),
    ).toEqual({ state: INITIAL_SHORTCUT_STATE, action: { type: "go", to } });
  });

  it("g alone waits for the second key", () => {
    expect(sequence([["g", 0]])).toEqual({ state: { gAt: T0 }, action: null });
  });

  it("works from a task row too", () => {
    expect(
      sequence(
        [
          ["g", 0],
          ["t", 10],
        ],
        taskButton,
      ).action,
    ).toEqual({ type: "go", to: "today" });
  });

  it("times out", () => {
    expect(
      sequence([
        ["g", 0],
        ["i", G_TIMEOUT_MS],
      ]).action,
    ).toEqual({ type: "go", to: "inbox" });
    const late = sequence([
      ["g", 0],
      ["i", G_TIMEOUT_MS + 1],
    ]);
    expect(late).toEqual({ state: INITIAL_SHORTCUT_STATE, action: null });
    // A late second key is a fresh key: "j" then moves.
    expect(
      sequence([
        ["g", 0],
        ["j", G_TIMEOUT_MS + 1],
      ]).action,
    ).toEqual({ type: "move", delta: 1 });
  });

  it("is cancelled, without side effects, by any other key", () => {
    for (const other of ["j", "k", "x", "e", "q", "a", "?", "Enter", "Escape", " "]) {
      const result = sequence(
        [
          ["g", 0],
          [other, 100],
        ],
        taskButton,
      );
      expect(result, JSON.stringify(other)).toEqual({ state: INITIAL_SHORTCUT_STATE, action: null });
      // ...so the following "i" is just "i".
      const after = resolveShortcut(result.state, key("i"), body, { now: T0 + 200 });
      expect(after.action, JSON.stringify(other)).toBeNull();
    }
  });

  it("is cancelled by a Shift-modified second key", () => {
    expect(
      sequence([
        ["g", 0],
        [key("I", { shiftKey: true }), 100],
      ]),
    ).toEqual({ state: INITIAL_SHORTCUT_STATE, action: null });
  });

  it("is cancelled by a press the guard rejects (modified, or typed into a field)", () => {
    expect(
      sequence([
        ["g", 0],
        [key("i", { ctrlKey: true }), 100],
        ["i", 200],
      ]).action,
    ).toBeNull();
    const typed = resolveShortcut({ gAt: T0 }, key("i"), { tagName: "INPUT" }, { now: T0 + 100 });
    expect(typed).toEqual({ state: INITIAL_SHORTCUT_STATE, action: null });
  });

  it("survives a bare Shift or a held g, and a second g restarts the wait", () => {
    expect(
      sequence([
        ["g", 0],
        ["Shift", 100],
        ["i", 200],
      ]).action,
    ).toEqual({ type: "go", to: "inbox" });
    expect(
      sequence([
        ["g", 0],
        [key("g", { repeat: true }), 100],
        ["u", 200],
      ]).action,
    ).toEqual({ type: "go", to: "upcoming" });
    expect(
      sequence([
        ["g", 0],
        ["g", 1000],
        ["p", 1000 + G_TIMEOUT_MS],
      ]).action,
    ).toEqual({ type: "go", to: "projects" });
  });

  it("never fires go without a g first", () => {
    for (const k of ["i", "t", "u", "p"]) expect(action(key(k))).toBeNull();
  });
});

describe("moveIndex", () => {
  it.each<[number, 1 | -1, number, number | null]>([
    // [current, delta, count, expected]
    [-1, 1, 3, 0], // first j selects the first row
    [-1, -1, 3, 0], // so does k
    [0, 1, 3, 1],
    [1, 1, 3, 2],
    [2, 1, 3, 2], // clamped at the end
    [2, -1, 3, 1],
    [0, -1, 3, 0], // clamped at the start
    [0, 1, 1, 0],
    [5, 1, 3, 0], // a stale index starts over
    [-1, 1, 0, null],
    [0, 1, 0, null],
  ])("(%i, %i, %i) -> %s", (current, delta, count, expected) => {
    expect(moveIndex(current, delta, count)).toBe(expected);
  });
});
