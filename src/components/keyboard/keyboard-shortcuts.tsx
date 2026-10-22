"use client";

import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useId, useRef } from "react";
import { INITIAL_SHORTCUT_STATE, moveIndex, resolveShortcut, type ShortcutAction } from "@/core/shortcuts";
import { OPEN_PLAN_EVENT, OPEN_PLAN_PARAM } from "@/components/plan/events";
import { QUICK_ADD_ID } from "@/components/tasks/quick-add";
import { focusRingClass, quietButtonClass } from "@/components/ui";
import { TASK_BUTTON, TASK_CHECKBOX, TASK_ROW, describeTarget } from "./target";

const GO_PATHS = { inbox: "/inbox", today: "/today", upcoming: "/upcoming" } as const;

/**
 * How long after "x" a row that re-renders away (e.g. into "Completed") gets
 * focus put back, and how long after "q" on a page without quick add we wait
 * for Inbox's to appear.
 */
const RESTORE_MS = 10_000;

// Each entry: alternatives, each a sequence of keys ("g then i").
const HELP: { heading: string; items: [string[][], string][] }[] = [
  {
    heading: "Go to",
    items: [
      [[["g", "i"]], "Inbox"],
      [[["g", "t"]], "Today"],
      [[["g", "u"]], "Upcoming"],
      [[["g", "p"]], "Projects (in the sidebar)"],
      [[["/"]], "Search"],
    ],
  },
  { heading: "Plan", items: [[[["p"]], "Plan My Day"]] },
  {
    heading: "Tasks",
    items: [
      [[["j"]], "Next task"],
      [[["k"]], "Previous task"],
      [[["x"], ["Space"]], "Complete or reopen"],
      [[["e"], ["Enter"]], "Edit"],
      [[["Esc"]], "Close the editor"],
      [[["q"], ["n"]], "New task"],
    ],
  },
  { heading: "Help", items: [[[["?"]], "Show or hide shortcuts"]] },
];

/** Task rows' main buttons in page order, leaving out hidden ones (e.g. in a closed "Completed"). */
function visibleTaskButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(TASK_BUTTON)).filter((el) => el.getClientRects().length > 0);
}

/** The main button of the task row containing `el`, if any. */
function rowButton(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof Element)) return null;
  return el.closest(TASK_ROW)?.querySelector<HTMLElement>(TASK_BUTTON) ?? null;
}

/** "g p": the current project's link, else the first; with no projects, start a new one. */
function focusProjects() {
  const link =
    document.querySelector<HTMLElement>('[data-project-link][aria-current="page"]') ??
    document.querySelector<HTMLElement>("[data-project-link]");
  if (link) return link.focus();
  const create = document.querySelector<HTMLElement>("[data-new-project]");
  if (create instanceof HTMLButtonElement) create.click();
  else create?.focus();
}

