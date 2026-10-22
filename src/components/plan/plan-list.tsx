"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { formatEstimate } from "@/core/format";
import { focusRingClass } from "@/components/ui";
import { dropIndex, effectiveEstimate, readDuration, type PlanRow, type Segment } from "./model";

/** The attribute on each row; its value is the task id. The panel focuses rows by it. */
export const PLAN_ROW_ATTR = "data-plan-row";

/** Focuses the row for `taskId`, if it is on the page. */
export function focusPlanRow(taskId: string): boolean {
  const el = document.querySelector<HTMLElement>(`[${PLAN_ROW_ATTR}="${CSS.escape(taskId)}"]`);
  el?.focus();
  return el !== null;
}

const chipClass = "inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-xs";

type Drag = { segment: Segment; from: number };
type Drop = { segment: Segment; before: number };

/**
 * The review list: today's saved plan, then the draft, as one ordered list. Rows
 * reorder within their segment by dragging the handle or with Alt+↑/↓, and are
 * removed with × or Backspace/Delete. Estimates are edited in place.
 */
export function PlanList({
  saved,
  draft,
  defaultEstimateMin,
  onMove,
  onRemove,
  onSaveEstimate,
}: {
  saved: PlanRow[];
  draft: PlanRow[];
  defaultEstimateMin: number;
  onMove: (segment: Segment, from: number, to: number) => void;
  onRemove: (taskId: string) => void;
  /** Resolves to an error message, or null once saved. */
  onSaveEstimate: (taskId: string, estimateMin: number | null) => Promise<string | null>;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const hintId = useId();

  function endDrag() {
    setDrag(null);
    setDrop(null);
  }

  function renderRows(segment: Segment, rows: PlanRow[]) {
    return rows.map((row, index) => {
      // A drop that would leave the row where it is isn't shown.
      const target = drag?.segment === segment && drop?.segment === segment ? drop.before : null;
      const noOp = target !== null && drag !== null && (target === drag.from || target === drag.from + 1);
      const lineAbove = !noOp && target === index;
      const lineBelow = !noOp && target === rows.length && index === rows.length - 1;
      return (
        <PlanRowItem
          key={row.taskId}
          row={row}
          defaultEstimateMin={defaultEstimateMin}
          hintId={hintId}
          dropLine={lineAbove ? "above" : lineBelow ? "below" : null}
          dragging={drag?.segment === segment && drag.from === index}
          first={index === 0}
          last={index === rows.length - 1}
          onKeyMove={(delta) => onMove(segment, index, index + delta)}
          onRemove={() => onRemove(row.taskId)}
          onSaveEstimate={(min) => onSaveEstimate(row.taskId, min)}
          onDragStart={() => setDrag({ segment, from: index })}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!drag || drag.segment !== segment) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = e.currentTarget.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
            if (drop?.segment !== segment || drop.before !== before) setDrop({ segment, before });
          }}
          onDrop={(e) => {
            if (!drag || drag.segment !== segment || !drop || drop.segment !== segment) return;
            e.preventDefault();
            onMove(segment, drag.from, dropIndex(drag.from, drop.before));
            endDrag();
          }}
        />
      );
    });
  }

  return (
    <>
      <p id={hintId} className="sr-only">
        Alt plus arrow up or down moves the task. Delete or Backspace removes it.
      </p>
      <ol aria-label="Your plan for today" className="border-t border-stone-200">
        {renderRows("saved", saved)}
        {saved.length > 0 && draft.length > 0 && (
          <li aria-hidden="true" className="border-b border-stone-200 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-500">
            New
          </li>
        )}
        {renderRows("draft", draft)}
      </ol>
      <p className="mt-2 hidden text-xs text-stone-500 sm:block">
        Drag <span aria-hidden>⠿</span> or press Alt+↑/↓ to reorder. Delete removes the focused task.
      </p>
    </>
  );
}

