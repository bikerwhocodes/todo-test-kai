import type { ShortcutTarget } from "@/core/shortcuts";

// Hooks TaskRow puts on its markup for the keyboard shortcuts to find.
export const TASK_ROW = "[data-task-row]";
export const TASK_BUTTON = "[data-task-button]";
export const TASK_CHECKBOX = "[data-task-checkbox]";

/** The focused element (event.target) as the pure shortcut rules see it. */
export function describeTarget(target: EventTarget | null): ShortcutTarget | null {
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    type: target instanceof HTMLInputElement ? target.type : undefined,
    isContentEditable: target.isContentEditable,
    inDialog: target.closest('dialog[open], [role="dialog"], [aria-modal="true"]') !== null,
    inTaskRow: target.closest(TASK_ROW) !== null,
    onTaskButton: target.matches(TASK_BUTTON),
  };
}
