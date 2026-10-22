// Shared Tailwind class strings, matching the auth form styling.

/** Keyboard focus ring for buttons and links (mouse clicks don't show it). */
export const focusRingClass = "outline-none focus-visible:ring-2 focus-visible:ring-stone-500";

export const inputClass =
  "block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-base outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 disabled:opacity-60";

export const primaryButtonClass =
  `rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60 ${focusRingClass}`;

export const secondaryButtonClass =
  `rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-60 ${focusRingClass}`;

export const quietButtonClass =
  `rounded-md px-2 py-1 text-sm text-stone-600 hover:bg-stone-200 hover:text-stone-900 disabled:opacity-60 ${focusRingClass}`;

export const labelClass = "mb-1 block text-sm font-medium text-stone-700";
