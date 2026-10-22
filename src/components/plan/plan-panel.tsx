"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { formatEstimate } from "@/core/format";
import { explainReasons } from "@/core/scheduler/explain";
import {
  acceptPlanAction,
  dismissSuggestionAction,
  removePlanItemAction,
  reorderPlanAction,
  suggestPlanAction,
} from "@/server/actions/plans";
import { rememberAvailableTimeAction } from "@/server/actions/settings";
import { createTaskAction, updateTaskAction } from "@/server/actions/tasks";
import type { PlanDraft } from "@/server/repo/plans";
import { primaryButtonClass, quietButtonClass, secondaryButtonClass } from "@/components/ui";
import { OPEN_PLAN_EVENT, OPEN_PLAN_PARAM } from "./events";
import {
  acceptLabel,
  acceptPayload,
  findRow,
  formatOver,
  formatPlannedOf,
  initialPanelState,
  isPreset,
  manualRow,
  moveAnnouncement,
  moveTo,
  panelReducer,
  planTotals,
  rowIds,
  splitTitle,
  suggestionRow,
  type PlanOption,
  type PlanRow,
  type SavedPlanItem,
  type Segment,
} from "./model";
import { PLAN_TRIGGER_ATTR } from "./plan-button";
import { BlockedSection, DidntFitSection, NothingFits, NothingToPlan, type DidntFitItem } from "./plan-extras";
import { PlanList, focusPlanRow } from "./plan-list";
import { PLAN_SEARCH_ID_ATTR, PlanSearch } from "./plan-search";
import { TIME_STEP_FOCUS_ATTR, TimeStep } from "./time-step";

export type PlanPanelProps = {
  /** Today's plan, in order, done items included. */
  saved: SavedPlanItem[];
  /** The time on today's plan, if one was chosen. */
  planAvailableMin: number | null;
  /** The custom time the user last entered, to prefill "Custom". */
  lastAvailableMin: number | null;
  /** user_settings.default_estimate_min: what a task without an estimate counts as. */
  defaultEstimateMin: number;
  /** The user's open tasks, for "Add a task". */
  options: PlanOption[];
};

type Result<T = void> = { ok: true; data: T } | { ok: false; error: string };

const OFFLINE = "Couldn't reach NextUp. Check your connection and try again.";

/** Runs a server action; a thrown error (network, server crash) becomes a failed result. */
async function call<T>(action: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await action();
  } catch {
    return { ok: false, error: OFFLINE };
  }
}

/**
 * Plan My Day (spec §4.5): a native modal dialog, full screen on phones and a
 * side sheet from `sm` up. It opens on OPEN_PLAN_EVENT (the "Plan my day"
 * buttons and the "p" shortcut) and on `?plan=1`, and gives focus back to the
 * opener when it closes. Each opening starts afresh from the page's props.
 */
