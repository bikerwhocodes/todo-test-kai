// Global keyboard shortcuts: the shared "not while typing" guard and the keymap.
// The DOM wiring lives in components/keyboard; this only decides what a keydown means.

export type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  /** Auto-repeat from a held key. */
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
};

/** What a shortcut needs to know about the focused element (event.target). */
export type ShortcutTarget = {
  /** Upper-case tag name, as the DOM reports it. */
  tagName: string;
  /** `type` attribute for inputs. */
  type?: string;
  isContentEditable?: boolean;
  /** Inside an open <dialog> or an element with role="dialog"/aria-modal. */
  inDialog?: boolean;
  /** Inside a task row (its checkbox, its main button or its open editor). */
  inTaskRow?: boolean;
  /** The row's main button itself, where Space would otherwise open the editor. */
  onTaskButton?: boolean;
};

// Inputs that take no typed text; a key pressed on them can't be meant as input.
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** Whether the focused element takes typed text (text-like inputs, textarea, select, contenteditable). */
export function isTypingTarget(target: ShortcutTarget): boolean {
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target.tagName === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
  return false;
}

/**
 * The guard every single-key shortcut shares: no Ctrl/Meta/Alt, not already
 * handled, not mid-composition, and not while the user is typing into a field
 * or working in a dialog. Shift is left to each shortcut.
 */
export function acceptsShortcut(event: ShortcutKeyEvent, target: ShortcutTarget | null): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (!target) return true;
  return !target.inDialog && !isTypingTarget(target);
}

// ---------------------------------------------------------------------------------------
// The keymap ("/" is handled by core/search's shouldFocusSearch)

export type GoTarget = "inbox" | "today" | "upcoming" | "projects";

export type ShortcutAction =
  | { type: "go"; to: GoTarget }
  | { type: "move"; delta: 1 | -1 }
  | { type: "toggleComplete" }
  | { type: "edit" }
  | { type: "quickAdd" }
  | { type: "toggleHelp" };

/** `gAt` is when a pending "g" was pressed, in the same clock as `now`. */
export type ShortcutState = { gAt: number | null };

export const INITIAL_SHORTCUT_STATE: ShortcutState = { gAt: null };

/** How long a pending "g" waits for its second key. */
export const G_TIMEOUT_MS = 1500;

const GO_KEYS = new Map<string, GoTarget>([
  ["i", "inbox"],
  ["t", "today"],
  ["u", "upcoming"],
  ["p", "projects"],
]);

// Pressing these alone starts no shortcut and mustn't cancel a pending "g".
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);

export type ShortcutResult = { state: ShortcutState; action: ShortcutAction | null };

/**
 * Resolves a keydown to an action. `now` is the event's time (e.g.
 * `event.timeStamp`); `helpOpen` says the shortcut help dialog is showing,
 * in which case only "?" (to close it) is a shortcut.
 *
 * "?" accepts Shift, since most layouts need it; letters and Space don't.
 * While a "g" is pending (for G_TIMEOUT_MS) the next key is only the second
 * half of "g i/t/u/p": anything else, including a press the guard rejects,
 * cancels it and does nothing else. A held key repeats j/k only.
 */
export function resolveShortcut(
  state: ShortcutState,
  event: ShortcutKeyEvent,
  target: ShortcutTarget | null,
  { now, helpOpen = false }: { now: number; helpOpen?: boolean },
): ShortcutResult {
  if (MODIFIER_KEYS.has(event.key)) return { state, action: null };
  const none: ShortcutResult = { state: INITIAL_SHORTCUT_STATE, action: null };
  const act = (action: ShortcutAction): ShortcutResult => ({ state: INITIAL_SHORTCUT_STATE, action });

  if (helpOpen) {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.defaultPrevented && !event.isComposing;
    return plain && event.key === "?" && !event.repeat ? act({ type: "toggleHelp" }) : none;
  }
  if (!acceptsShortcut(event, target)) return none;

  // Caps Lock turns "j" into "J"; Shift-modified letters are ruled out below.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const moves = key === "j" || key === "k";
  if (event.repeat && !moves) return { state, action: null };

  const pending = state.gAt !== null && now - state.gAt <= G_TIMEOUT_MS;
  if (pending) {
    if (event.shiftKey) return none;
    const to = GO_KEYS.get(key);
    if (to) return act({ type: "go", to });
    // A second "g" restarts the wait rather than cancelling it.
    return key === "g" ? { state: { gAt: now }, action: null } : none;
  }

  if (key === "?") return act({ type: "toggleHelp" });
  if (event.shiftKey) return none;
  if (moves) return act({ type: "move", delta: key === "j" ? 1 : -1 });
  if (key === "g") return { state: { gAt: now }, action: null };
  if (key === "q" || key === "n") return act({ type: "quickAdd" });

  if (!target?.inTaskRow) return none;
  if (key === "x") return act({ type: "toggleComplete" });
  if (key === "e") return act({ type: "edit" });
  // Space only on the row's main button: on the checkbox it already toggles,
  // and elsewhere it should still scroll or press the focused button.
  if (key === " " && target.onTaskButton) return act({ type: "toggleComplete" });
  return none;
}

/**
 * The row to focus after moving `delta` from `current` (-1 when no row has
 * focus) in a list of `count` rows, clamped at the ends. With no row focused
 * either direction starts at the first. Null when there are no rows.
 */
export function moveIndex(current: number, delta: 1 | -1, count: number): number | null {
  if (count <= 0) return null;
  if (current < 0 || current >= count) return 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}