function PlanRowItem({
  row,
  defaultEstimateMin,
  hintId,
  dropLine,
  dragging,
  first,
  last,
  onKeyMove,
  onRemove,
  onSaveEstimate,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  row: PlanRow;
  defaultEstimateMin: number;
  hintId: string;
  dropLine: "above" | "below" | null;
  dragging: boolean;
  first: boolean;
  last: boolean;
  onKeyMove: (delta: number) => void;
  onRemove: () => void;
  onSaveEstimate: (estimateMin: number | null) => Promise<string | null>;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLLIElement>) => void;
  onDrop: (e: React.DragEvent<HTMLLIElement>) => void;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLLIElement>) {
    // Keys typed into the estimate field are its own.
    if (e.target instanceof HTMLInputElement) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      onKeyMove(e.key === "ArrowUp" ? -1 : 1);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onRemove();
    }
  }

  const line =
    dropLine === "above"
      ? "shadow-[inset_0_2px_0_0_var(--color-stone-700)]"
      : dropLine === "below"
        ? "shadow-[inset_0_-2px_0_0_var(--color-stone-700)]"
        : "";

  return (
    <li
      {...{ [PLAN_ROW_ATTR]: row.taskId }}
      tabIndex={0}
      aria-describedby={hintId}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete Backspace"
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex items-start gap-1.5 border-b border-stone-200 py-1.5 pr-0.5 outline-none focus-visible:bg-stone-100 focus-visible:ring-2 focus-visible:ring-stone-500 focus-visible:ring-inset ${line} ${
        dragging ? "opacity-50" : ""
      }`}
    >
      <span
        draggable
        aria-hidden="true"
        title="Drag to reorder"
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          // Firefox starts a drag only once some data is set. Not text/plain, so a
          // stray drop on the search field doesn't type the title into it.
          e.dataTransfer.setData("application/x-nextup-plan-row", row.taskId);
          const li = e.currentTarget.closest("li");
          if (li) e.dataTransfer.setDragImage(li, 12, 12);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        className="flex min-h-9 w-6 shrink-0 cursor-grab items-center justify-center text-stone-400 select-none hover:text-stone-700 active:cursor-grabbing pointer-coarse:hidden"
      >
        ⠿
      </span>
      {/* Touch screens can't drag natively (and have no Alt+arrows): move buttons instead. */}
      <span className="hidden shrink-0 flex-col pointer-coarse:flex">
        <button
          type="button"
          onClick={() => onKeyMove(-1)}
          disabled={first}
          aria-label={`Move ${row.title} up`}
          className={`flex h-9 w-9 items-center justify-center rounded-md text-stone-500 disabled:opacity-30 ${focusRingClass}`}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onKeyMove(1)}
          disabled={last}
          aria-label={`Move ${row.title} down`}
          className={`flex h-9 w-9 items-center justify-center rounded-md text-stone-500 disabled:opacity-30 ${focusRingClass}`}
        >
          ↓
        </button>
      </span>
      <div className="min-w-0 flex-1 py-1">
        <p className={`text-sm break-words ${row.done ? "text-stone-500 line-through" : "text-stone-900"}`}>
          {row.title}
          {row.done && <span className="sr-only"> (done, not counted)</span>}
        </p>
        <RowChips row={row} />
      </div>
      <EstimateControl
        row={row}
        defaultEstimateMin={defaultEstimateMin}
        onSave={onSaveEstimate}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${row.title}`}
        title="Remove"
        className={`flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-lg leading-none text-stone-400 hover:bg-stone-200 hover:text-stone-800 ${focusRingClass}`}
      >
        ×
      </button>
    </li>
  );
}

function RowChips({ row }: { row: PlanRow }) {
  const chips: React.ReactNode[] = [];
  if (row.kind === "saved") {
    chips.push(
      <span key="saved" className={`${chipClass} bg-stone-200 text-stone-700`}>
        Planned
      </span>,
    );
  } else if (row.kind === "manual") {
    chips.push(
      <span key="manual" className={`${chipClass} bg-sky-50 text-sky-800`}>
        Added by you
      </span>,
    );
  } else {
    row.reasons.forEach((reason, i) =>
      chips.push(
        <Fragment key={`r${i}`}>
          {i === 0 && <span className="sr-only">Why: </span>}
          <span className={`${chipClass} bg-amber-50 break-words text-amber-900`}>{reason}</span>
        </Fragment>,
      ),
    );
  }
  return <div className="mt-1 flex flex-wrap items-center gap-1.5">{chips}</div>;
}

/**
 * The row's estimate as a button; Enter or a click turns it into a field
 * ("45", "1h 30m"; empty clears it). Enter saves, Escape cancels.
 */
function EstimateControl({
  row,
  defaultEstimateMin,
  onSave,
}: {
  row: PlanRow;
  defaultEstimateMin: number;
  onSave: (estimateMin: number | null) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set once the edit ends, so the blur from the field going away doesn't save again.
  const closing = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const assumed = row.estimateMin === null;
  const shown = formatEstimate(effectiveEstimate(row.estimateMin, defaultEstimateMin));
  const initial = row.estimateMin === null ? "" : formatEstimate(row.estimateMin);

  if (row.done) {
    return <span className="shrink-0 px-1 py-2.5 text-xs text-stone-400 line-through">{shown}</span>;
  }

  function start() {
    closing.current = false;
    setText(initial);
    setError(null);
    setEditing(true);
  }

  function stop(refocus: boolean) {
    closing.current = true;
    setEditing(false);
    if (refocus) requestAnimationFrame(() => focusPlanRow(row.taskId));
  }

  async function save(refocus: boolean) {
    if (saving || closing.current) return;
    if (text.trim() === initial) return stop(refocus);
    const result = readDuration(text, { allowEmpty: true });
    if (!result.ok) return setError(result.error);
    setSaving(true);
    const failed = await onSave(result.minutes);
    setSaving(false);
    if (failed) setError(failed);
    else stop(refocus);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        aria-label={
          assumed
            ? `Estimate for ${row.title}: ${shown}, assumed. Set an estimate`
            : `Estimate for ${row.title}: ${shown}. Change it`
        }
        title={assumed ? "Assumed (your default estimate). Click to set one." : "Change the estimate"}
        className={`min-h-9 shrink-0 rounded-md px-1.5 text-xs tabular-nums hover:bg-stone-200 ${focusRingClass} ${
          assumed ? "text-stone-400 italic underline decoration-dotted underline-offset-2" : "text-stone-600"
        }`}
      >
        {shown}
        {assumed && <span aria-hidden>?</span>}
      </button>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end">
      <input
        ref={inputRef}
        type="text"
        value={text}
        // Read-only rather than disabled while saving: disabling would blur it.
        readOnly={saving}
        aria-busy={saving || undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save(true);
          } else if (e.key === "Escape") {
            // Cancels the edit without closing the dialog.
            e.preventDefault();
            e.stopPropagation();
            stop(true);
          }
        }}
        // Clicking away saves a valid change; an invalid one stays open with its error.
        onBlur={() => {
          if (!error) void save(false);
        }}
        aria-label={`Estimate for ${row.title}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder={formatEstimate(defaultEstimateMin)}
        className="min-h-9 w-20 rounded-md border border-stone-300 bg-white px-2 text-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 aria-busy:opacity-60"
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 max-w-36 text-right text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