export function PlanPanel(props: PlanPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  // Bumped on each opening; keys the body so its state starts afresh.
  const [session, setSession] = useState(0);
  // Saved-plan edits (remove, reorder, estimates) happen at once; refresh Today on close.
  const changedRef = useRef(false);
  const titleId = useId();

  function open() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    returnFocusRef.current = document.activeElement;
    changedRef.current = false;
    setSession((s) => s + 1);
  }
  const openRef = useRef(open);
  openRef.current = open;

  // Show the dialog once the fresh body has rendered, then focus step 1.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (session === 0 || !dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(`[${TIME_STEP_FOCUS_ATTR}]`)?.focus();
  }, [session]);

  useEffect(() => {
    const onOpen = () => openRef.current();
    window.addEventListener(OPEN_PLAN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PLAN_EVENT, onOpen);
  }, []);

  // `/today?plan=1` (the "p" shortcut from another page): open, then drop the param.
  useEffect(() => {
    if (!searchParams.has(OPEN_PLAN_PARAM)) return;
    openRef.current();
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete(OPEN_PLAN_PARAM);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  function onClosed() {
    if (changedRef.current) router.refresh();
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    // After accepting, the button that opened the panel may have re-rendered away.
    const target =
      el instanceof HTMLElement && el.isConnected && el !== document.body
        ? el
        : document.querySelector<HTMLElement>(`[${PLAN_TRIGGER_ATTR}]`);
    target?.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClosed}
      onClick={(e) => {
        // The backdrop beside the sheet; a click there lands on the <dialog> itself.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      // Full screen below sm; from sm up a sheet on the right (fixed, inset 0, so ml-auto pins it there).
      className="m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-stone-900 backdrop:bg-stone-900/30 sm:ml-auto sm:max-w-lg"
    >
      {session > 0 && (
        <PanelBody
          key={session}
          {...props}
          titleId={titleId}
          onChanged={() => (changedRef.current = true)}
          onClose={() => dialogRef.current?.close()}
          onAccepted={() => {
            changedRef.current = true;
            dialogRef.current?.close();
          }}
        />
      )}
    </dialog>
  );
}

type Step = "time" | "review";

type Suggested = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; draft: PlanDraft };

function PanelBody({
  saved,
  planAvailableMin,
  lastAvailableMin,
  defaultEstimateMin,
  options,
  titleId,
  onChanged,
  onClose,
  onAccepted,
}: PlanPanelProps & {
  titleId: string;
  onChanged: () => void;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [step, setStep] = useState<Step>("time");
  const [availableMin, setAvailableMin] = useState<number | null>(planAvailableMin);
  const [suggested, setSuggested] = useState<Suggested | null>(null);
  const [state, dispatch] = useReducer(panelReducer, saved, initialPanelState);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Only the latest suggestion request may set the draft.
  const requestRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timeHeadingId = useId();
  const reviewHeadingId = useId();

  const draft = suggested?.status === "ready" ? suggested.draft : null;
  const inList = rowIds(state);
  const totals = planTotals([...state.saved, ...state.draft], availableMin ?? 0, defaultEstimateMin);

  // --- Step 1 ---

  async function choose(minutes: number, custom: boolean) {
    setAvailableMin(minutes);
    setStep("review");
    setError(null);
    setAcceptError(null);
    setSuggested({ status: "loading" });
    requestAnimationFrame(() => document.getElementById(reviewHeadingId)?.focus());
    if (custom) {
      void call(() => rememberAvailableTimeAction({ availableMin: minutes })).then((r) => {
        if (!r.ok) setNotice("Couldn't remember this time for next time.");
      });
    }
    const request = ++requestRef.current;
    const result = await call(() => suggestPlanAction({ availableMin: minutes }));
    if (request !== requestRef.current) return;
    if (!result.ok) return setSuggested({ status: "error", error: result.error });
    const next = result.data;
    dispatch({
      type: "setDraft",
      suggestions: next.suggestions.map((s) =>
        suggestionRow({
          id: s.task.id,
          title: s.title,
          estimateMin: s.task.estimateMin,
          reasons: explainReasons(s.reasons),
        }),
      ),
    });
    setSuggested({ status: "ready", draft: next });
  }

  function changeTime() {
    requestRef.current++;
    setStep("time");
    setNotice(null);
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(`[${TIME_STEP_FOCUS_ATTR}]`)?.focus());
  }

  // --- The list ---

  /** Focus for after `taskId` leaves the list: the next row, else the previous, else the search. */
  function neighbourOf(taskId: string): string | null {
    const all = [...stateRef.current.saved, ...stateRef.current.draft];
    const i = all.findIndex((r) => r.taskId === taskId);
    return all[i + 1]?.taskId ?? all[i - 1]?.taskId ?? null;
  }

  function focusAfterRender(taskId: string | null) {
    requestAnimationFrame(() => {
      if (taskId && focusPlanRow(taskId)) return;
      bodyRef.current?.querySelector<HTMLElement>(`[${PLAN_SEARCH_ID_ATTR}]`)?.focus();
    });
  }

  async function remove(taskId: string) {
    const found = findRow(stateRef.current, taskId);
    if (!found) return;
    const { segment, index, row } = found;
    const restore = (message: string) => {
      dispatch({ type: "restore", segment, index, row });
      setError(message);
    };
    setError(null);
    focusAfterRender(neighbourOf(taskId));
    dispatch({ type: "remove", taskId });
    setAnnouncement(`Removed ${row.title}`);
    if (row.kind === "manual") return;

    if (row.kind === "saved") {
      onChanged();
      const removed = await call(() => removePlanItemAction({ taskId }));
      if (!removed.ok) return restore(removed.error);
      // So it doesn't come straight back as a suggestion today.
      const dismissed = await call(() => dismissSuggestionAction({ taskId }));
      if (!dismissed.ok) setError(`Removed ${row.title} from your plan, but it may be suggested again today.`);
      return;
    }
    const dismissed = await call(() => dismissSuggestionAction({ taskId }));
    if (!dismissed.ok) restore(dismissed.error);
  }

  async function move(segment: Segment, from: number, to: number) {
    const before = stateRef.current[segment];
    const after = moveTo(before, from, to);
    if (after === before) return;
    const row = before[from]!;
    dispatch({ type: "setOrder", segment, rows: after });
    setAnnouncement(moveAnnouncement(row.title, to, after.length));
    focusAfterRender(row.taskId);
    if (segment === "draft") return;

    onChanged();
    setError(null);
    const result = await call(() => reorderPlanAction({ taskIds: after.map((r) => r.taskId) }));
    if (!result.ok) {
      dispatch({ type: "setOrder", segment, rows: before });
      setError(result.error);
    }
  }

  async function saveEstimate(taskId: string, estimateMin: number | null): Promise<string | null> {
    const result = await call(() => updateTaskAction({ id: taskId, estimateMin }));
    if (!result.ok) return result.error;
    onChanged();
    dispatch({ type: "setEstimate", taskId, estimateMin: result.data.estimateMin });
    return null;
  }

  function addManual(task: { id: string; title: string; estimateMin: number | null }) {
    if (inList.has(task.id)) return;
    dispatch({ type: "addManual", row: manualRow(task) });
    setAnnouncement(`Added ${task.title}`);
  }

  function addAnyway(d: DidntFitItem) {
    addManual({ id: d.task.id, title: d.title, estimateMin: d.task.estimateMin });
  }

  /** Makes "<title> (part 1)" with the original's priority and deadline, and adds it to the draft. */
  async function split(d: DidntFitItem, minutes: number): Promise<string | null> {
    const title = splitTitle(d.title);
    const created = await call(() => createTaskAction({ title, projectId: d.projectId }));
    if (!created.ok) return created.error;
    onChanged();
    const task = created.data;
    const updated = await call(() =>
      updateTaskAction({ id: task.id, estimateMin: minutes, priority: d.task.priority, deadline: d.task.deadline }),
    );
    addManual({ id: task.id, title: task.title, estimateMin: updated.ok ? updated.data.estimateMin : null });
    if (!updated.ok) setError(`Added ${task.title}, but couldn't set its estimate: ${updated.error}`);
    return null;
  }

  // --- Footer ---

  async function accept() {
    if (accepting || availableMin === null || suggested?.status === "loading") return;
    setAccepting(true);
    setAcceptError(null);
    const result = await call(() => acceptPlanAction(acceptPayload(stateRef.current.draft, availableMin)));
    setAccepting(false);
    if (!result.ok) return setAcceptError(result.error);
    onAccepted();
  }

  // --- Review content ---

  const shown = (items: ReadonlyArray<DidntFitItem>) => items.filter((d) => !inList.has(d.task.id));
  const nothingFitsShortest = draft?.nothingFits ? shown(draft.nothingFits.shortest) : [];
  const nothingFitsIds = new Set(nothingFitsShortest.map((d) => d.task.id));
  const didntFit = draft ? shown(draft.didntFit).filter((d) => !nothingFitsIds.has(d.task.id)) : [];
  const nothingToPlan =
    draft !== null &&
    draft.suggestions.length === 0 &&
    draft.didntFit.length === 0 &&
    draft.nothingFits === null &&
    state.saved.length === 0 &&
    state.draft.length === 0;
  const blockedIds = draft ? draft.blocked.map((b) => b.id) : [];
  const hasRows = state.saved.length + state.draft.length > 0;

  return (
    <div
      ref={bodyRef}
      onKeyDown={(e) => {
        // Ctrl/⌘+Enter accepts from anywhere in step 2; plain Enter never does.
        if (step === "review" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void accept();
        }
      }}
      className="flex h-full flex-col bg-white shadow-xl sm:border-l sm:border-stone-200"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-4 py-2">
        <h2 id={titleId} className="font-semibold">
          Plan my day
        </h2>
        <button type="button" onClick={onClose} className={`${quietButtonClass} min-h-9`}>
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {step === "time" ? (
          <TimeStep
            headingId={timeHeadingId}
            selectedMin={availableMin}
            // Today's (or just chosen) custom time, else the one remembered from last time.
            customDefault={availableMin !== null && !isPreset(availableMin) ? availableMin : lastAvailableMin}
            onChoose={(m, custom) => void choose(m, custom)}
          />
        ) : (
          <section aria-labelledby={reviewHeadingId} aria-busy={suggested?.status === "loading"} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <h3 id={reviewHeadingId} tabIndex={-1} className="min-w-0 text-base font-medium outline-none">
                {formatEstimate(availableMin ?? 0)} available
              </h3>
              <button type="button" onClick={changeTime} className={`${quietButtonClass} min-h-9`}>
                Change
              </button>
            </div>
            {notice && <p className="text-xs text-stone-500">{notice}</p>}

            <div className="rounded-md bg-stone-100 px-3 py-2">
              <p className="text-sm text-stone-800 tabular-nums">
                {formatPlannedOf(totals.plannedMin, totals.availableMin)}
              </p>
              {/* Always rendered so screen readers hear the warning appear. */}
              <p role="status" aria-live="polite" className="text-sm text-amber-800">
                {totals.overMin > 0 ? `${formatOver(totals.overMin)}. You can still add these.` : ""}
              </p>
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}

            {suggested?.status === "loading" && <p className="text-sm text-stone-500">Finding tasks that fit…</p>}
            {suggested?.status === "error" && (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-red-700">
                  {suggested.error}
                </p>
                <button
                  type="button"
                  onClick={() => availableMin !== null && void choose(availableMin, false)}
                  className={`${secondaryButtonClass} min-h-9`}
                >
                  Try again
                </button>
              </div>
            )}

            {draft?.nothingFits && (
              <NothingFits
                availableMin={availableMin ?? 0}
                shortest={nothingFitsShortest}
                onAddAnyway={addAnyway}
                onMoreTime={changeTime}
              />
            )}
            {nothingToPlan && draft && <NothingToPlan draft={draft} />}

            {hasRows && (
              <div>
                <PlanList
                  saved={state.saved}
                  draft={state.draft}
                  defaultEstimateMin={defaultEstimateMin}
                  onMove={(segment, from, to) => void move(segment, from, to)}
                  onRemove={(id) => void remove(id)}
                  onSaveEstimate={saveEstimate}
                />
              </div>
            )}

            <PlanSearch options={options} excludeIds={new Set([...inList, ...blockedIds])} onPick={addManual} />

            <div className="space-y-2">
              <DidntFitSection
                items={didntFit}
                remainingMin={totals.remainingMin}
                onAddAnyway={addAnyway}
                onSplit={split}
              />
              {draft && <BlockedSection items={draft.blocked} />}
            </div>
          </section>
        )}
      </div>

      {step === "review" && (
        <footer className="shrink-0 border-t border-stone-200 px-4 py-3">
          {acceptError && (
            <p role="alert" className="mb-2 text-sm text-red-700">
              {acceptError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={onClose} className={`${secondaryButtonClass} min-h-9`}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void accept()}
              disabled={accepting || suggested?.status === "loading"}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              className={`${primaryButtonClass} min-h-9`}
            >
              {accepting ? "Saving…" : acceptLabel(state.draft.length)}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

// Re-exported for the page's prop types.
export type { PlanOption, PlanRow, SavedPlanItem };