/**
 * The app-wide shortcuts (see core/shortcuts; "/" is SearchShortcut's), plus
 * the "Shortcuts" button and the help dialog it and "?" open.
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  // Read by the keydown listener; a ref so navigating doesn't re-register it
  // (which would drop a pending "g" or the quick add focus after "q").
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const titleId = useId();

  function openHelp() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    returnFocusRef.current = document.activeElement;
    dialog.showModal();
  }

  function onHelpClosed() {
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  }

  useEffect(() => {
    let state = INITIAL_SHORTCUT_STATE;
    // Space toggled a task on keydown; its keyup mustn't also press the button.
    let spaceToggled = false;
    // After "x", the row to put focus back on if its re-render drops focus.
    let restore: { taskId: string; index: number; until: number } | null = null;
    // After "q" sent us to Inbox, focus its quick add once it renders.
    let quickAddUntil: number | null = null;

    function run(action: ShortcutAction, target: EventTarget | null) {
      switch (action.type) {
        case "go":
          if (action.to === "projects") focusProjects();
          else router.push(GO_PATHS[action.to]);
          return;
        case "move": {
          const buttons = visibleTaskButtons();
          const own = rowButton(document.activeElement);
          const next = moveIndex(own ? buttons.indexOf(own) : -1, action.delta, buttons.length);
          if (next !== null) buttons[next]?.focus();
          return;
        }
        case "toggleComplete": {
          const own = rowButton(target);
          const row = own?.closest<HTMLElement>(TASK_ROW);
          const checkbox = row?.querySelector<HTMLInputElement>(TASK_CHECKBOX);
          if (!own || !row || !checkbox) return;
          const index = Math.max(0, visibleTaskButtons().indexOf(own));
          restore = { taskId: row.dataset.taskId ?? "", index, until: performance.now() + RESTORE_MS };
          checkbox.click();
          return;
        }
        case "edit": {
          const own = rowButton(target);
          if (!own) return;
          if (own.getAttribute("aria-expanded") !== "true") own.click();
          // The editor appears on React's next commit; focus its first field after that.
          requestAnimationFrame(() => {
            const id = own.getAttribute("aria-controls");
            const editor = id ? document.getElementById(id) : null;
            editor?.querySelector<HTMLElement>("input, textarea, select")?.focus();
          });
          return;
        }
        case "quickAdd": {
          const input = document.getElementById(QUICK_ADD_ID);
          if (input instanceof HTMLInputElement) return input.focus();
          quickAddUntil = performance.now() + RESTORE_MS;
          router.push("/inbox");
          return;
        }
        case "planMyDay":
          // On Today the panel listens for the event; elsewhere it opens from the URL.
          if (pathnameRef.current === "/today") window.dispatchEvent(new Event(OPEN_PLAN_EVENT));
          else router.push(`/today?${OPEN_PLAN_PARAM}=1`);
          return;
        case "toggleHelp":
          if (dialogRef.current?.open) dialogRef.current.close();
          else openHelp();
          return;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      restore = null;
      quickAddUntil = null;
      const result = resolveShortcut(state, event, describeTarget(event.target), {
        now: event.timeStamp,
        helpOpen: dialogRef.current?.open === true,
      });
      state = result.state;
      if (!result.action) return;
      // Also stops Space scrolling the page.
      event.preventDefault();
      spaceToggled = event.key === " ";
      run(result.action, event.target);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== " " || !spaceToggled) return;
      spaceToggled = false;
      event.preventDefault();
    }

    // A completed task moves to "Completed" (or off Today) when the server
    // re-renders, taking focus with it. Put focus back on the row, or on the
    // row now in its place if it's hidden or gone.
    const observer = new MutationObserver(() => {
      if (quickAddUntil !== null) {
        const input = document.getElementById(QUICK_ADD_ID);
        if (performance.now() > quickAddUntil) quickAddUntil = null;
        else if (input instanceof HTMLInputElement) {
          quickAddUntil = null;
          input.focus();
        }
        return;
      }
      const r = restore;
      if (!r) return;
      if (performance.now() > r.until) {
        restore = null;
        return;
      }
      if (document.activeElement && document.activeElement !== document.body) return;
      const buttons = visibleTaskButtons();
      const same = buttons.find((b) => b.closest<HTMLElement>(TASK_ROW)?.dataset.taskId === r.taskId);
      (same ?? buttons[Math.min(r.index, buttons.length - 1)])?.focus();
    });

    function onPointerDown() {
      restore = null;
      quickAddUntil = null;
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onPointerDown);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerdown", onPointerDown);
      observer.disconnect();
    };
  }, [router]);

  return (
    <>
      <button
        type="button"
        onClick={openHelp}
        aria-haspopup="dialog"
        aria-keyshortcuts="?"
        title="Keyboard shortcuts (?)"
        className={`rounded-md px-2 py-1 hover:bg-stone-200 hover:text-stone-900 ${focusRingClass}`}
      >
        Shortcuts <Kbd>?</Kbd>
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={onHelpClosed}
        // A click on the backdrop lands on the <dialog> itself.
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-stone-200 bg-white p-0 text-stone-900 shadow-lg backdrop:bg-stone-900/30"
      >
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id={titleId} className="font-semibold">
              Keyboard shortcuts
            </h2>
            <button type="button" onClick={() => dialogRef.current?.close()} className={quietButtonClass}>
              Close
            </button>
          </div>
          {HELP.map((section) => (
            <section key={section.heading} className="mt-4 first:mt-0">
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-stone-500 uppercase">{section.heading}</h3>
              <dl className="divide-y divide-stone-100 text-sm">
                {section.items.map(([alternatives, label]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4 py-1.5">
                    <dt className="text-stone-700">{label}</dt>
                    <dd className="shrink-0 text-xs text-stone-500">
                      <Keys alternatives={alternatives} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <p className="mt-4 text-xs text-stone-500">Shortcuts are off while you type in a field.</p>
        </div>
      </dialog>
    </>
  );
}

function Keys({ alternatives }: { alternatives: string[][] }) {
  return alternatives.map((sequence, i) => (
    <Fragment key={i}>
      {i > 0 && " or "}
      {sequence.map((key, j) => (
        <Fragment key={j}>
          {j > 0 && " then "}
          <Kbd>{key}</Kbd>
        </Fragment>
      ))}
    </Fragment>
  ));
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-xs text-stone-700">
      {children}
    </kbd>
  );
}
